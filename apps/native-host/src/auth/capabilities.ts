/** Capability tiers for the network surface — reachability is not authorization. */

export type Capability =
  | "sessions.read"
  | "sessions.manage"
  | "tabs.read"
  | "tabs.create"
  | "page.read"
  | "page.act"
  | "files.upload"
  | "js.evaluate"
  | "policy.write"
  | "consent.approve";

export type CapabilityTier = "read" | "act" | "admin";

const READ_CAPS: readonly Capability[] = [
  "sessions.read",
  // Self-scoped session lifecycle; ownership guard blocks cross-principal use.
  "sessions.manage",
  "tabs.read",
  "page.read",
];

const ACT_CAPS: readonly Capability[] = [
  ...READ_CAPS,
  "tabs.create",
  "page.act",
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

/** Tool → capability map; privileged writes split out for non-admin withholding. */
const TOOL_CAPABILITY: Record<string, Capability> = {
  // sessions
  start: "sessions.manage",
  end: "sessions.manage",
  info: "sessions.read",
  list_sessions: "sessions.read",
  list_browsers: "sessions.read",
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
  // prompts the user — not read tier
  require_consent: "page.act",
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

/** Arg-scoped tier rules, enforced at dispatch. */
export function argScopedTierAllows(
  toolName: string,
  args: Record<string, unknown>,
  tier: CapabilityTier,
): boolean {
  if (toolName === "list_tabs" && args?.scope === "all" && tier !== "admin") {
    return false;
  }
  // Read tier may end (leave) but not close tabs.
  if (toolName === "end" && args?.on_tabs === "close" && tier === "read") {
    return false;
  }
  return true;
}
