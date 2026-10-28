/**
 * SessionRegistry — in-memory session + tab-group ownership state.
 * Chrome APIs live in the extension; groups are created lazily from the first tab.
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
  /** Browser (Chrome profile) the session drives; null until the host picks one. */
  browser: string | null;
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
  browser?: string | null;
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

/** Default idle window before reaping. Daemons may override via FN_BROWSER_SESSION_IDLE_MS. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_MAX_SESSIONS_PER_OWNER = 50;

export class SessionRegistry {
  private readonly sessions = new Map<SessionId, Session>();
  private readonly tabToSession = new Map<TabId, SessionId>();
  private readonly groupToSession = new Map<number, SessionId>();
  private readonly groupInits = new Map<SessionId, Promise<unknown>>();
  private readonly tabLocks = new Map<TabId, Promise<unknown>>();
  // In-flight guard: don't reap while a command is still executing.
  private readonly inFlight = new Map<SessionId, number>();
  private colorCursor = 0;


  constructor(
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
    private readonly maxSessionsPerOwner: number = DEFAULT_MAX_SESSIONS_PER_OWNER,
    /** Idle reap window; 0 disables. */
    private readonly idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
  ) {}

  start(args: StartSessionArgs): Session {
    return this.create({ ...args, id: crypto.randomUUID() as SessionId });
  }

  /**
   * Host-side session record; Chrome group appears on first tab (bindTabGroup).
   */
  create(args: CreateSessionArgs): Session {
    // Global + per-owner session caps.
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
      browser: args.browser ?? null,
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

  /** Pin the browser a session drives. No-op for an unknown session. */
  bindBrowser(sessionId: SessionId, browser: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.browser = browser;
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
   * Per-session lifecycle mutex (create_tab/adopt_tab vs end()).
   */
  async runSessionExclusive<T>(sessionId: SessionId, fn: () => Promise<T>): Promise<T> {
    return this.runExclusive(this.groupInits, sessionId, fn);
  }

  /** Per-tab mutex for adopt_tab (cross-principal contention). */
  async runTabExclusive<T>(tabId: TabId, fn: () => Promise<T>): Promise<T> {
    return this.runExclusive(this.tabLocks, tabId, fn);
  }

  private async runExclusive<K, T>(
    locks: Map<K, Promise<unknown>>,
    key: K,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    // Chain after prev regardless of outcome — failed holder must not block next.
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
    // closing=true immediately so tab reads reject during teardown.
    pre.closing = true;

    // Teardown under session lock so in-flight create/adopt finish first.
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
            // Scale with tab count — bulk close can exceed 20s.
            { timeoutMs: Math.max(30_000, tabIds.length * 1_000), sessionId: args.sessionId },
          );
          if (!res.ok) {
            throw new Error(`failed to close tab group: ${res.error.message}`);
          }
        }
      } catch (err) {
        // Teardown failed — reset closing so end() is retriable; reaper backstops.
        session.closing = false;
        throw err;
      }
      // Confirmed teardown — GC registry state + the session's policy state.
      if (session.tabGroupId !== null) this.groupToSession.delete(session.tabGroupId);
      for (const tabId of session.ownedTabs) {
        this.tabToSession.delete(tabId);
      }
      this.sessions.delete(args.sessionId);
      return { ok: true, closedTabs: onTabs === "close" ? tabIds.length : 0 };
    });
  }

  get(sessionId: SessionId): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (session) session.lastHeartbeat = new Date();
    return session;
  }

  /** Refresh idle clock on session-scoped requests (most tab ops skip get()). */
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
   * Dispatch-time check: session may have begun closing while command was queued.
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
    // Reject ops that raced teardown after the ownership check passed.
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
    // Group events use tabId -1; never record it as an owned tab.
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
      // Don't reap while a command is in flight.
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
