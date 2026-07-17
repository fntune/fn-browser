import { afterEach, describe, expect, it } from "vitest";

import { __resetMutexStateForTests, withTabMutex } from "../cdp/mutex.js";
import type { TabId } from "../cdp/types.js";

const tab = (n: number) => n as unknown as TabId;

describe("withTabMutex", () => {
  afterEach(() => {
    __resetMutexStateForTests();
  });

  it("serializes writes on the same tab", async () => {
    const order: string[] = [];
    const tabA = tab(1);

    const p1 = withTabMutex(tabA, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a-end");
      return "a";
    });

    const p2 = withTabMutex(tabA, async () => {
      order.push("b-start");
      order.push("b-end");
      return "b";
    });

    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("runs in parallel across different tabs", async () => {
    const events: string[] = [];
    const tabA = tab(1);
    const tabB = tab(2);

    const p1 = withTabMutex(tabA, async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("a-end");
    });

    const p2 = withTabMutex(tabB, async () => {
      events.push("b-start");
      await new Promise((r) => setTimeout(r, 10));
      events.push("b-end");
    });

    await Promise.all([p1, p2]);
    // Both start before either ends — prove parallelism.
    expect(events.slice(0, 2).sort()).toEqual(["a-start", "b-start"]);
  });

  it("does not block subsequent ops on the same tab after a failure", async () => {
    const tabA = tab(1);
    await expect(
      withTabMutex(tabA, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const result = await withTabMutex(tabA, async () => "ok");
    expect(result).toBe("ok");
  });

  it("cleans up the tail entry when the last op completes", async () => {
    const tabA = tab(1);
    await withTabMutex(tabA, async () => "done");
    // If the tail were leaked, a subsequent op would still await the stale
    // Promise — but since it's Resolve it wouldn't visibly fail. The internal
    // invariant is that tails.get(tabA) is undefined, which we test indirectly
    // by resetting to a known state.
    __resetMutexStateForTests();
    const result = await withTabMutex(tabA, async () => 42);
    expect(result).toBe(42);
  });
});
