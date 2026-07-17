import { isReplaySafeTool } from "./tool-catalog.js";

export interface BrowserProxyOptions {
  /** Primary fn-browser URL, e.g. "http://localhost:7722" */
  primaryUrl: string;
  /** Optional fallback URL for failover, e.g. "https://fn-browser.tail-xxx.ts.net" */
  fallbackUrl?: string;
  /** Bearer token for the primary (if FN_BROWSER_AUTH_TOKENS is set on that daemon) */
  primaryToken?: string;
  /** Bearer token for the fallback daemon */
  fallbackToken?: string;
  /** Per-backend attempt timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum retained affinity entries. Safety locks are never evicted. */
  maxAffinityEntries?: number;
}

export type BrowserProxyHandler = (request: Request) => Promise<Response>;

type BackendName = "primary" | "fallback";
type BackendAffinity = BackendName | "fallback_pending" | "primary_locked";

interface Backend {
  name: BackendName;
  url: string;
  token?: string;
}

type FetchAttempt =
  | { ok: true; response: Response; shouldFailover: boolean }
  | { ok: false; error: unknown; failure: "cancelled" | "timeout" | "unreachable" };

type RuntimeEnv = {
  env?: Record<string, string | undefined>;
};

interface RequestRouting {
  replaySafe: boolean;
  sessionId?: string;
}

const DEFAULT_TIMEOUT_MS = 65_000;
const DEFAULT_MAX_AFFINITY_ENTRIES = 10_000;

