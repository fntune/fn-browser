/**
 * Parse the daemon's bearer-token table from the environment.
 *
 * `FN_BROWSER_AUTH_TOKENS` is a comma-separated list of `name:token:tier`
 * entries, e.g. `ci-runner:s3cr3t:act,desktop:hunter2:admin`. `name` is a
 * non-secret audit label; `tier` is read|act|admin. Tokens must not contain a
 * colon (use url-safe base64 / hex).
 *
 * Unset → empty table → auth disabled (localhost-trust, current behavior).
 * Set-but-malformed → throw: a network server must never silently fall back to
 * "no auth" because its token config was wrong.
 */

import {
  isCapabilityTier,
  TIER_CAPABILITIES,
  type Principal,
} from "./capabilities.js";

export function parseAuthTokens(raw: string | undefined): Map<string, Principal> {
  const table = new Map<string, Principal>();
  if (!raw || raw.trim() === "") return table;

  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Set-but-empty (e.g. "," or ", ,") must fail loud, not silently disable auth —
  // an operator behind a reverse proxy could otherwise believe bearer auth is on
  // while the surface runs as local admin.
  if (entries.length === 0) {
    throw new Error("FN_BROWSER_AUTH_TOKENS is set but contains no valid entries");
  }

  // The `name` is `principal.id`. Two tokens sharing a name = the SAME principal
  // ON PURPOSE — that's the documented paired-token pattern (a read token rides
  // alongside an act/admin token of the same principal to observe its sessions).
  // So duplicate names are allowed; only a duplicate raw token (below) is a
  // config error.

  // Error messages reference the entry INDEX or name only — never the raw
  // `name:token:tier`, which would write the bearer secret into startup logs.
  entries.forEach((entry, i) => {
    const parts = entry.split(":");
    if (parts.length !== 3) {
      throw new Error(`FN_BROWSER_AUTH_TOKENS: malformed entry #${i + 1} (expected name:token:tier)`);
    }
    const [name, token, tier] = parts as [string, string, string];
    if (!name || !token) {
      throw new Error(`FN_BROWSER_AUTH_TOKENS: entry #${i + 1} has an empty name or token`);
    }
    if (!isCapabilityTier(tier)) {
      throw new Error(
        `FN_BROWSER_AUTH_TOKENS: entry "${name}" has unknown tier "${tier}" (expected read, act, or admin)`,
      );
    }
    if (table.has(token)) {
      throw new Error(`FN_BROWSER_AUTH_TOKENS: duplicate token for "${name}"`);
    }
    table.set(token, { id: name, tier, capabilities: TIER_CAPABILITIES[tier] });
  });

  return table;
}

/**
 * Parse `FN_BROWSER_AUTH_SCOPE`: which routes the bearer-token table gates.
 *
 * - `all` (default): every HTTP route requires auth — the network-exposed /
 *   tailnet posture, unchanged.
 * - `mcp`: only `/mcp/*` requires the bearer token; the side-panel control
 *   routes (`/sessions`, `/rate-limits`, `/global-policy`, `/consents`,
 *   `/events`, `/health`) keep loopback trust + CORS/CSRF. This is the local
 *   single-user posture: it stops any local process from driving the browser
 *   through the MCP surface without asking the panel (which by design never
 *   holds secrets) to authenticate. Only valid on a loopback bind — the app
 *   factory enforces that.
 *
 * Set-but-unknown → throw (same fail-loud rule as the token table).
 */
export type AuthScope = "all" | "mcp";

export function parseAuthScope(raw: string | undefined): AuthScope {
  if (!raw || raw.trim() === "") return "all";
  const scope = raw.trim().toLowerCase();
  if (scope === "all" || scope === "mcp") return scope;
  throw new Error(`FN_BROWSER_AUTH_SCOPE: unknown scope "${raw}" (expected all or mcp)`);
}

/**
 * Parse the tailnet identity→tier table from `FN_BROWSER_IDENTITY_TIERS`, a
 * comma-separated list of `login:tier` (e.g. `alice@example.com:admin`). The
 * login is keyed lower-cased; the principal id is the login (audit identity).
 * Only consulted when the daemon trusts a verified identity header injected by
 * the tsnet sidecar / `tailscale serve` (see createAuthMiddleware).
 *
 * Tiers are read|act|admin. Logins commonly contain `@` but no `:`, so we split
 * on the LAST colon (the tier). Malformed entries throw — same fail-loud rule.
 */
export function parseIdentityTiers(raw: string | undefined): Map<string, Principal> {
  const table = new Map<string, Principal>();
  if (!raw || raw.trim() === "") return table;

  for (const entry of raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    const idx = entry.lastIndexOf(":");
    if (idx <= 0 || idx === entry.length - 1) {
      throw new Error(`FN_BROWSER_IDENTITY_TIERS: malformed entry "${entry}" (expected login:tier)`);
    }
    const login = entry.slice(0, idx).toLowerCase();
    const tier = entry.slice(idx + 1);
    if (!isCapabilityTier(tier)) {
      throw new Error(
        `FN_BROWSER_IDENTITY_TIERS: entry "${entry}" has unknown tier "${tier}" (expected read, act, or admin)`,
      );
    }
    // Authorization config — a duplicate login (incl. case variants) would let
    // entry order silently decide the tier. Reject it (matches parseAuthTokens).
    if (table.has(login)) {
      throw new Error(`FN_BROWSER_IDENTITY_TIERS: duplicate login "${login}"`);
    }
    table.set(login, { id: login, tier, capabilities: TIER_CAPABILITIES[tier] });
  }

  return table;
}
