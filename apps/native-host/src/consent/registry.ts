/** Daemon-owned consent queue — first of extension, operator, or timeout wins. */

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
  /** Remote operators cannot resolve — local side panel only. */
  localOnly?: boolean;
}

export interface ConsentRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Resolves to the target tab's origin when FN_BROWSER_TRUSTED_ORIGINS trusts it. */
  trustedOrigin?: () => Promise<string | undefined>;
}

/** The seam createMcpServer plugs the daemon registry into. */
export interface ConsentSink {
  request(
    params: ConsentRequestParams,
    forward: () => Promise<ToolResult>,
    opts: ConsentRequestOptions,
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

/** Maps resolve() reason to HTTP status. */
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
    opts: ConsentRequestOptions = {},
  ): Promise<ToolResult> {
    if (opts.signal?.aborted) return cancelledResult();
    // Trusted origin — approve without a prompt, as the extension's allowlist does. Never for local-only.
    if (!params.localOnly && opts.trustedOrigin) {
      const origin = await opts.trustedOrigin();
      if (opts.signal?.aborted) return cancelledResult();
      if (origin) {
        void this.audit.append({
          kind: "consent.auto_approved",
          title: params.title,
          origin,
          ...(params.tabId !== undefined ? { tabId: params.tabId } : {}),
        });
        return { ok: true, result: { choice: "allow", autoApproved: true, origin } };
      }
    }
    // Over cap — fail closed (deny).
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
    if (opts.signal?.aborted) cancel(); // close addEventListener race

    this.bus.emit("operator", "consent.requested", this.view(pending), createdAt);
    void this.audit.append({ kind: "consent.requested", id, title: pending.title, ...(pending.tabId !== undefined ? { tabId: pending.tabId } : {}) });

    const timer = setTimeout(() => pending.settle({ kind: "timeout" }), timeoutMs);

    // Extension success → resolve; failure ignored so operator can still decide.
    void forward()
      .then((r) => {
        if (r.ok) {
          const choice = (r.result as { choice?: string } | null)?.choice;
          if (typeof choice === "string") {
            pending.settle({ kind: "choice", choice, via: "extension" });
          }
          return;
        }
        // localOnly + unreachable extension — fail fast, not 10-min hang.
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

  /** Operator resolve; returns structured result for HTTP status mapping. */
  resolve(id: string, choice: string, approvedBy?: string): ResolveResult {
    const pending = this.pending.get(id);
    if (!pending || pending.settled) return { ok: false, reason: "unknown" };
    if (pending.localOnly) {
      void this.audit.append({ kind: "consent.operator_refused_local_only", id, ...(approvedBy ? { approvedBy } : {}) });
      return { ok: false, reason: "local_only" };
    }
    // Choice must match offered options — reject stale/mistyped operator input.
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
