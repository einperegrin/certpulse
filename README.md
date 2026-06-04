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

## ⚙️ Environment variables

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `RESEND_API_KEY` | no | *empty* | If empty, alerts log to stdout |
| `ALERT_EMAIL_TO` | yes¹ | *empty* | Destination email |
| `ALERT_EMAIL_FROM` | no | `certpulse@localhost` | Use a Resend-verified domain |
| `CHECK_INTERVAL` | no | `60` | Minutes between automatic checks |
| `DATABASE_PATH` | no | `/app/data/certpulse.db` | SQLite file path |
| `PORT` | no | `3000` | API listen port |
| `VITE_API_URL` | no | `http://localhost:3000` | Web → API URL |

¹ Required only for email alerts. Without `RESEND_API_KEY`, all alerts go to stdout.

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