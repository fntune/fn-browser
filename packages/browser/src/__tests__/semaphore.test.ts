import { describe, expect, it } from "vitest";

import { Semaphore } from "../cdp/semaphore.js";

describe("Semaphore", () => {
  it("rejects an invalid permit count", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it("never lets more than N holders run at once", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;

    const task = async (): Promise<void> => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      release();
    };

    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(sem.available).toBe(2);
    expect(sem.pending).toBe(0);
  });

  it("hands a freed permit to the next FIFO waiter", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const r0 = await sem.acquire(); // holds the only permit

    const a = sem.acquire().then((rel) => {
      order.push(1);
      rel();
    });
    const b = sem.acquire().then((rel) => {
      order.push(2);
      rel();
    });

    expect(sem.pending).toBe(2);
    r0(); // release → waiter a runs, then b
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]);
  });

  it("release is idempotent — double release does not leak a permit", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release(); // no-op
    expect(sem.available).toBe(1);
  });
});
