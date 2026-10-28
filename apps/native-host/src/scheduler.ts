/** Command scheduler — admission cap, per-tab lanes, browser_busy backpressure. */

import type { ToolResult } from "@fn-browser/browser/mcp";

/** CDP ops that mutate page/tab state and must serialize per tab. */
const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "navigate",
  "click",
  "fill_form",
  "upload_file",
  "evaluate_js",
  // adopt_tab re-parents a tab — must serialize concurrent adopts of same tab.
  "adopt_tab",
]);

/** Tabs a command must hold exclusively; session teardown locks all tabIds. */
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
    // Only consent bypasses admission; teardown must not jump ahead of queued mutations.
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

  /** Scan queue front-to-back; skip busy tabs without reordering. */
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
