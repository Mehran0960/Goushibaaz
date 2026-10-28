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

The GitHub Actions workflow `.github/workflows/discover-filo-candidates.yml` runs every two hours and can also be started manually. It renders public Shorts lists from fourteen MediaFarsi channel pages and collects metadata-only leads from public Telegram channels, Aparat search results, and eight YouTube searches filtered by the public Creative Commons search option. The scouting output is stored in the `filo-candidate-discovery` workflow artifact; repeated view snapshots are maintained separately in `state/trends.json` and `state/platform-trends.json`. Persian-language content ranks first; hidden-camera moments, CCTV/dashcam clips, funny animals, visual comedy, and satisfying clips form a separate visual-first review category. Sources that do not yield video cards are reported and replaced after a successful scan. A view-per-hour estimate from one scan is only a proxy; observed velocity requires repeat observations after a sufficient interval.

The scout prioritizes Persian-language entertainment and flags videos that may be language-neutral. YouTube Creative Commons-filtered results are a lead only, not final rights clearance: public pages often do not expose a verifiable license label, and third-party content may contain separately copyrighted music or clips. Public visibility, the Creative Commons search filter, and trend rank do **not** by themselves establish permission to commercialize every component. Candidates remain ineligible for upload until rights/permission and Filo compliance are verified. No discovery step downloads media or publishes a post.

View the [latest scout runs](https://github.com/Mehran0960/Goushibaaz/actions/workflows/discover-filo-candidates.yml).

## Scheduled Filo publishing

The first working publishing adapter is Filo, implemented in `.github/workflows/publish-approved-video-to-filo.yml`. It runs on an automatic schedule every three hours (eight daily slots, UTC) and can also be started manually. Code edits alone do not trigger publication.

For each slot, the publisher searches Wikimedia Commons for a fresh, non-duplicate animal/visual-first short. It fails closed unless the file is a WebM video whose metadata explicitly confirms either CC0 1.0 or CC BY 4.0, a plausible file size, and a duration of 3–180 seconds. CC BY-NC, CC BY-ND, CC BY-SA, and uncertain licenses are excluded. For CC BY 4.0, the description includes the creator, source link, license link, and a note that the video was cropped/transcoded to vertical 9:16. The publisher converts the clip, generates a cover frame, uploads and selects the cover, fills a Persian title/description with source attribution, then submits it to Filo. Published and pending items are tracked in `state/filo-published.json` to prevent duplicate uploads. If no fresh eligible source is found, the slot is skipped instead of reusing copyrighted or uncertain material.

CC BY 4.0 permits commercial reuse and adaptation subject to attribution, source/license links, and indicating modifications; the publisher adds those elements to the description. Wikimedia license metadata does not necessarily clear separately copyrighted audio or other third-party rights, so residual rights and platform moderation still require care. See the [official CC BY 4.0 deed](https://creativecommons.org/licenses/by/4.0/deed.en).

Filo may hold new videos in a moderation/approval queue for up to 72 hours. A successful upload request is **not** a guarantee of public approval, monetization, or income. The scheduled run therefore records submission/approval status separately from a confirmed public URL. Candidate discovery from YouTube, Telegram, and Aparat remains a trend signal only; it does not itself grant permission to republish those videos.

## Other publishing destinations

The planned destinations are **Rubika, Bale, and Telegram** as independent adapters. Rubika is the next integration. The public channel `@didobyn` has been resolved and verified through the official Bot API: channel ID `c0EHrgB0fb431bf54ac2552d95d29b86`, title `دیدوبین`, type `Channel`. The earlier `RUBIKA_CHAT_ID` value was rejected by `sendMessage`; the preflight no longer depends on that secret and resolves `@didobyn` directly. A real send/delete test succeeded, confirming the bot can post to the channel and remove the test message. `.github/workflows/rubika-preflight.yml` now validates `RUBIKA_BOT_TOKEN`, resolves the right channel automatically, keeps routine checks read-only, and cleans up the optional test post. This is a connection test only; the automated Rubika video publisher and independent retry/state handling remain to be implemented next. Bale and Telegram will follow as separate adapters, and a failure at one destination must never block the others. The Cloudflare trend-scout Worker also requires its API key and admin token to be configured as Cloudflare secrets.

## Repository layout

- `cloudflare/src/index.js` — Worker API, scheduled scanning, scoring, and candidate endpoints.
- `scripts/platform_scout.cjs` — public Telegram, Aparat, and YouTube Creative Commons-filtered metadata scouting.
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

