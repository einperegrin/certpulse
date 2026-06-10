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
