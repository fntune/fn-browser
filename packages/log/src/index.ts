/**
 * @fn-browser/log - Structured JSON logger with OpenTelemetry support
 */

export { log, createLogger } from "./logger";
export type { Logger } from "./logger";
export { StructuredLogger, setTelemetryCapture } from "./structured-logger";
export type { LogEventType } from "./structured-logger";
export type { LogLevel, LogEntry, LogData } from "./types";
