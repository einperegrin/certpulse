# Security Policy

CertPulse is a self-hosted SSL/TLS and domain-expiry monitor. It connects
outbound to your services and the public internet — security bugs in the
monitoring plane itself can have real impact (leaked secrets in
config, SSRF against the host, RCE via the API).

We take reports seriously and respond promptly.

## Supported versions

Only the **`main` branch** and the most recent tagged release receive
security fixes. Older versions are not patched — please upgrade.

| Version              | Supported |
| -------------------- | --------- |
| `main`               | ✅        |
| Latest tagged release | ✅       |
| Older releases       | ❌        |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories → New draft advisory](https://github.com/einperegrin/certpulse/security/advisories/new).

Include, to the extent you can:

- A clear description of the issue and its impact
- Reproduction steps / proof-of-concept (a host you control, ideally)
- Affected version or commit SHA
- Any known mitigations or workarounds you've identified

If you cannot use GitHub Advisories (e.g. no GitHub account), open a
**draft** issue marked clearly as `[SECURITY — please convert to
advisory]` with minimal details and we will convert it.

## Response SLA

| Stage                   | Target                                       |
| ----------------------- | -------------------------------------------- |
| Acknowledgement         | within **48 hours** of your report           |
| Triage & severity       | within **7 days**                            |
| Patch (critical / high) | within **14 days**                           |
| Patch (medium / low)    | next regular release (typically 2–4 weeks)   |
| Public disclosure       | coordinated with you, after a fix is shipped |

Critical and high-severity issues are prioritised. We will keep you
informed of progress and credit you in the advisory (unless you prefer
to remain anonymous).

## Scope

**In scope** — vulnerabilities in the CertPulse codebase:

- The Hono API server (`packages/api`)
- The React dashboard (`packages/web`)
- The Docker images published from this repo
- Documentation that, if followed, would lead users into insecure
  configurations (e.g. default secrets that should be rotated)

**Out of scope**:

- Vulnerabilities in **upstream dependencies** (Hono, Drizzle, Vite,
  Tailwind, better-sqlite3, etc.). Please report those to the relevant
  upstream maintainer. We follow `npm audit` and Dependabot and patch
  promptly when fixes are available.
- Issues that require the user to already have privileged access
  (e.g. someone with `docker exec` into the api container bypassing
  its own auth)
- Theoretical issues without a realistic attack path
- TLS / certificate-validation logic: CertPulse does **not** trust the
  certificates it monitors, so failures to validate expiry/issuer
  structure on those certs are by design

## Safe harbour

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data
  destruction, or service disruption
- Only interact with accounts / domains they own or have explicit
  permission to test
- Stop and report immediately if they encounter unrelated user data
- Give us a reasonable window to patch before public disclosure

## Recognition

We publish a "Thanks" section in release notes for reporters who
consent to being credited. Hall of fame so far: _none yet — be the
first_.
