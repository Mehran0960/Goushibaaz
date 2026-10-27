# Goushibaaz — Early Viral Video Scout

Goushibaaz focuses on discovering videos that are gaining momentum **before** their viral peak, tracking measured growth rather than total views alone, and publishing eligible media through independent destination adapters.

## Current architecture

- **Cloudflare Workers + Cron:** scheduled scans and dispatch.
- **Cloudflare D1:** candidates, timestamped public-stat snapshots, growth scores, scan history, authorization evidence and independent delivery states.
- **GitHub:** version control and a manual deployment workflow.

## Current discovery behavior

The first discovery source is YouTube Data API v3. The worker samples Iran-region popular videos and periodically searches for newly published Persian-language videos. It stores repeated view snapshots and calculates views/minute plus changes in velocity. A first sighting is not treated as proof of growth.

## Filo publishing: first destination

The Worker now includes a Filo-specific queue, status, jobs, and dispatch interface:

- `GET /admin/filo/status`
- `POST /admin/filo/queue` with `{"video_id":"..."}`
- `GET /admin/filo/jobs?limit=30`
- `POST /admin/filo/dispatch`

**Important limitation:** I could not verify a public, documented Filo upload API. The public upload page sends unauthenticated visitors to login, and I will not invent a private endpoint or claim an upload worked when it did not. The Worker therefore uses an explicit connector contract instead of guessing Filo's private internals.

To complete the live upload path, configure the two secrets below to point to a legitimate, working connector that actually uploads the authorized media to the Filo account. The connector must accept an HTTPS POST with a bearer token and JSON fields `job_id`, `idempotency_key`, `title`, `description`, `media_url`, `source_url`, `license_type` and `license_evidence_url`; it must respond with JSON `{"ok":true,"post_id":"..."}` only after Filo confirms the post. Retries are idempotency-keyed and per-job.

Required connector settings:
- `FILO_UPLOAD_BRIDGE_URL` — HTTPS URL of the connector.
- `FILO_UPLOAD_BRIDGE_TOKEN` — bearer token stored as a Cloudflare Worker secret.

Do not point this at an undocumented endpoint guessed from Filo's website. The connector URL needs to be verified and operated by you or an authorized integration provider.

## Other destinations

Rubika, Bale, and Telegram will be added as separate adapters after their upload methods and account credentials are verified. Each destination uses independent delivery state and retries so failures do not block other destinations.

## Configuration

Cloudflare Worker secrets:
- `YOUTUBE_API_KEY` — Google Cloud key with YouTube Data API v3 enabled.
- `ADMIN_TOKEN` — long random bearer token for protected admin routes.
- `FILO_UPLOAD_BRIDGE_TOKEN` — only when a verified Filo connector is available.

Cloudflare Worker variable:
- `FILO_UPLOAD_BRIDGE_URL` — HTTPS connector URL, only when one is verified.

Optional variable:
- `YT_REGION_CODE`, defaults to `IR`.

Never commit secrets to GitHub or send them in chat.

## Other routes

- `GET /health` — reports service and configuration presence.
- `POST /admin/scan` — run a scan.
- `GET /admin/candidates?limit=30` — ranked candidates.
- `GET /admin/runs?limit=20` — scan history.
- `POST /admin/authorizations` — record verified commercial-use authorization; requires `video_id`, `license_type` and HTTPS `evidence_url`. Provide `media_url` as a direct, externally reachable HTTPS video file URL.

Every admin route requires `Authorization: Bearer <ADMIN_TOKEN>`.

## D1 and deployment

The D1 schema is in `schema.sql`; the initial migration is `migrations/0001_init.sql`. Use the GitHub Actions workflow `Deploy Goushibaaz trend scout` after adding repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
