# @fn-browser/log

Structured JSON logger with OpenTelemetry support for consistent, observable logging across your application.

## Installation

```bash
bun add @fn-browser/log
```

## Key Exports

- `log` - Default structured logger instance
- `StructuredLogger` - Logger class for custom instances
- `LogLevel`, `LogEntry`, `LogData` - Types

## Usage Examples

### Basic Logging

```typescript
import { log } from "@fn-browser/log";

// Different log levels
log.info("User signed up", { userId: "123", email: "user@example.com" });
log.warn("Rate limit approaching", { userId: "123", remaining: 10 });
log.error("Payment failed", { userId: "123", error: err.message });
log.debug("Processing webhook", { payload: webhookData });
```

### Custom Logger Instance

```typescript
import { StructuredLogger } from "@fn-browser/log";

const logger = new StructuredLogger({
  service: "payment-service",
  level: process.env.LOG_LEVEL || "info",
  defaultMeta: { environment: process.env.NODE_ENV },
});

// All logs will include service and environment
logger.info("Payment processed", { amount: 100, currency: "USD" });
// Output: {"timestamp":"2024-...","level":"info","message":"Payment processed","service":"payment-service","environment":"production","amount":100,"currency":"USD"}
```

### OpenTelemetry Integration

```typescript
import { log } from "@fn-browser/log";
import { trace } from "@opentelemetry/api";

// Logger automatically picks up trace context
const tracer = trace.getTracer("my-service");

await tracer.startActiveSpan("process-order", async (span) => {
  // This log will automatically include trace_id and span_id
  log.info("Processing order", { orderId: "123" });
  span.end();
});
```

## Dependencies

### Regular

- `@fn-browser/utils` - Core utilities

### Optional

- `@opentelemetry/api` - OpenTelemetry integration

### Dev

- `tsup`, `typescript`, `vitest`
