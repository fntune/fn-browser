/**
 * Capability model for the daemon's network surface.
 *
 * Network membership (a reachable client, later a tailnet peer) is NOT
 * authorization to drive a browser. Every caller authenticates to a Principal
 * carrying a set of capabilities; each tool/route requires one. Browser control
 * is too powerful to gate on reachability alone (open risk #2).
 *
 * Three tiers expand to capability sets. `evaluate_js` (arbitrary page JS) and
 * `upload_file` (reads bytes off the host disk) are privileged: only `admin`
 * holds them, so they are OFF by default for remote `read`/`act` callers.
 */

export type Capability =
  | "sessions.read"
  | "sessions.manage"
  | "tabs.read"
  | "tabs.create"
  | "page.read"
  | "page.act"
  | "files.upload"
  | "js.evaluate"
  | "meta"
  | "ratelimit"
  | "policy.write"
  | "consent.approve"
  | "flows.run";

export type CapabilityTier = "read" | "act" | "admin";

const READ_CAPS: readonly Capability[] = [
  "sessions.read",
  // Manage your OWN session lifecycle (start + end). Cross-principal access is
  // blocked by the session-ownership guard, so this is self-scoped; read tokens
  // need it to open a session AND to clean it up (no unbounded accumulation).
  "sessions.manage",
  "tabs.read",
  "page.read",
  "meta",
];

const ACT_CAPS: readonly Capability[] = [
  ...READ_CAPS,
  "tabs.create",
  "page.act",
  "flows.run",
  // rate_limit_check/consume mutate shared quota state (seed/increment a
  // counter), so a read-only token must not reach them (quota poisoning).
  "ratelimit",
];

const ADMIN_CAPS: readonly Capability[] = [
  ...ACT_CAPS,
  "files.upload",
  "js.evaluate",
  "policy.write",
  "consent.approve",
];

export const TIER_CAPABILITIES: Record<CapabilityTier, ReadonlySet<Capability>> = {
  read: new Set(READ_CAPS),
  act: new Set(ACT_CAPS),
  admin: new Set(ADMIN_CAPS),
};

export function isCapabilityTier(value: string): value is CapabilityTier {
  return value === "read" || value === "act" || value === "admin";
}

/**
 * A caller. `id` is a non-secret label used for audit (never the token).
 */
export interface Principal {
  id: string;
  tier: CapabilityTier;
  capabilities: ReadonlySet<Capability>;
}

/** Hono context env: middleware attaches the authenticated principal. */
export interface AppEnv {
  Variables: { principal: Principal };
}

/**
 * The capability a tool requires. Mirrors tool-catalog permission classes but
 * splits the privileged writes (`upload_file`, `evaluate_js`) into their own
 * capabilities so they can be withheld from non-admin callers.
 */
const TOOL_CAPABILITY: Record<string, Capability> = {
  // sessions — start/end manage your OWN session (read-tier; ownership guard
  // blocks cross-principal); info/list are reads.
  start: "sessions.manage",
  end: "sessions.manage",
  info: "sessions.read",
  list_sessions: "sessions.read",
  // tabs
  list_tabs: "tabs.read",
  create_tab: "tabs.create",
  adopt_tab: "tabs.create",
  // page reads
  read_page: "page.read",
  get_page_text: "page.read",
  screenshot: "page.read",
  find: "page.read",
  observe: "page.read",
  read_console: "page.read",
  read_network: "page.read",
  // page acts
  navigate: "page.act",
  click: "page.act",
  fill_form: "page.act",
  // privileged
  upload_file: "files.upload",
  evaluate_js: "js.evaluate",
  // flows
  run_flow: "flows.run",
  // rate limits mutate shared quota state — act+ only
  rate_limit_check: "ratelimit",
  rate_limit_consume: "ratelimit",
  // require_consent enqueues operator/side-panel prompts and require_tos_acceptance
  // mutates the shared ToS-accepted set — both must stay out of the read tier
  // (a read token shouldn't spam the operator or mutate state).
  require_consent: "page.act",
  require_tos_acceptance: "page.act",
  // check_activity_window is a pure read — safe for read tier.
  check_activity_window: "meta",
};

export function requiredCapabilityForTool(name: string): Capability | undefined {
  return TOOL_CAPABILITY[name];
}

export interface AuthorizationResult {
  allowed: boolean;
  /** The capability that was required, when known. */
  required?: Capability;
}

/**
 * Decide whether a principal may invoke a tool. Unknown tools are denied (no
 * mapped capability → fail closed). The required capability is always returned
 * for audit/diagnostics.
 */
export function authorizeTool(principal: Principal, toolName: string): AuthorizationResult {
  const required = requiredCapabilityForTool(toolName);
  if (!required) return { allowed: false };
  return { allowed: principal.capabilities.has(required), required };
}

/**
 * Some calls need a higher tier based on their ARGUMENTS, not just the tool's
 * base capability. `list_tabs scope:"all"` enumerates tabs across every session
 * (other principals' tabs) and is admin-only. This lives here so the rule is
 * applied uniformly — both at the JSON-RPC dispatch AND for inner run_flow node
 * calls, which re-enter through the per-tool `authorize` hook and never touch
 * the dispatch layer. Returns false when the (tool, args) pair exceeds the tier.
 */
export function argScopedTierAllows(
  toolName: string,
  args: Record<string, unknown>,
  tier: CapabilityTier,
): boolean {
  if (toolName === "list_tabs" && args?.scope === "all" && tier !== "admin") {
    return false;
  }
  // `end on_tabs:"close"` closes tabs — a destructive browser-state change, not
  // observation. The read tier may dissolve its own session group (default
  // "leave") but must not close tabs (e.g. of a shared-principal act session).
  if (toolName === "end" && args?.on_tabs === "close" && tier === "read") {
    return false;
  }
  return true;
}
