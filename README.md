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

The GitHub Actions workflow `.github/workflows/discover-filo-candidates.yml` runs every two hours and can also be started manually. It dynamically crawls MediaFarsi home/ranking/new-channel/statistics pages, up to 100 sitemap targets at the first level, 150 additional sitemap targets, and up to 150 relevant category pages. It scans up to **1,000 Persian channel Shorts pages per run**: 100 priority channels plus a rotating window of up to 900 other discovered channels. Each run exports the complete discovered/selected channel registry in `out/mediafarsi-source-catalog.json`; URLs that fail or return no video cards are recorded as discovery errors rather than treated as active sources.

The additional public-source scout checks **28 fixed Telegram video channels plus up to 180 directory-discovered channels**, using 21 public Telegram directory/search pages; approximately **100 Aparat search queries** and **90 YouTube Creative Commons-filtered queries** cover Persian comedy, animals, visual entertainment, sports, food, nature, science, DIY, satisfying processes, and other short-form topics. The scan runs with bounded concurrency to reduce burst failures. It reads public metadata only. Repeated view snapshots are maintained in `state/trends.json` and `state/platform-trends.json`.

The shared policy lives in `config/content-policy.json`: **Persian/Iran-related signals rank first, portrait/Shorts evidence second, observed growth third, and freshness fourth**. Every destination's final export target is 1080×1920 (9:16). A source URL appearing in a Shorts list is only a vertical-format hint, not proof that the source file is exactly 9:16; source width/height evidence is recorded when available. The scout writes `out/shorts-priority.json` and `out/shorts-priority.md` through `scripts/merge_short_candidates.cjs`, merging MediaFarsi Shorts, Telegram, Aparat, and YouTube leads into one shortlist shared for editorial review and future destination adapters.

All discovery data is metadata-only. Public Telegram/Aparat availability, a YouTube Creative Commons search filter, and trend rank do **not** grant permission to republish. A YouTube/API license label is still only a clearance signal until rights in the full clip (including music and third-party material) and the intended reuse are verified. These candidates stay discovery-only until rights are independently cleared. No discovery step downloads media or publishes a post.

