/**
 * Global test setup: redirect HOME to a tmp dir so observability side effects
 * (RunLog JSONL files, screenshot PNGs) never leak into the developer's real
 * ~/.fn-browser tree during tests. Cleaned up in afterAll.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

const originalHome = process.env.HOME;
let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "fn-host-tests-"));
  process.env.HOME = tmpHome;
});

afterAll(() => {
  process.env.HOME = originalHome;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
