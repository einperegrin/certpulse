# Contributing to CertPulse

Thanks for your interest in CertPulse! 🎉
This is currently a solo-maintainer project, so your contributions — bug
reports, fixes, docs, ideas — genuinely matter and are very welcome.

## Code of conduct

Be respectful and constructive. Disagree with the idea, not the person.
Assume good faith. Harassment of any kind is not tolerated.

## Reporting bugs

Open a [GitHub Issue](https://github.com/einperegrin/certpulse/issues/new)
and include:

- CertPulse version and commit (for Docker: `docker compose ps` shows the
  image tag, e.g. `einperegrin/certpulse:v1.0.0`; for source installs:
  `git rev-parse HEAD`)
- How you deployed (Docker image? `docker compose up`? source install?)
- Relevant logs (`api` container logs, browser console for UI issues)
- Steps to reproduce, expected vs. actual behaviour
- Hostname or config (redact secrets) if it helps reproduce

## Suggesting features

Open a [GitHub Issue](https://github.com/einperegrin/certpulse/issues/new)
and tag it as a feature request (the maintainer will apply the
**enhancement** label on triage). Briefly describe:

- The problem you want to solve (not just the proposed solution)
- Your proposed behaviour and any alternatives you considered
- Whether you'd be willing to send a PR

> ℹ️ CertPulse is [open-core (AGPL v3)](./LICENSE). Features that clearly
> belong to a future **commercial / cloud** tier may be redirected there.

## Submitting a pull request

1. **Fork** the repo and create a branch from `main`:
   ```bash
   git checkout -b fix/short-description main
   ```
   Branch prefixes used in the project: `feat/`, `fix/`, `docs/`, `chore/`,
   `refactor/`, `test/`.

2. **Install & verify** locally:
   ```bash
   npm install
   docker compose up --build   # or: npm run dev:api & npm run dev:web
   ```

3. **Make your change.** Keep PRs focused — one logical change per PR.
   Larger features should be discussed in an issue first.

4. **Run the full local gate** before pushing:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
   CI runs the same three jobs on every PR. A PR that fails CI won't be
   merged.

5. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat(api): add Slack alert rate-limiting
   fix(web): correct countdown for sub-day expiries
   docs: document ntfy auth token env var
   chore(deps): bump hono to 4.6
   ```
   Types in use: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`,
   `perf`, `build`, `ci`.

6. **Push** and open a PR against `main`. In the PR description:
   - Link the issue it closes (`Closes #123`)
   - Describe the change and any trade-offs
   - Add a screenshot for UI changes
   - Note any follow-up work (separate issue is fine)

7. **Wait for review.** This is a solo-maintainer project, so review may
   take a few days. Patience appreciated.

## Development setup

```bash
git clone https://github.com/einperegrin/certpulse.git
cd certpulse
npm install
cp .env.example .env

# Option A: full stack in Docker
docker compose up --build

# Option B: run each package directly
npm run dev:api      # http://localhost:3000
npm run dev:web      # http://localhost:5173
```

### Running tests

```bash
npm test              # vitest in the api workspace (web has no test suite yet)
npm run typecheck     # tsc --noEmit in both packages
```

The web dev server proxies `/api/*` to `http://localhost:3000` by default.
Override with `VITE_API_URL` if needed.

### Repo layout

```
packages/api   # Hono 4 + Drizzle + better-sqlite3
packages/web   # React 19 + Vite 6 + Tailwind 4
landing/       # static marketing site (certpulse.com)
docker-compose.yml
```

## Code style

- **TypeScript strict** — no `any` in new code without justification
- `npm run lint` runs `tsc --noEmit` in each workspace (no ESLint/Prettier
  enforcement yet; formatting matches the surrounding style in a file)
- Match surrounding style in a file; don't reformat unrelated lines
- Prefer small, pure functions; explicit over clever

## License

By contributing, you agree that your contributions are licensed under the
[AGPL v3](./LICENSE), the same license as the project. If you have a
reason to contribute under different terms, open an issue first.
