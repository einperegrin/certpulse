/**
 * Structured logger (L-6).
 *
 * One pino logger for the whole api. LOG_LEVEL defaults to "info";
 * `pino-pretty` is intentionally NOT installed in production — JSON
 * on stdout is what docker / log aggregators expect.
 *
 * Redaction: the most likely sources of PII (bearer tokens, bot
 * tokens, recipient email addresses) are listed in `redact.paths` and
 * replaced with "[REDACTED]" before the log line is written.
 */
import pino, { type Logger } from "pino";

const level = process.env.LOG_LEVEL ?? "info";

export const logger: Logger = pino({
  level,
  base: { app: "certpulse-api" },
  redact: {
    paths: [
      // Incoming HTTP auth
      "req.headers.authorization",
      "headers.authorization",
      "authorization",
      // Per-channel config blobs (Telegram botToken, webhook URLs with
      // embedded secrets, Resend API key, etc.)
      "config.botToken",
      "config.token",
      "config.apiKey",
      "config.secret",
      // Top-level "to" / "from" are email recipients in the channel
      // senders; we don't want to log recipient addresses.
      "to",
      "from",
    ],
    censor: "[REDACTED]",
  },
});

export type AppLogger = typeof logger;
