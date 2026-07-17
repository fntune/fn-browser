/**
 * Daemon-owned consent registry — the single source of truth for pending HITL
 * decisions (closes the split-brain risk where approval state lived only in the
 * extension).
 *
 * A consent request: registers a pending record, emits `consent.requested` on
 * the operator event plane, and waits for the FIRST of three outcomes —
 *   - the local side panel replies (the extension `forward` round-trip), or
 *   - a remote operator POSTs `/consents/:id/resolve` → `resolve(id, choice)`, or
 *   - the deadline elapses.
 * The extension reply is treated as a resolution only on success; an
 * unreachable/errored extension is ignored so a remote operator can still
 * decide. First settlement wins; later ones are no-ops.
 *
 * The return shape mirrors a normal `sendToExtension` ToolResult so
 * PolicyStore.requireConsent (in @fntune/browser) consumes it unchanged.
 */

import type { ToolResult } from "@fntune/browser/mcp";
import type { EventBus } from "../events/bus.js";
import type { AuditLog } from "../observability/audit.js";

const DEFAULT_CONSENT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PENDING = 500;

export interface ConsentRequestParams {
  title: string;
  body: string;
  options?: string[];
  tabId?: number;
  /**
   * Only the LOCAL user (extension side panel) may resolve this — the `/consents`
   * operator route refuses it. Used for handing over an unowned user tab, where a
   * remote operator pre-approving would defeat the explicit local handoff.
   */
  localOnly?: boolean;
}

/** The seam createMcpServer plugs the daemon registry into. */
export interface ConsentSink {
  request(
    params: ConsentRequestParams,
    forward: () => Promise<ToolResult>,
    opts: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ToolResult>;
}

export interface PendingConsentView {
  id: string;
  title: string;
  body: string;
  options: string[];
  tabId?: number;
  createdAt: string;
  /** Resolvable only by the local user, not a remote operator (see request). */
  localOnly?: boolean;
}

type Outcome =
  | { kind: "choice"; choice: string; via: "extension" | "operator"; approvedBy?: string }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: string };

/**
 * Outcome of an operator `resolve()`. The route maps `reason` to an HTTP status:
 * `local_only` → 403 (only the local user may resolve), `unknown` → 404,
 * `invalid_choice` → 400. A bare boolean couldn't distinguish these.
 */
export type ResolveResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "local_only" | "invalid_choice" };

interface PendingConsent extends PendingConsentView {
  settle: (outcome: Outcome) => void;
  settled: boolean;
}

export class ConsentRegistry implements ConsentSink {
  private readonly pending = new Map<string, PendingConsent>();

  constructor(
    private readonly bus: EventBus,
    private readonly audit: AuditLog,
    private readonly idgen: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
    private readonly maxPending: number = DEFAULT_MAX_PENDING,
  ) {}

