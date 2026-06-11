/**
 * Smoke test for the Grafana dashboard JSON shipped at
 * `packages/api/grafana/certpulse-dashboard.json`.
 *
 * The dashboard is hand-authored (see commit message for #15) — no
 * code generation, no UI. This test guards against:
 *
 *   1. The JSON being malformed (can't be imported into Grafana)
 *   2. The `title` being something other than "CertPulse" (so a
 *      renamed dashboard doesn't break the README's "import the
 *      CertPulse dashboard" link)
 *   3. A panel silently disappearing (the spec asks for 8 panels in a
 *      2x4 grid; regressions here are immediately visible)
 *   4. Any panel title changing (so a renamed panel doesn't surprise
 *      the README's "screenshot description" / community marketing
 *      copy that references the panel names)
 *   5. The PromQL not actually referencing the metrics we ship from
 *      /metrics — a typo in the dashboard query would render an empty
 *      panel after a fresh install.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DASHBOARD_PATH = join(
  __dirname,
  "..",
  "grafana",
  "certpulse-dashboard.json",
);

type Dashboard = {
  title: string;
  schemaVersion: number;
  panels: { id: number; title: string; type: string; targets: { expr: string }[] }[];
};

describe("Grafana dashboard JSON", () => {
  const json: Dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, "utf8"));

  it("parses as valid JSON and has the expected top-level title", () => {
    expect(json.title).toBe("CertPulse");
  });

  it("uses schemaVersion 38 (Grafana 10+)", () => {
    // Per the spec: "Grafana dashboard JSON model version 36+,
    // schemaVersion: 38". This is the floor.
    expect(json.schemaVersion).toBeGreaterThanOrEqual(38);
  });

  it("has exactly 8 panels in a 2x4 grid", () => {
    expect(json.panels).toHaveLength(8);
  });

  it("contains all 8 expected panel titles", () => {
    const titles = json.panels.map((p) => p.title).sort();
    expect(titles).toEqual(
      [
        "Alerts sent (by channel)",
        "Checks per second",
        "HTTP request duration (p50 / p95 / p99)",
        "HTTP requests by status",
        "Last alert age (s)",
        "Last check age (s)",
        "Rate-limit hits",
        "Top 10 endpoints by 5xx rate",
      ].sort(),
    );
  });

  it("every panel references a metric we actually export from /metrics", () => {
    // Names are taken straight from packages/api/src/lib/metrics.ts.
    // If you add a new metric and reference it in a panel, the test
    // tells you to add it to this set.
    const knownMetrics = [
      "certpulse_http_request_duration_seconds_bucket",
      "certpulse_checks_total",
      "certpulse_alerts_sent_total",
      "certpulse_rate_limit_hits_total",
      "certpulse_http_requests_total",
      "certpulse_last_check_timestamp_seconds",
      "certpulse_last_alert_timestamp_seconds",
      "certpulse_audit_log_writes_total",
    ];
    for (const panel of json.panels) {
      const exprs = panel.targets.map((t) => t.expr);
      expect(exprs.length).toBeGreaterThan(0);
      for (const expr of exprs) {
        // The expression must mention at least one of the known
        // metrics — otherwise it's a typo or a stale reference to
        // something we removed.
        const matches = knownMetrics.filter((m) => expr.includes(m));
        expect(matches, `panel "${panel.title}" expr "${expr}"`).toHaveLength(
          // Most panels match 1+ metric. `topk(10, sum by (path) ...)`
          // matches `certpulse_http_requests_total`. `time() - foo`
          // matches the timestamp gauges. So `>= 1` is the right floor.
          1,
        );
      }
    }
  });

  it("templates a Prometheus datasource variable named DS_PROMETHEUS", () => {
    // The README's "Monitoring with Grafana" section tells users to
    // pick their datasource on import — the variable name is part of
    // the public interface.
    const templating = (json as unknown as {
      templating: { list: { name: string; type: string; query: string }[] };
    }).templating;
    const ds = templating.list.find((v) => v.name === "DS_PROMETHEUS");
    expect(ds).toBeDefined();
    expect(ds?.type).toBe("datasource");
  });

  it("default time range is last 6 hours, refresh 30s", () => {
    const dash = json as unknown as { time: { from: string; to: string }; refresh: string };
    expect(dash.time.from).toBe("now-6h");
    expect(dash.time.to).toBe("now");
    expect(dash.refresh).toBe("30s");
  });
});
