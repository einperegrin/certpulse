import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { checks, domains } from "../db/schema.js";
import { checkSSL, type CheckResult } from "./checker.js";
import { processCheckAlert } from "./alerter.js";

export interface RunCheckOutcome {
  domainId: number;
  hostname: string;
  port: number;
  valid: boolean;
  daysRemaining: number | null;
  checkId: number;
  alertStatus?: string;
  error?: string | null;
}

export async function runCheckForDomain(
  domainId: number,
  hostname: string,
  port = 443
): Promise<RunCheckOutcome> {
  const result = await checkSSL(hostname, port);
  const db = getDb();

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
    })
    .returning({ id: checks.id })
    .all();

  const checkId = inserted[0]?.id ?? 0;
  const outcome: RunCheckOutcome = {
    domainId,
    hostname,
    port,
    valid: result.valid,
    daysRemaining: result.daysRemaining,
    checkId,
    error: result.error,
  };

  try {
    const alert = await processCheckAlert({
      checkId,
      domainId,
      daysRemaining: result.daysRemaining,
    });
    if (alert) outcome.alertStatus = alert.status;
  } catch (err) {
    console.error(`[alerter] error processing check ${checkId}:`, err);
  }

  return outcome;
}

export async function runCheckForDomainById(domainId: number): Promise<RunCheckOutcome> {
  const db = getDb();
  const row = db
    .select()
    .from(domains)
    .where(eq(domains.id, domainId))
    .limit(1)
    .all()[0];
  if (!row) {
    throw new Error(`Domain ${domainId} not found`);
  }
  return runCheckForDomain(row.id, row.hostname, row.port);
}

export async function runChecksForAllEnabledDomains(): Promise<RunCheckOutcome[]> {
  const db = getDb();
  const rows = db
    .select()
    .from(domains)
    .where(eq(domains.enabled, true))
    .all();
  const out: RunCheckOutcome[] = [];
  for (const row of rows) {
    try {
      const outcome = await runCheckForDomain(row.id, row.hostname, row.port);
      out.push(outcome);
    } catch (err) {
      out.push({
        domainId: row.id,
        hostname: row.hostname,
        port: row.port,
        valid: false,
        daysRemaining: null,
        checkId: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
