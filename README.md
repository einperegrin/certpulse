<div align="center">

# 🔔 CertPulse

**Self-hosted SSL certificate & domain expiry monitor with multi-channel alerts.**

Let's Encrypt stopped expiry notifications on June 4, 2025.  
Cert lifetimes are shrinking to 47 days by 2029.  
CertPulse fills the gap.

[![CI](https://github.com/einperegrin/certpulse/actions/workflows/ci.yml/badge.svg)](https://github.com/einperegrin/certpulse/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ready-blue?logo=docker&logoColor=white)](./docker-compose.yml)

[Quickstart](#-quickstart-docker) · [Channels](#-alert-channels) · [API](#-api) · [Config](#%EF%B8%8F-environment-variables) · [Develop](#-development)

|</div>

<img src="screenshot-800w.png" alt="CertPulse Dashboard" width="800" />

---

## ✨ What it does

- **SSL expiry monitoring** — checks certificates via `node:tls`, alerts at 30 / 7 / 1 days and on expiry
- **Domain registration expiry** — RDAP bootstrap + WHOIS fallback, same alert schedule
- **5 alert channels** — Email, Webhook, Telegram, Slack, ntfy — configure per domain
- **Self-hosted** — one `docker compose up`, data in SQLite, zero external dependencies
- **Modern stack** — Hono, React 19, Drizzle, Tailwind 4 — no PHP, no Python

## 🚀 Quickstart (Docker)

```bash
cp .env.example .env
# Optional: set RESEND_API_KEY + ALERT_EMAIL_TO for email alerts
# Leave blank to log alerts to stdout instead

docker compose up --build
```

Open http://localhost:5173 for the dashboard, http://localhost:3000/health for the API.

Click **+ Add**, type a hostname, and the first SSL check fires immediately.  
From then on, checks run on a cron schedule (default: every 60 minutes).

## 📡 Alert channels

Every domain can have any combination of channels. Missing config = silently skipped, failed channel = logged but doesn't block others.

| Channel | Free? | Setup |
|---------|-------|-------|
| **Email** | ✅ | Set `RESEND_API_KEY` + `ALERT_EMAIL_TO` |
| **Webhook** | ✅ | Any HTTPS endpoint; POST JSON payload |
| **Telegram** | ✅ | Bot token + chat ID via @BotFather |
| **Slack** | ✅ | Incoming Webhook URL |
| **ntfy** | ✅ | Pick a topic on https://ntfy.sh |

### Alert levels (cert & domain expiry)

| Days remaining | Level | Subject |
|---------------|-------|---------|
| > 30 | *none* | — |
| ≤ 30 | `warning` | Expires in 30 days |
| ≤ 7 | `urgent` | Expires in 7 days |
| ≤ 1 | `critical` | EXPIRES TOMORROW |
| ≤ 0 | `emergency` | CERTIFICATE / DOMAIN EXPIRED |

Dedup: at most one alert per (domain, source, channel, level) per 24 hours.

### Webhook payload

```json
{
  "source": "cert",
  "level": "urgent",
  "hostname": "example.com:443",
  "daysRemaining": 5,
  "subject": "[CertPulse] example.com: Expires in 7 days",
  "text": "…"
}
```

## 🛠 Stack

| Layer | Tech |
|-------|------|
| API | Node 22 + [Hono](https://hono.dev/) + [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [Drizzle ORM](https://orm.drizzle.team/) |
| Scheduler | [node-cron](https://github.com/node-cron/node-cron) |
| SSL check | `node:tls` (built-in, zero deps) |
| Domain expiry | RDAP bootstrap + plain TCP WHOIS (no extra deps) |
| Email | [Resend](https://resend.com/) (free tier: 100 emails/day) |
| Web | React 19 + Vite 6 + Tailwind 4 + [shadcn/ui](https://ui.shadcn.com/) + TanStack Query 5 |
| Storage | Single SQLite file via `certpulse-data` Docker volume |

## 📁 Repo layout

```
certpulse/
├── docker-compose.yml
├── .env.example
├── packages/
│   ├── api/                    Hono backend
│   │   ├── src/
│   │   │   ├── db/             drizzle schema + migration runner
│   │   │   ├── routes/         domains, checks, channels, dashboard
│   │   │   └── services/      checker, alerter, channels, scheduler, whois
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web/                    React frontend
│       ├── src/
│       │   ├── pages/          Dashboard, DomainDetail
│       │   ├── components/    AddDomainDialog, DomainTable, ChannelsEditor, StatusBadge
│       │   └── lib/            api client, format utils
│       ├── Dockerfile          vite build → nginx
│       └── package.json
└── .github/workflows/ci.yml
```

## 🔌 API

Base URL: `http://localhost:3000`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness probe |
| GET | `/api/config` | Effective config (interval, hasResend, alert email) |
| GET | `/api/dashboard` | Counts + rows (cert + domain expiry, healthy, expired) |
| GET | `/api/domains` | List all monitored domains + latest check |
| POST | `/api/domains` | Add a domain; runs first check immediately |
| GET | `/api/domains/:id` | Domain detail with last 10 checks |
| DELETE | `/api/domains/:id` | Remove a domain (cascades) |
| POST | `/api/domains/:id/check` | Manual "Check Now" |
| GET | `/api/domains/:id/channels` | List alert channels for a domain |
| POST | `/api/domains/:id/channels` | Upsert a channel |
| PATCH | `/api/domains/:id/channels/:cid` | Update enabled flag / config |
| DELETE | `/api/domains/:id/channels/:cid` | Remove a channel |
| GET | `/api/checks?domain_id=X` | Recent checks (filtered) |
| GET | `/api/alerts` | Alert history (includes source + channel) |

### Example

```bash
curl -X POST http://localhost:3000/api/domains \
  -H 'Content-Type: application/json' \
  -d '{"hostname": "example.com"}'
```

## 📊 Monitoring with Grafana (v0.4+)

The API exposes Prometheus metrics at `GET /metrics` (no auth — like `/health/*`). A ready-to-import Grafana dashboard is shipped in the repo at [`packages/api/grafana/certpulse-dashboard.json`](./packages/api/grafana/certpulse-dashboard.json).

The dashboard is hand-authored, schemaVersion 38 (Grafana 10+), and shows 8 panels in a 2×4 grid:

| # | Panel | PromQL (essence) |
|---|-------|------------------|
| 1 | HTTP request duration (p50 / p95 / p99) | `histogram_quantile(0.5/0.95/0.99, sum(rate(certpulse_http_request_duration_seconds_bucket[5m])) by (le))` |
| 2 | Checks per second | `sum(rate(certpulse_checks_total[5m]))` |
| 3 | Alerts sent (by channel) | `sum by (channel) (rate(certpulse_alerts_sent_total[5m]))` |
| 4 | Rate-limit hits | `sum(rate(certpulse_rate_limit_hits_total[5m]))` |
| 5 | HTTP requests by status | `sum by (status) (rate(certpulse_http_requests_total[5m]))` |
| 6 | Last check age (s) | `time() - certpulse_last_check_timestamp_seconds` |
| 7 | Last alert age (s) | `time() - certpulse_last_alert_timestamp_seconds` |
| 8 | Top 10 endpoints by 5xx rate | `topk(10, sum by (path) (rate(certpulse_http_requests_total{status=~"5.."}[5m])))` |

### Import the dashboard

1. **Start Prometheus** scraping the API. Minimal `prometheus.yml`:
   ```yaml
   scrape_configs:
     - job_name: certpulse
       metrics_path: /metrics
       static_configs:
         - targets: ["localhost:3000"]   # or `api:3000` inside docker compose
   ```
2. **In Grafana**: Dashboards → New → Import → upload `packages/api/grafana/certpulse-dashboard.json`.
3. When prompted, pick your Prometheus datasource from the `DS_PROMETHEUS` dropdown. (The dashboard ships with a single template variable so you can switch datasources on a per-folder basis.)
4. Defaults: **last 6 hours**, **30s refresh**.

### One-command deploy with Grafana + Prometheus

Add to your `docker-compose.yml` (or a sibling file):

```yaml
services:
  prometheus:
    image: prom/prometheus:v2.54.1
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports: ["9090:9090"]
  grafana:
    image: grafana/grafana:11.2.0
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=changeme
    ports: ["3001:3000"]   # 3000 is taken by the CertPulse API
    depends_on: [prometheus]
```

Then open `http://localhost:3001`, add Prometheus as a datasource (`http://prometheus:9090`), and import the JSON.

### Metric reference

All names below are exported by `prom-client` from `packages/api/src/lib/metrics.ts`:

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `certpulse_http_request_duration_seconds` | Histogram | `result`, `method` | rate-limit middleware (per /api/* request) |
| `certpulse_http_requests_total` | Counter | `method`, `path`, `status` | rate-limit middleware (every request, including 429s) |
| `certpulse_checks_total` | Counter | `result` | SSL/TLS check outcome (success/failure) |
| `certpulse_check_duration_seconds` | Histogram | — | SSL/TLS check wall time |
| `certpulse_alerts_sent_total` | Counter | `channel`, `source`, `result` | alerter dispatch (sent/failed/deduped/skipped) |
| `certpulse_alert_send_duration_seconds` | Histogram | `channel` | per-channel send time |
| `certpulse_rate_limit_hits_total` | Counter | `path` | 429s emitted by the limiter |
| `certpulse_audit_log_writes_total` | Counter | `action`, `resource_type` | `recordAudit()` in services/audit.ts |
| `certpulse_last_check_timestamp_seconds` | Gauge | — | set from `scheduler_state.last_tick` on every /metrics scrape |
| `certpulse_last_alert_timestamp_seconds` | Gauge | — | set from the newest `alerts.createdAt` on every /metrics scrape |
| `certpulse_domains_total` | Gauge | — | count of rows in `domains` |
| `certpulse_tokens_total` | Gauge | — | count of rows in `api_tokens` |
| `certpulse_db_query_duration_seconds` | Histogram | `operation` | per-DB-query timing |

Plus the full set of default Node.js process metrics (event-loop lag, GC, memory, fd count, …) from `prom-client`'s `collectDefaultMetrics()`.

## ⚙️ Environment variables

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `RESEND_API_KEY` | no | *empty* | If empty, alerts log to stdout |
| `ALERT_EMAIL_TO` | yes¹ | *empty* | Destination email |
| `ALERT_EMAIL_FROM` | no | `certpulse@localhost` | Use a Resend-verified domain |
| `CHECK_INTERVAL` | no | `60` | Minutes between automatic checks |
| `DATABASE_PATH` | no | `/app/data/certpulse.db` | SQLite file path |
| `PORT` | no | `3000` | API listen port (internal — not exposed by docker compose) |
| `VITE_API_URL` | no | `http://localhost:3000` | Web → API URL |
| `AUTH_DISABLED` | no | *unset* | **DEV ONLY** — skips bearer-token auth. Never set in production. |
| `ALLOW_PRIVATE_HOSTS` | no | *unset* | **DEV ONLY** — lets `POST /api/domains` and webhook URL validation accept loopback/private hostnames. Skip in production. |
| `ALLOW_NONSTANDARD_TLS_PORTS` | no | *unset* | Lets `POST /api/domains` accept ports other than 443/8443. |
| `WEB_PORT` | no | `5173` | Host port for the nginx reverse proxy. The api service is **internal-only** — it is not exposed on a host port. |

¹ Required only for email alerts. Without `RESEND_API_KEY`, all alerts go to stdout.

## 🛡️ Container hardening (v0.2+)

The compose stack is locked down by default:

- **No host port on the api** — all traffic goes through nginx on `WEB_PORT`. Reach the api from the host with `docker compose exec api ...`.
- **Read-only root filesystem** on both services. The only writable path inside the api is `/app/data` (a named volume for SQLite).
- **`cap_drop: ALL`** + **`no-new-privileges:true`** on both services — drop every Linux capability, refuse setuid escalation. The api additionally adds back `CAP_CHOWN`, `CAP_SETUID`, and `CAP_SETGID` so its entrypoint can repair the ownership of `/app/data` on volumes inherited from older images and drop to the unprivileged user. With no-new-privileges, those capabilities cannot be inherited by any child process — they are a one-shot tool used by PID 1.
- **Dedicated unprivileged user** in the api image (UID/GID 10001, no shell, no home). The api process runs as that user; the entrypoint runs as root just long enough to chown the data directory and call `setpriv`.
- **Healthchecks** on both services. The api hits its own `/health`; the web hits `/health` through nginx.

## ⬆️ Upgrading

The api image runs as a dedicated unprivileged user (UID/GID 10001). On every start, the entrypoint repairs the ownership of `/app/data` so volumes inherited from older images (where the file was provisioned as `root`) become writable automatically.

If you ever see `SqliteError: attempt to write a readonly database` in the api logs after an upgrade, the most likely cause is a host bind mount whose contents are owned by the host user. Either:

```bash
# Re-run the entrypoint's repair manually:
docker compose exec api chown -R 10001:10001 /app/data

# Or, if you prefer to drop the old database and start clean
# (you will lose any registered domains — re-add them afterwards):
docker compose down
docker volume rm certpulse_certpulse-data
docker compose up -d
```

## 🔐 Authentication (v0.2+)

All `/api/*` routes require a bearer token, except `/health` (kept public for the docker healthcheck).

### Create your first token

```bash
# from inside packages/api
npm run token:create -- --label "admin"

# or from a running container
docker compose exec api npm run token:create -- --label admin
```

The CLI prints the raw token **exactly once** — copy it immediately. The database only stores the SHA-256 hash; the raw token is unrecoverable.

### Use the token

```bash
curl -H "Authorization: Bearer <token>" http://localhost:5173/api/domains
```

### Manage tokens

```bash
npm run token:list               # show id, label, created, expires, last-used
npm run token:revoke -- --id 3   # delete by id
```

### Escape hatch (dev only)

Set `AUTH_DISABLED=*** in your `.env` for local dev to skip auth. **Never** set this in production — the entire API is open.

## 🧪 Development

```bash
npm install          # workspace install (api + web)
npm run dev:api      # http://localhost:3000
npm run dev:web      # http://localhost:5173
npm test             # vitest in both packages
npm run typecheck    # tsc --noEmit in both packages
```

The web dev server proxies `/api/*` to `http://localhost:3000` by default. Override with `VITE_API_URL`.

## ✅ Acceptance criteria

- [x] `docker compose up` starts both services
- [x] Can add a domain via UI
- [x] SSL check runs automatically on schedule
- [x] Manual "Check Now" works
- [x] Expired / expiring domains show correct status
- [x] Email alert sent at 30 / 7 / 1 days (logged if no Resend key)
- [x] Data persists across container restarts (SQLite volume)
- [x] Multi-channel alerts (email + webhook + Telegram + Slack + ntfy)
- [x] Domain registration expiry (RDAP + WHOIS fallback)
- [x] Per-source (cert vs domain) alert dedup, independent channels

## 🗺 Roadmap

- [ ] Landing page + pricing (Cloud tier)
- [ ] User auth (magic link)
- [ ] Status page for monitored domains
- [ ] CT log monitoring (Certificate Transparency)
- [ ] Internal / PKI certificate support
- [ ] API token auth
- [ ] Stripe billing

## 🤝 Contributing

PRs welcome! Open an issue first to discuss what you'd like to change.

## License

Licensed under the [GNU Affero General Public License v3.0](./LICENSE).  
If you'd like to use CertPulse in a closed-source product, contact us for a commercial license.