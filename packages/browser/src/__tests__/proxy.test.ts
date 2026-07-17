import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type BrowserProxyHandler,
  browserProxyOptionsFromEnv,
  createBrowserProxy,
} from "../mcp/proxy.js";

function invoke(handler: BrowserProxyHandler, path: string, init: RequestInit): Promise<Response> {
  return handler(new Request(`http://localhost${path}`, init));
}

type FetchCall = {
  url: string;
  authorization: string | null;
};

const primaryUrl = "http://primary.test";
const fallbackUrl = "http://fallback.test";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createBrowserProxy", () => {
  it("routes primary success and keeps the session on primary", async () => {
    const calls: FetchCall[] = [];
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push(fetchCall(input, init));
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({
      primaryUrl,
      fallbackUrl,
      primaryToken: "primary-token",
    });

    await invoke(app, "/mcp/browser", request("s1"));
    await invoke(app, "/mcp/browser", request("s1"));

    expect(calls).toEqual([
      { url: `${primaryUrl}/mcp/browser`, authorization: "Bearer primary-token" },
      { url: `${primaryUrl}/mcp/browser`, authorization: "Bearer primary-token" },
    ]);
  });

  it("fails over on primary extension_unreachable and keeps the session on fallback", async () => {
    const calls: FetchCall[] = [];
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const call = fetchCall(input, init);
        calls.push(call);
        if (call.url.startsWith(primaryUrl)) return extensionUnreachableResponse();
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: "fallback" } });
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({
      primaryUrl,
      fallbackUrl,
      fallbackToken: "fallback-token",
    });

    const first = await invoke(app, "/mcp/browser", request("s2"));
    expect(await first.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: "fallback" } });

    await invoke(app, "/mcp/browser", request("s2"));

    expect(calls).toEqual([
      { url: `${primaryUrl}/mcp/browser`, authorization: null },
      { url: `${fallbackUrl}/mcp/browser`, authorization: "Bearer fallback-token" },
      { url: `${fallbackUrl}/mcp/browser`, authorization: "Bearer fallback-token" },
    ]);
  });

  it("fails over a replay-safe read when the primary reports cdp_timeout", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = fetchCall(input, init);
        calls.push(call);
        return call.url.startsWith(primaryUrl)
          ? cdpTimeoutResponse()
          : jsonResponse({ ok: "fallback" });
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    const response = await invoke(app, "/mcp/browser", request("cdp-timeout"));

    expect(response.headers.get("X-FN-Browser-Backend")).toBe("fallback");
    expect(await response.json()).toEqual({ ok: "fallback" });
    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
    ]);
  });

  it("keeps argument-only session affinity after failover", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = fetchCall(input, init);
        calls.push(call);
        if (call.url.startsWith(primaryUrl)) return extensionUnreachableResponse();
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: "fallback" } });
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    await invoke(app, "/mcp/browser", argumentRequest("argument-session"));
    await invoke(app, "/mcp/browser", argumentRequest("argument-session"));

    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
    ]);
  });

  it("does not replay a mutating tool after primary extension_unreachable", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(fetchCall(input, init));
        return extensionUnreachableResponse();
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    const res = await invoke(
      app,
      "/mcp/browser",
      request("unsafe-disconnect", "click"),
    );

    expect(res.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
    ]);

    const read = await invoke(
      app,
      "/mcp/browser",
      request("unsafe-disconnect", "read_page"),
    );
    expect(read.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
      `${primaryUrl}/mcp/browser`,
    ]);
  });

  it("lets safe reads fail over after a successful primary mutation", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = fetchCall(input, init);
        calls.push(call);
        if (calls.length === 1) {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } });
        }
        if (call.url.startsWith(primaryUrl)) return extensionUnreachableResponse();
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: "fallback" } });
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    const mutation = await invoke(app, "/mcp/browser", request("successful-mutation", "click"));
    const read = await invoke(app, "/mcp/browser", request("successful-mutation", "read_page"));

    expect(mutation.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(read.headers.get("X-FN-Browser-Backend")).toBe("fallback");
    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
      `${primaryUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
    ]);
  });

  it("uses fallback directly for a session already assigned to fallback", async () => {
    const calls: FetchCall[] = [];
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const call = fetchCall(input, init);
        calls.push(call);
        if (calls.length === 1) return extensionUnreachableResponse();
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    await invoke(app, "/mcp/browser", request("sticky"));
    await invoke(app, "/mcp/browser", request("sticky"));
    await invoke(app, "/mcp/browser", request("sticky"));

    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
    ]);
  });

  it("does not pin a session when fallback rejects authentication", async () => {
    const calls: FetchCall[] = [];
    let primaryAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = fetchCall(input, init);
        calls.push(call);
        if (call.url.startsWith(primaryUrl)) {
          primaryAttempts++;
          return primaryAttempts === 1
            ? extensionUnreachableResponse()
            : jsonResponse({ ok: "primary-recovered" });
        }
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    const failed = await invoke(app, "/mcp/browser", request("fallback-auth"));
    const recovered = await invoke(app, "/mcp/browser", request("fallback-auth"));

    expect(failed.status).toBe(401);
    expect(recovered.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
      `${primaryUrl}/mcp/browser`,
    ]);
  });

  it("returns the primary error response when no fallback is configured", async () => {
    const calls: FetchCall[] = [];
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push(fetchCall(input, init));
        return jsonResponse({ error: "primary failed" }, { status: 503 });
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl });

    const res = await invoke(app, "/mcp/browser", request("s3"));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "primary failed" });
    expect(calls.map((call) => call.url)).toEqual([`${primaryUrl}/mcp/browser`]);
  });

  it("tries fallback once when primary returns 500", async () => {
    const calls: FetchCall[] = [];
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const call = fetchCall(input, init);
        calls.push(call);
        if (call.url.startsWith(primaryUrl)) return jsonResponse({ error: "down" }, { status: 500 });
        return jsonResponse({ ok: "fallback" });
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    const res = await invoke(app, "/mcp/browser?x=1", request("s4"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: "fallback" });
    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser?x=1`,
      `${fallbackUrl}/mcp/browser?x=1`,
    ]);
  });

  it("fails over a safe call when the daemon returns its JSON-RPC timeout envelope", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = fetchCall(input, init);
        calls.push(call);
        if (call.url.startsWith(primaryUrl)) return daemonTimeoutResponse();
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: "fallback" } });
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    const res = await invoke(app, "/mcp/browser", request("daemon-timeout"));

    expect(res.headers.get("X-FN-Browser-Backend")).toBe("fallback");
    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
    ]);
  });

  it("fails over when the primary attempt times out", async () => {
    vi.useFakeTimers();
    const calls: FetchCall[] = [];
    const mockFetch = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const call = fetchCall(input, init);
        calls.push(call);
        if (call.url.startsWith(primaryUrl)) return responseWhenAborted(init);
        return Promise.resolve(jsonResponse({ ok: "fallback" }));
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl, fallbackUrl, timeoutMs: 25 });

    const responsePromise = invoke(app, "/mcp/browser", request("timeout-failover"));
    await vi.advanceTimersByTimeAsync(25);
    const res = await responsePromise;

    expect(res.status).toBe(200);
    expect(res.headers.get("X-FN-Browser-Backend")).toBe("fallback");
    expect(await res.json()).toEqual({ ok: "fallback" });
    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
    ]);
  });

  it("does not replay a mutating tool after a primary timeout", async () => {
    vi.useFakeTimers();
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(fetchCall(input, init));
        return responseWhenAborted(init);
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl, timeoutMs: 25 });

    const responsePromise = invoke(
      app,
      "/mcp/browser",
      request("unsafe-timeout", "fill_form"),
    );
    await vi.advanceTimersByTimeAsync(25);
    const res = await responsePromise;

    expect(res.status).toBe(504);
    expect(res.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
    ]);
  });

  it("returns a 504 when the primary attempt times out without fallback", async () => {
    vi.useFakeTimers();
    const calls: FetchCall[] = [];
    const mockFetch = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push(fetchCall(input, init));
        return responseWhenAborted(init);
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl, timeoutMs: 25 });

    const responsePromise = invoke(app, "/mcp/browser", request("timeout-no-fallback"));
    await vi.advanceTimersByTimeAsync(25);
    const res = await responsePromise;

    expect(res.status).toBe(504);
    expect(res.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(await res.json()).toEqual({
      error: {
        code: "browser_proxy_backend_timeout",
        message: "primary fn-browser backend timed out.",
      },
    });
    expect(calls.map((call) => call.url)).toEqual([`${primaryUrl}/mcp/browser`]);
  });

  it("passes primary event streams through without failover body inspection", async () => {
    const calls: FetchCall[] = [];
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const call = fetchCall(input, init);
        calls.push(call);
        if (call.url.startsWith(primaryUrl)) return eventStreamResponse("event: ready\n\n");
        return jsonResponse({ ok: "fallback" });
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    const res = await invoke(app, "/events", {
      method: "GET",
      headers: { "X-Session-Id": "sse" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(await firstBodyChunk(res)).toBe("event: ready\n\n");
    expect(calls.map((call) => call.url)).toEqual([`${primaryUrl}/events`]);
  });

  it("evicts the oldest sticky affinity entry when the cap is exceeded", async () => {
    const calls: FetchCall[] = [];
    const primaryFailures = new Set(["s1", "s2", "s3"]);
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const call = fetchCall(input, init);
        calls.push(call);
        const sessionId = new Headers(init?.headers).get("X-Session-Id");
        if (call.url.startsWith(primaryUrl) && sessionId && primaryFailures.delete(sessionId)) {
          return extensionUnreachableResponse();
        }
        return jsonResponse({
          ok: call.url.startsWith(primaryUrl) ? "primary" : "fallback",
        });
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl, fallbackUrl, maxAffinityEntries: 2 });

    await invoke(app, "/mcp/browser", request("s1"));
    await invoke(app, "/mcp/browser", request("s2"));
    await invoke(app, "/mcp/browser", request("s3"));
    const res = await invoke(app, "/mcp/browser", request("s1"));

    expect(await res.json()).toEqual({ ok: "primary" });
    expect(res.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(calls.map((call) => call.url)).toEqual([
      `${primaryUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
      `${primaryUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
      `${primaryUrl}/mcp/browser`,
      `${fallbackUrl}/mcp/browser`,
      `${primaryUrl}/mcp/browser`,
    ]);
  });

  it("preserves an ambiguous-mutation primary lock under affinity pressure", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = fetchCall(input, init);
        calls.push(call);
        const sessionId = new Headers(init?.headers).get("X-Session-Id");
        if (call.url.startsWith(primaryUrl) && sessionId === "locked") {
          return extensionUnreachableResponse();
        }
        return jsonResponse({ ok: call.url.startsWith(primaryUrl) ? "primary" : "fallback" });
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl, maxAffinityEntries: 1 });

    await invoke(app, "/mcp/browser", request("locked", "click"));
    await invoke(app, "/mcp/browser", request("other"));
    calls.length = 0;

    const response = await invoke(app, "/mcp/browser", request("locked"));

    expect(response.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(calls.map((call) => call.url)).toEqual([`${primaryUrl}/mcp/browser`]);
  });

  it("fails closed when ambiguous locks exhaust the affinity capacity", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = fetchCall(input, init);
        calls.push(call);
        return call.url.startsWith(primaryUrl)
          ? extensionUnreachableResponse()
          : jsonResponse({ ok: "fallback" });
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl, maxAffinityEntries: 1 });

    await invoke(app, "/mcp/browser", request("lock-a", "click"));
    await invoke(app, "/mcp/browser", request("lock-b", "click"));
    calls.length = 0;

    const response = await invoke(app, "/mcp/browser", request("lock-b"));

    expect(response.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(calls.map((call) => call.url)).toEqual([`${primaryUrl}/mcp/browser`]);
  });

  it("does not dispatch fallback when safety locks consume every affinity slot", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(fetchCall(input, init));
        return extensionUnreachableResponse();
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl, maxAffinityEntries: 1 });

    await invoke(app, "/mcp/browser", request("locked", "click"));
    calls.length = 0;

    const response = await invoke(app, "/mcp/browser", request("new-session"));

    expect(response.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(calls.map((call) => call.url)).toEqual([`${primaryUrl}/mcp/browser`]);
  });

  it("refreshes active fallback affinity before LRU eviction", async () => {
    const calls: FetchCall[] = [];
    const primaryFailures = new Set(["s1", "s2", "s3"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = fetchCall(input, init);
        calls.push(call);
        const sessionId = new Headers(init?.headers).get("X-Session-Id");
        if (call.url.startsWith(primaryUrl) && sessionId && primaryFailures.delete(sessionId)) {
          return extensionUnreachableResponse();
        }
        return jsonResponse({ ok: call.url.startsWith(primaryUrl) ? "primary" : "fallback" });
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl, maxAffinityEntries: 2 });

    await invoke(app, "/mcp/browser", request("s1"));
    await invoke(app, "/mcp/browser", request("s2"));
    await invoke(app, "/mcp/browser", request("s1")); // refresh s1
    await invoke(app, "/mcp/browser", request("s3")); // evicts s2
    calls.length = 0;

    const active = await invoke(app, "/mcp/browser", request("s1"));
    const evicted = await invoke(app, "/mcp/browser", request("s2"));

    expect(active.headers.get("X-FN-Browser-Backend")).toBe("fallback");
    expect(evicted.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(calls.map((call) => call.url)).toEqual([
      `${fallbackUrl}/mcp/browser`,
      `${primaryUrl}/mcp/browser`,
    ]);
  });

  it("sets the chosen backend response header on primary and fallback responses", async () => {
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const call = fetchCall(input, init);
        const sessionId = new Headers(init?.headers).get("X-Session-Id");
        if (call.url.startsWith(primaryUrl) && sessionId === "header-fallback") {
          return extensionUnreachableResponse();
        }
        return jsonResponse({
          ok: call.url.startsWith(primaryUrl) ? "primary" : "fallback",
        });
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    const primary = await invoke(app, "/mcp/browser", request("header-primary"));
    const fallback = await invoke(app, "/mcp/browser", request("header-fallback"));

    expect(primary.headers.get("X-FN-Browser-Backend")).toBe("primary");
    expect(await primary.json()).toEqual({ ok: "primary" });
    expect(fallback.headers.get("X-FN-Browser-Backend")).toBe("fallback");
    expect(await fallback.json()).toEqual({ ok: "fallback" });
  });

  it("serializes concurrent same-session calls so they cannot split across backends", async () => {
    let primaryAttempts = 0;
    const mockFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = urlFromInput(input);
      if (url.startsWith(primaryUrl)) {
        primaryAttempts++;
        // Defer so a second concurrent call would, without the lock, also reach
        // primary before the first writes affinity.
        await Promise.resolve();
        return extensionUnreachableResponse();
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: "fallback" } });
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    const [a, b] = await Promise.all([
      invoke(app, "/mcp/browser", request("concurrent")),
      invoke(app, "/mcp/browser", request("concurrent")),
    ]);

    // Both land on the SAME backend — the first call pins fallback, the second
    // (serialized behind it) re-reads affinity and follows. Without the lock the
    // two would race primary independently (primaryAttempts === 2) and could split.
    expect(a.headers.get("X-FN-Browser-Backend")).toBe("fallback");
    expect(b.headers.get("X-FN-Browser-Backend")).toBe("fallback");
    expect(primaryAttempts).toBe(1);
  });

  it("runs fallback-pinned calls concurrently (no head-of-line serialization)", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const gates: Array<() => void> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = urlFromInput(input);
      // Primary always fails so the first call pins the session to fallback.
      if (url.startsWith(primaryUrl)) return extensionUnreachableResponse();
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      // Hold the fallback call open until the test releases it, so we can observe
      // how many are in-flight at once.
      await new Promise<void>((resolve) => gates.push(resolve));
      inflight--;
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: "fallback" } });
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl, fallbackUrl });

    // 1) Pin to fallback: primary fails, fallback runs — release it to settle.
    const pin = invoke(app, "/mcp/browser", request("conc"));
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gates.shift()!();
    await pin;

    // 2) Two concurrent calls on the now fallback-pinned session. With the
    //    fast path both reach the fallback together (gates fills to 2); under a
    //    blanket per-session lock the second would never start until the first
    //    settled, so gates would stall at 1 and this waitFor would time out.
    const a = invoke(app, "/mcp/browser", request("conc"));
    const b = invoke(app, "/mcp/browser", request("conc"));
    await vi.waitFor(() => expect(gates.length).toBe(2));
    for (const release of gates.splice(0)) release();
    await Promise.all([a, b]);

    expect(maxInflight).toBe(2);
  });

  it("does not dispatch a request cancelled while waiting on the session lock", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(fetchCall(input, init));
        if (calls.length === 1) await firstGate;
        return jsonResponse({ ok: true });
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl });
    const first = invoke(app, "/mcp/browser", request("queued-cancel"));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const controller = new AbortController();
    const queued = invoke(
      app,
      "/mcp/browser",
      request("queued-cancel", "click", controller.signal),
    );
    controller.abort();
    releaseFirst();

    await first;
    const cancelled = await queued;
    expect(cancelled.status).toBe(499);
    expect(calls).toHaveLength(1);
  });

  it("aborts an in-flight backend fetch when the caller cancels", async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(fetchCall(input, init));
        return responseWhenAborted(init);
      }),
    );
    const app = createBrowserProxy({ primaryUrl, fallbackUrl });
    const controller = new AbortController();
    const pending = invoke(
      app,
      "/mcp/browser",
      request("inflight-cancel", "click", controller.signal),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    controller.abort();

    const cancelled = await pending;
    expect(cancelled.status).toBe(499);
    expect(await cancelled.json()).toMatchObject({
      error: { code: "browser_proxy_request_cancelled" },
    });
    expect(calls).toHaveLength(1);
  });

  it("cancels the discarded primary body when a 5xx fails over (no socket leak)", async () => {
    let primaryBodyCancelled = false;
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = urlFromInput(input);
        if (url.startsWith(primaryUrl)) {
          // A streaming 5xx body the proxy never reads (status short-circuits
          // failover before the body); its cancel() must fire when discarded.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("upstream error"));
            },
            cancel() {
              primaryBodyCancelled = true;
            },
          });
          return new Response(body, { status: 500 });
        }
        return jsonResponse({ ok: "fallback" });
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const app = createBrowserProxy({ primaryUrl, fallbackUrl });
    const res = await invoke(app, "/mcp/browser", request("leak-check"));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-FN-Browser-Backend")).toBe("fallback");
    expect(primaryBodyCancelled).toBe(true);
  });

  it("reads the proxy attempt timeout from the environment", () => {
    vi.stubEnv("FN_BROWSER_PROXY_PRIMARY_URL", primaryUrl);
    vi.stubEnv("FN_BROWSER_PROXY_TIMEOUT_MS", "1234");

    expect(browserProxyOptionsFromEnv()).toEqual({
      primaryUrl,
      timeoutMs: 1234,
    });
  });
});

