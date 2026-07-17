/**
 * Local-only observability sink: one JSONL file per MCP run under
 * `~/.fn-browser/runs/YYYY-MM-DD/<runId>.jsonl`. Each tool call produces two
 * entries (`phase: "start"` + `phase: "end"`) so we can reconstruct timing
 * and ordering post-hoc with `jq`. Zero new deps.
 *
 * Mirrors every entry to @fntune/log so it also surfaces in the service-worker
 * console alongside the rest of the host's structured logs. The on-disk file
 * is the durable record; stderr is the live feed.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@fntune/log";

const log = createLogger({ pkg: "native-host", module: "observability" });

function getRootDir(): string {
  // Honour HOME env override for tests; fall back to OS homedir when unset.
  // On macOS, os.homedir() uses getpwuid() and ignores HOME, so the env var
  // check has to come first.
  const home = process.env.HOME ?? homedir();
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

// What a caller hands to `append()` — the same shape minus the run/session
// fields the RunLog stamps on every entry. Typed as a union (not
// Omit<RunEvent>) because TS doesn't narrow discriminated unions through Omit.
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

/**
 * Summarise an object so we never write megabytes of base64 screenshot or
 * HTML into a trace file. Truncates long strings, drops suspicious large
 * buffers, preserves arrays/objects recursively up to a reasonable depth.
 */
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
      // Observability must never break a live tool call. Log the failure and
      // swallow it — the call itself is not affected.
      log.warn("run_log write failed", {
        runId: this.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Mirror to @fntune/log for stderr visibility. Omit args/result from the
    // stderr copy since the JSONL file is authoritative and stderr is noisy.
    if (event.phase === "start") {
      log.info("tool.start", { runId: this.runId, tool: event.tool });
    } else {
      log.info("tool.end", {
        runId: this.runId,
        tool: event.tool,
        ok: event.ok,
        durationMs: event.durationMs,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      });
    }
  }
}

export function getRunLogRoot(): string {
  return getRootDir();
}
