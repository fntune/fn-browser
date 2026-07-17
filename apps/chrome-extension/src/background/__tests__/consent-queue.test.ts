import { describe, expect, it } from "vitest";

import { consentQueue } from "../consent-queue.js";

describe("ConsentQueue.rejectAll", () => {
  it("rejects all pending consents (so callers fail fast on a link drop)", async () => {
    const p1 = consentQueue.request({ title: "a", body: "b" });
    const p2 = consentQueue.request({ title: "c", body: "d" });
    expect(consentQueue.listPending()).toHaveLength(2);

    consentQueue.rejectAll("host transport disconnected: closed");

    await expect(p1).rejects.toThrow(/host transport disconnected/);
    await expect(p2).rejects.toThrow(/host transport disconnected/);
    expect(consentQueue.listPending()).toHaveLength(0);
  });

  it("is a no-op when nothing is pending", () => {
    expect(() => consentQueue.rejectAll("x")).not.toThrow();
  });
});
