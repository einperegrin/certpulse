/**
 * URL guard tests. Closes H-1 (channel URL hardening).
 */
import { afterEach, describe, expect, it } from "vitest";
import { validateWebhookUrl } from "./url-guard.js";

describe("validateWebhookUrl", () => {
  const saved = process.env.ALLOW_PRIVATE_HOSTS;

  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOW_PRIVATE_HOSTS;
    else process.env.ALLOW_PRIVATE_HOSTS = saved;
  });

  it("rejects non-URLs", async () => {
    expect((await validateWebhookUrl("not-a-url")).ok).toBe(false);
    expect((await validateWebhookUrl("")).ok).toBe(false);
  });

  it("rejects ftp://", async () => {
    expect((await validateWebhookUrl("ftp://example.com/hook")).ok).toBe(false);
  });

  it("rejects file://", async () => {
    expect((await validateWebhookUrl("file:///etc/passwd")).ok).toBe(false);
  });

  it("rejects javascript://", async () => {
    expect((await validateWebhookUrl("javascript:alert(1)")).ok).toBe(false);
  });

  it("rejects http:// for non-loopback hostnames", async () => {
    expect((await validateWebhookUrl("http://example.com/hook")).ok).toBe(false);
  });

  it("rejects https:// to IPv4 loopback", async () => {
    expect((await validateWebhookUrl("https://127.0.0.1/hook")).ok).toBe(false);
  });

  it("rejects https:// to the cloud metadata link-local IP", async () => {
    expect(
      (await validateWebhookUrl("https://169.254.169.254/latest/meta-data/")).ok
    ).toBe(false);
  });

  it("rejects https:// to RFC1918 hostnames", async () => {
    // We don't actually have 10.0.0.1 in DNS but the IP literal path
    // short-circuits without DNS.
    expect((await validateWebhookUrl("https://10.0.0.1/hook")).ok).toBe(false);
    expect((await validateWebhookUrl("https://192.168.1.1/hook")).ok).toBe(false);
  });

  it("accepts public https URLs", async () => {
    const res = await validateWebhookUrl("https://hooks.slack.com/services/T/B/X");
    expect(res.ok).toBe(true);
  });

  it("accepts https://example.com (public-resolving)", async () => {
    const res = await validateWebhookUrl("https://example.com/hook");
    expect(res.ok).toBe(true);
  });

  it("allows http://localhost for dev", async () => {
    process.env.ALLOW_PRIVATE_HOSTS = "1";
    const res = await validateWebhookUrl("http://localhost:8080/hook");
    expect(res.ok).toBe(true);
  });

  it("rejects http://localhost when ALLOW_PRIVATE_HOSTS is unset", async () => {
    delete process.env.ALLOW_PRIVATE_HOSTS;
    const res = await validateWebhookUrl("http://localhost:8080/hook");
    // localhost resolves to 127.0.0.1 → rejected as private.
    expect(res.ok).toBe(false);
  });

  it("rejects https://localhost", async () => {
    delete process.env.ALLOW_PRIVATE_HOSTS;
    const res = await validateWebhookUrl("https://localhost/hook");
    expect(res.ok).toBe(false);
  });

  it("ALLOW_PRIVATE_HOSTS=1 lets private https through (air-gapped mode)", async () => {
    process.env.ALLOW_PRIVATE_HOSTS = "1";
    const res = await validateWebhookUrl("https://10.0.0.5/api/alert");
    expect(res.ok).toBe(true);
  });
});
