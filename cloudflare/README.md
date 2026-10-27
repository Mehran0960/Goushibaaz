# Goushibaaz — Cloudflare trend scout

This branch introduces a Cloudflare-native trend-scanning backend without changing the existing Flask prototype on \`main\`.

## What it does
- Polls YouTube's public Data API for Iran-region popular videos every 10 minutes.
- Searches for newly published Persian-language videos at most once every 30 minutes. That stays under the API's default 100 \`search.list\` calls/day if the scheduler remains at this interval.
- Stores timestamped view/engagement snapshots in D1.
- Computes view velocity, compares it with the previous sampled velocity, and ranks candidates by a transparent early-growth score.
- Exposes authenticated admin endpoints for a manual scan, candidate list, scan history, and recording a verified commercial-use authorization.
- Treats first sightings as \`insufficient_history\`; it does not pretend to know a growth trend until later snapshots exist.

## Deliberate limitations
- This phase discovers and ranks candidate videos; it does not download or re-host videos by default.
- The authorization endpoint records an evidence URL and, optionally, a direct HTTPS media URL for content whose commercial reuse is actually authorized.
- Publisher adapters for Filo, Rubika, Bale, and Telegram must be added/activated only after each destination's current upload method and account credentials are verified. Each destination must have its own retry/status record so one failure cannot block the others.
- The project never logs the YouTube API key or includes it in Git.

## Configure
Required Worker secrets:
- \`YOUTUBE_API_KEY\`: a Google Cloud key with YouTube Data API v3 enabled.
- \`ADMIN_TOKEN\`: a long random bearer token for the /admin endpoints.

Optional variable:
- \`YT_REGION_CODE\`, defaults to \`IR\`.

Do not put either secret in source control or send them in chat. Add them as Cloudflare Worker secrets.

## Routes
- \`GET /health\` — exposes only whether required bindings/secrets exist.
- \`POST /admin/scan\` — run one scan. Requires \`Authorization: Bearer <ADMIN_TOKEN>\`.
- \`GET /admin/candidates?limit=30\` — ranked candidates. Requires the same bearer token.
- \`GET /admin/runs?limit=20\` — scan history.
- \`POST /admin/authorizations\` — record evidence that a video's commercial reuse is allowed; requires \`video_id\`, \`license_type\`, and HTTPS \`evidence_url\`. An optional \`media_url\` must be a direct, externally reachable HTTPS video URL.

## D1 setup
Run \`schema.sql\` against the database named \`goushibaaz-trend-db\`, then put the returned database UUID in \`wrangler.jsonc\`.

## Deployment
Use Wrangler or the GitHub workflow-dispatch action after adding repository secrets \`CLOUDFLARE_API_TOKEN\` and \`CLOUDFLARE_ACCOUNT_ID\`. Keep YouTube/admin tokens as Worker secrets, not GitHub repository variables.
