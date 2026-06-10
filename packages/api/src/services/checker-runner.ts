import { eq } from "drizzle-orm";
import { getDb, type DB } from "../db/index.js";
import { checks, domains } from "../db/schema.js";
import { checkSSL } from "./checker.js";
import { processCheckAlert, type ChannelDispatchResult } from "./alerter.js";
import { lookupDomainExpiry } from "./whois.js";
import { isPrivateAddress } from "./ssrf-guard.js";
import { checksTotal, checkDurationSeconds } from "../lib/metrics.js";
import { logger } from "./logger.js";

/**
 * Error thrown when a check is denied because the hostname resolves to a
 * private/loopback/link-local address at the time of the check. This is a
 * runtime guard — even if a hostname was public when POSTed, it may have
 * flipped private since, and we must not open a connection to it.
 */
export class PrivateAddressError extends Error {
  readonly hostname: string;
  constructor(hostname: string) {
    super(
      `Refusing to check ${hostname}: hostname resolves to a private/loopback/link-local address. ` +
        `Set ALLOW_PRIVATE_HOSTS=1 to override (not recommended).`
    );
    this.name = "PrivateAddressError";
    this.hostname = hostname;
  }
}

export interface RunCheckOutcome {
  domainId: number;
  hostname: string;
  port: number;
  valid: boolean;
  daysRemaining: number | null;
  domainExpiresAt: string | null;
  domainExpiresDaysRemaining: number | null;
  domainRegistrar: string | null;
  checkId: number;
  alerts?: { cert: ChannelDispatchResult[]; domain: ChannelDispatchResult[] } | null;
  error?: string | null;
  domainError?: string | null;
}

export interface RunCheckOptions {
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
  skipWhois?: boolean;
  /**
   * Number of checks to run in parallel. Defaults to 5 inside
   * `runChecksForAllEnabledDomains` (Task 2.2 / H-3) — kept small to
   * bound peak memory and TCP sockets on shared hosts.
   */
  concurrency?: number;
}

export async function runCheckForDomain(
  domainId: number,
  hostname: string,
  port = 443,
  db: DB = getDb(),
  options: RunCheckOptions = {}
): Promise<RunCheckOutcome> {
  // SSRF guard at the moment of TCP connect. The guard runs in POST
  // /api/domains too, but a hostname that flips from public to private
  // between writes would slip past that. This is the last line of defence.
  if (process.env.ALLOW_PRIVATE_HOSTS !== "1") {
    if (await isPrivateAddress(hostname)) {
      throw new PrivateAddressError(hostname);
    }
  }

  const checkTimer = checkDurationSeconds.startTimer();
  let result;
  try {
    result = await checkSSL(hostname, port, {
      rejectUnauthorized: options.rejectUnauthorized,
      timeoutMs: options.timeoutMs,
    });
  } catch (err) {
    // Network/SSL error → mark the check as a failure for the counter
    // and re-throw so the caller can decide what to do.
    checksTotal.inc({ result: "failure" });
    checkTimer();
    throw err;
  }
  checkTimer();
  checksTotal.inc({ result: result.valid ? "success" : "failure" });

  // Run the domain expiry lookup in parallel with the DB insert; we don't
  // need its result to persist the cert side of the check.
  const whoisPromise = options.skipWhois
    ? Promise.resolve(null)
    : lookupDomainExpiry(hostname).catch((err) => ({
        expiresAt: null,
        daysRemaining: null,
        registrar: null,
        error: err instanceof Error ? err.message : String(err),
      }));

  const inserted = db
    .insert(checks)
    .values({
      domainId,
      valid: result.valid,
      issuer: result.issuer,
      issuerOrg: result.issuerOrg,
      serial: result.serial,
      notBefore: result.notBefore,
      notAfter: result.notAfter,
      daysRemaining: result.daysRemaining,
      error: result.error,
      rawPem: result.rawPem,
      domainExpiresAt: null,
      domainExpiresDaysRemaining: null,
      domainRegistrar: null,
      domainRegistrarError: null,
    })
    .returning({ id: checks.id })
    .all();

  const checkId = inserted[0]?.id ?? 0;

  const whois = await whoisPromise;
  // If we got an expiry result, patch the check row so the dashboard can
  // see it without waiting for the next run.
  if (whois) {
    try {
      db.update(checks)
        .set({
          domainExpiresAt: whois.expiresAt,
          domainExpiresDaysRemaining: whois.daysRemaining,
          domainRegistrar: whois.registrar,
          domainRegistrarError: whois.error,
        })
        .where(eq(checks.id, checkId))
        .run();
    } catch (err) {
      logger.error({ err, checkId }, "failed to persist whois result");
    }
  }

  const outcome: RunCheckOutcome = {
    domainId,
    hostname,
    port,
    valid: result.valid,
    daysRemaining: result.daysRemaining,
    domainExpiresAt: whois?.expiresAt ?? null,
    domainExpiresDaysRemaining: whois?.daysRemaining ?? null,
    domainRegistrar: whois?.registrar ?? null,
    checkId,
    error: result.error,
    domainError: whois?.error ?? null,
  };

  try {
    const alertOut = await processCheckAlert({
      checkId,
      domainId,
      certDaysRemaining: result.daysRemaining,
      domainDaysRemaining: whois?.daysRemaining ?? null,
      db,
    });
    outcome.alerts = { cert: alertOut.cert ?? [], domain: alertOut.domain ?? [] };
  } catch (err) {
    logger.error({ err, checkId }, "alerter error processing check");
  }

  return outcome;
}

export async function runCheckForDomainById(
  domainId: number,
  db: DB = getDb(),
  options: RunCheckOptions = {}
): Promise<RunCheckOutcome> {
  const row = db
    .select()
    .from(domains)
    .where(eq(domains.id, domainId))
    .limit(1)
    .all()[0];
  if (!row) {
    throw new Error(`Domain ${domainId} not found`);
  }
  return runCheckForDomain(row.id, row.hostname, row.port, db, options);
}

export async function runChecksForAllEnabledDomains(
  db: DB = getDb(),
  options: RunCheckOptions = {}
): Promise<RunCheckOutcome[]> {
  // Clamp to at least 1: a zero or negative `concurrency` would cause
  // `for (i += concurrency)` to spin forever. (Copilot review:
  // checker-runner.ts:179.)
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const rows = db
    .select()
    .from(domains)
    .where(eq(domains.enabled, true))
    .all();

  // Process in chunks of `concurrency` (Task 2.2 / H-3). Chunking
  // instead of `Promise.all` over every row bounds peak memory and
  // TCP sockets, which matters when an operator has hundreds of
  // domains configured.
  const out: RunCheckOutcome[] = [];
  for (let i = 0; i < rows.length; i += concurrency) {
    const chunk = rows.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map((row) =>
        runCheckForDomain(row.id, row.hostname, row.port, db, options)
      )
    );
    results.forEach((r, idx) => {
      const row = chunk[idx];
      if (r.status === "fulfilled") {
        out.push(r.value);
      } else {
        // Preserve which domain failed (Copilot review: checker-runner.ts).
        out.push({
          domainId: row?.id ?? 0,
          hostname: row?.hostname ?? "unknown",
          port: row?.port ?? 443,
          valid: false,
          daysRemaining: null,
          domainExpiresAt: null,
          domainExpiresDaysRemaining: null,
          domainRegistrar: null,
          checkId: 0,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    });
  }
  return out;
}
