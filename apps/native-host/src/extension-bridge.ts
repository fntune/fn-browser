/**
 * ExtensionBridge: request/response correlator on top of NativeMessagingBridge.
 *
 * Commands flow host -> extension. The host issues a command, awaits the
 * response (matched by id), returns the typed result. Events flow
 * extension -> host and surface via onEvent handlers.
 *
 * Liveness + command deadlines share ONE monotonic poll (see `poll`). The poll
 * checks an unanswered ping BEFORE per-command deadlines, so a silently-dead
 * link always fails in-flight commands as the retryable
 * `extension_unreachable` rather than racing the per-command deadline into a
 * `cdp_timeout`. Deadlines are evaluated against `performance.now()` (monotonic),
 * so a suspended-then-woken process can't fire a deadline early.
 */

import type { MessageTransport } from "./transport.js";
import {
  type ExtensionToHostEvent,
  type ExtensionToHostError,
  type ExtensionToHostResponse,
  type HostHelloAck,
  newMessageId,
  PROTOCOL_VERSION,
} from "./protocol.js";
import { HOST_VERSION } from "./version.js";

export interface CommandResult {
  ok: true;
  result: unknown;
}

export interface CommandFailure {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

type PendingCommand = {
  resolve: (r: CommandResult | CommandFailure) => void;
  method: string;
  timeoutMs: number;
  /** Monotonic (`performance.now()`) instant after which the command times out.
   *  Checked by the poll — never a per-command `setTimeout`, so a process
   *  suspend can't fire it early and a wake can't fire a backlog of them. */
  deadlineAtMs: number;
  /** Transport socket generation captured at send. A pending whose generation is
   *  superseded (the socket flipped) is failed as unreachable — defends the
   *  "a command never outlives its socket" invariant independently of the
   *  daemon remembering to call markDisconnected() on every flip. */
  generation: number;
};

// Lowered from 60s: on *silent* extension death (port open, SW gone, no EOF)
// in-flight calls hang until this fires. Silent death is rare — the open
// native-messaging port keeps the SW alive and a hard EOF already exits the
// host — so a shorter backstop trades little against faster failure. Long
// operations (consent prompts) pass an explicit larger `timeoutMs`. On the
// WebSocket (daemon) path the silence watchdog below fails in-flight commands
// well before this fires; this is the floor for a genuinely slow-but-alive op.
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
/** Grace after an actual ping before its missing pong marks the link dead. */
const PONG_GRACE_MS = 5_000;
/** How often the liveness + deadline poll runs. Detection latency is at most
 *  `pingInterval + PONG_GRACE_MS + LIVENESS_CHECK_MS`; kept comfortably under
 *  the command timeout so the watchdog wins the race against it. */
const LIVENESS_CHECK_MS = 2_000;

/** Monotonic clock. `performance.now()` does not jump on wall-clock/NTP
 *  adjustments, so liveness/deadline math can't be skewed by a clock step. */
function monotonicNowMs(): number {
  return performance.now();
}

export class ExtensionBridge {
  private readonly pending = new Map<string, PendingCommand>();
  private readonly eventHandlers = new Set<(event: ExtensionToHostEvent) => void>();
  private connected = false;
  private extensionVersion: string | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Single interval driving both the silence watchdog and command deadlines.
   *  Runs only while there is liveness to watch (ping enabled + connected) or a
   *  command to time out — see `updatePoll`. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Monotonic instant at which the latest unacknowledged ping was sent. Any
   *  inbound frame clears it because all inbound traffic proves liveness. */
  private awaitingPongSinceMs: number | null = null;

