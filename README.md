# Goushibaaz — Early Viral Video Scout

Goushibaaz is focused on one job: discover videos that are gaining momentum **before** they reach their viral peak, rank them using observed growth rather than total views alone, and provide a reliable foundation for publishing selected videos through independent destination adapters.

## Current architecture

- **Cloudflare Workers + Cron:** scheduled scans.
- **Cloudflare D1:** candidates, timestamped public-stat snapshots, trend scores, scan history, verified reuse authorization, and per-destination delivery state.
- **GitHub:** source control and a manual deployment workflow.

## How the scout ranks candidates

The current first source is YouTube Data API v3. The worker samples video statistics, stores snapshots, calculates views per minute and changes in that velocity, and ranks newer candidates with stronger growth. A first sighting is not treated as proof of growth; repeated observations are required.

The current discovery source is a signal, not a guarantee that a video will go viral. Additional sources can be added behind the same discovery interface.

## Scheduled Persian-first Shorts scout

The GitHub Actions workflow `.github/workflows/discover-filo-candidates.yml` runs every two hours and can also be started manually. It renders public Shorts lists from fourteen MediaFarsi channel pages, collects public titles/view counts/posting age, records repeated snapshots in `state/trends.json`, and stores the current report as the `filo-candidate-discovery` workflow artifact. Persian-language titles rank first; videos that may work without speech (hidden-camera moments, visual comedy, animals, fails, satisfying clips) are a separate review category, not an automatic upload decision. Sources that render no Shorts cards are removed or replaced after a successful scan. A view-per-hour estimate from one scan is only a proxy; observed velocity is shown only after a sufficient interval between scans.

The scout prioritizes Persian-language entertainment and also flags mixed-language clips whose titles suggest the language may be less important. It excludes obvious political/sensitive headlines and stale clips from the shortlist. Public visibility and trend rank do **not** establish republication rights; all candidates remain ineligible for upload until license/permission and Filo compliance are verified.

View the [latest scout runs](https://github.com/Mehran0960/Goushibaaz/actions/workflows/discover-filo-candidates.yml).

## Publishing destinations

The target destinations are **Filo, Rubika, Bale, and Telegram**. Each destination must use a separate adapter and independent retry/status state, so a failure at one platform does not block discovery or publishing to the others.

**Important status:** the current deployed worker implements trend discovery and candidate tracking. Publishing adapters for the four destinations are not yet complete or confirmed active. The worker's scheduled scan also requires its API key and admin token to be configured as Cloudflare secrets.

## Repository layout

- `cloudflare/src/index.js` — Worker API, scheduled scanning, scoring, and candidate endpoints.
- `cloudflare/schema.sql` — full D1 schema.
- `cloudflare/migrations/0001_init.sql` — initial D1 migration.
- `cloudflare/wrangler.jsonc` — Worker, Cron, and D1 binding configuration.
- `.github/workflows/deploy-goushibaaz.yml` — manual deployment workflow.

## Setup

1. Create or use a Google Cloud project with **YouTube Data API v3** enabled and obtain an API key.
2. Add `YOUTUBE_API_KEY` and a strong random `ADMIN_TOKEN` as **Cloudflare Worker secrets** for `goushibaaz-trend-scout`. Never commit them.
3. Add GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to enable the manual deployment workflow.
4. Run the `Deploy Goushibaaz trend scout` workflow from GitHub Actions.
5. Check `GET /health`; then use authenticated admin routes described in `cloudflare/README.md`.

## Security and reliability

- Secrets belong in Cloudflare/GitHub secret stores, never source files or logs.
- A trend score is based on observed data; missing history is marked as insufficient evidence.
- Duplicate candidates are keyed by platform video ID.
- Before a publisher sends media to a destination, the project should require verifiable authorization for commercial reuse and a valid, accessible media source.
- Destination publishing should be idempotent, independently retryable, and observable.