  async request(
    params: ConsentRequestParams,
    forward: () => Promise<ToolResult>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ToolResult> {
    if (opts.signal?.aborted) return cancelledResult();
    // Bound the queue: an authenticated caller could otherwise spawn unbounded
    // pending records + 10-minute timers. Over the cap, fail closed (deny).
    if (this.pending.size >= this.maxPending) {
      void this.audit.append({ kind: "consent.rejected_overload", pending: this.pending.size });
      return {
        ok: false,
        error: {
          code: "consent_overloaded",
          message: `Too many pending consents (${this.pending.size}); retry shortly.`,
        },
      };
    }
    const id = this.idgen();
    const options = params.options ?? ["allow", "deny"];
    const createdAt = this.now().toISOString();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;

    let resolveOutcome!: (outcome: Outcome) => void;
    const decided = new Promise<Outcome>((res) => {
      resolveOutcome = res;
    });

    const pending: PendingConsent = {
      id,
      title: params.title,
      body: params.body,
      options,
      ...(params.tabId !== undefined ? { tabId: params.tabId } : {}),
      ...(params.localOnly ? { localOnly: true } : {}),
      createdAt,
      settled: false,
      settle: (outcome) => {
        if (pending.settled) return;
        pending.settled = true;
        resolveOutcome(outcome);
      },
    };
    this.pending.set(id, pending);

    const cancel = (): void => pending.settle({ kind: "cancelled" });
    opts.signal?.addEventListener("abort", cancel, { once: true });
    // Close the addEventListener race if the signal aborted between the entry
    // check above and listener registration.
    if (opts.signal?.aborted) cancel();

    this.bus.emit("operator", "consent.requested", this.view(pending), createdAt);
    void this.audit.append({ kind: "consent.requested", id, title: pending.title, ...(pending.tabId !== undefined ? { tabId: pending.tabId } : {}) });

    const timer = setTimeout(() => pending.settle({ kind: "timeout" }), timeoutMs);

    // Surface to the local side panel. Success → resolution; error → ignored so
    // a remote operator can still resolve.
    void forward()
      .then((r) => {
        if (r.ok) {
          const choice = (r.result as { choice?: string } | null)?.choice;
          if (typeof choice === "string") {
            pending.settle({ kind: "choice", choice, via: "extension" });
          }
          return;
        }
        // The extension forward failed (e.g. the WS link dropped). A normal
        // consent can still be resolved by a remote operator or time out — keep
        // waiting. But a LOCAL-ONLY consent can ONLY be answered by the now-
        // unreachable local user (operators are refused), so it would otherwise
        // hang to the 10-min timeout — settle it fast.
        if (pending.localOnly) {
          pending.settle({ kind: "failed", reason: r.error.message });
        }
      })
      .catch(() => {
        /* ignore — the consent may still resolve via operator or timeout */
      });

    try {
      const outcome = await decided;
      const resolvedAt = this.now().toISOString();
      if (outcome.kind === "timeout") {
        void this.audit.append({ kind: "consent.timeout", id });
        this.bus.emit("operator", "consent.resolved", { id, via: "timeout" }, resolvedAt);
        return {
          ok: false,
          error: { code: "cdp_timeout", message: "Consent request timed out — no operator responded." },
        };
      }
      if (outcome.kind === "cancelled") {
        void this.audit.append({ kind: "consent.cancelled", id });
        this.bus.emit("operator", "consent.resolved", { id, via: "cancelled" }, resolvedAt);
        return cancelledResult();
      }
      if (outcome.kind === "failed") {
        void this.audit.append({ kind: "consent.failed", id, reason: outcome.reason });
        this.bus.emit("operator", "consent.resolved", { id, via: "failed" }, resolvedAt);
        return {
          ok: false,
          error: {
            code: "extension_unreachable",
            message: `Local-only consent could not be resolved (extension link lost): ${outcome.reason}`,
          },
        };
      }
      const resolution = {
        id,
        choice: outcome.choice,
        via: outcome.via,
        ...(outcome.approvedBy ? { approvedBy: outcome.approvedBy } : {}),
      };
      void this.audit.append({ kind: "consent.resolved", ...resolution });
      this.bus.emit("operator", "consent.resolved", resolution, resolvedAt);
      return { ok: true, result: { choice: outcome.choice } };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", cancel);
      this.pending.delete(id);
    }
  }

  /** Resolve a pending consent from a remote operator. `approvedBy` is the
   * operator's principal id, recorded in the audit trail. Returns a structured
   * result so the route can distinguish `unknown` (404), `local_only` (403 —
   * only the local user may resolve those, see ConsentRequestParams.localOnly),
   * and `invalid_choice` (400). */
  resolve(id: string, choice: string, approvedBy?: string): ResolveResult {
    const pending = this.pending.get(id);
    if (!pending || pending.settled) return { ok: false, reason: "unknown" };
    if (pending.localOnly) {
      // A remote operator must not approve a local-only handoff (e.g. adopting
      // the user's own tab). Record the attempt; only the side panel can settle.
      void this.audit.append({ kind: "consent.operator_refused_local_only", id, ...(approvedBy ? { approvedBy } : {}) });
      return { ok: false, reason: "local_only" };
    }
    // The choice must be one this prompt actually offered — a stale/mistyped
    // operator response must not inject an impossible answer downstream treats
    // as real (e.g. accept/decline prompts, custom workflow branches).
    if (!pending.options.includes(choice)) {
      return { ok: false, reason: "invalid_choice" };
    }
    pending.settle({
      kind: "choice",
      choice,
      via: "operator",
      ...(approvedBy ? { approvedBy } : {}),
    });
    return { ok: true };
  }

  list(): PendingConsentView[] {
    return [...this.pending.values()].filter((p) => !p.settled).map((p) => this.view(p));
  }

  private view(p: PendingConsent): PendingConsentView {
    return {
      id: p.id,
      title: p.title,
      body: p.body,
      options: p.options,
      ...(p.tabId !== undefined ? { tabId: p.tabId } : {}),
      ...(p.localOnly ? { localOnly: true } : {}),
      createdAt: p.createdAt,
    };
  }
}

function cancelledResult(): ToolResult {
  return {
    ok: false,
    error: {
      code: "request_cancelled",
      message: "The request deadline elapsed while consent was pending.",
    },
  };
}