View the [latest scout runs](https://github.com/Mehran0960/Goushibaaz/actions/workflows/discover-filo-candidates.yml).

## Filo: first revenue-focused destination

Filo runs as an independent scheduled publisher, separate from the shared Telegram/Bale/Rubika pipeline. Its workflow `.github/workflows/publish-approved-video-to-filo.yml` runs at four Iran-audience windows (08:00, 12:30, 18:00 and 21:00) and can also be started manually. It enforces a maximum of four publication attempts per UTC day and at least three hours between attempts. Its own concurrency group and publication ledger prevent overlapping submissions and duplicate source reuse; a slow Filo review or upload does not block the other destinations.

The Filo selector combines Persian-first and broad entertainment discovery, then ranks eligible candidates using topic fit, hooks, freshness, observed growth, recent trend momentum and category diversity. It checks each source's item-level license and media file before download; CC0 1.0 and CC BY 4.0 are accepted, with attribution and modification details retained for CC BY. Unknown or unauthorized sources are not downloaded or published. When no licensed external clip survives the checks, the publisher falls back to an original Persian puzzle video generated from the 24-item in-repository puzzle bank. The fallback uses original text and visual design plus Persian eSpeak NG narration; each puzzle is used once before a 5-day reuse window. This avoids an empty publishing slot without relaxing the external-content rights gate.

Filo outputs use 720×1280 (9:16), matching the platform's creator guidance for 720p video and a relevant, high-quality cover. Titles are Persian, directly related to the clip and avoid emoji-heavy or exaggerated wording. The description carries source and license details and asks viewers to follow گوشی‌باز. Original puzzle videos use a question, three answer choices, countdown, answer reveal and explanation with Persian voice narration. Each video ends with a 1.6-second, fully Persian, high-contrast follow card: «برای ویدیوهای بیشتر | گوشی‌باز را در فیلو دنبال کنید». This is channel promotion, not a claim of ownership. The publishing script uploads and explicitly selects a generated cover before submission.

The state ledger distinguishes `submitted_pending_approval` from `published`. A successful submission request or a post URL alone is not proof that the video is publicly active or earning revenue. The system only marks `published` after the account page shows an active status. Filo's moderation, view qualification, RPM and actual payments remain platform-controlled; uploads do not guarantee income.

## Multi-source trend intelligence

- A separate, free trend-intelligence workflow scans 48 curated public Persian Telegram video feeds (including Gizmiz-style sources), rotates broad Bing-indexed searches across Instagram, TikTok, YouTube, Aparat and other public video platforms, and uses the official YouTube Data API only when `YOUTUBE_API_KEY` is configured. YouTube search usage is internally capped at 30 calls/day; paid Firecrawl search is disabled in this adapter.
- The scan refreshes twice hourly and stores a bounded candidate/history ledger in `state/trend-intelligence.json`. It tracks observed view-count snapshots, views/hour and acceleration when enough time-separated measurements exist. First-seen lifetime-view rates remain explicitly marked as estimates.
- Topic momentum is converted into `state/platform-trends.json`, which the existing editorial ranker already reads to adjust the next licensed-media selection. This makes viral demand a ranking signal rather than a shortcut around rights checks.
- Public-channel and social-platform candidates are discovery signals only. Their public availability, view counts, or source popularity do not grant permission to download or republish. Public publishing continues to require the existing verified CC0 / CC BY 4.0 or explicit creator-permission gate.
- A successful first scan collected more than 200 fresh candidate records from Telegram feeds in one pass. Search engines and optional API lanes can return zero results or be unavailable; each source is best-effort and no single source is a hard dependency.

## Current publishing focus: Rubika, Telegram and Bale

The project now uses a **single shared licensed-video preparation pipeline**. The central scheduler dispatches `.github/workflows/prepare-shared-video.yml`; it discovers a fresh candidate, verifies commercial reuse rights, converts it once to a silent 1080×1920 (9:16) MP4, and creates one SHA-256-verified manifest/artifact. On completion, three independent `workflow_run` workflows fan out that exact artifact to Rubika, Telegram and Bale. Each destination has its own adapter, concurrency group, credentials, deduplication and publication state; a failure in one destination cannot stop the other two or the next discovery slot.

- Rights-cleared media discovery now combines 22 Wikimedia Commons topic searches with 24 Internet Archive topic searches. Every downloaded source is rechecked for an explicit CC0 1.0 or CC BY 4.0 license, public WebM/MP4/MOV/M4V media, size and duration before conversion.
- Editorial ranking combines measured trend velocity, topic momentum, freshness, Persian/local relevance, source quality, recent-topic diversity and a modest curiosity-to-payoff retention-arc bonus; first-sighting velocity remains marked as an estimate.
- Shared preparation and cross-destination dedupe: `scripts/rubika_publish_cc0.cjs`, `state/shared-publications.json`, and artifact `goushibaaz-shared-candidate`.
- Independent adapters: `scripts/rubika_publish_shared.cjs`, `scripts/telegram_publish.cjs`, `scripts/bale_publish.cjs`, with common transport/validation in `scripts/platform_publish.cjs`.
- Destination state: `state/rubika-published.json`, `state/telegram-published.json`, and `state/bale-published.json`.
- The scheduler dispatches the shared preparation workflow and prevents overlapping preparations, while observing destination-run load for capacity planning. A slow or failed destination never blocks fresh discovery slots; only that destination's own workflow queue/retry path is affected. The capacity model budgets for preparation plus three destination runs.
- Public sending is explicitly enabled for Telegram, Bale and Rubika: each destination workflow sets its own `GOUSHIBAAZ_PUBLIC_PUBLISH_ENABLED=true` and `GOUSHIBAAZ_FIRST_PUBLICATION_APPROVED=true`. This removes dependence on a shared repository variable. Each destination still resolves and validates its own bot/channel at send time, keeps its own idempotency ledger and concurrency group, and records success/failure independently.
- Every destination resolves the intended `@didobyn` channel at execution time and uses the numeric ID returned by that platform's API. Telegram and Bale no longer fail solely because their stored numeric channel-ID secrets are missing or stale; Rubika likewise uses its verified `getChat` result.
- The first real public post still requires explicit approval. The no-send integration test exercises all three adapters against one identical artifact.

Filo remains parked and is not part of the central scheduler.

## Repository layout

- `cloudflare/src/index.js` — Worker API, scheduled scanning, scoring, and candidate endpoints.
- `scripts/platform_scout.cjs` — public Telegram, Aparat, and YouTube Creative Commons-filtered metadata scouting.
- `scripts/rubika_publish_cc0.cjs` — independent, verified-license Rubika vertical-video publisher.
- `.github/workflows/publish-approved-video-to-rubika.yml` — Rubika manual dispatch and independent publication-state persistence.
- `.github/workflows/dispatch-short-publishers.yml` — synchronized central cron runner and cache-backed scheduler-state persistence.
- `scripts/synchronized_scheduler.cjs` — adaptive 7/17/27+ minute cadence, concurrent destination fan-out, account-load/API feedback, and future-platform quota reserve.
- `state/rubika-published.json` — Rubika-only deduplication and destination message IDs.
- `cloudflare/schema.sql` — full D1 schema.
- `cloudflare/migrations/0001_init.sql` and `0002_content_fit_preferences.sql` — D1 schema migrations.
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

