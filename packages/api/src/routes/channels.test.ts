import { beforeEach, describe, expect, it, afterEach, vi } from "vitest";
import { createInMemoryDb, type DB } from "../db/index.js";
import { runSqlMigrations } from "../db/sqlmigrate.js";
import { domains } from "../db/schema.js";
import Database from "better-sqlite3";
import { createApp } from "../index.js";

function makeDb(): { db: DB; sqlite: Database.Database } {
  const { db, sqlite } = createInMemoryDb();
  runSqlMigrations(sqlite);
  return { db, sqlite };
}

function makeApp(): {
  app: ReturnType<typeof createApp>;
  db: DB;
} {
  const m = makeDb();
  return { app: createApp({ db: m.db }), db: m.db };
}

function seedDomain(db: DB, hostname = "example.com") {
  const inserted = db
    .insert(domains)
    .values({ hostname, port: 443 })
    .returning()
    .all();
  return inserted[0]!;
}

describe("alert channels router", () => {
  let app: ReturnType<typeof createApp>;
  let db: DB;

  beforeEach(() => {
    // Default for the happy-path tests: let the URL guard stay on but
    // use public hostnames. The dedicated H-1 describe block re-enables
    // the strict path.
    delete process.env.ALLOW_PRIVATE_HOSTS;
    const m = makeApp();
    app = m.app;
    db = m.db;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.ALLOW_PRIVATE_HOSTS;
  });

  it("rejects an unknown channel", async () => {
    const d = seedDomain(db);
    const res = await app.request(`/api/domains/${d.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "carrier-pigeon" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a webhook channel via POST and lists it via GET", async () => {
    const d = seedDomain(db);
    const post = await app.request(`/api/domains/${d.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "webhook",
        enabled: true,
        config: { url: "https://example.com/hook" },
      }),
    });
    expect(post.status).toBe(201);
    const postBody = (await post.json()) as { channel: { channel: string; config: { url: string } } };
    expect(postBody.channel.channel).toBe("webhook");
    expect(postBody.channel.config.url).toBe("https://example.com/hook");

    const get = await app.request(`/api/domains/${d.id}/channels`);
    expect(get.status).toBe(200);
    const list = (await get.json()) as { channels: Array<{ channel: string; config: { url: string } }> };
    expect(list.channels.length).toBe(1);
    expect(list.channels[0]?.channel).toBe("webhook");
  });

  it("upserts when POSTing a channel that already exists for the domain", async () => {
    const d = seedDomain(db);
    await app.request(`/api/domains/${d.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "telegram",
        config: { botToken: "a", chatId: "1" },
      }),
    });
    const second = await app.request(`/api/domains/${d.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "telegram",
        config: { botToken: "b", chatId: "2" },
        enabled: false,
      }),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { channel: { enabled: boolean; config: { botToken: string; chatId: string } } };
    expect(body.channel.enabled).toBe(false);
    expect(body.channel.config.botToken).toBe("b");
  });

  it("patches a channel's enabled flag", async () => {
    const d = seedDomain(db);
    const post = await app.request(`/api/domains/${d.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "ntfy",
        config: { topic: "certpulse" },
      }),
    });
    const created = (await post.json()) as { channel: { id: number; enabled: boolean } };
    expect(created.channel.enabled).toBe(true);
    const patch = await app.request(`/api/domains/${d.id}/channels/${created.channel.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { channel: { enabled: boolean } };
    expect(patched.channel.enabled).toBe(false);
  });

  it("deletes a channel", async () => {
    const d = seedDomain(db);
    const post = await app.request(`/api/domains/${d.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "slack",
        config: { url: "https://hooks.slack.com/services/X" },
      }),
    });
    const created = (await post.json()) as { channel: { id: number } };
    const del = await app.request(`/api/domains/${d.id}/channels/${created.channel.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const list = await app.request(`/api/domains/${d.id}/channels`);
    const listBody = (await list.json()) as { channels: unknown[] };
    expect(listBody.channels.length).toBe(0);
  });

  it("returns 404 for missing domain", async () => {
    const get = await app.request(`/api/domains/99999/channels`);
    expect(get.status).toBe(404);
  });
});

describe("alert channels router — URL guard (H-1)", () => {
  let app: ReturnType<typeof createApp>;
  let db: DB;

  beforeEach(() => {
    // The default config has AUTH_DISABLED=1 (vitest.config.ts). The URL
    // guard runs independently; here we want the strict path — keep
    // ALLOW_PRIVATE_HOSTS unset.
    delete process.env.ALLOW_PRIVATE_HOSTS;
    const m = makeApp();
    app = m.app;
    db = m.db;
  });

  it("rejects a webhook channel whose URL is private/loopback", async () => {
    const d = seedDomain(db);
    const res = await app.request(`/api/domains/${d.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "webhook",
        config: { url: "https://127.0.0.1/hook" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/private|loopback|link-local/i);
  });

  it("rejects a slack channel whose URL is private/loopback", async () => {
    const d = seedDomain(db);
    const res = await app.request(`/api/domains/${d.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "slack",
        config: { url: "https://169.254.169.254/latest" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an ntfy channel whose server is loopback", async () => {
    const d = seedDomain(db);
    const res = await app.request(`/api/domains/${d.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "ntfy",
        config: { server: "https://10.0.0.1", topic: "alerts" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects PATCH that changes the URL to a private target", async () => {
    const d = seedDomain(db);
    // Seed a public webhook channel first.
    const post = await app.request(`/api/domains/${d.id}/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "webhook",
        config: { url: "https://example.com/hook" },
      }),
    });
    const created = (await post.json()) as { channel: { id: number } };
    // Now try to PATCH it to a private URL.
    const patch = await app.request(
      `/api/domains/${d.id}/channels/${created.channel.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { url: "https://192.168.1.1/hook" } }),
      }
    );
    expect(patch.status).toBe(400);
  });
});
