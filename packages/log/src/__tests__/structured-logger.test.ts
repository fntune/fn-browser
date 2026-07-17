import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StructuredLogger, setTelemetryCapture } from "../structured-logger";

describe("StructuredLogger", () => {
  let logSpy: any;
  let errorSpy: any;
  let warnSpy: any;
  let debugSpy: any;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:30:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  it("includes nodeId and projectId in output", () => {
    const logger = new StructuredLogger("node-1", "proj-1");
    logger.info("test.event", "hello");

    expect(logSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      level: "info",
      message: "hello",
      eventType: "test.event",
      nodeId: "node-1",
      projectId: "proj-1",
      timestamp: "2024-01-15T10:30:00.000Z",
    });
  });

  it("works without projectId", () => {
    const logger = new StructuredLogger("node-2");
    logger.info("test.event", "no project");

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.nodeId).toBe("node-2");
    expect(output.projectId).toBeUndefined();
  });

  it("logger.info outputs correct format via console.log", () => {
    const logger = new StructuredLogger("node-1", "proj-1");
    logger.info("deploy", "deploying", { region: "us-east-1" });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.level).toBe("info");
    expect(output.eventType).toBe("deploy");
    expect(output.data).toMatchObject({ region: "us-east-1" });
  });

  it("logger.warn outputs via console.warn", () => {
    const logger = new StructuredLogger("node-1", "proj-1");
    logger.warn("rate.limit", "approaching limit");

    expect(warnSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(output.level).toBe("warn");
    expect(output.eventType).toBe("rate.limit");
  });

  it("logger.error outputs via console.error", () => {
    const logger = new StructuredLogger("node-1", "proj-1");
    logger.error("crash", "process crashed", { exitCode: 1 });

    expect(errorSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(output.level).toBe("error");
    expect(output.data).toMatchObject({ exitCode: 1 });
  });

  it("logger.debug outputs via console.debug when LOG_LEVEL=debug", () => {
    process.env.LOG_LEVEL = "debug";
    const logger = new StructuredLogger("node-1", "proj-1");
    logger.debug("trace", "tracing");

    expect(debugSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(debugSpy.mock.calls[0][0] as string);
    expect(output.level).toBe("debug");
  });

  describe("level filtering", () => {
    it("filters debug when LOG_LEVEL=info", () => {
      process.env.LOG_LEVEL = "info";
      const logger = new StructuredLogger("node-1", "proj-1");
      logger.debug("evt", "should not appear");

      expect(debugSpy).not.toHaveBeenCalled();
    });

    it("filters debug and info when LOG_LEVEL=warn", () => {
      process.env.LOG_LEVEL = "warn";
      const logger = new StructuredLogger("node-1", "proj-1");

      logger.debug("evt", "d");
      logger.info("evt", "i");
      logger.warn("evt", "w");
      logger.error("evt", "e");

      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it("filters everything except error when LOG_LEVEL=error", () => {
      process.env.LOG_LEVEL = "error";
      const logger = new StructuredLogger("node-1", "proj-1");

      logger.debug("evt", "d");
      logger.info("evt", "i");
      logger.warn("evt", "w");
      logger.error("evt", "e");

      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it("allows all levels when LOG_LEVEL=debug", () => {
      process.env.LOG_LEVEL = "debug";
      const logger = new StructuredLogger("node-1", "proj-1");

      logger.debug("evt", "d");
      logger.info("evt", "i");
      logger.warn("evt", "w");
      logger.error("evt", "e");

      expect(debugSpy).toHaveBeenCalledOnce();
      expect(logSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledOnce();
    });
  });

  it("omits data field when context is empty", () => {
    const logger = new StructuredLogger("node-1", "proj-1");
    logger.info("evt", "no context");

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.data).toBeUndefined();
  });

  it("keeps __telemetry as capture control metadata", () => {
    const capture = vi.fn();
    setTelemetryCapture(capture);

    try {
      const logger = new StructuredLogger("node-1", "proj-1");
      logger.info("fallback.event", "captured", {
        action: "send",
        __telemetry: {
          eventName: "custom.event",
          distinctId: "user-1",
          groups: { tenant: 42 },
        },
      });

      expect(capture).toHaveBeenCalledOnce();
      const payload = capture.mock.calls[0][0];
      expect(payload).toMatchObject({
        event: "custom.event",
        distinctId: "user-1",
        groups: { tenant: "42" },
      });
      expect(payload.properties).toMatchObject({
        level: "info",
        nodeId: "node-1",
        projectId: "proj-1",
        message: "captured",
        action: "send",
      });
      expect(payload.properties).not.toHaveProperty("__telemetry");
    } finally {
      setTelemetryCapture(null);
    }
  });
});
