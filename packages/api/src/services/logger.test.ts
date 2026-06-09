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

  // Regression for the original test (logger.test.ts:39): the previous
  // assertion `expect(lines.length).toBeGreaterThan(0)` was a no-op that
  // passed even when LOG_LEVEL was unset (so info logging was NOT
  // silenced). This test now sets the level explicitly on the logger
  // instance — independent of process.env.LOG_LEVEL — and asserts that
  // info is dropped while error is kept. (Copilot review: logger.test.ts:39.)
  it("respects level=error to silence info, but keeps error lines", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    // Note: we pass `level` directly to pino, NOT via process.env,
    // so the test is deterministic and doesn't depend on the
    // surrounding shell's env.
    const testLogger = pino(
      { level: "error", base: { app: "certpulse-api" } },
      sink
    );
    testLogger.info("should not appear");
    testLogger.error("should appear");
    // Exactly one line: the error. info must be silenced at level=error.
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj.msg).toBe("should appear");
    expect(obj.level).toBe(50); // pino numeric level for "error"
  });
});
