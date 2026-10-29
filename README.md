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

The GitHub Actions workflow `.github/workflows/discover-filo-candidates.yml` runs every two hours and can also be started manually. It dynamically crawls MediaFarsi home/ranking/new-channel/statistics pages, category pages, and sitemap links, then scans up to **800 Persian channel Shorts pages per run**. The selection keeps the highest-priority 80 sources in every run and rotates through the remaining discovered channels over subsequent runs. The first successful dynamic run discovered 224 unique channel sources and collected 3,734 public Shorts leads; the expanded sitemap crawl is intended to find additional channels beyond that first 224-source catalog. Each run exports the discovered/selected channel registry in `out/mediafarsi-source-catalog.json`.

The additional public-source scout checks **7 fixed Telegram video channels plus up to 24 channels discovered from public entertainment-link directories**, **24 Aparat search queries**, and **26 YouTube Creative Commons-filtered search queries**. It reads public metadata only. Repeated view snapshots are maintained in `state/trends.json` and `state/platform-trends.json`.

The shared policy lives in `config/content-policy.json`: **Persian/Iran-related signals rank first, portrait/Shorts evidence second, observed growth third, and freshness fourth**. Every destination's final export target is 1080×1920 (9:16). A source URL appearing in a Shorts list is only a vertical-format hint, not proof that the source file is exactly 9:16; source width/height evidence is recorded when available. The scout writes `out/shorts-priority.json` and `out/shorts-priority.md` through `scripts/merge_short_candidates.cjs`, merging MediaFarsi Shorts, Telegram, Aparat, and YouTube leads into one shortlist shared for editorial review and future destination adapters.

All discovery data is metadata-only. Public Telegram/Aparat availability, a YouTube Creative Commons search filter, and trend rank do **not** grant permission to republish. A YouTube/API license label is still only a clearance signal until rights in the full clip (including music and third-party material) and the intended reuse are verified. These candidates stay discovery-only until rights are independently cleared. No discovery step downloads media or publishes a post.

View the [latest scout runs](https://github.com/Mehran0960/Goushibaaz/actions/workflows/discover-filo-candidates.yml).

## Scheduled Filo publishing

The first working publishing adapter is Filo, implemented in `.github/workflows/publish-approved-video-to-filo.yml`. It runs on an automatic schedule every three hours (eight daily slots, UTC) and can also be started manually. Code edits alone do not trigger publication.

For each slot, the publisher now searches Persian/Iran-related open-license video queries first, then falls back to broader animal/visual-entertainment queries if suitable local clips are scarce. The publisher also rejects protest, political-event, war, weapon and military material; a location name such as Tehran does not make footage entertainment. It fails closed unless the file is a WebM video whose metadata explicitly confirms either CC0 1.0 or CC BY 4.0, a plausible file size, and a duration of 3–180 seconds. CC BY-NC, CC BY-ND, CC BY-SA, and uncertain licenses are excluded. Candidates with Persian/Iran-related metadata and portrait source dimensions rank ahead of general candidates. Every published output is transcoded to 1080×1920 (9:16); source aspect ratio is recorded when metadata provides it. For CC BY 4.0, the description includes the creator, source link, license link, and a modification note. The publisher converts the clip, generates a cover frame, uploads and selects the cover, fills a Persian title/description with source attribution, then submits it to Filo. Published and pending items are tracked in `state/filo-published.json` to prevent duplicate uploads. If no fresh eligible source is found, the slot is skipped instead of reusing copyrighted or uncertain material.

CC BY 4.0 permits commercial reuse and adaptation subject to attribution, source/license links, and indicating modifications; the publisher adds those elements to the description. Wikimedia license metadata does not necessarily clear separately copyrighted audio or other third-party rights, so residual rights and platform moderation still require care. See the [official CC BY 4.0 deed](https://creativecommons.org/licenses/by/4.0/deed.en).

Filo may hold new videos in a moderation/approval queue for up to 72 hours. A successful upload request is **not** a guarantee of public approval, monetization, or income. The scheduled run therefore records submission/approval status separately from a confirmed public URL. Candidate discovery from YouTube, Telegram, and Aparat remains a trend signal only; it does not itself grant permission to republish those videos.

## Other publishing destinations

Publishing destinations are being added as independent adapters so one platform failure cannot block the others. The public Rubika channel `@didobyn` is verified through the Bot API as `Channel`, title `دیدوبین`, internal ID `c0EHrgB0fb431bf54ac2552d95d29b86`. Do not use the old `RUBIKA_CHAT_ID` secret; it was rejected by `sendMessage`. Both preflight and the publisher resolve `@didobyn` directly using `RUBIKA_BOT_TOKEN`.

The independent Rubika publisher is implemented in `scripts/rubika_publish_cc0.cjs` and scheduled by `.github/workflows/publish-approved-video-to-rubika.yml` every three hours, offset from the Filo schedule, with manual dispatch available. The first real native video post succeeded (Rubika message ID `1954300513323781160`). The workflow searches Persian/Iran-related licensed videos first, then uses broader licensed fallback queries. It rejects protest, political-event, war, weapon and military footage even where the title contains an Iranian place name. It accepts only files with explicitly verified CC0 1.0 or CC BY 4.0 metadata, ranks Persian/Iran and source-portrait signals ahead of raw popularity, converts output to 1080×1920 (9:16) MP4, includes attribution/license links, and records each destination publication in `state/rubika-published.json` to avoid reposts. The Bot API upload endpoint repeatedly timed out on MP4s carrying an AAC audio stream, while silent MP4s uploaded successfully; for now, Rubika videos are exported without audio. This limitation is isolated to the Rubika adapter and does not modify Filo output. Improving audio compatibility remains a follow-up engineering task. The preflight workflow `.github/workflows/rubika-preflight.yml` resolves the channel automatically, stays read-only by default, and can optionally send then delete a temporary test message. Bale and Telegram remain separate future adapters. The Cloudflare trend-scout Worker also requires its API key and admin token to be configured as Cloudflare secrets.

## Repository layout

- `cloudflare/src/index.js` — Worker API, scheduled scanning, scoring, and candidate endpoints.
- `scripts/platform_scout.cjs` — public Telegram, Aparat, and YouTube Creative Commons-filtered metadata scouting.
- `scripts/rubika_publish_cc0.cjs` — independent, verified-license Rubika vertical-video publisher.
- `.github/workflows/publish-approved-video-to-rubika.yml` — separate Rubika schedule/dispatch and publication-state persistence.
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

