# Goushibaaz — Early Viral Video Scout

Goushibaaz is focused on one job: discover videos that are gaining momentum **before** they reach their viral peak, rank them using observed growth rather than total views alone, and provide a reliable foundation for publishing selected videos through independent destination adapters.

## Current architecture

- **Cloudflare Workers + Cron:** scheduled scans.
- **Cloudflare D1:** candidates, timestamped public-stat snapshots, trend scores, scan history, verified reuse authorization, and per-destination delivery state.
- **GitHub:** source control and a manual deployment workflow.

## How the scout ranks candidates

The current first source is YouTube Data API v3. The worker samples video statistics, stores snapshots, calculates views per minute and changes in that velocity, and ranks newer candidates with stronger growth. A first sighting is not treated as proof of growth; repeated observations are required.

The current discovery source is a signal, not a guarantee that a video will go viral. Additional sources can be added behind the same discovery interface.

The multi-source trend-intelligence pipeline keeps a free 15-minute discovery pass and adds a separate Firecrawl-backed pass every four hours. The paid pass rotates two searches per run and obeys the persisted internal ceiling of 800 credits/month; the six-runs/day schedule is sized for at most about 720 credits in a 30-day month, leaving a reserve. It reads `FIRECRAWL_API_KEY` from GitHub Actions Secrets (or a protected Actions variable fallback); missing credentials safely fall back to free discovery. Pexels is enabled separately through `PEXELS_API_KEY` in the shared publisher and Filo publisher; workflows log credential presence only, never the key value.

## Scheduled Persian-first Shorts scout

The GitHub Actions workflow `.github/workflows/discover-filo-candidates.yml` runs every two hours and can also be started manually. It dynamically crawls MediaFarsi home/ranking/new-channel/statistics pages, up to 100 sitemap targets at the first level, 150 additional sitemap targets, and up to 150 relevant category pages. It scans up to **1,000 Persian channel Shorts pages per run**: 100 priority channels plus a rotating window of up to 900 other discovered channels. Each run exports the complete discovered/selected channel registry in `out/mediafarsi-source-catalog.json`; URLs that fail or return no video cards are recorded as discovery errors rather than treated as active sources.

The additional public-source scout checks **28 fixed Telegram video channels plus up to 180 directory-discovered channels**, using 21 public Telegram directory/search pages; approximately **100 Aparat search queries** and **90 YouTube Creative Commons-filtered queries** cover Persian comedy, animals, visual entertainment, sports, food, nature, science, DIY, satisfying processes, and other short-form topics. Rotating public-web searches also cover Instagram Reels, TikTok, YouTube Shorts, X, Facebook Reels, Reddit, Vimeo, Dailymotion, Twitch clips and Rumble, with new metadata search lanes for **Snapchat Spotlight, Likee, Kwai and Bilibili**. These social-platform URLs remain discovery signals only; their video files are not downloaded or reposted without verified reuse rights. The scan runs with bounded concurrency to reduce burst failures. Repeated view snapshots are maintained in `state/trends.json` and `state/platform-trends.json`.

The shared policy lives in `config/content-policy.json`: **Iranian-audience fit and a strong entertainment hook rank first**, with measured growth, Persian/local relevance, freshness and topic diversity supporting the final choice. Priority lanes include Persian comedy, hidden-camera, reactions, surprise/payoff, sports skills, useful technology demos, food, transformations and other relatable entertainment. This content-priority model is adapted from the audience-triage approach in `TrendsUpLoader`; trends remain discovery signals, not permission to reuse. Every destination exports 9:16. Landscape sources are fitted in full over a blurred background; the foreground itself is not cropped. The scout writes `out/shorts-priority.json` and `out/shorts-priority.md` through `scripts/merge_short_candidates.cjs`, merging MediaFarsi Shorts, Telegram, Aparat, and YouTube leads into one shortlist shared for editorial review and future destination adapters.

All discovery data is metadata-only. Public Telegram/Aparat availability, a YouTube Creative Commons search filter, and trend rank do **not** grant permission to republish. A YouTube/API license label is still only a clearance signal until rights in the full clip (including music and third-party material) and the intended reuse are verified. These candidates stay discovery-only until rights are independently cleared. No discovery step downloads media or publishes a post.

