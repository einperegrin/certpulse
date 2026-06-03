import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb, type DB } from "../db/index.js";
import { runSqlMigrations } from "../db/sqlmigrate.js";
import { checks, domains } from "../db/schema.js";
import Database from "better-sqlite3";
import {
  determineAlertLevel,
  processCheckAlert,
} from "./alerter.js";
import {
  type AlertContent,
  type AlertChannelSender,
  type ChannelName,
  type SendResult,
  setChannelSender,
  resetChannelSender,
} from "./channels.js";

function makeDb(): { db: DB; sqlite: Database.Database } {
  const { db, sqlite } = createInMemoryDb();
  runSqlMigrations(sqlite);
  return { db, sqlite };
}

function recordingSender(
  name: ChannelName,
  inbox: { content: AlertContent; config: Record<string, unknown> }[],
  errRef: { value: SendResult | null }
): AlertChannelSender {
  return {
    channel: name,
    async send(content, config): Promise<SendResult> {
      inbox.push({ content, config });
      return errRef.value ?? { id: `mock-${name}` };
    },
  };
}

describe("determineAlertLevel", () => {
  it("returns warning for <=30 days", () => {
    expect(determineAlertLevel(30)?.level).toBe("warning");
    expect(determineAlertLevel(15)?.level).toBe("warning");
  });
  it("returns urgent for <=7 days", () => {
    expect(determineAlertLevel(7)?.level).toBe("urgent");
    expect(determineAlertLevel(3)?.level).toBe("urgent");
  });
  it("returns critical for <=1 day", () => {
    expect(determineAlertLevel(1)?.level).toBe("critical");
  });
  it("returns emergency for <=0 (expired)", () => {
    expect(determineAlertLevel(0)?.level).toBe("emergency");
    expect(determineAlertLevel(-1)?.level).toBe("emergency");
  });
  it("returns null for >30 days", () => {
    expect(determineAlertLevel(31)).toBeNull();
    expect(determineAlertLevel(60)).toBeNull();
  });
  it("returns null for null daysRemaining", () => {
    expect(determineAlertLevel(null)).toBeNull();
  });
});