export function browserProxyOptionsFromEnv(): BrowserProxyOptions | null {
  const primaryUrl = env("FN_BROWSER_PROXY_PRIMARY_URL");
  if (!primaryUrl) return null;

  const fallbackUrl = env("FN_BROWSER_PROXY_FALLBACK_URL");
  const primaryToken = env("FN_BROWSER_PROXY_PRIMARY_TOKEN");
  const fallbackToken = env("FN_BROWSER_PROXY_FALLBACK_TOKEN");
  const timeoutMs = positiveInteger(env("FN_BROWSER_PROXY_TIMEOUT_MS"));

  return {
    primaryUrl,
    ...(fallbackUrl ? { fallbackUrl } : {}),
    ...(primaryToken ? { primaryToken } : {}),
    ...(fallbackToken ? { fallbackToken } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

export function createBrowserProxy(opts: BrowserProxyOptions): BrowserProxyHandler {
  const affinity = new Map<string, BackendAffinity>();
  let failoverDisabledByLockCapacity = false;
  // Per-session routing lock (tail-chained promises), so concurrent calls for
  // one session can't race a backend flip and split across machines.
  const routingLocks = new Map<string, Promise<unknown>>();
  // Native-host permits several legitimate browser operations to run up to 60s.
  // The 65s default is a floor: keep the proxy attempt timeout above that
  // ceiling so a slow but valid operation is not aborted and replayed against a
  // different Chrome instance.
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxAffinityEntries =
    opts.maxAffinityEntries !== undefined && opts.maxAffinityEntries >= 0
      ? Math.floor(opts.maxAffinityEntries)
      : DEFAULT_MAX_AFFINITY_ENTRIES;
  const primary: Backend = {
    name: "primary",
    url: opts.primaryUrl,
    ...(opts.primaryToken ? { token: opts.primaryToken } : {}),
  };
  const fallback: Backend | null = opts.fallbackUrl
    ? {
        name: "fallback",
        url: opts.fallbackUrl,
        ...(opts.fallbackToken ? { token: opts.fallbackToken } : {}),
      }
    : null;

  const route = async (
    request: Request,
    sessionId: string | undefined,
    replaySafe: boolean,
  ): Promise<Response> => {
    const assigned = sessionId ? readAffinity(affinity, sessionId) : undefined;
    if (request.signal.aborted) {
      return responseFromAttempt(
        cancelledAttempt(request.signal.reason),
        assigned === "fallback" ? "fallback" : "primary",
      );
    }

    if (assigned === "fallback" && fallback) {
      const attempt = await fetchBackend(request, fallback, false, timeoutMs);
      return responseFromAttempt(attempt, fallback.name);
    }
    if (assigned === "primary_locked" || assigned === "fallback_pending") {
      const attempt = await fetchBackend(request, primary, false, timeoutMs);
      return responseFromAttempt(attempt, primary.name);
    }
    if (sessionId && failoverDisabledByLockCapacity) {
      const attempt = await fetchBackend(request, primary, false, timeoutMs);
      return responseFromAttempt(attempt, primary.name);
    }

    const fallbackRequest =
      replaySafe && fallback && (assigned === undefined || assigned === "primary")
        ? request.clone()
        : null;
    const primaryAttempt = await fetchBackend(request, primary, replaySafe, timeoutMs);

    // Caller cancellation is terminal for this proxy request. In particular, a
    // replay-safe primary cancellation must not turn into a fallback dispatch.
    if (!primaryAttempt.ok && primaryAttempt.failure === "cancelled") {
      return responseFromAttempt(primaryAttempt, primary.name);
    }

    // A timeout, lost response, or extension disconnect does not prove whether
    // a state-changing browser command ran. Never replay such a request against
    // another machine: return the primary outcome and let the caller reconcile.
    if (!replaySafe) {
      if (sessionId) {
        const backend = (await mutationOutcomeIsAmbiguous(primaryAttempt))
          ? "primary_locked"
          : "primary";
        const recorded = writeAffinity(affinity, sessionId, backend, maxAffinityEntries);
        if (!recorded) {
          // SHORTCUT: without a session-end signal or persistent lock store,
          // exhausting the bounded map must disable new failover until restart.
          // Upgrade by clearing durable locks on explicit session lifecycle events.
          failoverDisabledByLockCapacity = true;
        }
      }
      return responseFromAttempt(primaryAttempt, primary.name);
    }

    if (primaryAttempt.ok && !primaryAttempt.shouldFailover) {
      if (
        sessionId &&
        !writeAffinity(affinity, sessionId, "primary", maxAffinityEntries)
      ) {
        failoverDisabledByLockCapacity = true;
      }
      return responseFromAttempt(primaryAttempt, primary.name);
    }

    if (!fallback || !fallbackRequest) {
      return responseFromAttempt(primaryAttempt, primary.name);
    }

    // Reserve the bounded affinity slot before dispatching to fallback. Without
    // this non-evictable placeholder, another session could fill the map while
    // the fallback request is in flight and leave this session unable to pin.
    if (
      sessionId &&
      !writeAffinity(affinity, sessionId, "fallback_pending", maxAffinityEntries)
    ) {
      failoverDisabledByLockCapacity = true;
      return responseFromAttempt(primaryAttempt, primary.name);
    }

    // We are about to return the fallback's response, so the primary's response
    // is discarded. Release its body: a 5xx failover never read it (the status
    // check short-circuits before the body), and an un-consumed fetch body pins
    // its socket in the keep-alive pool — a slow connection leak under sustained
    // failover. (For the extension_unreachable path the body was already drained
    // by the clone-and-inspect, so this cancel is a harmless no-op.)
    const fallbackAttempt = await fetchBackend(fallbackRequest, fallback, true, timeoutMs);
    const usableFallback =
      fallbackAttempt.ok &&
      fallbackAttempt.response.ok &&
      !fallbackAttempt.shouldFailover;
    if (sessionId) {
      if (usableFallback) {
        if (!writeAffinity(affinity, sessionId, "fallback", maxAffinityEntries)) {
          failoverDisabledByLockCapacity = true;
          if (fallbackAttempt.ok) void fallbackAttempt.response.body?.cancel().catch(() => {});
          return responseFromAttempt(primaryAttempt, primary.name);
        }
      } else {
        releaseFallbackReservation(affinity, sessionId, assigned, maxAffinityEntries);
      }
    }
    if (primaryAttempt.ok) void primaryAttempt.response.body?.cancel().catch(() => {});
    return responseFromAttempt(fallbackAttempt, fallback.name);
  };

  return async (request: Request): Promise<Response> => {
    const { sessionId, replaySafe } = await inspectRequest(request);
    // A request with no session id can't be pinned, so there's nothing to keep
    // consistent — route it directly.
    if (!sessionId) return route(request, undefined, replaySafe);
    // A fallback-pinned session is terminal-sticky: route() never re-attempts
    // primary for it and never rewrites its affinity, so its backend can't flip
    // and concurrent calls can't split. Skip the lock so post-failover traffic
    // (the steady state on the VM) runs concurrently — no head-of-line stall.
    // (Peek without the LRU touch; correctness still rests on the lock below,
    // which re-reads affinity for any not-yet-fallback session.)
    if (affinity.get(sessionId) === "fallback") {
      // Refresh the LRU entry on every active fallback request. Otherwise a hot
      // fallback session can be evicted by newer sessions and drift to primary.
      readAffinity(affinity, sessionId);
      return route(request, sessionId, replaySafe);
    }
    // Otherwise the call can attempt primary and fail over, flipping the
    // session's backend. Serialize these per session: two concurrent calls
    // racing that flip could otherwise land on different machines, splitting one
    // session across two Chromes (and duplicating mutating actions). The lock
    // keeps route+failover+affinity-write atomic; queued calls re-read the (now
    // pinned) affinity and follow it. Different sessions stay fully concurrent.
    // SHORTCUT: concurrent same-session calls still serialize while the session
    // is unpinned or pinned-primary (head-of-line latency, bounded by the
    // per-attempt timeout per queued call). Acceptable — the single-agent path
    // issues calls sequentially, and once failed over the fast path above frees
    // them. Fully lifting it for pinned-primary would reintroduce the split when
    // primary flaps, so the lock stays on the transition-capable path.
    return runSessionExclusive(routingLocks, sessionId, async () => {
      if (request.signal.aborted) {
        return responseFromAttempt(cancelledAttempt(request.signal.reason), "primary");
      }
      return route(request, sessionId, replaySafe);
    });
  };
}

async function inspectRequest(request: Request): Promise<RequestRouting> {
  const headerSessionId = nonEmpty(request.headers.get("X-Session-Id"));
  if (request.method === "GET" || request.method === "HEAD") {
    return { replaySafe: true, ...(headerSessionId ? { sessionId: headerSessionId } : {}) };
  }
  if (request.method !== "POST") {
    return { replaySafe: false, ...(headerSessionId ? { sessionId: headerSessionId } : {}) };
  }

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return { replaySafe: false, ...(headerSessionId ? { sessionId: headerSessionId } : {}) };
  }
  if (!isRecord(body) || typeof body.method !== "string") {
    return { replaySafe: false, ...(headerSessionId ? { sessionId: headerSessionId } : {}) };
  }
  if (body.method === "initialize" || body.method === "tools/list") {
    return { replaySafe: true, ...(headerSessionId ? { sessionId: headerSessionId } : {}) };
  }
  if (body.method !== "tools/call" || !isRecord(body.params)) {
    return { replaySafe: false, ...(headerSessionId ? { sessionId: headerSessionId } : {}) };
  }

  const args = isRecord(body.params.arguments) ? body.params.arguments : undefined;
  const argumentSessionId = args ? nonEmpty(args.sessionId) : undefined;
  const sessionId = headerSessionId ?? argumentSessionId;
  return {
    replaySafe:
      typeof body.params.name === "string" && isReplaySafeTool(body.params.name),
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * Per-key serialization via a tail-chained promise map (mirrors the CDP
 * withTabMutex pattern) scoped to a single proxy instance — no module-global
 * state. Each call chains onto the prior call for the same key and swaps itself
 * in as the new tail; a failed call does not block the next.
 */
async function runSessionExclusive<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release: (value: T) => void;
  let fail: (reason: unknown) => void;
  const next = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  next.catch(() => undefined);
  locks.set(key, next);

  try {
    await prev;
  } catch {
    // A prior call's failure must not block subsequent calls for the same key.
  }

  try {
    const result = await fn();
    release!(result);
    return result;
  } catch (err) {
    fail!(err);
    throw err;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

async function fetchBackend(
  request: Request,
  backend: Backend,
  inspectFailoverBody: boolean,
  timeoutMs: number,
): Promise<FetchAttempt> {
  if (request.signal.aborted) return cancelledAttempt(request.signal.reason);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let callerCancelled = false;
  let resolveCancellation!: (attempt: FetchAttempt) => void;
  const cancellationAttempt = new Promise<FetchAttempt>((resolve) => {
    resolveCancellation = resolve;
  });
  const cancelFromCaller = (): void => {
    if (callerCancelled) return;
    callerCancelled = true;
    resolveCancellation(cancelledAttempt(request.signal.reason));
    controller.abort();
  };
  request.signal.addEventListener("abort", cancelFromCaller, { once: true });
  // Close the registration race before invoking fetch.
  if (request.signal.aborted) cancelFromCaller();
  if (callerCancelled) {
    request.signal.removeEventListener("abort", cancelFromCaller);
    return cancelledAttempt(request.signal.reason);
  }

  const timeoutAttempt = new Promise<FetchAttempt>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({
        ok: false,
        error: new DOMException(`${backend.name} fn-browser backend timed out.`, "AbortError"),
        failure: "timeout",
      });
      controller.abort();
    }, timeoutMs);
  });

  const fetchAttempt = (async (): Promise<FetchAttempt> => {
    try {
      const response = await fetch(
        targetUrl(backend.url, request.url),
        requestInit(request, backend, controller.signal),
      );
      return {
        ok: true,
        response,
        shouldFailover: inspectFailoverBody ? await shouldFailover(response) : false,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        error,
        failure: callerCancelled
          ? "cancelled"
          : timedOut || isAbortError(error)
            ? "timeout"
            : "unreachable",
      };
    }
  })();

  try {
    return await Promise.race([fetchAttempt, timeoutAttempt, cancellationAttempt]);
  } finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", cancelFromCaller);
  }
}

