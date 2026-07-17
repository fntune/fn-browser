/**
 * SessionRegistry — the multi-tenant concurrency substrate.
 *
 * One Session corresponds to one connected caller (a Claude session, a
 * @fntune/workflows run, any MCP client). Sessions own Chrome tab groups;
 * cross-session tab access is gated.
 *
 * This module holds the authoritative in-memory state. Persistence to Postgres
 * lands in task #29 (observability); day-1 state is ephemeral, which matches
 * the native-host lifecycle (bound to Chrome).
 *
 * The registry does NOT talk to chrome.* APIs directly — the extension owns
 * tab-group creation. A session's Chrome tab group is created lazily from its
 * first tab (bindTabGroup), so `start` touches no browser state; `end` only
 * round-trips when a group was actually created.
 */

import type { ChromeTabGroupColor, HitlMode, SessionId, TabId } from "../cdp/types.js";
import type { TransportBridge } from "./index.js";

export interface Session {
  id: SessionId;
  name: string;
  color: ChromeTabGroupColor;
  /**
   * Owning principal (audit id). `null` in single-tenant / unauthenticated use,
   * where ownership isn't enforced. In authenticated (daemon) mode a caller may
   * only reference sessions whose owner matches their principal.
   */
  ownerPrincipalId: string | null;
  /** null until the session's first tab lazily creates its Chrome tab group. */
  tabGroupId: number | null;
  /** null until the first tab lands; then pinned to that tab's window. */
  windowId: number | null;
  createdAt: Date;
  lastHeartbeat: Date;
  workflowRunIds: string[];
  policy: HitlMode;
  ownedTabs: Set<TabId>;
  /**
   * Set synchronously when `end()` begins (before it awaits extension teardown).
   * Tab-scoped ops on a closing session are rejected so a command can't slip
   * through the ownership check during the teardown window and then execute
   * against a tab that's being closed/ungrouped.
   */
  closing: boolean;
}

export interface StartSessionArgs {
  name?: string;
  color?: ChromeTabGroupColor;
  ownerPrincipalId?: string;
}

export interface CreateSessionArgs extends StartSessionArgs {
  id: SessionId;
}

export interface EndSessionArgs {
  sessionId: SessionId;
  onTabs?: "leave" | "close";
  bridge: TransportBridge;
}

export interface OwnershipCheck {
  allowed: boolean;
  reason?: string;
  ownerSessionId?: SessionId;
}

export type SessionIdFactory = (ownerPrincipalId: string | undefined) => SessionId;

const DEFAULT_COLORS: ChromeTabGroupColor[] = [
  "blue",
  "green",
  "purple",
  "orange",
  "pink",
  "cyan",
  "yellow",
  "red",
];

/** Default idle window before a session is reaped. Conservative for the
 *  in-process/shim case. Remote-agent daemons run with a larger window (set by
 *  the host from FN_BROWSER_SESSION_IDLE_MS) because an agent workflow can sit
 *  between browser actions far longer than a human session would — that gap, not
 *  any flap, is what produced the observed `no_session` errors (a request always
 *  touches the heartbeat first, so a flapping-but-active session never ages). */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_MAX_SESSIONS_PER_OWNER = 50;

export class SessionRegistry {
  private readonly sessions = new Map<SessionId, Session>();
  private readonly tabToSession = new Map<TabId, SessionId>();
  private readonly groupToSession = new Map<number, SessionId>();
  private readonly groupInits = new Map<SessionId, Promise<unknown>>();
  private readonly tabLocks = new Map<TabId, Promise<unknown>>();
  // In-flight request count per session. The idle reaper must not prune a
  // session with a command still queued/executing (e.g. an evaluate_js with a
  // caller-supplied long timeout) — that could leave the command dispatching
  // against a tab no longer owned by any live session.
  private readonly inFlight = new Map<SessionId, number>();
  private colorCursor = 0;

  /**
   * Best-effort hook fired when a session leaves the registry — via end() or the
   * idle reaper. The daemon wires this to PolicyStore.clearSession so a session's
   * policy state (rate counters, ToS acceptances) dies with it.
   */
  onSessionRemoved?: (sessionId: SessionId) => void;