View the [latest scout runs](https://github.com/Mehran0960/Goushibaaz/actions/workflows/discover-filo-candidates.yml).

## Filo: first revenue-focused destination

Filo runs as an independent scheduled publisher, separate from the shared Telegram/Bale/Rubika pipeline. Its workflow `.github/workflows/publish-approved-video-to-filo.yml` now wakes every **five minutes**, continuously across the day. The publisher enforces a minimum five-minute gap and a ceiling of **288 attempts per UTC day**, including manual starts. This is a maximum technical ceiling, not a promise or target: an attempt still requires a fresh eligible video, verified reuse rights, successful media preparation and Filo acceptance. Its own concurrency group and publication ledger prevent overlapping submissions. A long upload, GitHub scheduling delay, Filo moderation or lack of suitable licensed media can make the real interval longer.

The Filo selector combines Persian-first and broad entertainment discovery, then ranks eligible candidates using Iranian audience fit, a clear single-event hook/payoff, freshness, observed growth, recent trend momentum and category diversity. Generic institutional/space footage, current-affairs, sensitive and promotional content are excluded or heavily deprioritized. This ranking is inspired by `TrendsUpLoader`'s preferred entertainment lanes and safety gates. Each five-minute slot rotates a bounded batch of Wikimedia Commons and Internet Archive queries (four local plus six broad Commons queries; three local plus three broad Archive queries) and adds up to two queries derived from currently observed fast-growing entertainment titles. The trend scorer uses repeated view-count snapshots: first-seen lifetime-view rates remain explicitly marked as estimates, while observed velocity and positive acceleration guide lead selection. Acceleration adds ranking weight only when the licensed candidate also has a strong title match to that trend. This looks for a licensed version or closely related source material; title similarity is only a relevance signal, not proof that two clips are identical. Trend leads are restricted to approved entertainment lanes and observed (not estimated) view velocity. Each source's item-level license and media file are still checked before download; CC0 1.0, CC BY 4.0 and CC BY-SA 4.0 are accepted; attribution and modification details are retained for both attribution licences, and CC BY-SA derivatives are labelled under the same share-alike terms. Unknown or unauthorized sources are not downloaded or published. **There is no synthetic puzzle fallback in the Filo production path:** when no external candidate passes the license, media and duration checks, that scheduled slot records `no_eligible_licensed_candidate` and sends nothing. This preserves the chosen licensed-media-only model.

Filo outputs use 720×1280 (9:16), preserve an existing licensed source audio track, and fit the complete source frame over a blurred background so the foreground is not cropped. A relevant, high-quality cover is still generated. Titles are Persian, directly related to the clip and avoid emoji-heavy or exaggerated wording. The description carries source and license details and asks viewers to follow گوشی‌باز. Each video ends with a 1.6-second, fully Persian, high-contrast follow card: «برای ویدیوهای بیشتر | گوشی‌باز را در فیلو دنبال کنید». This is channel promotion, not a claim of ownership. The publishing script uploads and explicitly selects a generated cover before submission.

The state ledger distinguishes `submitted_pending_approval` from `published`. A successful submission request or a post URL alone is not proof that the video is publicly active or earning revenue. The system only marks `published` after the account page shows an active status. Filo's moderation, view qualification, RPM and actual payments remain platform-controlled; uploads do not guarantee income.

### Optional licensed stock-video supply: Pexels

- The independent Filo publisher and the shared Telegram/Bale/Rubika preparation path can use the official Pexels Videos API as an optional extra source. The adapter searches using the top currently observed trend lead; when no fresh lead exists it uses Pexels' popular-video endpoint. Pexels does not provide per-video view-velocity data through this integration, so no acceleration score is fabricated for stock clips.
- The API is polled at most once per 15 minutes per publishing path and only when `PEXELS_API_KEY` is configured. Without that secret, the module returns an empty candidate list and Wikimedia Commons / Internet Archive discovery continues normally.
- The adapter accepts only Pexels-hosted video pages and HTTPS MP4 files, checks duration, audio, dimensions and relevance, credits the contributor and links to the original Pexels page and license. The output adds a Persian editorial title overlay, vertical composition and the channel end card; raw standalone stock reposting is not the intended use.
- Add the key in GitHub repository Settings → Secrets and variables → Actions → New repository secret, named `PEXELS_API_KEY`. Never put the key in source files or chat. A Pexels API key is not currently present in the repository, so this source remains inactive until that secret is added.
- Pexels has its own content and API rules. A public stock license does not clear third-party trademarks, people, privacy or other rights in every clip; candidates that fail validation are skipped.

## Multi-source trend intelligence

- A separate, free trend-intelligence workflow runs every **15 minutes**. To keep the higher refresh rate from multiplying polling load, it rotates **24 of 48** curated public Persian Telegram feeds per run (a complete pass about every 30 minutes) and **24 of 48** YouTube global-chart region/category buckets per run (a complete pass about every 30 minutes). It rotates Bing-indexed searches across Instagram, TikTok, YouTube, Aparat, X, Facebook Reels, Reddit, Vimeo, Dailymotion, Twitch, Rumble, Snapchat Spotlight, Likee, Kwai and Bilibili. The official YouTube Data API is used only when `YOUTUBE_API_KEY` is configured: search calls remain capped at **30/day**, spaced at least 48 minutes apart, while chart reads are rotated to preserve the existing request volume. Paid Firecrawl search is disabled in this adapter.
- Each 15-minute scan stores a bounded candidate/history ledger in `state/trend-intelligence.json`.
- Topic momentum is converted into `state/platform-trends.json`, which the existing editorial ranker already reads to adjust the next licensed-media selection. This makes viral demand a ranking signal rather than a shortcut around rights checks.
- Public-channel and social-platform candidates are discovery signals only. Their public availability, view counts, or source popularity do not grant permission to download or republish. Public publishing continues to require the existing verified CC0 / CC BY 4.0 / CC BY-SA 4.0 or explicit creator-permission gate.
- A successful first scan collected more than 200 fresh candidate records from Telegram feeds in one pass. Search engines and optional API lanes can return zero results or be unavailable; each source is best-effort and no single source is a hard dependency.

## Current publishing focus: Telegram, Rubika and Bale

The project now uses a **single shared licensed-video preparation pipeline**. The central scheduler dispatches `.github/workflows/prepare-shared-video.yml`; it discovers a fresh entertainment candidate, verifies item-level commercial reuse rights and source audio, converts it once to an audio-preserving 1080×1920 (9:16) MP4, and creates one SHA-256-verified manifest/artifact. The full source frame remains visible in front of a blurred background instead of losing edge content to a center crop. Once an eligible artifact is uploaded, the preparation workflow dispatches Telegram, Bale and Rubika separately with `workflow_dispatch`, passing the exact preparation run ID to each destination. Dispatch requests run concurrently; a failed request is recorded as deferred and never prevents the other destinations from starting. Each destination has its own adapter, concurrency group, credentials, deduplication and publication state; a failure in one destination cannot stop the other destinations or the next discovery slot.

- Rights-cleared discovery rotates bounded Wikimedia Commons and Internet Archive query batches on each shared-preparation slot, currently adding up to two leads from the measured trend ledger. A positive acceleration score is applied only to a licensed candidate whose source title strongly matches an observed rising-view lead. NASA/institutional public-media footage is deliberately disabled for this entertainment publisher. Every downloaded source is rechecked against its own CC0 1.0, CC BY 4.0 or CC BY-SA 4.0 metadata, public media URL, supported WebM/MP4 container, size, duration and audio-track presence before conversion.
- Editorial ranking follows the `TrendsUpLoader`-style Persian audience lanes, observed trend momentum, clear hooks and payoffs, freshness, local relevance and category diversity. Current-affairs, promotional, sensitive and weapons/military content is excluded from automated entertainment publishing; roundups are penalized. Scores never grant publication rights.
- Shared preparation and cross-destination dedupe: `scripts/rubika_publish_cc0.cjs`, `state/shared-publications.json`, and artifact `goushibaaz-shared-candidate`.
- Independent Iranian-platform adapters: `scripts/telegram_publish.cjs`, `scripts/rubika_publish_shared.cjs` and `scripts/bale_publish.cjs`, with shared Telegram/Bale transport and validation in `scripts/platform_publish.cjs`.
- Destination state: `state/telegram-published.json`, `state/rubika-published.json` and `state/bale-published.json`.
- The scheduler checks every five minutes (GitHub Actions' minimum scheduled interval) and aims to start the next shared preparation at that cadence. It can intentionally lengthen the interval when runner concurrency, GitHub API quota, missing external capacity data or repeated no-candidate outcomes make faster starts unreliable. An active preparation is rechecked after five minutes. GitHub may delay scheduled workflow starts, so this is a best-effort cadence rather than a real-time SLA. A slow or failed destination never blocks fresh discovery slots; only that destination's own workflow queue/retry path is affected. The capacity model budgets for preparation plus three destination runs.
- Public sending is explicitly enabled for Telegram, Bale and Rubika: each destination workflow sets its own `GOUSHIBAAZ_PUBLIC_PUBLISH_ENABLED=true` and `GOUSHIBAAZ_FIRST_PUBLICATION_APPROVED=true`. This removes dependence on a shared repository variable. Each destination still resolves and validates its own bot/channel at send time, keeps its own idempotency ledger and concurrency group, and records success/failure independently.
- Telegram, Bale and Rubika each resolve and validate the intended channel at execution time and use the numeric ID returned by their own platform APIs; stale or missing stored numeric channel IDs do not block channel resolution.
- Each destination workflow explicitly enables public sending and first-post approval. The adapter integration test runs in dry-run mode against one identical artifact and sends no public messages.

Filo remains independently scheduled every five minutes and does not block the shared Telegram/Rubika/Bale publisher scheduler. Both publishing paths use bounded rotating source queries plus a trend-title search lead; their actual publication rate remains conditional on rights-cleared media supply, job completion and destination acceptance.

### Destination availability

The currently wired public publishing destinations are **Filo, Telegram, Bale and Rubika**. Filo has its own licensed-media discovery and upload workflow with a five-minute best-effort schedule and five-minute minimum attempt gap; it can make up to 288 attempts per UTC day, but only submits when a fresh video clears the reuse-rights and media checks. Telegram, Rubika and Bale receive the same prepared artifact through three independent workflows with separate gates, concurrency groups, credentials and state files. Telegram is an active automatic publishing destination with its own workflow, bot credentials, idempotency ledger and publication state; public Telegram channels also remain discovery sources. A delivery failure or timeout in one destination does not cancel the other destination or the next discovery slot. The shared preparation stage remains a common upstream dependency: when it produces no eligible artifact, its consumers send nothing.

YouTube and Aparat are currently **discovery sources only**, not upload destinations in this repository. The YouTube API key is used for search/statistics; a separate OAuth credential with the `youtube.upload` scope is required for the official upload API. Aparat has no uploader adapter in this repository; an official supported upload integration must be confirmed before adding an automated destination. Do not treat a discovered video source as a publication destination.

### Failure isolation and next-round handling

- Each shared publication round is tied to one preparation run ID. Telegram, Bale and Rubika are dispatched independently only when that run contains a validated `prepared` manifest and its video artifact.
- A failed dispatch request or destination run ends only that destination's attempt. It does not cancel, wait for, or block the remaining destinations, Filo's independent schedule, or the next content-discovery round. There is no immediate same-round retry; the next scheduled round provides the next opportunity.
- Failures that occur before a send is attempted are recorded as retryable in that destination's own state file. An ambiguous submission after a send starts remains protected by the `send_started` / `submitted_unconfirmed` idempotency guard, so a possible successful post is not blindly duplicated.
- `no_eligible_candidate` and rights-based rejection remain content-selection outcomes, not destination outages. If there is no eligible shared artifact, no destination upload workflow is started for that round.

## Repository layout

- `cloudflare/src/index.js` — Worker API, scheduled scanning, scoring, and candidate endpoints.
- `scripts/platform_scout.cjs` — public Telegram, Aparat, and YouTube Creative Commons-filtered metadata scouting.
- `scripts/rubika_publish_cc0.cjs` — shared licensed-source discovery and audio-preserving vertical-video preparation.
- `scripts/media_format.cjs` — shared full-frame 9:16 conversion, blurred background, source-audio validation and AAC preservation.
- `scripts/trend_discovery.cjs` — observed-trend title extraction, rotating five-minute archive query batches and Iranian-audience lane weighting.
- `scripts/test_media_format.cjs` — regression tests for full-frame vertical output and retained audio.
- `.github/workflows/publish-shared-video-to-telegram.yml` — Telegram artifact fan-out, independent delivery and publication-state persistence.
- `.github/workflows/publish-approved-video-to-rubika.yml` — Rubika manual dispatch and independent publication-state persistence.
- `.github/workflows/dispatch-short-publishers.yml` — synchronized central cron runner and cache-backed scheduler-state persistence.
- `scripts/synchronized_scheduler.cjs` — adaptive five-minute minimum shared preparation cadence, concurrent destination fan-out, account-load/API feedback, and a 1,200-start daily safety ceiling.
- `state/telegram-published.json` — Telegram-only deduplication and destination message IDs.
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