function request(
  sessionId: string,
  toolName = "read_page",
  signal?: AbortSignal,
): RequestInit {
  return {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: {
      Authorization: "Bearer caller-token",
      "Content-Type": "application/json",
      "X-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: { tabId: 1 } },
    }),
  };
}

function argumentRequest(sessionId: string, toolName = "read_page"): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: "Bearer caller-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: { tabId: 1, sessionId } },
    }),
  };
}

function fetchCall(input: RequestInfo | URL, init?: RequestInit): FetchCall {
  return {
    url: urlFromInput(input),
    authorization: new Headers(init?.headers).get("authorization"),
  };
}

function urlFromInput(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function extensionUnreachableResponse(): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: { code: "extension_unreachable", message: "down" },
          }),
        },
      ],
      isError: true,
    },
  });
}

function cdpTimeoutResponse(): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: { code: "cdp_timeout", message: "Chrome did not respond in time." },
          }),
        },
      ],
      isError: true,
    },
  });
}

function daemonTimeoutResponse(): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000, message: "request timed out" },
  });
}

function responseWhenAborted(init?: RequestInit): Promise<Response> {
  return new Promise((resolve) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      resolve(jsonResponse({ aborted: true }));
      return;
    }
    signal.addEventListener("abort", () => resolve(jsonResponse({ aborted: true })), {
      once: true,
    });
  });
}

function eventStreamResponse(chunk: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function firstBodyChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response body is missing");
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}
