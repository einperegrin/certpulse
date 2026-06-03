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
    it("falls back to a log entry when no API key is configured", async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      try {
        const sender = getChannelSender("email");
        const r = await sender.send(
          {
            subject: "hello",
            text: "world",
            level: "warning",
            hostname: "h",
            daysRemaining: 5,
            source: "cert",
          },
          { to: "test@example.com" },
          process.env
        );
        expect(r.id).toMatch(/^log-/);
        expect(logs.join("\n")).toMatch(/\[alert:email:log\]/);
      } finally {
        console.log = origLog;
      }
    });
  });
});
