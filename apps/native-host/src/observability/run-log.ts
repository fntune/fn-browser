/** Per-run JSONL tool trace under ~/.fn-browser/runs/. */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function getRootDir(): string {
  const home = process.env.HOME ?? homedir(); // HOME first — os.homedir() ignores it on macOS
  return join(home, ".fn-browser", "runs");
}
const ensuredDirs = new Set<string>();

export type RunPhase = "start" | "end";

export interface RunEventBase {
  runId: string;
  sessionId?: string;
  tool: string;
  phase: RunPhase;
  at: string;
}

export interface RunStartEvent extends RunEventBase {
  phase: "start";
  args: unknown;
}

export interface RunEndEvent extends RunEventBase {
  phase: "end";
  ok: boolean;
  durationMs: number;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export type RunEvent = RunStartEvent | RunEndEvent;

// What callers pass to append() — run/session fields stamped by RunLog.
export type RunEventInput =
  | Omit<RunStartEvent, "runId" | "sessionId">
  | Omit<RunEndEvent, "runId" | "sessionId">;

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function ensureDir(path: string): Promise<void> {
  if (ensuredDirs.has(path)) return;
  await mkdir(path, { recursive: true });
  ensuredDirs.add(path);
}

/** Truncate large values before writing to trace files. */
const MAX_STRING_CHARS = 512;
const MAX_DEPTH = 6;

export function summarize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[truncated:depth]";
  if (typeof value === "string") {
    if (value.startsWith("data:")) {
      return `[data-url:${value.length}b]`;
    }
    return value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}…[+${value.length - MAX_STRING_CHARS}]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((entry) => summarize(entry, depth + 1))
      .concat(value.length > 20 ? [`[+${value.length - 20} more]`] : []);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = summarize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export class RunLog {
  constructor(
    private readonly runId: string,
    private readonly sessionId?: string,
  ) {}

  static newRunId(): string {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    return g.crypto?.randomUUID?.() ?? `run_${Date.now().toString(36)}`;
  }

  async append(event: RunEventInput): Promise<void> {
    const now = new Date();
    const entry: RunEvent = {
      runId: this.runId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...event,
    } as RunEvent;

    const dir = join(getRootDir(), dayStamp(now));
    const file = join(dir, `${this.runId}.jsonl`);

    try {
      await ensureDir(dir);
      await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      // Observability must not break tool calls.
      console.error(
        `[run-log] write failed for ${this.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Mirror to stderr without args/result (JSONL is authoritative).
    if (event.phase === "start") {
      console.error(`[run-log] ${this.runId} ${event.tool} start`);
    } else {
      const status = event.ok ? "ok" : `error${event.errorCode ? ` ${event.errorCode}` : ""}`;
      console.error(`[run-log] ${this.runId} ${event.tool} ${status} ${event.durationMs}ms`);
    }
  }
}

export function getRunLogRoot(): string {
  return getRootDir();
}