  /**
   * @param pingIntervalMs when > 0, send app-level `ping` frames on this
   *   interval after the handshake and disconnect if no inbound frame arrives
   *   within `pingIntervalMs + PONG_GRACE_MS`. Enabled by fn-browserd (WebSocket
   *   transport, which has no built-in liveness); left 0 for the native-messaging
   *   shim (the stdio port already signals death, and that path's client doesn't
   *   pong).
   */
  constructor(
    private readonly bridge: MessageTransport,
    private readonly pingIntervalMs = 0,
    /** Monotonic clock source; injectable so timer tests can drive it
     *  independently of the poll interval. Defaults to `performance.now()`. */
    private readonly now: () => number = monotonicNowMs,
  ) {
    bridge.onMessage((message) => {
      this.handleMessage(message);
    });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get peerVersion(): string | null {
    return this.extensionVersion;
  }

  /** Number of registered extension-event handlers. Guards the invariant that
   * the daemon registers its tab-reconcile handler exactly ONCE — a future
   * refactor that moved bridge/app construction into the per-connection path
   * would make this grow per reconnect (a real leak). */
  get eventHandlerCount(): number {
    return this.eventHandlers.size;
  }

  /**
   * Mark the extension link as down (e.g. the daemon's WebSocket closed, or the
   * silence watchdog tripped). Flips `isConnected` to false and fast-fails every
   * in-flight command with `extension_unreachable` instead of letting them hang
   * to the deadline — the liveness signal a persistent transport gives us "for
   * free" on close, and what the watchdog synthesizes on a silent death.
   */
  markDisconnected(): void {
    this.bridge.disconnect?.();
    this.connected = false;
    this.extensionVersion = null;
    this.awaitingPongSinceMs = null;
    this.stopPing();
    for (const pending of this.pending.values()) {
      pending.resolve({
        ok: false,
        error: { code: "extension_unreachable", message: "Extension disconnected." },
      });
    }
    this.pending.clear();
    this.updatePoll();
  }

  /** Clear all timers (ping + poll). For clean daemon shutdown / test teardown. */
  dispose(): void {
    this.stopPing();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async sendCommand(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<CommandResult | CommandFailure> {
    if (!this.connected) {
      return {
        ok: false,
        error: {
          code: "extension_unreachable",
          message: "Extension is not connected. Is Chrome open with the fn-browser extension enabled?",
        },
      };
    }

    const id = newMessageId();
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

    return new Promise<CommandResult | CommandFailure>((resolve) => {
      this.pending.set(id, {
        resolve,
        method,
        timeoutMs,
        deadlineAtMs: this.now() + timeoutMs,
        generation: this.bridge.generation?.() ?? 0,
      });
      this.updatePoll();
      try {
        this.bridge.send({ id, kind: "command", method, params });
      } catch (err) {
        // A synchronous transport throw (socket in a bad state) would otherwise
        // leave this entry pending until the deadline — fail fast instead: drop
        // the entry and resolve the caller as unreachable.
        this.pending.delete(id);
        this.updatePoll();
        resolve({
          ok: false,
          error: {
            code: "extension_unreachable",
            message: `Failed to send ${method} to the extension: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        });
      }
    });
  }

  onEvent(handler: (event: ExtensionToHostEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return;
    // Any inbound frame proves the link is alive. A `pong` carries no payload
    // beyond acknowledging the latest probe.
    this.awaitingPongSinceMs = null;
    switch (message.kind) {
      case "hello":
        this.handleHello(message as unknown as { id: string; extensionVersion: string; protocolVersion: number });
        return;
      case "response":
        this.handleResponse(message as unknown as ExtensionToHostResponse | ExtensionToHostError);
        return;
      case "event":
        this.handleEvent(message as unknown as ExtensionToHostEvent);
        return;
      case "pong":
        return;
    }
  }

  private handleHello(hello: { id: string; extensionVersion: string; protocolVersion: number }): void {
    this.connected = true;
    this.extensionVersion = hello.extensionVersion;
    const ack: HostHelloAck = {
      id: hello.id,
      kind: "hello_ack",
      hostVersion: HOST_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    };
    this.bridge.send(ack);
    this.startPing();
    this.updatePoll();
  }

  /** Begin app-level liveness pinging (no-op unless pingIntervalMs > 0). The
   *  pings keep pong traffic flowing on an otherwise-idle link so the silence
   *  watchdog (in `poll`) has fresh inbound frames to observe. */
  private startPing(): void {
    if (this.pingIntervalMs <= 0) return;
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        this.awaitingPongSinceMs = this.now();
        this.bridge.send({ id: newMessageId(), kind: "ping" });
      } catch {
        this.markDisconnected();
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Start/stop the poll to match whether there's anything to watch: liveness
   *  (ping enabled + connected) or at least one in-flight command to time out. */
  private updatePoll(): void {
    const needed = (this.pingIntervalMs > 0 && this.connected) || this.pending.size > 0;
    if (needed && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), LIVENESS_CHECK_MS);
      this.pollTimer.unref?.();
    } else if (!needed && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * One tick of the liveness + deadline poll. Order matters: a silent-link or
   * post-sleep wake is detected FIRST and fails every pending as the retryable
   * `extension_unreachable`, so a dead link never surfaces as a per-command
   * `cdp_timeout`. Only on a live link do per-command deadlines fire — those are
   * connected-but-stalled ops (`cdp_timeout`).
   */
  private poll(): void {
    const now = this.now();

    // 1. Pong watchdog (WebSocket/daemon path only). The deadline starts when a
    //    ping is actually sent, not from the last old inbound frame. If the host
    //    event loop stalls, the delayed ping therefore receives its full grace
    //    window before the poll may declare the live socket dead.
    if (
      this.pingIntervalMs > 0 &&
      this.connected &&
      this.awaitingPongSinceMs !== null &&
      now - this.awaitingPongSinceMs > PONG_GRACE_MS
    ) {
      this.markDisconnected();
      return;
    }

    // 2. Per-command deadlines + superseded-generation guard (live link).
    const currentGen = this.bridge.generation?.();
    for (const [id, pending] of this.pending) {
      if (currentGen !== undefined && pending.generation < currentGen) {
        this.pending.delete(id);
        pending.resolve({
          ok: false,
          error: { code: "extension_unreachable", message: "Extension socket was superseded." },
        });
        continue;
      }
      if (now >= pending.deadlineAtMs) {
        this.pending.delete(id);
        pending.resolve({
          ok: false,
          error: {
            // Connected ⇒ the extension is alive but the op didn't return in
            // time. Disconnected ⇒ retryable link loss —
            // matches the contract markDisconnected uses.
            code: this.connected ? "cdp_timeout" : "extension_unreachable",
            message: this.connected
              ? "Extension connected but command timed out — tab or CDP may be stalled."
              : "Extension disconnected.",
          },
        });
      }
    }
    this.updatePoll();
  }

  private handleResponse(resp: ExtensionToHostResponse | ExtensionToHostError): void {
    const pending = this.pending.get(resp.id);
    if (!pending) return;
    this.pending.delete(resp.id);
    if (resp.ok) {
      pending.resolve({ ok: true, result: resp.result });
    } else {
      pending.resolve({ ok: false, error: resp.error });
    }
    this.updatePoll();
  }

  private handleEvent(event: ExtensionToHostEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error("[extension-bridge] event handler threw:", err);
      }
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
