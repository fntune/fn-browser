/**
 * Persist base64 screenshot bytes to disk and return a path the caller can
 * reference without dragging the base64 through Claude's conversation
 * context. Default storage: `~/.fn-browser/screenshots/YYYY-MM-DD/<id>.png`.
 *
 * This sits under `observability/` because screenshots are a debug artifact,
 * not production state. Users can `rm -rf ~/.fn-browser/screenshots` safely.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ensuredDirs = new Set<string>();

// Monotonic per-process counter guarantees uniqueness for same-millisecond
// writes from this host; the random suffix guards against cross-process
// collisions (a second host, or a wrapped run).
let screenshotSeq = 0;

function getRoot(): string {
  // Honour HOME env override for tests; fall back to OS homedir when unset.
  // On macOS, os.homedir() uses getpwuid() and ignores HOME, so the env var
  // check has to come first.
  const home = process.env.HOME ?? homedir();
  return join(home, ".fn-browser", "screenshots");
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function ensureDir(path: string): Promise<void> {
  if (ensuredDirs.has(path)) return;
  await mkdir(path, { recursive: true });
  ensuredDirs.add(path);
}

export interface SavedScreenshot {
  path: string;
  fileUrl: string;
  bytes: number;
}

export interface SaveScreenshotContext {
  runId?: string;
  tabId?: number;
}

export async function saveScreenshot(
  base64Data: string,
  ctx: SaveScreenshotContext = {},
): Promise<SavedScreenshot> {
  const now = new Date();
  const dir = join(getRoot(), dayStamp(now));
  await ensureDir(dir);

  // Filename: <ms timestamp>_<tabId?>_<runId suffix>_<unique>.png — sortable by
  // time, inspectable at a glance. The unique token prevents two captures in the
  // same millisecond (same tab, same run) from silently overwriting each other.
  const runSuffix =
    ctx.runId && ctx.runId.length > 8
      ? ctx.runId.slice(0, 8)
      : ctx.runId ?? "anon";
  const tabPart = ctx.tabId !== undefined ? `_t${ctx.tabId}` : "";
  const unique = `${(screenshotSeq++).toString(36)}${crypto.randomUUID().slice(0, 8)}`;
  const filename = `${now.getTime()}${tabPart}_${runSuffix}_${unique}.png`;
  const path = join(dir, filename);

  const buffer = Buffer.from(base64Data, "base64");
  await writeFile(path, buffer);

  return {
    path,
    fileUrl: `file://${path}`,
    bytes: buffer.byteLength,
  };
}

export function getScreenshotRoot(): string {
  return getRoot();
}