function requestInit(
  request: Request,
  backend: Backend,
  signal: AbortSignal,
): RequestInit & { duplex?: "half" } {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  if (backend.token) headers.set("authorization", `Bearer ${backend.token}`);

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal,
  };

  if (request.body && request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  return init;
}

async function shouldFailover(response: Response): Promise<boolean> {
  if (response.status >= 500) return true;
  return responseHasFailoverSignal(response);
}

async function responseHasFailoverSignal(response: Response): Promise<boolean> {
  const body = await jsonBody(response);
  if (body === null) return false;
  if (isDaemonTimeoutEnvelope(body)) return true;

  const code = toolErrorCode(body);
  return code === "extension_unreachable" || code === "cdp_timeout";
}

async function mutationOutcomeIsAmbiguous(attempt: FetchAttempt): Promise<boolean> {
  if (!attempt.ok) return true;
  if (attempt.response.status >= 500) return true;

  const body = await jsonBody(attempt.response);
  if (body === null) return false;
  if (isDaemonTimeoutEnvelope(body)) return true;
  const code = toolErrorCode(body);
  return code === "extension_unreachable" || code === "cdp_timeout";
}

async function jsonBody(response: Response): Promise<unknown | null> {
  const contentType = response.headers.get("content-type");
  if (!contentType?.toLowerCase().includes("application/json")) return null;

  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

function isDaemonTimeoutEnvelope(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.error)) return false;
  return value.error.code === -32000 && value.error.message === "request timed out";
}

