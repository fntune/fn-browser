/** Persist screenshots to disk; debug artifact, safe to delete. */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ensuredDirs = new Set<string>();

// Per-process seq + random suffix — avoid same-ms filename collisions.
let screenshotSeq = 0;

function getRoot(): string {
  const home = process.env.HOME ?? homedir(); // HOME first — os.homedir() ignores it on macOS
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
