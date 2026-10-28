/**
 * In-memory platform policy: rate limits, consent, ToS cache, activity window.
 */

import type { HitlMode, SessionId } from "../cdp/types.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TransportBridge } from "./index.js";

export type RateLimitWindow = "minute" | "hour" | "daily";

/** Counter namespace. `global` is shared across sessions (the default and the
 * cross-session invariant); `session` namespaces the counter per caller. */
export type RateLimitScope = "global" | "session";

export interface RateLimitScopeArgs {
  scope?: RateLimitScope;
  sessionId?: SessionId;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  reset_at: string;
  count: number;
}

export interface RateLimitConsumeResult {
  allowed: boolean;
  remaining: number;
  reset_at: string;
}

export interface RateCounterSnapshot {
  tag: string;
  count: number;
  reset_at: string;
}

export interface RequireConsentArgs {
  title: string;
  body: string;
  options?: string[];
  timeoutMs?: number;
  bridge: TransportBridge;
  /** Caller session id — when set, PolicyStore consults `session.policy`. */
  sessionId?: SessionId;
  /**
   * Whether the gated action is destructive (application submit, message send,
   * purchase, post, etc.). Destructive actions ALWAYS prompt — the three-mode
   * policy only affects non-destructive requests.
   */
  destructive?: boolean;
  /**
   * Tab the gated action targets. Forwarded to the extension so it can
   * resolve the page's origin, check its allowlist (auto-approving trusted
   * sites), and include the origin in the consent modal rendered in the
   * side panel.
   */
  tabId?: number;
  /**
   * This decision must be made by the LOCAL user at the keyboard — a remote
   * operator must NOT be able to resolve it through the daemon `/consents`
   * route. Used for handing over an unowned user tab (adopt_tab).
   */
  localOnly?: boolean;
  /** Cancels a pending prompt when the owning request deadline elapses. */
  signal?: AbortSignal;
}

export interface RequireTosArgs {
  origin: string;
  policyText: string;
  bridge: TransportBridge;
  sessionId?: SessionId;
  signal?: AbortSignal;
}

interface RateCounter {
  count: number;
  resetAt: number;
}

const DEFAULT_CONSENT_TIMEOUT_MS = 10 * 60 * 1000;

export class PolicyStore {
  private readonly counters = new Map<string, RateCounter>();
  // ToS keyed by live session id so acceptances die with the session.
  private readonly tosAcceptedBySession = new Map<string, Set<string>>();
  private globalPolicy: HitlMode | null = null;

  constructor(private readonly sessionRegistry?: SessionRegistry) {}

  /**
   * Global HITL override. Destructive actions still prompt when set.
   */
  setGlobalPolicy(policy: HitlMode | null): void {
    this.globalPolicy = policy;
  }

  getGlobalPolicy(): HitlMode | null {
    return this.globalPolicy;
  }

  /**
   * Advisory peek at a counter. Seeds the window (so the counter shows up in
   * `/rate-limits` before any consume) but never increments. For gating writes,
   * prefer the atomic `rateLimitConsume`.
   */
  async rateLimitCheck(
    tag: string,
    max: number,
    window: string,
    opts?: RateLimitScopeArgs,
  ): Promise<RateLimitCheckResult> {
    const now = Date.now();
    const counter = this.ensureCounter(this.counterKey(tag, opts), parseWindow(window), now);
    const allowed = counter.count < max;
    return {
      allowed,
      remaining: Math.max(0, max - counter.count),
      reset_at: new Date(counter.resetAt).toISOString(),
      count: counter.count,
    };
  }

  /**
   * Atomic check-and-increment; no await between read and write on the event loop.
   */
  async rateLimitConsume(
    tag: string,
    max: number,
    window: string,
    opts?: RateLimitScopeArgs,
  ): Promise<RateLimitConsumeResult> {
    const now = Date.now();
    const counter = this.ensureCounter(this.counterKey(tag, opts), parseWindow(window), now);
    const allowed = counter.count < max;
    if (allowed) counter.count++;
    return {
      allowed,
      remaining: Math.max(0, max - counter.count),
      reset_at: new Date(counter.resetAt).toISOString(),
    };
  }

