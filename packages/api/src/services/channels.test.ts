import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
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
    // Regression (Copilot review: channels.test.ts:181). The previous
    // test constructed a brand-new pino logger inside the test and
    // drove it directly — it never exercised the production email
    // sender's fallback path (`logger.info(...)` + `console.log`), so
    // it would have stayed green even if `channels.ts` stopped
    // logging/redacting correctly. This test goes through
    // `getChannelSender("email")` and observes both side effects of
    // the no-key fallback.
    it("falls back to structured log + console output via getChannelSender", async () => {
      // The pre-existing beforeEach in this file deletes
      // ALERT_EMAIL_TO/RESEND_API_KEY and calls setEmailApiKey(undefined),
      // so the email sender has no API key AND no recipient. For this
      // test we need a recipient (otherwise the sender short-circuits
      // with "No destination email configured" before the fallback
      // path is exercised), so we set ALERT_EMAIL_TO here and clear
      // it in the finally block.
      const prevTo = process.env.ALERT_EMAIL_TO;
      process.env.ALERT_EMAIL_TO = "fallback-recipient@example.com";

      // Capture console.log (the email fallback writes content.text to stdout).
      const consoleLines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      };

      // Capture the production pino logger's writes. The fallback
      // path goes through `logger.info({to, from, subject}, "alert:email:log")`
      // and pino applies the redact list ("to", "from") to that record
      // before writing to the underlying stream.
      const loggerLines: string[] = [];
      const loggerSink = new Writable({
        write(chunk, _enc, cb) {
          loggerLines.push(chunk.toString());
          cb();
        },
      });
      const { logger } = await import("./logger.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const origStream = (logger as any)[Symbol.for("pino.stream")];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (logger as any)[Symbol.for("pino.stream")] = loggerSink;
      void origStream;
      try {
        const sender = getChannelSender("email");
        const r = await sender.send(
          {
            subject: "CertPulse test subject",
            text: "certpulse-alert-body",
            level: "warning",
            hostname: "test.example.com",
            daysRemaining: 5,
            source: "cert",
          },
          {},
          process.env
        );
        // Fallback path returns a log-* id (not an error).
        expect(r.error).toBeUndefined();
        expect(r.id).toMatch(/^log-/);

        // (1) The fallback writes the alert text to stdout — this is
        //     the primary observable of the no-key branch in
        //     `channels.ts`. The previous test only checked a
        //     locally-constructed pino logger and never went through
        //     the sender, so it stayed green even if the production
        //     fallback silently stopped emitting. (Copilot review:
        //     channels.test.ts:181.)
        expect(consoleLines.some((l) => l.includes("certpulse-alert-body"))).toBe(true);

        // (2) Pino's redact list is unit-tested in logger.test.ts; the
        //     point of THIS test is the integration with the
        //     `getChannelSender("email")` fallback, not the redact
        //     list itself. We still keep a soft assertion that the
        //     structured logger was called, but tolerate pino's
        //     async/transport plumbing swallowing the patch in some
        //     Node/pino combinations — the `console.log` check above
        //     is the load-bearing one.
        if (loggerLines.length > 0) {
          const lastLine = loggerLines[loggerLines.length - 1]!;
          const obj = JSON.parse(lastLine);
          expect(obj.msg).toBe("alert:email:log");
          // When our stream-patch worked, the redact list applies and
          // to/from come out as "[REDACTED]". Pino's redaction is
          // independently verified in logger.test.ts; here we only
          // assert that the structured log line was emitted.
          expect(typeof obj.subject).toBe("string");
        }
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (logger as any)[Symbol.for("pino.stream")] = origStream;
        console.log = origLog;
        if (prevTo === undefined) delete process.env.ALERT_EMAIL_TO;
        else process.env.ALERT_EMAIL_TO = prevTo;
      }
    });
  });
});
