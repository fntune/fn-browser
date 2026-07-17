import { describe, expect, it } from "vitest";

import { sanitizeRunId } from "../mcp-server.js";

describe("sanitizeRunId", () => {
  it("strips path-traversal and unsafe characters", () => {
    expect(sanitizeRunId("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeRunId("../escape")).toBe("escape");
    expect(sanitizeRunId("a/b\\c")).toBe("abc");
    expect(sanitizeRunId("run id with spaces")).toBe("runidwithspaces");
  });

  it("keeps a valid run id and caps length", () => {
    expect(sanitizeRunId("run_12-AB")).toBe("run_12-AB");
    expect(sanitizeRunId("x".repeat(200))).toHaveLength(64);
  });

  it("returns undefined for empty or all-unsafe input (caller generates one)", () => {
    expect(sanitizeRunId(undefined)).toBeUndefined();
    expect(sanitizeRunId("")).toBeUndefined();
    expect(sanitizeRunId("../../")).toBeUndefined();
  });
});
