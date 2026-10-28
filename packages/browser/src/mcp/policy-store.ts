/**
 * In-memory HITL policy: the global override and consent prompts.
 */

import type { HitlMode, SessionId } from "../cdp/types.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TransportBridge } from "./index.js";

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

const DEFAULT_CONSENT_TIMEOUT_MS = 10 * 60 * 1000;

export class PolicyStore {
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

  /**
   * Test-only: reset all in-memory state.
   */
  __reset(): void {
    this.globalPolicy = null;
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
}
