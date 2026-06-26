# SSLert POC Spec

> **Goal:** Prove the core value prop in 3-5 days — self-hosted SSL expiry monitor that alerts before cert expiration.

## Problem Statement

Let's Encrypt stopped expiry notifications June 4, 2025. Cert lifetimes shrinking to 47 days by 2029. Nobody offers open-core self-hostable SSL monitor with multi-channel alerts at indie pricing. We fill that gap.

## POC Scope (Week 1)

**In scope:**
- Add domain → check SSL cert expiry date
- Cron-based periodic checks (hourly)
- Email alerts at 30d, 7d, 1d before expiry
- Simple dashboard: list domains, status, days until expiry
- Docker Compose one-liner deploy
- SQLite storage

**Explicitly OUT of scope for POC:**
- Multi-channel alerts (webhook, Telegram, Slack) — v1
- Domain expiry (RDAP/WHOIS) — v1
- Internal/PKI cert support — v1
- User auth — v1
- Billing/Stripe — v1
- Status pages — v1
- CT log monitoring — v1
- API endpoints — v1

## Architecture

```
┌─────────────────────────────────────────────┐
│  Docker Compose                              │
│                                              │
│  ┌──────────┐    ┌──────────────────────┐   │
│  │  React   │    │  Node + Hono API     │   │
│  │  + Vite  │───▶│  :3000               │   │
│  │  + shadcn│    │                       │   │
│  └──────────┘    │  ┌─────────────────┐ │   │
│                  │  │ SSL Checker      │ │   │
│                  │  │ node:tls connect │ │   │
│                  │  │ getPeerCert()    │ │   │
│                  │  └─────────────────┘ │   │
│                  │                       │   │
│                  │  ┌─────────────────┐ │   │
│                  │  │ Cron Scheduler   │ │   │
│                  │  │ node-cron       │ │   │
│                  │  └─────────────────┘ │   │
│                  │                       │   │
│                  │  ┌─────────────────┐ │   │
│                  │  │ Alert Engine    │ │   │
│                  │  │ Resend (email)  │ │   │
│                  │  └─────────────────┘ │   │
│                  └──────────────────────┘   │
│                          │                   │
│                    ┌─────┴─────┐             │
│                    │  SQLite   │             │
│                    │  (file)   │             │
│                    └───────────┘             │
└─────────────────────────────────────────────┘
```

## Data Model (SQLite via Drizzle ORM)

```sql
-- Domains being monitored
CREATE TABLE domains (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname    TEXT NOT NULL UNIQUE,
  port        INTEGER DEFAULT 443,
  enabled     INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- SSL check results
CREATE TABLE checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id       INTEGER NOT NULL REFERENCES domains(id),
  checked_at      TEXT DEFAULT (datetime('now')),
  valid           INTEGER NOT NULL,        -- 0=invalid, 1=valid
  issuer          TEXT,
  issuer_org      TEXT,
  serial          TEXT,
  not_before      TEXT,                    -- cert NotBefore
  not_after       TEXT,                    -- cert NotAfter (expiry)
  days_remaining  INTEGER,
  error           TEXT,                    -- null if valid
  raw_pem         TEXT                     -- full cert chain
);

-- Alert history
CREATE TABLE alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id   INTEGER NOT NULL REFERENCES domains(id),
  check_id    INTEGER NOT NULL REFERENCES checks(id),
  type       TEXT NOT NULL,                -- 'email'
  status     TEXT NOT NULL,                -- 'pending', 'sent', 'failed'
  sent_at    TEXT,
  error      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## API Endpoints (Hono)

```
POST   /api/domains              — Add domain to monitor
GET    /api/domains              — List all domains with status
GET    /api/domains/:id          — Get domain detail + recent checks
DELETE /api/domains/:id          — Remove domain
POST   /api/domains/:id/check   — Trigger immediate check
GET    /api/checks               — Recent checks (all domains)
GET    /api/checks?domain_id=X   — Checks for specific domain
GET    /api/dashboard            — Summary: total, expiring soon, expired
```

## SSL Check Logic (node:tls)

```typescript
import { connect } from 'node:tls';

