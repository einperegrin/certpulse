/**
 * Tests for `packages/web/src/lib/api.ts`.
 *
 * Focus: Bug 3 (v0.5 critical bugs) — the error-handler used to call
 * both `res.json()` AND `res.text()` on a non-2xx response, which threw
 * "body stream already read" on non-JSON bodies (e.g. nginx 502 HTML
 * page). The fix reads the body exactly once as text and then tries
 * `JSON.parse` on it.
 *
 * Each test below is a small fetch stub. We are NOT testing the api
 * helpers' higher-level behaviour (that belongs in the upcoming
 * Playwright E2E suite); we are testing the byte-level contract of
 * the error parser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, clearApiToken, setApiToken } from "../lib/api";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  // Per-test clean state for the token helpers (the setup file wipes
  // localStorage, this just keeps the helpers themselves tidy).
  clearApiToken();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

/** Helper: install a fake fetch that returns the given Response. */
function stubFetch(response: Response): void {
  globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("api.ts — error handler (Bug 3 fix)", () => {
  it("(repro) non-JSON 502 HTML does NOT throw 'body stream already read'", async () => {
    // The literal symptom Roman hit: the upstream nginx returns an
    // HTML error page when the api container is down. The OLD code
    // did `res.json()` (throws) then `res.text()` (throws "body stream
    // already read"). The NEW code must surface a clean ApiError
    // describing the upstream outage instead.
    //
    // NOTE: we create a fresh Response per call below — Response
    // bodies are one-shot, and re-using the same instance across two
    // api.listDomains() calls in one test would itself produce a
    // "body already read" error and mask the real bug.
    const buildResponse = () =>
      new Response(
        "<html><body><h1>502 Bad Gateway</h1></body></html>",
        { status: 502, headers: { "content-type": "text/html" } },
      );

    // Assertion 1: must reject with an ApiError carrying status 502.
    stubFetch(buildResponse());
    await expect(api.listDomains()).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
    });

    // Assertion 2: message must reference the upstream-down situation,
    // NOT the cryptic "body stream already read" string the user used
    // to see. (Uses a freshly-built Response to avoid body reuse.)
    stubFetch(buildResponse());
    await expect(api.listDomains()).rejects.toThrow(/server unavailable/i);
  });

  it("(correct) non-JSON 502 message does not include 'body stream'", async () => {
    // Regression guard — if a future refactor reintroduces the dual
    // .json()/.text() pattern, the error message will start with
    // "body stream already read". This test fails loudly if so.
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

  it("(correct) JSON `{error: 'msg'}` surfaces 'msg' as the ApiError message", async () => {
    // Standard error path: server returns a JSON object with an
    // `error` field. That field's value should become the message.
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

  it("(correct) 401 with non-JSON body falls back to the friendly 'check your API token' message", async () => {
    // When the server returns 401 with a non-JSON body (e.g. nginx
    // auth_basic challenge, or a stripped reverse-proxy error page),
    // the friendly 401 message is the right UX. When the server
    // returns a JSON `{error: "..."}`, the server's text wins — the
    // test for THAT path is the previous one ("JSON error surfaces").
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

  it("(correct) 2xx responses still parse JSON normally", async () => {
    // Sanity guard: the rewrite of the error branch must not have
    // broken the success branch. listDomains returns `{domains: [...]}`
    // and we want the wrapper to keep returning that shape.
    stubFetch(
      new Response(JSON.stringify({ domains: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(api.listDomains()).resolves.toEqual({ domains: [] });
  });

  it("(correct) text/plain 500 surfaces a short snippet, not the whole body", async () => {
    // Some proxy errors return plain text. The fix's snippet logic
    // must truncate to ~120 chars and strip newlines so the UI
    // doesn't display an unreadable blob.
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
      // Snippet is bounded — never the whole 500-char blob.
      expect((err as Error).message.length).toBeLessThan(200);
      expect((err as Error).message).toMatch(/Request failed: 500/);
    }
  });
});

describe("api.ts — Authorization header (Bug 2 fix)", () => {
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