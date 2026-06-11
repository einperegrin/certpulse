/**
 * Prometheus metrics for CertPulse (v0.3 / M-4).
 *
 * The exporter is `prom-client` (de-facto standard for Node.js). The
 * `/metrics` endpoint serves the text format consumed by Prometheus
 * scrapers. Defaults include Node.js process metrics (event-loop lag,
 * memory, GC, fd count, etc.) plus our domain-specific counters and
 * histograms.
 *
 * Counters / histograms are declared as module-level singletons so any
 * service can `import { checksTotal } from "../lib/metrics.js"` and
 * call `.inc()` / `.observe()`. We keep the API surface tiny on
 * purpose — the goal is "a few lines to record a check" — and put
 * label cardinality under control by hard-coding the label set.
 */
import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
} from "prom-client";
import type { ChannelName } from "../services/channels.js";
import type { AlertSource } from "../services/alerter.js";

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

/**
 * `certpulse_checks_total{result="success|failure"}` — total number of
 * certificate check attempts (one per (domain, tick) row, success or
 * not). Used for SLO dashboards ("% of checks successful over 24h").
 */
export const checksTotal = new Counter({
  name: "certpulse_checks_total",
  help: "Total certificate checks performed",
  labelNames: ["result"] as const,
  registers: [registry],
});

/** `certpulse_check_duration_seconds` — wall time per SSL check. */
export const checkDurationSeconds = new Histogram({
  name: "certpulse_check_duration_seconds",
  help: "Duration of a single SSL/TLS check",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

/**
 * `certpulse_alerts_sent_total{channel, source, result}` — total
 * alert dispatch attempts. `result` is "sent" | "failed" | "deduped"
 * | "skipped".
 */
export const alertsSentTotal = new Counter({
  name: "certpulse_alerts_sent_total",
  help: "Total alert dispatch attempts",
  labelNames: ["channel", "source", "result"] as const,
  registers: [registry],
});

/** `certpulse_alert_send_duration_seconds{channel}` — per-channel send time. */
export const alertSendDurationSeconds = new Histogram({
  name: "certpulse_alert_send_duration_seconds",
  help: "Duration of an alert channel send",
  labelNames: ["channel"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/** `certpulse_domains_total` — current number of monitored domains. */
export const domainsTotal = new Gauge({
  name: "certpulse_domains_total",
  help: "Current number of monitored domains",
  registers: [registry],
});

/** `certpulse_tokens_total` — current number of active api tokens. */
export const tokensTotal = new Gauge({
  name: "certpulse_tokens_total",
  help: "Current number of active API tokens",
  registers: [registry],
});

/** `certpulse_db_query_duration_seconds{operation}` — DB query timing. */
export const dbQueryDurationSeconds = new Histogram({
  name: "certpulse_db_query_duration_seconds",
  help: "Duration of a DB query, labelled by operation",
  labelNames: ["operation"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

/**
 * `certpulse_http_request_duration_seconds{result, method}` — wall time
 * per HTTP /api/* request. Distinct from `certpulse_check_duration_seconds`,
 * which measures the SSL/TLS check itself. v0.3 keeps `method` and `result`
 * as the only labels to bound cardinality; per-route labels are a v0.4 task.
 */
export const httpRequestDurationSeconds = new Histogram({
  name: "certpulse_http_request_duration_seconds",
  help: "Duration of an HTTP /api/* request",
  labelNames: ["result", "method"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Typed helper for the alerter — narrows the labels to known channel
 * and source names so a typo at the call site fails the type checker
 * instead of polluting the metric.
 */
export function recordAlertOutcome(
  channel: ChannelName,
  source: AlertSource,
  result: "sent" | "failed" | "deduped" | "skipped"
): void {
  alertsSentTotal.inc({ channel, source, result });
}

/**
 * `certpulse_http_requests_total{method, path, status}` — request
 * count labelled by method, the route's path template (not the
 * literal URL — see HTTPMetrics below) and the response status. This
 * is the Prometheus standard for "requests by status" / "top error
 * endpoints" panels. (v0.4 / Grafana dashboard panel 5 + 8.)
 */
export const httpRequestsTotal = new Counter({
  name: "certpulse_http_requests_total",
  help: "Total HTTP /api/* requests, labelled by method/path/status",
  labelNames: ["method", "path", "status"] as const,
  registers: [registry],
});

/**
 * `certpulse_rate_limit_hits_total{path}` — number of times the
 * in-memory rate limiter rejected a request. Bumped from the
 * rate-limit middleware on each 429. (v0.4 / Grafana dashboard
 * panel 4.)
 */
export const rateLimitHitsTotal = new Counter({
  name: "certpulse_rate_limit_hits_total",
  help: "Total /api/* requests rejected by the rate limiter",
  labelNames: ["path"] as const,
  registers: [registry],
});

/**
 * `certpulse_audit_log_writes_total{action, resource_type}` — number
 * of audit rows written, labelled by action prefix (e.g. "domain",
 * "channel", "token", "auth"). Bumped from `recordAudit` in
 * services/audit.ts. (v0.4 / Grafana dashboard panel — "audit log
 * activity".)
 */
export const auditLogWritesTotal = new Counter({
  name: "certpulse_audit_log_writes_total",
  help: "Total audit log rows written, labelled by action/resource type",
  labelNames: ["action", "resource_type"] as const,
  registers: [registry],
});

/**
 * `certpulse_last_check_timestamp_seconds` — Unix seconds at the
 * last scheduler tick. Set from the DB on every /metrics scrape
 * (see `refreshGauges` in index.ts) so the value is always fresh.
 * The Grafana "last check age" panel computes `time() -
 * certpulse_last_check_timestamp_seconds`. (v0.4.)
 */
export const lastCheckTimestampSeconds = new Gauge({
  name: "certpulse_last_check_timestamp_seconds",
  help: "Unix seconds at the last scheduler tick (or 0 if never)",
  registers: [registry],
});

/**
 * `certpulse_last_alert_timestamp_seconds` — Unix seconds at the
 * most recent alert row in the DB. Like `lastCheckTimestampSeconds`,
 * refreshed on every /metrics scrape. (v0.4 / Grafana dashboard
 * panel 7.)
 */
export const lastAlertTimestampSeconds = new Gauge({
  name: "certpulse_last_alert_timestamp_seconds",
  help: "Unix seconds at the most recent alert (or 0 if never)",
  registers: [registry],
});