  constructor(
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
    private readonly maxSessionsPerOwner: number = DEFAULT_MAX_SESSIONS_PER_OWNER,
    /** Idle window before the reaper prunes a session. The daemon passes a
     *  larger value for remote-agent workloads; zero disables idle reaping. */
    private readonly idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
    /** Optional host-owned identity factory. Network daemons use it to bind
     * authenticated session ids to their principal for safe cross-host restore. */
    private readonly createSessionId: SessionIdFactory = () => crypto.randomUUID() as SessionId,
  ) {}

  start(args: StartSessionArgs): Session {
    return this.create({ ...args, id: this.createSessionId(args.ownerPrincipalId) });
  }

  /**
   * Create a session as a pure host-side record with an explicit identity. No
   * Chrome tab group exists until the first tab lazily creates it (see
   * bindTabGroup), so a zero-tab restored session has no browser footprint.
   */
  create(args: CreateSessionArgs): Session {
    // Bound session creation so a (e.g. read-tier) caller can't spawn unbounded
    // empty sessions — global cap + per-owner cap.
    if (this.sessions.has(args.id)) {
      throw new Error(`session ${args.id} already exists`);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`session limit reached (${this.maxSessions})`);
    }
    if (args.ownerPrincipalId) {
      let owned = 0;
      for (const s of this.sessions.values()) {
        if (s.ownerPrincipalId === args.ownerPrincipalId) owned++;
      }
      if (owned >= this.maxSessionsPerOwner) {
        throw new Error(`session limit reached for principal (${this.maxSessionsPerOwner})`);
      }
    }
    const session: Session = {
      id: args.id,
      name: args.name ?? "session",
      color: args.color ?? this.nextColor(),
      ownerPrincipalId: args.ownerPrincipalId ?? null,
      tabGroupId: null,
      windowId: null,
      createdAt: new Date(),
      lastHeartbeat: new Date(),
      workflowRunIds: [],
      policy: "ask",
      ownedTabs: new Set(),
      closing: false,
    };
    this.sessions.set(args.id, session);
    return session;
  }

  /**
   * Owning principal of a session without bumping its heartbeat. Returns
   * `undefined` if the session doesn't exist. Used for the impersonation guard.
   */
  ownerPrincipalId(sessionId: SessionId): string | null | undefined {
    return this.sessions.get(sessionId)?.ownerPrincipalId;
  }

  /**
   * Bind the Chrome tab group created from the session's first tab. Tolerates a
   * session ended/pruned mid-flight (no-op). Throws only on a genuine bug: a
   * second, different group bound to an already-grouped session.
   */
  bindTabGroup(sessionId: SessionId, groupId: number, windowId: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.tabGroupId !== null && session.tabGroupId !== groupId) {
      throw new Error(
        `session ${sessionId} already bound to group ${session.tabGroupId}, refusing ${groupId}`,
      );
    }
    session.tabGroupId = groupId;
    session.windowId = windowId;
    this.groupToSession.set(groupId, sessionId);
  }

  /**
   * Per-session lifecycle mutex. Serializes a session's tab-lifecycle ops —
   * create_tab/adopt_tab AND end() — so they cannot interleave: a tab being
   * created can't be orphaned by a concurrent teardown (end sees it in the
   * snapshot, or the create re-reads a closing/gone session and aborts). Binding
   * is monotonic, so this also guarantees exactly one group is created on the
   * first tab.
   */
  async runSessionExclusive<T>(sessionId: SessionId, fn: () => Promise<T>): Promise<T> {
    return this.runExclusive(this.groupInits, sessionId, fn);
  }

  /**
   * Per-tab mutex. Serializes ops that contend on a single tab's ownership/
   * grouping — specifically `adopt_tab`, so two principals can't both move the
   * same initially-unowned tab into their group (the cross-principal check is
   * re-run inside this lock BEFORE the Chrome mutation).
   */
  async runTabExclusive<T>(tabId: TabId, fn: () => Promise<T>): Promise<T> {
    return this.runExclusive(this.tabLocks, tabId, fn);
  }

  private async runExclusive<K, T>(
    locks: Map<K, Promise<unknown>>,
    key: K,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    // Run after prev settles regardless of its outcome — a failed holder must
    // not poison the next. `tail` is what later callers chain on.
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    locks.set(key, tail);
    try {
      return await run;
    } finally {
      // Drop the entry when no later caller has queued behind us (no leak).
      if (locks.get(key) === tail) {
        locks.delete(key);
      }
    }
  }

  async end(args: EndSessionArgs): Promise<{ ok: true; closedTabs: number }> {
    const pre = this.sessions.get(args.sessionId);
    if (!pre) return { ok: true, closedTabs: 0 };
    // Mark closing SYNCHRONOUSLY so tab reads (which don't take the lifecycle
    // lock) reject immediately during teardown.
    pre.closing = true;

    // Run teardown under the per-session lifecycle lock so an in-flight
    // create_tab/adopt_tab finishes attaching its tab (then included in the
    // snapshot and closed) before teardown, and any later one re-reads a
    // closing/deleted session and aborts — no orphaned tabs.
    return this.runSessionExclusive(args.sessionId, async () => {
      const session = this.sessions.get(args.sessionId);
      if (!session) return { ok: true, closedTabs: 0 };

      const onTabs = args.onTabs ?? "leave";
      const tabIds = Array.from(session.ownedTabs);

      try {
        // Only round-trip to the extension when a Chrome group was ever created.
        if (session.tabGroupId !== null) {
          const res = await args.bridge.sendToExtension(
            "__internal_end_session_group",
            { tabGroupId: session.tabGroupId, onTabs, tabIds },
            // Closing many tabs can exceed the lowered 20s default — give teardown
            // headroom that scales with the tab count.
            { timeoutMs: Math.max(30_000, tabIds.length * 1_000) },
          );
          if (!res.ok) {
            throw new Error(`failed to close tab group: ${res.error.message}`);
          }
        }
      } catch (err) {
        // Transient teardown failure (extension disconnect/timeout/browser_busy,
        // or a synchronous transport throw): the Chrome group is likely still
        // open, so KEEP the session retriable — reset `closing` (so its ops
        // aren't wedged) and let the caller retry end({on_tabs:"close"}) to
        // actually close the group. The idle reaper backstops a session then
        // abandoned. (The catch also covers a thrown bridge call, which
        // previously skipped cleanup and left the session stuck at closing=true.)
        session.closing = false;
        throw err;
      }
      // Confirmed teardown — GC registry state + the session's policy state.
      if (session.tabGroupId !== null) this.groupToSession.delete(session.tabGroupId);
      for (const tabId of session.ownedTabs) {
        this.tabToSession.delete(tabId);
      }
      this.sessions.delete(args.sessionId);
      this.onSessionRemoved?.(args.sessionId);
      return { ok: true, closedTabs: onTabs === "close" ? tabIds.length : 0 };
    });
  }

  get(sessionId: SessionId): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (session) session.lastHeartbeat = new Date();
    return session;
  }

  /**
   * Refresh a session's idle clock. Called on every session-scoped tool request
   * so the idle reaper only prunes genuinely-inactive sessions — most tab ops
   * (navigate/click/…) go through checkTabOwnership(), not get(), so without
   * this an actively-working session could be reaped after IDLE_TIMEOUT_MS.
   * No-op for an unknown id.
   */
  touch(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastHeartbeat = new Date();
  }

  /** Whether a session id resolves to a live session. Does NOT bump the
   * heartbeat (unlike get()) — for validating ids before caching under them. */
  has(sessionId: SessionId): boolean {
    return this.sessions.has(sessionId);
  }

  /** Mark a request in-flight for a session so the idle reaper won't prune it
   * mid-command. Paired with endRequest() in a finally. No-op for an unknown id. */
  beginRequest(sessionId: SessionId): void {
    if (!this.sessions.has(sessionId)) return;
    this.inFlight.set(sessionId, (this.inFlight.get(sessionId) ?? 0) + 1);
  }

  endRequest(sessionId: SessionId): void {
    const n = (this.inFlight.get(sessionId) ?? 0) - 1;
    if (n <= 0) this.inFlight.delete(sessionId);
    else this.inFlight.set(sessionId, n);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Associate a tab with a session (e.g., after create_tab or adopt_tab).
   */
  attachTab(sessionId: SessionId, tabId: TabId): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    const prevOwner = this.tabToSession.get(tabId);
    if (prevOwner && prevOwner !== sessionId) {
      this.sessions.get(prevOwner)?.ownedTabs.delete(tabId);
    }
    session.ownedTabs.add(tabId);
    this.tabToSession.set(tabId, sessionId);
  }

  detachTab(tabId: TabId): void {
    const ownerId = this.tabToSession.get(tabId);
    this.tabToSession.delete(tabId);
    if (!ownerId) return;
    this.sessions.get(ownerId)?.ownedTabs.delete(tabId);
  }

  getTabOwner(tabId: TabId): SessionId | undefined {
    return this.tabToSession.get(tabId);
  }

  /**
   * True if `tabId` belongs to a session that is tearing down. The daemon
   * scheduler calls this at DISPATCH time (after a command waited in the per-tab
   * lane) to drop a tab-op whose session began closing while it was queued —
   * the ownership check at admission time can't see a `closing` flag set later.
   * Does not bump the session heartbeat.
   */
  isTabSessionClosing(tabId: TabId): boolean {
    const ownerId = this.tabToSession.get(tabId);
    if (!ownerId) return false;
    return this.sessions.get(ownerId)?.closing === true;
  }

  /**
   * Check whether a caller session may operate on a given tab.
   */
  checkTabOwnership(tabId: TabId, callerSessionId: SessionId): OwnershipCheck {
    const ownerId = this.tabToSession.get(tabId);
    if (!ownerId) {
      // Not in any session's group — user tab.
      return {
        allowed: false,
        reason: "tab is not owned by any session (user tab)",
      };
    }
    if (ownerId !== callerSessionId) {
      return {
        allowed: false,
        reason: "tab belongs to another session",
        ownerSessionId: ownerId,
      };
    }
    // The owning session is tearing down — its tabs are about to be closed/
    // ungrouped, so reject ops that raced in during the teardown window.
    if (this.sessions.get(ownerId)?.closing) {
      return { allowed: false, reason: "session is closing", ownerSessionId: ownerId };
    }
    return { allowed: true };
  }

  /**
   * Reconcile after a manual user drag (chrome.tabs.onUpdated /
   * chrome.tabGroups.onUpdated fires in the extension). The extension calls
   * this with the tab's new group id.
   */
  reconcileTabGroupChange(tabId: TabId, newGroupId: number): void {
    // Group-level events (chrome.tabGroups.onUpdated) carry a sentinel tabId of
    // -1 (no specific tab). Never record it as an owned tab — that fake id would
    // later be sent to Chrome on teardown and fail ("No tab with id: -1").
    if ((tabId as unknown as number) < 0) return;

    const newOwner = this.groupToSession.get(newGroupId);
    const prevOwner = this.tabToSession.get(tabId);

    if (prevOwner) {
      this.sessions.get(prevOwner)?.ownedTabs.delete(tabId);
    }

    if (newOwner) {
      this.sessions.get(newOwner)?.ownedTabs.add(tabId);
      this.tabToSession.set(tabId, newOwner);
    } else {
      this.tabToSession.delete(tabId);
    }
  }

  setPolicy(sessionId: SessionId, policy: HitlMode): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    session.policy = policy;
  }

  addRun(sessionId: SessionId, runId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    session.workflowRunIds.push(runId);
  }

  /**
   * Sweep idle sessions. Returns the IDs of sessions that were pruned.
   */
  pruneIdle(now: Date = new Date()): SessionId[] {
    if (this.idleTimeoutMs === 0) return [];
    const cutoff = now.getTime() - this.idleTimeoutMs;
    const pruned: SessionId[] = [];
    for (const session of this.sessions.values()) {
      // Never reap a session with a command still in flight — it could complete
      // or dispatch against a tab that's no longer owned by any live session.
      if ((this.inFlight.get(session.id) ?? 0) > 0) continue;
      if (session.lastHeartbeat.getTime() < cutoff) {
        for (const tabId of session.ownedTabs) {
          this.tabToSession.delete(tabId);
        }
        if (session.tabGroupId !== null) {
          this.groupToSession.delete(session.tabGroupId);
        }
        this.groupInits.delete(session.id);
        this.sessions.delete(session.id);
        this.onSessionRemoved?.(session.id);
        pruned.push(session.id);
      }
    }
    return pruned;
  }

  private nextColor(): ChromeTabGroupColor {
    const c = DEFAULT_COLORS[this.colorCursor % DEFAULT_COLORS.length]!;
    this.colorCursor++;
    return c;
  }

  __reset(): void {
    this.sessions.clear();
    this.tabToSession.clear();
    this.groupToSession.clear();
    this.groupInits.clear();
    this.colorCursor = 0;
  }
}
