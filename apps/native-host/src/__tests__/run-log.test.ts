/**
 * Tests for the local-only RunLog sink. Uses a tmp directory by overriding
 * the HOME env var so we don't pollute the dev's real ~/.fn-browser/runs.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunLog, getRunLogRoot, summarize } from "../observability/run-log.js";

// HOME is redirected to a tmp dir by src/__tests__/setup.ts.

describe("RunLog", () => {
  it("writes two JSONL entries per tool call", async () => {
    const runId = "r_test_1";
    const log = new RunLog(runId, "sess_abc");
    await log.append({
      phase: "start",
      tool: "navigate",
      at: "2026-04-18T00:00:00Z",
      args: { url: "https://x.y" },
    });
    await log.append({
      phase: "end",
      tool: "navigate",
      at: "2026-04-18T00:00:00Z",
      ok: true,
      durationMs: 42,
      result: { status: "loaded" },
    });
    const day = new Date().toISOString().slice(0, 10);
    const path = join(getRunLogRoot(), day, `${runId}.jsonl`);
    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.phase).toBe("start");
    expect(first.runId).toBe(runId);
    expect(first.sessionId).toBe("sess_abc");
    expect(first.args).toEqual({ url: "https://x.y" });
    expect(second.phase).toBe("end");
    expect(second.ok).toBe(true);
    expect(second.durationMs).toBe(42);
  });

  it("summarize() truncates long strings, masks data URLs, caps arrays", () => {
    expect(summarize("data:image/png;base64,AAAA".padEnd(10_000, "A"))).toMatch(
      /^\[data-url:\d+b\]$/,
    );
    const big = "x".repeat(2000);
    expect(summarize(big)).toMatch(/^x{512}…\[\+1488\]$/);
    const arr = Array.from({ length: 30 }, (_, i) => i);
    const out = summarize(arr) as unknown[];
    expect(out.length).toBe(21);
    expect(out[20]).toBe("[+10 more]");
  });

  it("newRunId() returns a unique string", () => {
    const a = RunLog.newRunId();
    const b = RunLog.newRunId();
    expect(a).not.toBe(b);
    expect(typeof a).toBe("string");
  });
});