function toolErrorCode(value: unknown): string | null {
  const text = firstMcpText(value);
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  return errorCode(parsed);
}

function firstMcpText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const result = value.result;
  if (!isRecord(result)) return null;
  const content = result.content;
  if (!Array.isArray(content)) return null;
  const first = content[0];
  if (!isRecord(first) || typeof first.text !== "string") return null;
  return first.text;
}

function errorCode(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const error = value.error;
  if (!isRecord(error) || typeof error.code !== "string") return null;
  return error.code;
}

function responseFromAttempt(attempt: FetchAttempt, backend: BackendName): Response {
  if (attempt.ok) return responseWithBackend(attempt.response, backend);

  const cancelled = attempt.failure === "cancelled";
  const timeout = attempt.failure === "timeout";
  return responseWithBackend(
    Response.json(
      {
        error: {
          code: timeout
            ? "browser_proxy_backend_timeout"
            : cancelled
              ? "browser_proxy_request_cancelled"
              : "browser_proxy_backend_unreachable",
          message: cancelled
            ? "The caller cancelled the fn-browser proxy request."
            : timeout
              ? `${backend} fn-browser backend timed out.`
              : `${backend} fn-browser backend is unreachable.`,
        },
      },
      { status: cancelled ? 499 : timeout ? 504 : 502 },
    ),
    backend,
  );
}

function cancelledAttempt(reason: unknown): FetchAttempt {
  return {
    ok: false,
    error: reason ?? new DOMException("The caller cancelled the request.", "AbortError"),
    failure: "cancelled",
  };
}

function responseWithBackend(response: Response, backend: BackendName): Response {
  const next = new Response(response.body, response);
  next.headers.set("X-FN-Browser-Backend", backend);
  return next;
}

function readAffinity(
  affinity: Map<string, BackendAffinity>,
  sessionId: string,
): BackendAffinity | undefined {
  const backend = affinity.get(sessionId);
  if (!backend) return undefined;
  affinity.delete(sessionId);
  affinity.set(sessionId, backend);
  return backend;
}

function writeAffinity(
  affinity: Map<string, BackendAffinity>,
  sessionId: string,
  backend: BackendAffinity,
  maxEntries: number,
): boolean {
  affinity.delete(sessionId);

  if (maxEntries <= 0) return false;

  while (affinity.size >= maxEntries) {
    const oldest = oldestEvictableAffinity(affinity);
    if (oldest === undefined) return false;
    affinity.delete(oldest);
  }

  affinity.set(sessionId, backend);
  return true;
}

function oldestEvictableAffinity(
  affinity: Map<string, BackendAffinity>,
): string | undefined {
  for (const [sessionId, backend] of affinity) {
    if (backend !== "primary_locked" && backend !== "fallback_pending") return sessionId;
  }
  return undefined;
}

function releaseFallbackReservation(
  affinity: Map<string, BackendAffinity>,
  sessionId: string,
  previous: BackendAffinity | undefined,
  maxEntries: number,
): void {
  if (affinity.get(sessionId) !== "fallback_pending") return;
  affinity.delete(sessionId);
  if (previous === "primary") {
    writeAffinity(affinity, sessionId, previous, maxEntries);
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (isRecord(error) && error.name === "AbortError")
  );
}

function targetUrl(baseUrl: string, requestUrl: string): string {
  const base = new URL(baseUrl);
  const request = new URL(requestUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  base.pathname = `${basePath === "" ? "" : basePath}${request.pathname}`;
  base.search = request.search;
  base.hash = "";
  return base.href;
}

function env(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: RuntimeEnv;
    Bun?: RuntimeEnv;
  };
  return runtime.process?.env?.[name] ?? runtime.Bun?.env?.[name];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
