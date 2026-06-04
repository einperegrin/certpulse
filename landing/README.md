# CertPulse Landing

Static landing page for [certpulse.com](https://certpulse.com).

## Files

- `index.html` — the page
- `style.css` — styles (dark theme, no framework, ~13KB)
- `script.js` — copy-to-clipboard for the hero CTA and code blocks
- `og-image.svg` — Open Graph / Twitter card image (1200×630)

## Local preview

```bash
cd landing
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

GitHub Pages from the `gh-pages` branch (or `/landing` path on `main`).

The CI workflow `.github/workflows/landing.yml` builds and publishes this
folder to `gh-pages` on every push to `feat/landing` (and on manual trigger).
