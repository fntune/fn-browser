/**
 * Transport selection config.
 *
 * Three outcomes, in priority order:
 *  - **ws**   — an explicit `fnDaemonUrl` is provisioned (chrome.storage.managed
 *               wins over .local). Used for a remote/tailnet daemon, or to force
 *               a specific endpoint. Committed to without probing.
 *  - **shim** — `fnDaemonUrl` is set but EMPTY (an admin/policy clearing it):
 *               force the native-messaging shim, skipping auto-detect.
 *  - **auto** — nothing configured: probe loopback for a live `fn-browserd`
 *               (`detectLocalDaemon`) and use the WS path if one answers, else
 *               the shim. This makes "daemon running ⇒ used" zero-config.
 *
 * Exactly one transport is constructed per SW boot either way (the 7722
 * shim-vs-daemon collision guard), since auto resolves to ws OR shim before
 * anything connects.
 */

/** Storage keys the install policy / side panel writes. */
export const DAEMON_URL_KEY = "fnDaemonUrl";
export const EXTENSION_TOKEN_KEY = "fnExtensionToken";

/** Default loopback daemon endpoints (used by auto-detect). */
export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 7722;
export const DEFAULT_DAEMON_WS_URL = `ws://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}/ws/extension`;
const DEFAULT_DAEMON_PROBE_URL = `http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}/ws/extension`;
const PROBE_TIMEOUT_MS = 1500;

export type TransportConfig =
  | { mode: "auto" }
  | { mode: "shim" }
  | { mode: "ws"; url: string; token: string };

export interface DaemonConfigSnapshot {
  mode: TransportConfig["mode"];
  url: string;
  hasToken: boolean;
}

/** Panel-facing view of a resolved config: mode + url, plus WHETHER a token is
 * set — never the token value itself (the panel must not receive the secret). */
export function daemonConfigSnapshot(cfg: TransportConfig): DaemonConfigSnapshot {
  return {
    mode: cfg.mode,
    url: cfg.mode === "ws" ? cfg.url : "",
    hasToken: cfg.mode === "ws" && cfg.token.length > 0,
  };
}

type StorageArea = Pick<chrome.storage.StorageArea, "get">;

async function read(area: StorageArea | undefined): Promise<Record<string, unknown>> {
  if (!area) return {};
  try {
    return (await area.get([DAEMON_URL_KEY, EXTENSION_TOKEN_KEY])) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Resolve the configured transport. `local`/`managed` are injectable for tests;
 * default to chrome.storage.local / chrome.storage.managed.
 */
export async function resolveTransportConfig(
  local?: StorageArea,
  managed?: StorageArea,
): Promise<TransportConfig> {
  const hasChrome = typeof chrome !== "undefined";
  const localArea = local ?? (hasChrome ? chrome.storage.local : undefined);
  const managedArea = managed ?? (hasChrome ? chrome.storage.managed : undefined);

  const [m, l] = await Promise.all([read(managedArea), read(localArea)]);
  // Managed policy wins per key; only fall through to local when managed doesn't
  // set the key at all (so a managed empty value can clear a stale local one).
  const pick = (key: string): string => (key in m ? str(m[key]) : str(l[key]));
  const url = pick(DAEMON_URL_KEY);
  if (url) return { mode: "ws", url, token: pick(EXTENSION_TOKEN_KEY) };
  // No usable URL. Distinguish an EXPLICIT empty value (set anywhere → force the
  // shim, an admin disabling the WS path) from nothing configured (→ auto).
  const urlSet = DAEMON_URL_KEY in m || DAEMON_URL_KEY in l;
  return urlSet ? { mode: "shim" } : { mode: "auto" };
}

/**
 * Probe loopback for a live `fn-browserd`. GET `/ws/extension` — a DAEMON-only
 * route: the daemon's upgrade gate answers **426** (gate passed, not a WS
 * upgrade) or **403** (origin/token rejected) for a plain GET; the native-
 * messaging shim has no such route and **404**s; nothing-listening refuses fast.
 * So a 426/403 response ⇒ a daemon is up. Returns the WS URL to dial, or `null`
 * ⇒ use the shim.
 */
export async function detectLocalDaemon(
  fetchImpl: typeof fetch = fetch,
  probeUrl: string = DEFAULT_DAEMON_PROBE_URL,
  wsUrl: string = DEFAULT_DAEMON_WS_URL,
): Promise<string | null> {
  try {
    const res = await fetchImpl(probeUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.status === 426 || res.status === 403 ? wsUrl : null;
  } catch {
    return null; // refused / timeout / network error ⇒ no daemon, use the shim
  }
}
