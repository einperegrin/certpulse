import { eq } from "drizzle-orm";
import { getDb, type DB } from "../db/index.js";
import { checks, domains } from "../db/schema.js";
import { checkSSL } from "./checker.js";
import { processCheckAlert, type ChannelDispatchResult } from "./alerter.js";
import { lookupDomainExpiry } from "./whois.js";

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
}

export async function runCheckForDomain(
  domainId: number,
  hostname: string,
  port = 443,
  db: DB = getDb(),
  options: RunCheckOptions = {}
): Promise<RunCheckOutcome> {
  const result = await checkSSL(hostname, port, {
    rejectUnauthorized: options.rejectUnauthorized,
    timeoutMs: options.timeoutMs,
  });

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
      console.error(`[checker-runner] failed to persist whois result for check ${checkId}:`, err);
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
    console.error(`[alerter] error processing check ${checkId}:`, err);
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
  const rows = db
    .select()
    .from(domains)
    .where(eq(domains.enabled, true))
    .all();
  const out: RunCheckOutcome[] = [];
  for (const row of rows) {
    try {
      const outcome = await runCheckForDomain(row.id, row.hostname, row.port, db, options);
      out.push(outcome);
    } catch (err) {
      out.push({
        domainId: row.id,
        hostname: row.hostname,
        port: row.port,
        valid: false,
        daysRemaining: null,
        domainExpiresAt: null,
        domainExpiresDaysRemaining: null,
        domainRegistrar: null,
        checkId: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
