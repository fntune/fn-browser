/**
 * Host-side command scheduler — admission control + backpressure in front of
 * the single native-messaging pipe to the extension.
 *
 * The host blindly forwarding every command into one stdio pipe is the
 * throughput bottleneck under concurrent multi-session load. This scheduler
 * sits in front of the bridge dispatch (see mcp-server.ts) and enforces:
 *
 *   - a bounded **admission cap** (`maxInFlight`) — at most N commands are in
 *     flight to the extension at once; the rest queue;
 *   - **per-tab exclusive lanes** for mutating ops (navigate/click/fill_form/
 *     upload_file/evaluate_js) — two mutating ops on the same tab never run
 *     concurrently. Because sessions are tab-group-disjoint (a tab belongs to
 *     exactly one session), per-tab ordering also yields per-session ordering
 *     for tab-scoped ops, so no separate per-session key is needed here;
 *   - explicit **`browser_busy` backpressure** — when the wait queue is full
 *     (`maxQueueDepth`) new commands fail fast with a retry hint instead of
 *     queueing unboundedly.
 *
 * Read-only ops (list_tabs/read_page/find/observe/screenshot/...) carry no
 * per-tab lane; they are bounded only by the admission cap. Only the long
 * consent round-trip (`__internal_request_consent`, which blocks on the user for
 * minutes) **bypasses** admission so it never holds a slot; other internal
 * commands (e.g. session teardown) go through the queue in order.
 *
 * Queue-wait time and execution time are tracked separately (see `stats()`).
 *
 * This component is topology-independent: when the daemon inversion lands
 * (Phase 1), it moves verbatim into `fn-browserd` in front of the WS transport.
 */

import type { ToolResult } from "@fntune/browser/mcp";

/** CDP ops that mutate page/tab state and must serialize per tab. */
const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "navigate",
  "click",
  "fill_form",
  "upload_file",
  "evaluate_js",
  // adopt_tab re-parents a specific tab's group; concurrent adopts of the same
  // tab must serialize so the loser doesn't bind to a stale group.
  "adopt_tab",
]);

/**
 * The set of tabs a command must hold exclusively while it runs. Single-tab
 * mutating ops lock their `tabId`; session teardown locks ALL the session's
 * `tabIds` so it can't close/ungroup tabs out from under queued per-tab
 * mutations. Everything else locks nothing (admission-bounded only).
 */
function lockedTabsFor(method: string, tabId?: number, tabIds?: number[]): number[] {
  if (method === "__internal_end_session_group" && tabIds && tabIds.length > 0) {
    return [...new Set(tabIds)];
  }
  if (MUTATING_METHODS.has(method) && tabId !== undefined) {
    return [tabId];
  }
  return [];
}

export interface SchedulerConfig {
  /** Max commands in flight to the extension at once. */
  maxInFlight: number;
  /** Max commands waiting in the admission queue before `browser_busy`. */
  maxQueueDepth: number;
  /** Suggested client backoff returned with `browser_busy`. */
  retryAfterMs: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxInFlight: 8,
  maxQueueDepth: 64,
  retryAfterMs: 250,
};

export interface SchedulerStats {
  inFlight: number;
  queued: number;
  busyTabs: number;
  dispatched: number;
  rejected: number;
  lastQueueWaitMs: number;
  lastExecMs: number;
}

interface QueuedCommand {
  method: string;
  lockedTabs: number[];
  run: () => Promise<ToolResult>;
  resolve: (r: ToolResult) => void;
  enqueuedAt: number;
}

export class CommandScheduler {
  private readonly config: SchedulerConfig;
  private readonly queue: QueuedCommand[] = [];
  private readonly busyTabs = new Set<number>();
  private inFlight = 0;
  private dispatched = 0;
  private rejected = 0;
  private lastQueueWaitMs = 0;
  private lastExecMs = 0;

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    if (this.config.maxInFlight < 1 || this.config.maxQueueDepth < 1) {
      throw new Error("CommandScheduler requires maxInFlight >= 1 and maxQueueDepth >= 1");
    }
  }

  /**
   * Submit a command for scheduled dispatch. `run` performs the actual
   * round-trip to the extension and resolves with a ToolResult. The returned
   * promise resolves either with `run`'s result or a synthesized `browser_busy`
   * failure when the queue is saturated.
   */
  submit(
    cmd: { method: string; tabId?: number; tabIds?: number[] },
    run: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    // ONLY the long-blocking consent round-trip bypasses admission (it waits on
    // the user for minutes and must not hold a slot). Other __internal_ commands
    // — notably __internal_end_session_group, which closes/ungroups tabs — go
    // through the queue so teardown can't jump ahead of already-queued per-tab
    // mutations that passed ownership checks.
    if (cmd.method === "__internal_request_consent") {
      return run();
    }

    if (this.queue.length >= this.config.maxQueueDepth) {
      this.rejected++;
      return Promise.resolve<ToolResult>({
        ok: false,
        error: {
          code: "browser_busy",
          message: `Browser command queue is full (${this.queue.length} queued, ${this.inFlight} in flight). Retry after ~${this.config.retryAfterMs}ms.`,
          details: {
            retryAfterMs: this.config.retryAfterMs,
            queued: this.queue.length,
            inFlight: this.inFlight,
          },
        },
      });
    }

    return new Promise<ToolResult>((resolve) => {
      this.queue.push({
        method: cmd.method,
        lockedTabs: lockedTabsFor(cmd.method, cmd.tabId, cmd.tabIds),
        run,
        resolve,
        enqueuedAt: performance.now(),
      });
      this.pump();
    });
  }

  stats(): SchedulerStats {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      busyTabs: this.busyTabs.size,
      dispatched: this.dispatched,
      rejected: this.rejected,
      lastQueueWaitMs: this.lastQueueWaitMs,
      lastExecMs: this.lastExecMs,
    };
  }

  /**
   * Dispatch as many eligible queued commands as admission allows. Scans the
   * queue front-to-back, skipping (but not reordering) commands any of whose
   * locked tabs are busy — this preserves per-tab FIFO while letting other lanes
   * proceed.
   */
  private pump(): void {
    let i = 0;
    while (i < this.queue.length && this.inFlight < this.config.maxInFlight) {
      const cmd = this.queue[i];
      if (cmd === undefined) break; // bound guarantees this; narrows the type
      if (cmd.lockedTabs.some((t) => this.busyTabs.has(t))) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.dispatch(cmd);
      // Don't advance `i`: the splice shifted the next command into this slot.
    }
  }

  private dispatch(cmd: QueuedCommand): void {
    this.inFlight++;
    this.dispatched++;
    for (const t of cmd.lockedTabs) this.busyTabs.add(t);
    const dispatchedAt = performance.now();
    this.lastQueueWaitMs = dispatchedAt - cmd.enqueuedAt;

    const settle = (res: ToolResult): void => {
      this.lastExecMs = performance.now() - dispatchedAt;
      this.inFlight--;
      for (const t of cmd.lockedTabs) this.busyTabs.delete(t);
      cmd.resolve(res);
      this.pump();
    };

    cmd.run().then(settle, (err: unknown) =>
      settle({
        ok: false,
        error: {
          code: "scheduler_error",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    );
  }
}
