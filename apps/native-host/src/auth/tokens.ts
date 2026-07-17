/**
 * Parse `FN_BROWSER_AUTH_TOKENS` (`name:token:tier`, comma-separated).
 * Unset → empty (auth disabled). Set-but-malformed → throw (fail loud).
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

  // Set-but-empty must fail loud — operator may believe auth is on.
  if (entries.length === 0) {
    throw new Error("FN_BROWSER_AUTH_TOKENS is set but contains no valid entries");
  }

  // Duplicate names allowed (paired-token pattern); duplicate raw tokens rejected.
  // Error messages use index/name only — never echo the bearer secret.
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
 * Parse `FN_BROWSER_AUTH_SCOPE`: `all` (default) or `mcp` (/mcp/* only).
 * Set-but-unknown → throw.
 */
export type AuthScope = "all" | "mcp";

export function parseAuthScope(raw: string | undefined): AuthScope {
  if (!raw || raw.trim() === "") return "all";
  const scope = raw.trim().toLowerCase();
  if (scope === "all" || scope === "mcp") return scope;
  throw new Error(`FN_BROWSER_AUTH_SCOPE: unknown scope "${raw}" (expected all or mcp)`);
}

/** Parse `FN_BROWSER_IDENTITY_TIERS` (`login:tier`); split on last `:`. Malformed → throw. */
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
    // Duplicate login (incl. case variants) would make entry order pick the tier.
    if (table.has(login)) {
      throw new Error(`FN_BROWSER_IDENTITY_TIERS: duplicate login "${login}"`);
    }
    table.set(login, { id: login, tier, capabilities: TIER_CAPABILITIES[tier] });
  }

  return table;
}
