# Changelog

All notable changes to CertPulse are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-06-18

Full code-review pass over v0.4.0. Every change below closes at least one
finding from the structured review (CRITICAL/HIGH/MEDIUM/LOW) produced
against `/workspace/certpulse` on 2026-06-17.

### Security

- **CRITICAL — graceful shutdown in `src/index.ts:382-405`.** The HTTP server
  now `await server.close()` on SIGTERM/SIGINT, and the process installs
  `uncaughtException` / `unhandledRejection` handlers so a runaway promise
  rejection doesn't leave zombie containers. No-op `checksTotal.inc(.., 0)`
  removed.
- **CRITICAL — WHOIS SSRF guard in `services/whois.ts`.** `whoisServer` is
  now resolved through `isPrivateAddress()` before `createConnection`; a
  configuration pointing at `127.0.0.1`, `10.0.0.0/8`, or any RFC1918 range
  is rejected.
- **CRITICAL — IPv4-mapped IPv6 in `services/ssrf-guard.ts`.** The `::ffff:`
  prefix is now unwrapped and re-checked via `isPrivateIPv4` so the SSRF
  guard is symmetric across `dns.lookup` results from `node:net`.
- **HIGH — sanitized error responses.** `POST /api/domains` and
  `POST /api/domains/:id/check` now return `{error: "check_failed",
  requestId}` instead of the raw `err.message` (which leaked TLS details).
- **HIGH — error classification.** `services/checker.ts` now maps TLS
  codes (`ECONNRESET`, `CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`,
  …) into stable short codes (`tls_timeout`, `self_signed`, …) for the
  `last_error` column.
- **MEDIUM — web client token.** `packages/web/src/lib/api.ts` now
  reads/writes the API token via `localStorage` and sends it as
  `Authorization: Bearer`. A new `ApiError` class carries the HTTP
  `status` and sanitizes non-JSON 502 responses from the nginx reverse
  proxy.
- **MEDIUM — Telegram Markdown → HTML.** `services/channels.ts` now uses
  `parse_mode: "HTML"` and escapes `<`, `>`, `&` before sending. Previous
  markup leaked raw characters into user-facing alerts.

### Correctness

- **CRITICAL — FK CASCADE.** `db/migrations/0000_init.sql` now declares
  `checks.domain_id`, `alerts.domain_id`, `alerts.check_id` with
  `ON DELETE CASCADE`. Deleting a domain no longer leaves orphaned rows.
- **CRITICAL — migration tracking.** `db/sqlmigrate.ts` introduces
  `__applied_migrations(filename, applied_at)` and applies via
  `INSERT OR IGNORE`; previously a failed migration could be re-run
  silently.
- **CRITICAL — AUTH_DISABLED hardened.** `middleware/auth.ts` now checks
  `=== "1"` strictly (no truthy non-`"1"` values) and throws if
  `NODE_ENV === "production"` is set while the bypass is on. This kills
  the latent "shipped with auth off" footgun.
- **HIGH — `cli/backup.ts` no longer reads via `as any`.** Replaced the
  drizzle `$count(table)` cast with `getRawSqlite().prepare("SELECT
  count(*) FROM …")`; manifest counts now flow through the same channel
  as `.backup()`. Test mock updated to expose `getRawSqlite`; new
  regression test asserts `checks=7, domains=3, alerts=11` round-trip.
- **HIGH — parallel channel dispatch.** `services/alerter.ts` now awaits
  channel senders via `Promise.allSettled`; alerts reach all configured
  channels even if one times out.

### Code health

- **MEDIUM — `errMessage()` helper.** New `services/util.ts` centralizes
  the `(error as Error).message` pattern (used in 9 places). DRY.
- **LOW — dead code removed.** `lib.d.ts` references cleaned up; unused
  `count()` helper deleted; redundant `lib/api.ts` re-export of
  `alertEmailTo` removed (server does not return that field).
- **LOW — README / docs.** `version` field in `manifest.json` now reads
  from `package.json` via `readVersionFromPackage()`, so the version is
  correct whether the CLI is invoked through `tsx`, `npm run`, or
  `node`. (Previously relied on `npm_package_version` env var, which
  `tsx` does not populate.)

### Tests

- `vitest`: **181 passed | 1 skipped** (was 175 + 1 skipped before this
  pass; +1 regression in `backup.test.ts`, +2 new positive-path checks
  in `channels.test.ts` and `index.config.test.ts`).
- `tsc --noEmit`: clean across both workspaces.
- `vite build`: clean.
- Two `as any` casts removed (`index.config.test.ts` `logger.level`,
  `channels.test.ts` `pino.symbols.streamSym`) and replaced with
  typed helpers backed by `pino.LevelWithSilent` and
  `pino.symbols.streamSym`.

## [0.4.0] - 2026-06-14

Backup/restore CLI (#13), OpenAPI 3.1 + Swagger UI (#14), Grafana
dashboard (#15), and HMAC-signed outbound webhooks (#12). See
`docs/v0.4-dashboard.md` for the user-facing summary.

## [0.3.0] - 2026-06-10

Observability & operations: pino structured logging, Prometheus `/metrics`,
`/health` + `/health/ready` endpoints, rate-limiting, audit log table,
graceful shutdown, and Docker hardening. See `docs/v0.3-dashboard.md`.

## [0.2.0] - 2026-06-09

Phase 2 hardening: API-token auth, SSRF/URL guards, Dockerfile hardening,
nginx CSP, retention pruning.

## [0.1.0] - 2026-06-01

Initial release. Single-domain SSL expiry monitor with email alerts.