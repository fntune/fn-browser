import { describe, expect, it } from "vitest";

import { isLoopbackBind } from "../daemon/bind.js";

describe("isLoopbackBind", () => {
  it("accepts loopback IP literals and localhost", () => {
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("127.5.5.5")).toBe(true);
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("[::1]")).toBe(true);
    expect(isLoopbackBind("localhost")).toBe(true);
    expect(isLoopbackBind("LOCALHOST")).toBe(true);
  });

  it("rejects crafted hostnames and all-interfaces binds", () => {
    expect(isLoopbackBind("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackBind("127.example")).toBe(false);
    expect(isLoopbackBind("evil127.0.0.1")).toBe(false);
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
    expect(isLoopbackBind("::")).toBe(false);
    expect(isLoopbackBind("10.0.0.1")).toBe(false);
    expect(isLoopbackBind("127.0.0.256")).toBe(false);
  });
});
