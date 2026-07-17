import { describe, expect, it } from "vitest";

import { CommandScheduler } from "../scheduler.js";
import type { ToolResult } from "@fntune/browser/mcp";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const OK: ToolResult = { ok: true, result: null };

describe("CommandScheduler", () => {
  it("caps in-flight commands at maxInFlight", async () => {
    const sched = new CommandScheduler({ maxInFlight: 2, maxQueueDepth: 100 });
    const gates = Array.from({ length: 5 }, () => deferred<ToolResult>());
    let active = 0;
    let peak = 0;
    const results = gates.map((g, i) =>
      sched.submit({ method: "read_page", tabId: i }, async () => {
        active++;
        peak = Math.max(peak, active);
        const r = await g.promise;
        active--;
        return r;
      }),
    );

    await tick();
    expect(sched.stats().inFlight).toBe(2);
    expect(peak).toBe(2);

    for (const g of gates) g.resolve(OK);
    await Promise.all(results);
    expect(peak).toBe(2);
    expect(sched.stats().dispatched).toBe(5);
  });

  it("serializes mutating ops on the same tab but parallelizes across tabs", async () => {
    const sched = new CommandScheduler({ maxInFlight: 10, maxQueueDepth: 100 });
    const g1 = deferred<ToolResult>();
    const g2 = deferred<ToolResult>();
    let tab5Active = 0;
    let tab5Peak = 0;
    const track = (g: Promise<ToolResult>) => async (): Promise<ToolResult> => {
      tab5Active++;
      tab5Peak = Math.max(tab5Peak, tab5Active);
      const r = await g;
      tab5Active--;
      return r;
    };

    const a = sched.submit({ method: "navigate", tabId: 5 }, track(g1.promise));
    const b = sched.submit({ method: "click", tabId: 5 }, track(g2.promise));
    let otherTabRan = false;
    const c = sched.submit({ method: "navigate", tabId: 6 }, async () => {
      otherTabRan = true;
      return OK;
    });

    await tick();
    expect(tab5Active).toBe(1); // only the first tab-5 op dispatched
    expect(otherTabRan).toBe(true); // tab 6 not blocked behind tab 5

    g1.resolve(OK);
    await a;
    await tick();
    expect(tab5Active).toBe(1); // the second tab-5 op runs only now

    g2.resolve(OK);
    await Promise.all([b, c]);
    expect(tab5Peak).toBe(1); // never two concurrent mutating ops on tab 5
  });

  it("serializes concurrent adopt_tab on the same tab", async () => {
    const sched = new CommandScheduler({ maxInFlight: 10, maxQueueDepth: 100 });
    const g1 = deferred<ToolResult>();
    const g2 = deferred<ToolResult>();
    let active = 0;
    let peak = 0;
    const run = (g: Promise<ToolResult>) => async (): Promise<ToolResult> => {
      active++;
      peak = Math.max(peak, active);
      const r = await g;
      active--;
      return r;
    };
    const a = sched.submit({ method: "adopt_tab", tabId: 5 }, run(g1.promise));
    const b = sched.submit({ method: "adopt_tab", tabId: 5 }, run(g2.promise));
    await tick();
    expect(active).toBe(1); // second adopt_tab waits on the per-tab lane
    g1.resolve(OK);
    await a;
    g2.resolve(OK);
    await b;
    expect(peak).toBe(1);
  });

  it("does not lane-block read-only ops behind a busy mutating tab", async () => {
    const sched = new CommandScheduler({ maxInFlight: 10, maxQueueDepth: 100 });
    const g = deferred<ToolResult>();
    sched.submit({ method: "navigate", tabId: 5 }, async () => g.promise); // holds tab 5
    let readRan = false;
    const read = sched.submit({ method: "read_page", tabId: 5 }, async () => {
      readRan = true;
      return OK;
    });
    await tick();
    expect(readRan).toBe(true); // read-only carries no per-tab lane
    g.resolve(OK);
    await read;
  });

  it("returns browser_busy when the queue is full", async () => {
    const sched = new CommandScheduler({ maxInFlight: 1, maxQueueDepth: 2, retryAfterMs: 99 });
    const g = deferred<ToolResult>();
    const inflight = sched.submit({ method: "read_page", tabId: 1 }, async () => g.promise);
    const q1 = sched.submit({ method: "read_page", tabId: 2 }, async () => OK);
    const q2 = sched.submit({ method: "read_page", tabId: 3 }, async () => OK);

    const busy = await sched.submit({ method: "read_page", tabId: 4 }, async () => OK);
    expect(busy.ok).toBe(false);
    if (!busy.ok) {
      expect(busy.error.code).toBe("browser_busy");
      expect((busy.error.details as { retryAfterMs: number }).retryAfterMs).toBe(99);
    }
    expect(sched.stats().rejected).toBe(1);

    g.resolve(OK);
    await Promise.all([inflight, q1, q2]);
  });

  it("bypasses admission for __internal_ control-plane commands", async () => {
    const sched = new CommandScheduler({ maxInFlight: 1, maxQueueDepth: 1 });
    const g = deferred<ToolResult>();
    const inflight = sched.submit({ method: "navigate", tabId: 1 }, async () => g.promise);
    sched.submit({ method: "read_page", tabId: 2 }, async () => OK); // fills the single queue slot

    // A normal command would be browser_busy here; an internal one bypasses.
    let consentRan = false;
    const consent = await sched.submit({ method: "__internal_request_consent", tabId: 1 }, async () => {
      consentRan = true;
      return { ok: true, result: { choice: "allow" } };
    });
    expect(consentRan).toBe(true);
    expect(consent.ok).toBe(true);

    g.resolve(OK);
    await inflight;
  });

  it("schedules non-consent internal commands (teardown does not jump the queue)", async () => {
    const sched = new CommandScheduler({ maxInFlight: 1, maxQueueDepth: 5 });
    const g = deferred<ToolResult>();
    sched.submit({ method: "navigate", tabId: 1 }, async () => g.promise); // holds the only slot
    let teardownRan = false;
    const teardown = sched.submit({ method: "__internal_end_session_group" }, async () => {
      teardownRan = true;
      return OK;
    });
    await tick();
    expect(teardownRan).toBe(false); // queued behind the in-flight op, not bypassed
    g.resolve(OK);
    await teardown;
    expect(teardownRan).toBe(true);
  });

  it("locks all the session's tabs during teardown (multi-tab lane)", async () => {
    const sched = new CommandScheduler({ maxInFlight: 10, maxQueueDepth: 100 });
    const teardownGate = deferred<ToolResult>();
    // Teardown locks tabs 5 and 6.
    const teardown = sched.submit(
      { method: "__internal_end_session_group", tabIds: [5, 6] },
      async () => teardownGate.promise,
    );
    let navRan = false;
    // A navigate on tab 6 must wait until teardown releases the lane.
    const nav = sched.submit({ method: "navigate", tabId: 6 }, async () => {
      navRan = true;
      return OK;
    });
    await tick();
    expect(navRan).toBe(false);
    teardownGate.resolve(OK);
    await teardown;
    await nav;
    expect(navRan).toBe(true);
  });

  it("surfaces a run rejection as a scheduler_error result", async () => {
    const sched = new CommandScheduler({ maxInFlight: 1, maxQueueDepth: 4 });
    const res = await sched.submit({ method: "navigate", tabId: 1 }, async () => {
      throw new Error("kaboom");
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("scheduler_error");
      expect(res.error.message).toMatch(/kaboom/);
    }
  });
});