async function checkSSL(hostname: string, port = 443): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, hostname, { servername: hostname }, () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();

      if (!cert || Object.keys(cert).length === 0) {
        return reject(new Error('No certificate received'));
      }

      const notAfter = new Date(cert.valid_to);
      const daysRemaining = Math.ceil((notAfter.getTime() - Date.now()) / 86400000);

      resolve({
        valid: cert.valid ?? true,
        issuer: cert.issuer?.O ?? cert.issuer ?? 'Unknown',
        notBefore: cert.valid_from,
        notAfter: cert.valid_to,
        daysRemaining,
        serial: cert.serialNumber,
        raw: cert.raw.toString('pem'),
      });
    });

    socket.on('error', reject);
    socket.setTimeout(10000, () => {
      socket.destroy(new Error('Connection timeout'));
    });
  });
}
```

## Alert Rules

```
Days Remaining   │  Alert Level  │  Action
─────────────────┼───────────────┼─────────────────────
> 30             │  None         │  No alert
≤ 30             │  Warning      │  Email: "Expires in 30 days"
≤ 7              │  Urgent       │  Email: "Expires in 7 days"
≤ 1              │  Critical     │  Email: "EXPIRES TOMORROW"
Expired (≤ 0)    │  Emergency    │  Email: "CERTIFICATE EXPIRED"
```

- Dedup: max 1 alert per domain per level per 24h
- No alert for newly added domain if already expired (manual check first)

## Frontend (React + Vite + Tailwind + shadcn)

### Pages

1. **Dashboard** — main page
   - Stats cards: Total Domains | Expiring Soon (≤30d) | Expired | Healthy
   - Table: Domain | Issuer | Days Left | Last Check | Status badge
   - Color coding: green (>30), yellow (≤30), orange (≤7), red (≤1/expired)

2. **Add Domain** — simple modal/form
   - Input: hostname, port (default 443)
   - Button: "Add & Check Now"

3. **Domain Detail** — click domain row
   - Cert info: issuer, serial, valid from/to
   - Check history (last 10)
   - Alert history
   - "Check Now" button

### Layout
```
┌──────────────────────────────────────┐
│  🔒 SSLert    [Dashboard]  [+Add]│
├──────────────────────────────────────┤
│                                      │
│  ┌────────┐ ┌────────┐ ┌────────┐  │
│  │ Total  │ │ ≤30 days│ │Expired │  │
│  │   12   │ │    2    │ │   0    │  │
│  └────────┘ └────────┘ └────────┘  │
│                                      │
│  ┌──────────────────────────────┐   │
│  │ Domain         │ Days │ Status│   │
│  │ example.com    │  89  │ 🟢    │   │
│  │ api.test.io    │  12  │ 🟡    │   │
│  │ oldsite.dev    │  -2  │ 🔴    │   │
│  └──────────────────────────────┘   │
└──────────────────────────────────────┘
```

## Project Structure

```
sslert/
├── docker-compose.yml
├── package.json              (workspace root)
├── packages/
│   ├── api/                  (Hono backend)
│   │   ├── src/
│   │   │   ├── index.ts      (Hono app + routes)
│   │   │   ├── db/
│   │   │   │   ├── schema.ts  (Drizzle schema)
│   │   │   │   └── migrate.ts
│   │   │   ├── services/
│   │   │   │   ├── checker.ts (SSL check logic)
│   │   │   │   ├── alerter.ts (email alerts)
│   │   │   │   └── scheduler.ts (cron)
│   │   │   └── routes/
│   │   │       ├── domains.ts
│   │   │       ├── checks.ts
│   │   │       └── dashboard.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web/                  (React frontend)
│       ├── src/
│       │   ├── App.tsx
│       │   ├── pages/
│       │   │   ├── Dashboard.tsx
│       │   │   └── DomainDetail.tsx
│       │   ├── components/
│       │   │   ├── AddDomainDialog.tsx
│       │   │   ├── StatusBadge.tsx
│       │   │   └── DomainTable.tsx
│       │   └── lib/
│       │       └── api.ts     (fetch wrapper)
│       ├── Dockerfile
│       └── package.json
├── .github/
│   └── workflows/
│       └── ci.yml
├── .gitignore
├── LICENSE                   (AGPL-3.0)
└── README.md
```

## Docker Compose

```yaml
version: '3.8'
services:
  api:
    build: ./packages/api
    ports:
      - "3000:3000"
    volumes:
      - sslert-data:/app/data
    environment:
      - DATABASE_PATH=/app/data/sslert.db
      - RESEND_API_KEY=${RESEND_API_KEY}
      - ALERT_EMAIL_FROM=${ALERT_EMAIL_FROM:-sslert@localhost}
      - ALERT_EMAIL_TO=${ALERT_EMAIL_TO}
      - CHECK_INTERVAL=${CHECK_INTERVAL:-60}  # minutes
      - NODE_ENV=production

  web:
    build: ./packages/web
    ports:
      - "5173:80"
    environment:
      - VITE_API_URL=http://localhost:3000

volumes:
  sslert-data:
```

## Environment Variables

```env
# Required
RESEND_API_KEY=re_xxxx
ALERT_EMAIL_TO=admin@example.com

# Optional
ALERT_EMAIL_FROM=sslert@example.com
CHECK_INTERVAL=60           # minutes between checks
DATABASE_PATH=./data/sslert.db
PORT=3000
```

## Dependencies

```json
{
  "api": {
    "hono": "^4",
    "better-sqlite3": "^11",
    "drizzle-orm": "^0.36",
    "node-cron": "^3",
    "resend": "^4",
    "zod": "^3"
  },
  "web": {
    "react": "^19",
    "vite": "^6",
    "tailwindcss": "^4",
    "@shadcn/ui": "latest",
    "tanstack/react-query": "^5"
  }
}
```

## Test Plan (TDD-gated)

| Test | What | How |
|------|------|-----|
| SSL check | Valid cert returns days_remaining | `node:tls` mock or real domain |
| SSL check | Expired cert returns days_remaining ≤ 0 | Mock cert or real expired domain |
| SSL check | Invalid/unreachable domain returns error | Nonexistent domain |
| Alert 30d | Email sent when ≤30 days remaining | Mock Resend, check call args |
| Alert 7d | Email sent when ≤7 days remaining | Mock Resend |
| Alert dedup | No duplicate alerts within 24h | Two checks, verify 1 email |
| Add domain | POST /api/domains creates entry | HTTP test |
| Dashboard | GET /api/dashboard returns summary | Seed DB, check response |
| Cron | Scheduler runs checks at interval | Verify cron fires |

## Acceptance Criteria (POC = Done When)

- [ ] `docker compose up` starts both services
- [ ] Can add a domain via UI
- [ ] SSL check runs automatically on schedule
- [ ] Manual "Check Now" works
- [ ] Expired/expiring domains show correct status
- [ ] Email alert sent when domain ≤30/7/1 days
- [ ] Dashboard shows all domains with days remaining
- [ ] Data persists across container restarts

## Out of Scope for POC (v1 Backlog)

- Multi-channel alerts (webhook, Telegram, Slack, ntfy)
- Domain expiry (RDAP/WHOIS)
- Internal/PKI cert support
- User auth
- Stripe billing
- Status page
- CT log monitoring
- API token auth