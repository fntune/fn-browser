import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../logger";

describe("logger", () => {
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

  it("log.info outputs JSON with correct level, message, timestamp, and data", () => {
    const log = createLogger();
    log.info("event", { key: "value" });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output).toMatchObject({
      level: "info",
      message: "event",
      timestamp: "2024-01-15T10:30:00.000Z",
      data: { key: "value" },
    });
  });

  it("log.debug is filtered when LOG_LEVEL=info", () => {
    process.env.LOG_LEVEL = "info";
    const log = createLogger();
    log.debug("should not appear");

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("log.debug outputs when LOG_LEVEL=debug", () => {
    process.env.LOG_LEVEL = "debug";
    const log = createLogger();
    log.debug("visible");

    expect(debugSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(debugSpy.mock.calls[0][0] as string);
    expect(output.level).toBe("debug");
    expect(output.message).toBe("visible");
  });

  it("log.child merges context into all subsequent logs", () => {
    process.env.LOG_LEVEL = "debug";
    const log = createLogger();
    const child = log.child({ requestId: "abc" });

    child.info("child event", { extra: 1 });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.data).toMatchObject({ requestId: "abc", extra: 1 });
  });

  it("child context does not leak to parent logger", () => {
    const log = createLogger();
    log.child({ requestId: "abc" });
    log.info("parent event");

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.data).toBeUndefined();
  });

  it("log.error serializes Error to structured data", () => {
    const log = createLogger();
    const err = new Error("test");
    log.error("msg", err);

    expect(errorSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(output.level).toBe("error");
    expect(output.message).toBe("msg");
    expect(output.data.error).toBe("test");
    expect(output.data.stack).toBeDefined();
  });

  it("log.error serializes custom Error subclass with errorType", () => {
    const log = createLogger();

    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomError";
      }
    }

    log.error("fail", new CustomError("custom"));

    const output = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(output.data.error).toBe("custom");
    expect(output.data.errorType).toBe("CustomError");
  });

  describe("level filtering: debug < info < warn < error", () => {
    it("LOG_LEVEL=warn filters out debug and info", () => {
      process.env.LOG_LEVEL = "warn";
      const log = createLogger();

      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");

      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it("LOG_LEVEL=error filters out debug, info, and warn", () => {
      process.env.LOG_LEVEL = "error";
      const log = createLogger();

      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");

      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it("LOG_LEVEL=debug allows all levels", () => {
      process.env.LOG_LEVEL = "debug";
      const log = createLogger();

      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");

      expect(debugSpy).toHaveBeenCalledOnce();
      expect(logSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it("defaults to info when LOG_LEVEL is unset", () => {
      delete process.env.LOG_LEVEL;
      const log = createLogger();

      log.debug("d");
      log.info("i");

      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledOnce();
    });
  });

  it("log.warn outputs via console.warn", () => {
    const log = createLogger();
    log.warn("warning");

    expect(warnSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(output.level).toBe("warn");
  });

  it("omits data field when no data is provided", () => {
    const log = createLogger();
    log.info("bare message");

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.data).toBeUndefined();
  });
});
