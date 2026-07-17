export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
}

export type LogData = Record<string, unknown>;
