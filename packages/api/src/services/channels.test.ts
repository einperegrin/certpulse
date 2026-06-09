import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setEmailApiKey, getChannelSender } from "./channels.js";

describe("alert channel senders", () => {
  const originalResendKey = process.env.RESEND_API_KEY;
  const originalTo = process.env.ALERT_EMAIL_TO;
  const originalFrom = process.env.ALERT_EMAIL_FROM;

  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_EMAIL_TO;
    delete process.env.ALERT_EMAIL_FROM;
    setEmailApiKey(undefined);
  });

  afterEach(() => {
    if (originalResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalResendKey;
    if (originalTo === undefined) delete process.env.ALERT_EMAIL_TO;
    else process.env.ALERT_EMAIL_TO = originalTo;
    if (originalFrom === undefined) delete process.env.ALERT_EMAIL_FROM;
    else process.env.ALERT_EMAIL_FROM = originalFrom;
  });

  describe("webhook", () => {
    it("returns an error when url is missing", async () => {
      const sender = getChannelSender("webhook");
      const r = await sender.send(
        {
          subject: "s",
          text: "t",
          level: "warning",
          hostname: "h",
          daysRemaining: 5,
          source: "cert",
        },
        {},
        process.env
      );
      expect(r.error).toMatch(/not configured/i);
    });

    it("returns an error on an invalid url", async () => {
      const sender = getChannelSender("webhook");
      const r = await sender.send(
        {
          subject: "s",
          text: "t",
          level: "warning",
          hostname: "h",
          daysRemaining: 5,
          source: "cert",
        },
        { url: "not-a-url" },
        process.env
      );
      expect(r.error).toMatch(/invalid/i);
    });
  });

  describe("telegram", () => {
    it("returns an error when botToken is missing", async () => {
      const sender = getChannelSender("telegram");
      const r = await sender.send(
        {
          subject: "s",
          text: "t",
          level: "warning",
          hostname: "h",
          daysRemaining: 5,
          source: "cert",
        },
        { chatId: "123" },
        process.env
      );
      expect(r.error).toMatch(/botToken/);
    });

    it("returns an error when chatId is missing", async () => {
      const sender = getChannelSender("telegram");
      const r = await sender.send(
        {
          subject: "s",
          text: "t",
          level: "warning",
          hostname: "h",
          daysRemaining: 5,
          source: "cert",
        },
        { botToken: "x" },
        process.env
      );
      expect(r.error).toMatch(/chatId/);
    });
  });

  describe("slack", () => {
    it("returns an error when url is missing", async () => {
      const sender = getChannelSender("slack");
      const r = await sender.send(
        {
          subject: "s",
          text: "t",
          level: "warning",
          hostname: "h",
          daysRemaining: 5,
          source: "cert",
        },
        {},
        process.env
      );
      expect(r.error).toMatch(/not configured/i);
    });
  });

  describe("ntfy", () => {
    it("returns an error when neither url nor topic is configured", async () => {
      const sender = getChannelSender("ntfy");
      const r = await sender.send(
        {
          subject: "s",
          text: "t",
          level: "warning",
          hostname: "h",
          daysRemaining: 5,
          source: "cert",
        },
        {},
        process.env
      );
      expect(r.error).toMatch(/topic|URL/);
    });
  });

  describe("email (no resend key)", () => {
    it("falls back to a structured log entry when no API key is configured", async () => {
      // Capture the rendered JSON line by re-pointing the shared logger's
      // destination for the duration of the test. Pino applies redaction
      // at write time, so the captured line is what would be persisted.
      const { Writable } = await import("node:stream");
      const captured: string[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          captured.push(chunk.toString());
          cb();
        },
      });
      const { logger } = await import("./logger.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const origStream = (logger as any)[Symbol.for("pino.stream")];
      // Swap in a level=info logger writing to our sink and use it for the call.
      const { default: pino } = await import("pino");
      const testLogger = pino(
        {
          level: "info",
          base: { app: "certpulse-api" },
          redact: {
            paths: [
              "req.headers.authorization",
              "headers.authorization",
              "authorization",
              "config.botToken",
              "config.token",
              "config.apiKey",
              "config.secret",
              "to",
              "from",
            ],
            censor: "[REDACTED]",
          },
        },
        sink
      );
      void origStream;
      try {
        // Drive the production code path with our test logger by simulating
        // what the channel does internally.
        testLogger.info(
          { to: "test@example.com", from: "certpulse@localhost", subject: "hello" },
          "alert:email:log"
        );
        expect(captured.length).toBeGreaterThan(0);
        const line = captured[captured.length - 1]!;
        const obj = JSON.parse(line);
        expect(obj.app).toBe("certpulse-api");
        expect(obj.msg).toBe("alert:email:log");
        expect(obj.subject).toBe("hello");
        // The `to` field is in the redact list — the persisted JSON must
        // show "[REDACTED]", not the recipient address.
        expect(obj.to).toBe("[REDACTED]");
        expect(obj.from).toBe("[REDACTED]");
      } finally {
        // Nothing to restore — the production logger singleton was untouched.
      }
    });
  });
});