describe("alert dispatch (multi-channel + dedup)", () => {
  let db: DB;
  let sqlite: Database.Database;
  // Fake results for each channel — recorded by the test harness.
  let sentByChannel: Record<ChannelName, { content: AlertContent; config: Record<string, unknown> }[]>;
  let channelErrors: Record<ChannelName, SendResult | null>;

  beforeEach(() => {
    const m = makeDb();
    db = m.db;
    sqlite = m.sqlite;
    sentByChannel = {
      email: [],
      webhook: [],
      telegram: [],
      slack: [],
      ntfy: [],
    };
    channelErrors = {
      email: null,
      webhook: null,
      telegram: null,
      slack: null,
      ntfy: null,
    };
    process.env.ALERT_EMAIL_TO = "test@example.com";
    process.env.ALERT_EMAIL_FROM = "certpulse@example.com";

    // Replace every channel sender with a recording fake. This way the
    // tests exercise the real dispatch path (no short-circuits on missing
    // config) without hitting any network.
    for (const name of Object.keys(sentByChannel) as ChannelName[]) {
      setChannelSender(
        name,
        recordingSender(name, sentByChannel[name], {
          get value() {
            return channelErrors[name];
          },
        })
      );
    }
  });

  // Restore real senders after each test so subsequent tests / the running
  // process don't get stuck on a stub.
  // (vitest runs each test file in isolation, so this is mostly defensive.)

  it("does not send duplicate alerts within 24h for the same level (cert source)", async () => {
    const inserted = db
      .insert(domains)
      .values({ hostname: "example.com", port: 443 })
      .returning()
      .all();
    const domain = inserted[0]!;
    // No explicit alert_channels row → falls back to default email
    // (enabled because ALERT_EMAIL_TO is set).

    const c1 = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 5,
        notBefore: new Date().toISOString(),
        notAfter: new Date(Date.now() + 5 * 86400_000).toISOString(),
      })
      .returning({ id: checks.id })
      .all()[0]!;
    const c2 = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 5,
        notBefore: new Date().toISOString(),
        notAfter: new Date(Date.now() + 5 * 86400_000).toISOString(),
      })
      .returning({ id: checks.id })
      .all()[0]!;

    const a1 = await processCheckAlert({
      checkId: c1.id,
      domainId: domain.id,
      certDaysRemaining: 5,
      domainDaysRemaining: null,
      db,
    });
    const a2 = await processCheckAlert({
      checkId: c2.id,
      domainId: domain.id,
      certDaysRemaining: 5,
      domainDaysRemaining: null,
      db,
    });

    expect(a1.cert?.[0]?.status).toBe("sent");
    // Second call should dedupe.
    expect(a2.cert?.[0]?.status).toBe("deduped");
  });

  it("sends separate alerts when level changes", async () => {
    const inserted = db
      .insert(domains)
      .values({ hostname: "example.com", port: 443 })
      .returning()
      .all();
    const domain = inserted[0]!;

    const c1 = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 20,
      })
      .returning({ id: checks.id })
      .all()[0]!;
    const c2 = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 5,
      })
      .returning({ id: checks.id })
      .all()[0]!;

    const a1 = await processCheckAlert({
      checkId: c1.id,
      domainId: domain.id,
      certDaysRemaining: 20,
      domainDaysRemaining: null,
      db,
    });
    const a2 = await processCheckAlert({
      checkId: c2.id,
      domainId: domain.id,
      certDaysRemaining: 5,
      domainDaysRemaining: null,
      db,
    });
    expect(a1.cert?.[0]?.level).toBe("warning");
    expect(a2.cert?.[0]?.level).toBe("urgent");
  });

  it("fires alerts for both cert and domain sources independently", async () => {
    const inserted = db
      .insert(domains)
      .values({ hostname: "example.com", port: 443 })
      .returning()
      .all();
    const domain = inserted[0]!;
    const c = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 5,
      })
      .returning({ id: checks.id })
      .all()[0]!;

    const out = await processCheckAlert({
      checkId: c.id,
      domainId: domain.id,
      certDaysRemaining: 5,
      domainDaysRemaining: 3,
      db,
    });
    expect(out.cert).not.toBeNull();
    expect(out.domain).not.toBeNull();
    expect(out.cert?.[0]?.level).toBe("urgent");
    expect(out.domain?.[0]?.level).toBe("urgent");
  });

  it("isolates dedup per source and per channel", async () => {
    const inserted = db
      .insert(domains)
      .values({ hostname: "example.com", port: 443 })
      .returning()
      .all();
    const domain = inserted[0]!;

    // Add an explicit ntfy channel for this domain.
    db.insert((await import("../db/schema.js")).alertChannels)
      .values({
        domainId: domain.id,
        channel: "ntfy",
        enabled: true,
        config: JSON.stringify({ topic: "certpulse-test" }),
      })
      .run();

    const c = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 5,
      })
      .returning({ id: checks.id })
      .all()[0]!;

    const out = await processCheckAlert({
      checkId: c.id,
      domainId: domain.id,
      certDaysRemaining: 5,
      domainDaysRemaining: null,
      db,
    });
    // Two channels fired: default email + ntfy.
    expect(out.cert?.length).toBe(2);
    const channels = out.cert?.map((r) => r.channel).sort();
    expect(channels).toEqual(["email", "ntfy"]);

    // Second call: both should be deduped.
    const c2 = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 5,
      })
      .returning({ id: checks.id })
      .all()[0]!;
    const out2 = await processCheckAlert({
      checkId: c2.id,
      domainId: domain.id,
      certDaysRemaining: 5,
      domainDaysRemaining: null,
      db,
    });
    expect(out2.cert?.every((r) => r.status === "deduped")).toBe(true);
  });
});
