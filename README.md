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

## Paused Filo publishing (kept for later)

Filo is temporarily removed from the automatic publisher scheduler because its current uploader integration does not complete the site's upload-to-publication lifecycle. Its workflow and publisher code remain in the repository for later repair, but the central scheduler will not dispatch it and an unfinished Filo run will not block other destinations.

The first working publishing adapter is Filo, implemented in `.github/workflows/publish-approved-video-to-filo.yml`. Its cadence is controlled by `.github/workflows/dispatch-short-publishers.yml` and `scripts/synchronized_scheduler.cjs`. The scheduler polls every five minutes using a standard `*/5` GitHub Actions cron expression, but only starts a publication slot when its persisted next-due time arrives. In each slot, **all currently enabled destination workflows are dispatched concurrently** rather than alternating platforms. The target interval is adaptive: start at 7 minutes when observed capacity and recent source outcomes are healthy; increase to 17, 27, or longer tiers when API rate limits, concurrent workflow pressure, unknown telemetry, or repeated no-eligible-video outcomes indicate that more headroom is needed. GitHub's five-minute schedule granularity means a slot may start several minutes after its target time, and scheduled events can still be delayed or dropped during platform load. Each destination independently revalidates its source and license before publishing; if it cannot find a new eligible short, it skips the post.

For each slot, the publisher searches **90+ Wikimedia Commons topic queries** plus **24 Internet Archive topic searches**. Internet Archive search is not pre-filtered on its license index because that query was returning zero matches; each item's own metadata and specific WebM file are still checked for an explicit CC0 1.0 or CC BY 4.0 license before use. Both sources are deduplicated against previously submitted items. The publisher rejects protest, political-event, war, weapon and military material; a location name such as Tehran does not make footage entertainment. It fails closed unless the file is a WebM video whose metadata explicitly confirms CC0 1.0 or CC BY 4.0, a plausible file size, and a duration of **8–180 seconds**. CC BY-NC, CC BY-ND, CC BY-SA, and uncertain licenses are excluded.

Candidate ranking now weighs recognizable entertainment hooks, topic specificity, recent measured views-growth signals from the existing Telegram/Aparat/YouTube metadata snapshots, vertical-source evidence, freshness, and repeated recent topics. It rotates across Persian comedy, pets, sports skills, science/illusions, satisfying crafts, cooking, performances, nature and travel instead of preferring the longest animal clip. This score is only metadata-based triage; it does not claim to understand every frame or predict virality. The Rubika selector applies the same scoring and an 8-second minimum. Public Telegram, Instagram, TikTok and other discovered clips remain discovery-only unless actual republication permission is verified. A public post or viral score does not grant rights; direct candidates must still pass the existing CC0/CC BY or explicit permission gate. Every published output is transcoded to 1080×1920 (9:16); source aspect ratio is recorded when metadata provides it. For CC BY 4.0, the description includes the creator, source link, license link, and a modification note. The publisher converts the clip, generates a cover frame, uploads and selects the cover, fills a Persian title/description with source attribution, then submits it to Filo. Published and pending items are tracked in `state/filo-published.json` to prevent duplicate uploads. If no fresh eligible source is found, the slot is skipped instead of reusing copyrighted or uncertain material.

CC BY 4.0 permits commercial reuse and adaptation subject to attribution, source/license links, and indicating modifications; the publisher adds those elements to the description. Wikimedia license metadata does not necessarily clear separately copyrighted audio or other third-party rights, so residual rights and platform moderation still require care. See the [official CC BY 4.0 deed](https://creativecommons.org/licenses/by/4.0/deed.en).

Filo may hold new videos in a moderation/approval queue for up to 72 hours. A successful upload request is **not** a guarantee of public approval, monetization, or income. The scheduled run therefore records submission/approval status separately from a confirmed public URL. Candidate discovery from YouTube, Telegram, and Aparat remains a trend signal only; it does not itself grant permission to republish those videos.

## Multi-source trend intelligence

- A separate, free trend-intelligence workflow scans 48 curated public Persian Telegram video feeds (including Gizmiz-style sources), rotates broad Bing-indexed searches across Instagram, TikTok, YouTube, Aparat and other public video platforms, and uses the official YouTube Data API only when `YOUTUBE_API_KEY` is configured. YouTube search usage is internally capped at 30 calls/day; paid Firecrawl search is disabled in this adapter.
- The scan refreshes twice hourly and stores a bounded candidate/history ledger in `state/trend-intelligence.json`. It tracks observed view-count snapshots, views/hour and acceleration when enough time-separated measurements exist. First-seen lifetime-view rates remain explicitly marked as estimates.
- Topic momentum is converted into `state/platform-trends.json`, which the existing editorial ranker already reads to adjust the next licensed-media selection. This makes viral demand a ranking signal rather than a shortcut around rights checks.
- Public-channel and social-platform candidates are discovery signals only. Their public availability, view counts, or source popularity do not grant permission to download or republish. Public publishing continues to require the existing verified CC0 / CC BY 4.0 or explicit creator-permission gate.
- A successful first scan collected more than 200 fresh candidate records from Telegram feeds in one pass. Search engines and optional API lanes can return zero results or be unavailable; each source is best-effort and no single source is a hard dependency.

## Current publishing focus: Rubika, Telegram and Bale

The project now uses a **single shared licensed-video preparation pipeline**. The central scheduler dispatches `.github/workflows/prepare-shared-video.yml`; it discovers a fresh candidate, verifies commercial reuse rights, converts it once to a silent 1080×1920 (9:16) MP4, and creates one SHA-256-verified manifest/artifact. On completion, three independent `workflow_run` workflows fan out that exact artifact to Rubika, Telegram and Bale. Each destination has its own adapter, concurrency group, credentials, deduplication and publication state; a failure in one destination cannot stop the other two or the next discovery slot.

- Shared preparation and cross-destination dedupe: `scripts/rubika_publish_cc0.cjs`, `state/shared-publications.json`, and artifact `goushibaaz-shared-candidate`.
- Independent adapters: `scripts/rubika_publish_shared.cjs`, `scripts/telegram_publish.cjs`, `scripts/bale_publish.cjs`, with common transport/validation in `scripts/platform_publish.cjs`.
- Destination state: `state/rubika-published.json`, `state/telegram-published.json`, and `state/bale-published.json`.
- The scheduler now dispatches the shared preparation workflow and watches all three destination workflows before starting another slot. Its capacity model budgets for preparation plus three destination runs.
- Public sending is fail-closed until **both** repository variables `GOUSHIBAAZ_PUBLIC_PUBLISH_ENABLED=true` and `GOUSHIBAAZ_FIRST_PUBLICATION_APPROVED=true` are set. With either missing/false, every adapter validates the same artifact and records a dry-run result without sending a public post.
- Rubika's verified `getChat(@didobyn)` identity remains the source of truth for the actual Rubika channel ID; if `RUBIKA_CHAT_ID` is set but differs, the adapter warns and uses the verified Bot API ID. Telegram uses `TELEGRAM_CHAT_ID`; Bale uses `BALE_CHANNEL_ID`.
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