  /**
   * Snapshot of all active rate counters — exposed via GET /rate-limits for
   * the side-panel readout.
   */
  snapshotRateLimits(): RateCounterSnapshot[] {
    const now = Date.now();
    const snapshot: RateCounterSnapshot[] = [];
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) continue;
      // Strip the internal `global:` namespace so the readout shows the caller's
      // natural tag; session counters keep their `session:<id>:` namespace.
      const tag = key.startsWith("global:") ? key.slice("global:".length) : key;
      snapshot.push({
        tag,
        count: counter.count,
        reset_at: new Date(counter.resetAt).toISOString(),
      });
    }
    return snapshot;
  }

  async requireConsent(
    args: RequireConsentArgs,
  ): Promise<{ choice: string; at: string }> {
    // Non-destructive: act/follow_plan auto-allow; destructive always prompts.
    if (!args.destructive) {
      const effective = this.resolveEffectivePolicy(args.sessionId);
      if (effective === "act" || effective === "follow_plan") {
        return { choice: "allow", at: new Date().toISOString() };
      }
    }

    const timeoutMs = args.timeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;

    // The bridge routes to the extension which pops the side-panel modal.
    // Any extension-side modal dismissal returns { choice: "declined" | <opt> }.
    const result = await args.bridge.sendToExtension(
      "__internal_request_consent",
      {
        title: args.title,
        body: args.body,
        options: args.options ?? ["allow", "deny"],
        ...(typeof args.tabId === "number" ? { tabId: args.tabId } : {}),
        ...(args.localOnly ? { localOnly: true } : {}),
      },
      { timeoutMs, signal: args.signal, sessionId: args.sessionId },
    );

    if (!result.ok) {
      if (result.error.code === "cdp_timeout") {
        throw new Error("Consent request timed out — user did not respond.");
      }
      throw new Error(`Consent request failed: ${result.error.message}`);
    }

    const response = result.result as { choice: string };
    return { choice: response.choice, at: new Date().toISOString() };
  }

  async requireTosAcceptance(
    args: RequireTosArgs,
  ): Promise<{ accepted: boolean; already_accepted: boolean }> {
    // Only cache under a live session id; otherwise re-prompt every time.
    const tosKey =
      args.sessionId !== undefined &&
      (!this.sessionRegistry || this.sessionRegistry.has(args.sessionId))
        ? args.sessionId
        : undefined;
    if (tosKey !== undefined && this.tosAcceptedBySession.get(tosKey)?.has(args.origin)) {
      return { accepted: true, already_accepted: true };
    }
    // ToS is destructive-class — never auto-allowed by session policy.
    const consent = await this.requireConsent({
      title: `Accept ${args.origin} Terms of Service`,
      body: args.policyText,
      options: ["accept", "decline"],
      bridge: args.bridge,
      sessionId: args.sessionId,
      destructive: true,
      signal: args.signal,
    });
    const accepted = consent.choice === "accept" || consent.choice === "allow";
    if (accepted && tosKey !== undefined) {
      let set = this.tosAcceptedBySession.get(tosKey);
      if (!set) {
        set = new Set();
        this.tosAcceptedBySession.set(tosKey, set);
      }
      set.add(args.origin);
    }
    return { accepted, already_accepted: false };
  }

  checkActivityWindow(args: {
    start: string;
    end: string;
    tz?: string;
    /** Injectable clock for deterministic tests; defaults to the wall clock. */
    now?: Date;
  }): { in_window: boolean; next_window_at: string } {
    const tz = args.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = args.now ?? new Date();
    const nowLocal = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const [sh, sm] = parseHm(args.start);
    const [eh, em] = parseHm(args.end);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const nowMin = nowLocal.getHours() * 60 + nowLocal.getMinutes();
    const inWindow = startMin <= nowMin && nowMin < endMin;
    const nextStart = new Date(nowLocal);
    if (nowMin < startMin) {
      nextStart.setHours(sh, sm, 0, 0);
    } else {
      nextStart.setDate(nextStart.getDate() + 1);
      nextStart.setHours(sh, sm, 0, 0);
    }
    return {
      in_window: inWindow,
      next_window_at: nextStart.toISOString(),
    };
  }

  /**
   * Test-only: reset all in-memory state.
   */
  __reset(): void {
    this.counters.clear();
    this.tosAcceptedBySession.clear();
    this.globalPolicy = null;
  }

  /**
   * Evict all policy state owned by a session — its `session:<id>:*` rate
   * counters and its ToS acceptances. Called when a session ends (and by the
   * idle reaper) so policy state dies with the session instead of accumulating
   * for the daemon's lifetime. Global/unscoped state is untouched.
   */
  clearSession(sessionId: SessionId): void {
    this.tosAcceptedBySession.delete(sessionId);
    const prefix = `session:${sessionId}:`;
    for (const key of this.counters.keys()) {
      if (key.startsWith(prefix)) this.counters.delete(key);
    }
  }

  /**
   * Effective policy: global override → session policy → "ask".
   */
  private resolveEffectivePolicy(sessionId?: SessionId): HitlMode {
    if (this.globalPolicy !== null) return this.globalPolicy;
    if (sessionId && this.sessionRegistry) {
      const session = this.sessionRegistry.get(sessionId);
      if (session) return session.policy;
    }
    return "ask";
  }

  /**
   * Resolve the counter map key for a tag. `global` scope (default) keys by tag
   * directly — shared across sessions. `session` scope namespaces by session id;
   * it requires a sessionId.
   */
  private counterKey(tag: string, opts?: RateLimitScopeArgs): string {
    if (opts?.scope === "session") {
      if (!opts.sessionId) {
        throw new Error('rate-limit scope "session" requires a session id (pass sessionId or X-Session-Id).');
      }
      // Require a live session id — rotating fake ids must not mint fresh counters.
      if (this.sessionRegistry && !this.sessionRegistry.get(opts.sessionId as SessionId)) {
        throw new Error('rate-limit scope "session" requires a live session id.');
      }
      return `session:${opts.sessionId}:${tag}`;
    }
    // Namespace global keys so crafted tags can't collide with session-scoped keys.
    return `global:${tag}`;
  }

  private ensureCounter(
    tag: string,
    window: RateLimitWindow,
    now: number,
  ): RateCounter {
    let counter = this.counters.get(tag);
    if (counter && counter.resetAt > now) {
      return counter;
    }
    counter = {
      count: 0,
      resetAt: now + windowToMs(window),
    };
    this.counters.set(tag, counter);
    return counter;
  }
}

function parseHm(hm: string): [number, number] {
  const [h, m] = hm.split(":").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    throw new Error(`invalid HH:MM string: ${hm}`);
  }
  return [h!, m!];
}

/**
 * Validate an untrusted window string. Throws on unknown values so a bad enum
 * (e.g. the old "hourly") fails loudly instead of yielding `windowToMs() ===
 * undefined` → `resetAt = NaN` → a counter that resets every call (silently
 * disabling the limit).
 */
function parseWindow(window: string): RateLimitWindow {
  if (window === "minute" || window === "hour" || window === "daily") {
    return window;
  }
  throw new Error(`unknown rate-limit window "${window}" (expected minute, hour, or daily)`);
}

function windowToMs(window: RateLimitWindow): number {
  switch (window) {
    case "minute":
      return 60 * 1000;
    case "hour":
      return 60 * 60 * 1000;
    case "daily":
      return 24 * 60 * 60 * 1000;
    default: {
      const exhaustive: never = window;
      throw new Error(`unhandled rate-limit window: ${String(exhaustive)}`);
    }
  }
}
