# CertPulse

Self-hosted SSL certificate expiry monitor. Add a domain, get email alerts at 30 / 7 / 1 days before the cert expires (and when it has already expired). No SaaS, no per-domain fees.

## Why

Let's Encrypt stopped expiry notifications on June 4, 2025. Cert lifetimes are shrinking to 47 days by 2029. CertPulse fills the gap as a self-hostable, open-core monitor with multi-channel alerts.

## Quickstart (Docker)

```bash
cp .env.example .env
# Edit .env and set RESEND_API_KEY + ALERT_EMAIL_TO (or leave them blank
# to log alerts to the api container's stdout)

docker compose up --build
```

Open <http://localhost:5173> for the dashboard and <http://localhost:3000/health> for the API.

Click **+ Add**, type a hostname, and the first SSL check fires immediately. From then on, the api runs a check for every enabled domain on a cron schedule (default: every 60 minutes, configurable via `CHECK_INTERVAL`).

## Stack

- **API** — Node 22 + [Hono](https://hono.dev/) on port 3000, [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [Drizzle ORM](https://orm.drizzle.team/), [node-cron](https://github.com/node-cron/node-cron) scheduler, [Resend](https://resend.com/) for email. SSL check is plain `node:tls`.
- **Web** — React 19 + Vite 6 + Tailwind 4, [shadcn/ui](https://ui.shadcn.com/)-style components, TanStack Query 5, React Router 7.
- **Storage** — single SQLite file persisted via the `certpulse-data` named volume.
- **Deploy** — multi-stage Dockerfiles + `docker-compose.yml`.

## Repo layout

```
certpulse/
├── docker-compose.yml
├── .env.example
├── package.json                workspace root
├── packages/
│   ├── api/                    Hono backend
│   │   ├── src/
│   │   │   ├── index.ts        app bootstrap
│   │   │   ├── db/             drizzle schema + migration runner
│   │   │   ├── routes/         domains, checks, dashboard
│   │   │   └── services/       checker, alerter, scheduler
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web/                    React frontend
│       ├── src/
│       │   ├── App.tsx
│       │   ├── pages/          Dashboard, DomainDetail
│       │   ├── components/     AddDomainDialog, DomainTable, StatusBadge
│       │   └── lib/            api client, cn util
│       ├── Dockerfile          vite build -> nginx
│       ├── nginx.conf
│       └── package.json
└── .github/workflows/ci.yml
```

## API

Base URL: `http://localhost:3000`

| Method | Path                          | Purpose                                                 |
| ------ | ----------------------------- | ------------------------------------------------------- |
| GET    | `/health`                     | Liveness probe                                          |
| GET    | `/api/config`                 | Effective config (interval, hasResend, alert email)     |
| GET    | `/api/dashboard`              | Counts + rows (total, healthy, expiring, expired)       |
| GET    | `/api/domains`                | List all monitored domains + their latest check         |
| POST   | `/api/domains`                | Add a domain; runs the first check immediately           |
| GET    | `/api/domains/:id`            | Domain detail with last 10 checks                        |
| DELETE | `/api/domains/:id`            | Remove a domain (cascades to its checks + alerts)       |
| POST   | `/api/domains/:id/check`      | Manual "Check Now"                                      |
| GET    | `/api/checks?domain_id=X`     | Recent checks (optionally filtered)                     |
| GET    | `/api/alerts`                 | Recent alert history                                    |

### Example

```bash
curl -X POST http://localhost:3000/api/domains \
  -H 'Content-Type: application/json' \
  -d '{"hostname": "example.com"}'
```

## Environment variables

| Variable             | Required | Default                       | Notes                                                   |
| -------------------- | -------- | ----------------------------- | ------------------------------------------------------- |
| `RESEND_API_KEY`     | no       | _empty_                       | If empty, alerts are logged to the api container stdout |
| `ALERT_EMAIL_TO`     | yes¹     | _empty_                       | Destination for alerts                                  |
| `ALERT_EMAIL_FROM`   | no       | `certpulse@localhost`         | Use a domain verified in your Resend account            |
| `CHECK_INTERVAL`     | no       | `60`                          | Minutes between automatic SSL checks                    |
| `DATABASE_PATH`      | no       | `/app/data/certpulse.db`      | SQLite file path                                        |
| `PORT`               | no       | `3000`                        | API listen port                                         |
| `VITE_API_URL`       | no       | `http://localhost:3000`       | Used by the web build to reach the api                  |

¹ Required only if you want actual email. With `RESEND_API_KEY` set you must also set `ALERT_EMAIL_TO`.

## Alert levels

| Days remaining  | Level       | Subject                          |
| --------------- | ----------- | -------------------------------- |
| > 30            | _none_      | -                                |
| ≤ 30            | `warning`   | Expires in 30 days               |
| ≤ 7             | `urgent`    | Expires in 7 days                |
| ≤ 1             | `critical`  | EXPIRES TOMORROW                 |
| ≤ 0 (expired)   | `emergency` | CERTIFICATE EXPIRED              |

Dedup: at most one alert per domain per level per 24 hours.

## Development

```bash
npm install                 # workspace install (api + web)
npm run dev:api             # http://localhost:3000
npm run dev:web             # http://localhost:5173
npm test                     # vitest in both packages
npm run typecheck            # tsc --noEmit in both packages
```

The web dev server proxies `/api/*` to `http://localhost:3000` by default. Override with `VITE_API_URL`.

## Acceptance criteria

- [x] `docker compose up` starts both services
- [x] Can add a domain via UI
- [x] SSL check runs automatically on schedule
- [x] Manual "Check Now" works
- [x] Expired / expiring domains show correct status
- [x] Email alert sent when domain ≤ 30 / 7 / 1 days (or logged if no `RESEND_API_KEY`)
- [x] Dashboard shows all domains with days remaining
- [x] Data persists across container restarts (SQLite volume)

## v1 backlog

Multi-channel alerts (webhook, Telegram, Slack, ntfy), domain expiry (RDAP/WHOIS), internal/PKI cert support, user auth, Stripe billing, status page, CT log monitoring, API token auth.

## License

MIT — see [LICENSE](./LICENSE).
