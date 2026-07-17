import type { LogData, LogEntry, LogLevel } from "./types";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[getMinLevel()];
}

/**
 * Try to extract OTel trace context when @opentelemetry/api is available.
 * Returns undefined fields if the module is not installed or no active span.
 */
function getTraceContext(): { traceId?: string; spanId?: string } {
  try {
    // Dynamic require so this stays optional
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const otel =
      require("@opentelemetry/api") as typeof import("@opentelemetry/api");
    const span = otel.trace.getActiveSpan();
    if (span) {
      const ctx = span.spanContext();
      return { traceId: ctx.traceId, spanId: ctx.spanId };
    }
  } catch {
    // @opentelemetry/api not installed -- that's fine
  }
  return {};
}

function formatError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      error: err.message,
      stack: err.stack,
      ...(err.name !== "Error" && { errorType: err.name }),
    };
  }
  return { error: String(err) };
}

function writeEntry(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  switch (entry.level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "debug":
      console.debug(line);
      break;
    default:
      console.log(line);
  }
}

function emit(
  level: LogLevel,
  message: string,
  data: LogData | undefined,
  context: LogData,
): void {
  if (!shouldLog(level)) return;

  const trace = getTraceContext();
  const merged =
    Object.keys(context).length > 0 || data
      ? { ...context, ...data }
      : undefined;

  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(merged && Object.keys(merged).length > 0 && { data: merged }),
    ...(trace.traceId && { traceId: trace.traceId }),
    ...(trace.spanId && { spanId: trace.spanId }),
  };

  writeEntry(entry);
}

export interface Logger {
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  warn(message: string, data?: LogData): void;
  error(message: string, data?: LogData | Error): void;
  child(bindings: LogData): Logger;
}

function createLogger(context: LogData = {}): Logger {
  return {
    debug(message: string, data?: LogData) {
      emit("debug", message, data, context);
    },
    info(message: string, data?: LogData) {
      emit("info", message, data, context);
    },
    warn(message: string, data?: LogData) {
      emit("warn", message, data, context);
    },
    error(message: string, data?: LogData | Error) {
      if (data instanceof Error) {
        emit("error", message, formatError(data), context);
      } else {
        emit("error", message, data, context);
      }
    },
    child(bindings: LogData): Logger {
      return createLogger({ ...context, ...bindings });
    },
  };
}

/** Root logger instance. Use `log.child({ ... })` to bind context. */
export const log: Logger = createLogger();

export { createLogger };
