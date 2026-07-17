import type { LogData, LogEntry, LogLevel } from "./types";

export type LogEventType = string;

interface StructuredLogEntry extends LogEntry {
  eventType: LogEventType;
  nodeId?: string;
  projectId?: string;
}

type TelemetryCaptureFn = (opts: {
  event: string;
  properties: Record<string, unknown>;
  distinctId: string;
  groups?: Record<string, string>;
}) => void;

let externalCaptureFn: TelemetryCaptureFn | null = null;

/** Set an external telemetry capture function (e.g., PostHog). */
export function setTelemetryCapture(fn: TelemetryCaptureFn | null): void {
  externalCaptureFn = fn;
}

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

function writeEntry(entry: StructuredLogEntry): void {
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

function buildTelemetryProperties(context: LogData): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (key === "__telemetry") continue;
    properties[key] = value;
  }
  return properties;
}

export class StructuredLogger {
  private readonly nodeId: string;
  private readonly projectId?: string;

  constructor(nodeId: string, projectId?: string) {
    this.nodeId = nodeId;
    this.projectId = projectId;
  }

  log(
    level: LogLevel,
    eventType: LogEventType,
    message: string,
    context?: LogData,
  ): void {
    if (!shouldLog(level)) return;

    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      eventType,
      nodeId: this.nodeId,
      projectId: this.projectId,
      ...(context && Object.keys(context).length > 0 && { data: context }),
    };

    writeEntry(entry);
    this.emitTelemetry(level, eventType, message, context);
  }

  debug(eventType: LogEventType, message: string, context?: LogData): void {
    this.log("debug", eventType, message, context);
  }

  info(eventType: LogEventType, message: string, context?: LogData): void {
    this.log("info", eventType, message, context);
  }

  warn(eventType: LogEventType, message: string, context?: LogData): void {
    this.log("warn", eventType, message, context);
  }

  error(eventType: LogEventType, message: string, context?: LogData): void {
    this.log("error", eventType, message, context);
  }

  private emitTelemetry(
    level: LogLevel,
    eventType: LogEventType,
    message: string,
    context?: LogData,
  ): void {
    if (!externalCaptureFn || !context) return;

    try {
      const telemetry = context.__telemetry as
        | Record<string, unknown>
        | undefined;
      if (!telemetry || typeof telemetry !== "object") return;

      const eventName = String(telemetry.eventName || eventType);
      const distinctId = String(
        telemetry.distinctId || this.projectId || "system",
      );
      const rawGroups = telemetry.groups as
        | Record<string, string | number | boolean>
        | undefined;
      const normalizedGroups = rawGroups
        ? Object.fromEntries(
            Object.entries(rawGroups).map(([key, value]) => [
              key,
              String(value),
            ]),
          )
        : undefined;

      externalCaptureFn({
        event: eventName,
        properties: {
          level,
          nodeId: this.nodeId,
          projectId: this.projectId,
          message,
          ...buildTelemetryProperties(context),
        },
        distinctId,
        ...(normalizedGroups ? { groups: normalizedGroups } : {}),
      });
    } catch {
      // Never throw from logging path
    }
  }
}
