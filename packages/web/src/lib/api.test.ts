// Tests for the api.ts fetch wrapper. Covers Bug 2 (Bearer header)
// and Bug 3 (non-2xx body parsing — used to throw "body already read"
// on non-JSON responses like nginx 502 HTML).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, clearApiToken, setApiToken } from "../lib/api";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  clearApiToken();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function stubFetch(response: Response): void {
  globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("api.ts — error handler (Bug 3)", () => {
  it("non-JSON 502 HTML surfaces ApiError(502) and a friendly message", async () => {
    // Build a fresh Response per call — bodies are one-shot, reusing
    // the same instance across two api calls would itself throw.
    const buildResponse = () =>
      new Response(
        "<html><body><h1>502 Bad Gateway</h1></body></html>",
        { status: 502, headers: { "content-type": "text/html" } },
      );

    stubFetch(buildResponse());
    await expect(api.listDomains()).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
    });

    stubFetch(buildResponse());
    await expect(api.listDomains()).rejects.toThrow(/server unavailable/i);
  });

  it("non-JSON 502 message never contains 'body stream'", async () => {
    // Regression guard for the old dual .json()/.text() pattern.
    stubFetch(
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );

    try {
      await api.listDomains();
      throw new Error("expected api.listDomains() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as Error).message).not.toMatch(/body stream/i);
      expect((err as Error).message).not.toMatch(/already read/i);
    }
  });

  it("JSON {error: 'msg'} surfaces 'msg' as the ApiError message", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "domain not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(api.getDomain(999)).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "domain not found",
    });
  });

  it("401 with non-JSON body falls back to the friendly 'check your API token' message", async () => {
    stubFetch(
      new Response("Unauthorized", {
        status: 401,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(api.listDomains()).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: expect.stringMatching(/check your api token/i),
    });
  });

  it("2xx responses still parse JSON normally", async () => {
    stubFetch(
      new Response(JSON.stringify({ domains: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(api.listDomains()).resolves.toEqual({ domains: [] });
  });

  it("text/plain 500 surfaces a bounded snippet, not the whole body", async () => {
    const longText = "x".repeat(500);
    stubFetch(
      new Response(longText, {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );

    try {
      await api.listDomains();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as Error).message.length).toBeLessThan(200);
      expect((err as Error).message).toMatch(/Request failed: 500/);
    }
  });
});

describe("api.ts — Authorization header (Bug 2)", () => {
  it("attaches Bearer header when a token is set", async () => {
    setApiToken("cp_test_token_abc123");
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ domains: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await api.listDomains();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer cp_test_token_abc123");
  });

  it("does NOT attach Authorization header when no token is set", async () => {
    clearApiToken();
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ domains: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await api.listDomains();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});
