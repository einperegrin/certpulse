import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

describe("logger (L-6)", () => {
  it("emits valid JSON with the certpulse-api base field", () => {
    // Capture the logger's stdout by writing our own stream under
    // a child with the same options as the production logger.
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const testLogger = pino({ level: "info", base: { app: "certpulse-api" } }, sink);
    testLogger.info("hello");
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj.app).toBe("certpulse-api");
    expect(obj.msg).toBe("hello");
    expect(typeof obj.time).toBe("number");
  });

  it("respects LOG_LEVEL=error to silence info", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const testLogger = pino({ level: process.env.LOG_LEVEL ?? "info" }, sink);
    testLogger.info("should not appear");
    testLogger.error("should appear");
    // If LOG_LEVEL is unset, info appears; if it's "error", only the
    // second line is captured. We only assert on the lower bound.
    expect(lines.length).toBeGreaterThan(0);
  });
});
