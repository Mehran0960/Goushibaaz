const YOUTUBE_API = "https://www.googleapis.com/youtube/v3/";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function safeError(error) {
  const text = String(error && error.message ? error.message : error);
  return text.replace(/([?&]key=)[^&]+/gi, "$1[redacted]").slice(0, 500);
}

let githubSigningKeysCache = { expiresAt: 0, keys: [] };

function base64ToBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function verifyGitHubActionsToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("invalid GitHub OIDC token");
  const header = JSON.parse(new TextDecoder().decode(base64ToBytes(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(base64ToBytes(parts[1])));
  if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported GitHub OIDC signature");

  if (Date.now() > githubSigningKeysCache.expiresAt) {
    const response = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks", {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error("unable to retrieve GitHub OIDC signing keys");
    const body = await response.json();
    githubSigningKeysCache = {
      expiresAt: Date.now() + 10 * 60 * 1000,
      keys: Array.isArray(body.keys) ? body.keys : []
    };
  }

  const jwk = githubSigningKeysCache.keys.find(item => item.kid === header.kid);
  if (!jwk) throw new Error("GitHub OIDC signing key was not found");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signatureValid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    publicKey,
    base64ToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  if (!signatureValid) throw new Error("GitHub OIDC signature is invalid");

  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== "https://token.actions.githubusercontent.com") throw new Error("unexpected OIDC issuer");
  if (!audience.includes("goushibaaz-trend-scout")) throw new Error("unexpected OIDC audience");
  if (claims.repository !== "Mehran0960/Goushibaaz") throw new Error("unexpected repository");
  if (claims.ref !== "refs/heads/main") throw new Error("only the main branch may ingest data");
  if (claims.workflow_ref !== "Mehran0960/Goushibaaz/.github/workflows/trend-scout-scan.yml@refs/heads/main") {
    throw new Error("unexpected workflow identity");
  }
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= now) throw new Error("OIDC token expired");
  if (claims.nbf && Number(claims.nbf) > now + 60) throw new Error("OIDC token is not active yet");
  return claims;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function classifyContent(title, channelTitle, audioLanguage, defaultLanguage) {
  const text = (String(title || "") + " " + String(channelTitle || "")).normalize("NFKC").toLowerCase();
  const language = (String(audioLanguage || "") + " " + String(defaultLanguage || "")).toLowerCase();
  const hasPersianMetadata = /(^|[^a-z])fa([_-][a-z]{2,4})?([^a-z]|$)|persian|farsi/.test(language);
  const hasPersianScript = /[\u067e\u0686\u0698\u06af\u06a9\u06cc]/.test(text);
  const hasPersianTerms = /طنز|فان|خنده|دوربین مخفی|شکار لحظه|سوتی|کلیپ خنده|ولاگ|سرگرمی|چالش|باورنکردنی|عجیب ترین|حیوانات بامزه/.test(text);

  if (hasPersianMetadata || hasPersianScript || hasPersianTerms) {
    return {
      contentFit: "persian_priority",
      languageHint: "fa",
      fitReason: hasPersianMetadata ? "YouTube language metadata indicates Persian" : "Persian title or channel signals"
    };
  }

  const visualFirstPattern = /\b(cctv|dashcam|body ?cam|security camera|caught on camera|instant karma|near miss|epic fails?|funny moments|unexpected moments|oddly satisfying|satisfying video|no talking|without talking|silent comedy|slapstick|animal fails?|pets being silly)\b|\b(visual comedy|wordless|nonverbal)\b/i;
  if (visualFirstPattern.test(text)) {
    return {
      contentFit: "language_neutral_candidate",
      languageHint: "visual-first-review",
      fitReason: "Title suggests CCTV, visual comedy, animals, fails, or a no-dialogue format; verify the clip visually before reuse"
    };
  }

  return {
    contentFit: "other_language_review",
    languageHint: language || "unknown",
    fitReason: "No reliable Persian-language or language-neutral signal in public metadata"
  };
}

function parseVideo(item) {
  const stats = item.statistics || {};
  const snippet = item.snippet || {};
  const details = item.contentDetails || {};
  const viewCount = Number(stats.viewCount);
  if (!item.id || !Number.isFinite(viewCount)) return null;
  const fit = classifyContent(snippet.title, snippet.channelTitle, snippet.defaultAudioLanguage, snippet.defaultLanguage);
  return {
    id: String(item.id),
    title: String(snippet.title || "Untitled").slice(0, 500),
    channelId: snippet.channelId || null,
    channelTitle: String(snippet.channelTitle || "").slice(0, 250),
    publishedAt: snippet.publishedAt || null,
    views: viewCount,
    likes: stats.likeCount == null ? null : Number(stats.likeCount),
    comments: stats.commentCount == null ? null : Number(stats.commentCount),
    duration: details.duration || null,
    sourceLicense: item.status && item.status.license ? item.status.license : null,
    contentFit: fit.contentFit,
    languageHint: fit.languageHint,
    fitReason: fit.fitReason,
    sourceUrl: "https://www.youtube.com/watch?v=" + encodeURIComponent(String(item.id))
  };
}

async function youtube(path, params, apiKey) {
  const url = new URL(path, YOUTUBE_API);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("key", apiKey);
  const response = await fetch(url.toString(), { headers: { accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = body && body.error && body.error.errors && body.error.errors[0]
      ? body.error.errors[0].reason
      : "request_failed";
    throw new Error("YouTube API " + path + " returned HTTP " + response.status + " (" + reason + ")");
  }
  return body;
}

function scoreVideo(video, history, observedAt) {
  const nowMs = Date.parse(observedAt);
  const ageHours = video.publishedAt
    ? Math.max(0, (nowMs - Date.parse(video.publishedAt)) / 3600000)
    : 72;
  const prior1 = history[0] || null;
  const prior2 = history[1] || null;
  const prior3 = history[2] || null;
  const minsSincePrior = prior1
    ? Math.max(1, (nowMs - Date.parse(prior1.observed_at)) / 60000)
    : 0;
  const currentRate = prior1
    ? Math.max(0, (video.views - Number(prior1.views)) / minsSincePrior)
    : 0;
  let previousRate = 0;
  if (prior1 && prior2) {
    const period = Math.max(1, (Date.parse(prior1.observed_at) - Date.parse(prior2.observed_at)) / 60000);
    previousRate = Math.max(0, (Number(prior1.views) - Number(prior2.views)) / period);
  }
  const growthRatio = currentRate > 0 ? currentRate / Math.max(previousRate, 0.5) : 0;
  const freshness = 18 * Math.exp(-ageHours / 36);
  const velocityPoints = Math.min(45, 15 * Math.log10(currentRate + 1));
  const accelerationPoints = prior2
    ? Math.min(30, Math.max(0, (growthRatio - 1) * 20))
    : 0;
  const growthScore = Math.round(Math.min(100, freshness + velocityPoints + accelerationPoints) * 100) / 100;
  let state = "insufficient_history";
  if (prior1) state = "observing";
  if (prior2 && currentRate >= 5 && growthRatio >= 1.25) state = "emerging";
  if (prior2 && currentRate >= 20 && growthRatio >= 1.1) state = "fast_growth";
  if (video.publishedAt && ageHours > 168) state = "older_video";
  return {
    currentRate: Math.round(currentRate * 100) / 100,
    previousRate: Math.round(previousRate * 100) / 100,
    growthRatio: Math.round(growthRatio * 100) / 100,
    growthScore,
    state,
    snapshotCount: history.length + 1
  };
}

async function ingestYoutubeItems(env, rawItems, source) {
  if (!env.DB) return { ok: false, status: "configuration_required", missing: ["D1 binding DB"] };

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const observedAt = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  await env.DB.prepare(
    "INSERT INTO scan_runs (id, source, started_at, status) VALUES (?, ?, ?, 'running')"
  ).bind(runId, String(source || "github_actions").slice(0, 80), startedAt).run();

  try {
    const itemsById = new Map();
    for (const item of (Array.isArray(rawItems) ? rawItems : [])) {
      const parsed = parseVideo(item);
      if (parsed) itemsById.set(parsed.id, parsed);
    }
    const videos = [...itemsById.values()];
    if (!videos.length) {
      const finishedAt = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE scan_runs SET finished_at = ?, status = 'success', candidate_count = 0, emerging_count = 0, note = ? WHERE id = ?"
      ).bind(finishedAt, "No valid YouTube video records received", runId).run();
      return { ok: true, runId, source, received: rawItems.length, scanned: 0, emerging: 0, observedAt };
    }

    const cutoff = new Date(Date.parse(observedAt) - 90 * 60000).toISOString();
    const historyResult = await env.DB.prepare(
      "WITH ranked AS (" +
      " SELECT video_id, views, observed_at, " +
      " ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY observed_at DESC) AS rn " +
      " FROM video_snapshots WHERE observed_at >= ? AND observed_at < ?" +
      ") SELECT video_id, views, observed_at, rn FROM ranked WHERE rn <= 3"
    ).bind(cutoff, observedAt).all();
    const histories = new Map();
    for (const row of (historyResult.results || [])) {
      if (!histories.has(row.video_id)) histories.set(row.video_id, []);
      histories.get(row.video_id).push(row);
    }
    for (const rows of histories.values()) rows.sort((a, b) => Number(a.rn) - Number(b.rn));

    const snapshotStatements = [];
    const candidateStatements = [];
    let emergingCount = 0;
    for (const video of videos) {
      const history = histories.get(video.id) || [];
      const score = scoreVideo(video, history, observedAt);
      if (score.state === "emerging" || score.state === "fast_growth") emergingCount++;
      snapshotStatements.push(env.DB.prepare(
        "INSERT OR IGNORE INTO video_snapshots " +
        "(video_id, observed_at, views, likes, comments) VALUES (?, ?, ?, ?, ?)"
      ).bind(video.id, observedAt, video.views, video.likes, video.comments));
      candidateStatements.push(env.DB.prepare(
        "INSERT INTO video_candidates " +
        "(video_id, source_platform, source_url, title, channel_id, channel_title, published_at, " +
        "first_seen_at, last_seen_at, view_count, like_count, comment_count, duration, source_license, " +
        "views_per_minute, previous_views_per_minute, growth_ratio, growth_score, snapshot_count, trend_state, " +
        "content_fit, language_hint, fit_reason, updated_at) " +
        "VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(video_id) DO UPDATE SET " +
        "source_url=excluded.source_url, title=excluded.title, channel_id=excluded.channel_id, " +
        "channel_title=excluded.channel_title, published_at=excluded.published_at, last_seen_at=excluded.last_seen_at, " +
        "view_count=excluded.view_count, like_count=excluded.like_count, comment_count=excluded.comment_count, " +
        "duration=excluded.duration, source_license=excluded.source_license, views_per_minute=excluded.views_per_minute, " +
        "previous_views_per_minute=excluded.previous_views_per_minute, growth_ratio=excluded.growth_ratio, " +
        "growth_score=excluded.growth_score, snapshot_count=video_candidates.snapshot_count + 1, trend_state=excluded.trend_state, " +
        "content_fit=excluded.content_fit, language_hint=excluded.language_hint, fit_reason=excluded.fit_reason, " +
        "updated_at=excluded.updated_at"
      ).bind(
        video.id, video.sourceUrl, video.title, video.channelId, video.channelTitle, video.publishedAt,
        observedAt, observedAt, video.views, video.likes, video.comments, video.duration, video.sourceLicense,
        score.currentRate, score.previousRate, score.growthRatio, score.growthScore, score.snapshotCount,
        score.state, video.contentFit, video.languageHint, video.fitReason, observedAt
      ));
    }
    if (candidateStatements.length) await env.DB.batch(candidateStatements);
    if (snapshotStatements.length) await env.DB.batch(snapshotStatements);

    const finishedAt = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE scan_runs SET finished_at = ?, status = 'success', candidate_count = ?, emerging_count = ?, note = ? WHERE id = ?"
    ).bind(finishedAt, videos.length, emergingCount, null, runId).run();

    return {
      ok: true,
      runId,
      source,
      received: rawItems.length,
      scanned: videos.length,
      emerging: emergingCount,
      observedAt
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = safeError(error);
    await env.DB.prepare(
      "UPDATE scan_runs SET finished_at = ?, status = 'failed', note = ? WHERE id = ?"
    ).bind(finishedAt, message, runId).run().catch(() => {});
    return { ok: false, runId, status: "ingest_failed", error: message };
  }
}

async function dispatchFiloJobs(env, limit = 2) {
  if (!env.DB) return { ok: false, skipped: true, reason: "D1 binding DB is not configured" };
  if (!env.FILO_UPLOAD_BRIDGE_URL || !env.FILO_UPLOAD_BRIDGE_TOKEN) {
    return { ok: true, skipped: true, reason: "Filo connector not configured" };
  }

  let bridgeUrl;
  try {
    bridgeUrl = new URL(env.FILO_UPLOAD_BRIDGE_URL);
  } catch {
    return { ok: false, skipped: true, reason: "FILO_UPLOAD_BRIDGE_URL is invalid" };
  }
  if (bridgeUrl.protocol !== "https:") {
    return { ok: false, skipped: true, reason: "Filo connector URL must use HTTPS" };
  }

  const now = new Date().toISOString();
  const found = await env.DB.prepare(
    "SELECT d.id AS job_id, d.video_id, d.attempt_count, c.source_url, c.title, c.channel_title, " +
    "c.published_at, c.view_count, p.license_type, p.evidence_url, p.media_url " +
    "FROM delivery_jobs d " +
    "JOIN video_candidates c ON c.video_id = d.video_id " +
    "JOIN publication_authorizations p ON p.video_id = d.video_id AND p.status = 'approved' " +
    "WHERE d.destination = 'filo' AND d.status IN ('pending', 'retry') " +
    "AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?) " +
    "AND p.media_url IS NOT NULL " +
    "ORDER BY d.created_at ASC LIMIT ?"
  ).bind(now, limit).all();

  const jobs = found.results || [];
  const results = [];
  for (const job of jobs) {
    const attempt = Number(job.attempt_count || 0) + 1;
    const claimed = await env.DB.prepare(
      "UPDATE delivery_jobs SET status = 'processing', attempt_count = ?, updated_at = ?, last_error = NULL " +
      "WHERE id = ? AND status IN ('pending', 'retry')"
    ).bind(attempt, new Date().toISOString(), job.job_id).run();

    if (!claimed.meta || Number(claimed.meta.changes || 0) === 0) {
      results.push({ job_id: job.job_id, status: "skipped", reason: "already claimed" });
      continue;
    }

    try {
      const response = await fetch(bridgeUrl.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "authorization": "Bearer " + env.FILO_UPLOAD_BRIDGE_TOKEN,
          "idempotency-key": "goushibaaz-filo-" + job.video_id
        },
        body: JSON.stringify({
          platform: "filo",
          job_id: job.job_id,
          idempotency_key: "goushibaaz-filo-" + job.video_id,
          video_id: job.video_id,
          title: String(job.title || "").slice(0, 300),
          description: "منبع: " + String(job.channel_title || "منبع ویدئو") +
            (job.source_url ? "\nلینک منبع: " + job.source_url : ""),
          source_url: job.source_url,
          media_url: job.media_url,
          license_type: job.license_type,
          license_evidence_url: job.evidence_url
        }),
        signal: AbortSignal.timeout(20000)
      });

      const payload = await response.json().catch(() => ({}));
      const postId = payload && (payload.post_id || payload.video_id || payload.id);
      if (response.ok && payload && payload.ok === true && postId) {
        const postRef = String(postId).slice(0, 500);
        await env.DB.prepare(
          "UPDATE delivery_jobs SET status = 'published', destination_post_id = ?, last_error = NULL, " +
          "next_attempt_at = NULL, updated_at = ? WHERE id = ?"
        ).bind(postRef, new Date().toISOString(), job.job_id).run();
        results.push({ job_id: job.job_id, status: "published", destination_post_id: postRef });
      } else {
        const reason = "connector HTTP " + response.status + ": " +
          String((payload && (payload.error || payload.message)) || "missing ok=true and post_id").slice(0, 350);
        const delayMinutes = Math.min(360, Math.pow(2, Math.min(attempt, 8)));
        const nextAttempt = new Date(Date.now() + delayMinutes * 60000).toISOString();
        await env.DB.prepare(
          "UPDATE delivery_jobs SET status = 'retry', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?"
        ).bind(reason, nextAttempt, new Date().toISOString(), job.job_id).run();
        results.push({ job_id: job.job_id, status: "retry", error: reason, next_attempt_at: nextAttempt });
      }
    } catch (error) {
      const reason = safeError(error);
      const delayMinutes = Math.min(360, Math.pow(2, Math.min(attempt, 8)));
      const nextAttempt = new Date(Date.now() + delayMinutes * 60000).toISOString();
      await env.DB.prepare(
        "UPDATE delivery_jobs SET status = 'retry', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?"
      ).bind(reason, nextAttempt, new Date().toISOString(), job.job_id).run();
      results.push({ job_id: job.job_id, status: "retry", error: reason, next_attempt_at: nextAttempt });
    }
  }
  return { ok: true, configured: true, processed: results.length, results };
}

async function authorized(request, env) {
  if (!env.ADMIN_TOKEN) return { ok: false, response: json({ error: "ADMIN_TOKEN secret is not configured" }, 503) };
  const expected = "Bearer " + env.ADMIN_TOKEN;
  if (request.headers.get("authorization") !== expected) {
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }
  return { ok: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/actions/ingest-youtube" && request.method === "POST") {
      if (!env.DB) return json({ ok: false, error: "database_not_configured" }, 503);
      const authorization = request.headers.get("authorization") || "";
      const identityToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!identityToken) return json({ ok: false, error: "github_oidc_token_required" }, 401);
      try {
        await verifyGitHubActionsToken(identityToken);
      } catch {
        return json({ ok: false, error: "github_oidc_identity_rejected" }, 401);
      }

      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > 2_000_000) return json({ ok: false, error: "request_too_large" }, 413);
      const rawBody = await request.text();
      if (rawBody.length > 2_000_000) return json({ ok: false, error: "request_too_large" }, 413);
      let body;
      try { body = JSON.parse(rawBody); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
      if (!body || !Array.isArray(body.items) || body.items.length > 100) {
        return json({ ok: false, error: "items_array_required_max_100" }, 400);
      }
      const result = await ingestYoutubeItems(env, body.items, "github_actions");
      return json(result, result.ok ? 200 : 500);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "goushibaaz-trend-scout",
        version: "0.3.0",
        configured: {
          database: Boolean(env.DB),
          githubActionsIngest: true,
          adminToken: Boolean(env.ADMIN_TOKEN),
          filoConnector: Boolean(env.FILO_UPLOAD_BRIDGE_URL && env.FILO_UPLOAD_BRIDGE_TOKEN)
        }
      });
    }
    if (!url.pathname.startsWith("/admin/")) return json({ error: "not_found" }, 404);
    const auth = await authorized(request, env);
    if (!auth.ok) return auth.response;

    if (url.pathname === "/admin/scan" && request.method === "POST") {
      return json({ error: "manual_scan_disabled", note: "YouTube scans are supplied by the authenticated GitHub Actions workflow." }, 410);
    }

    if (url.pathname === "/admin/filo/status" && request.method === "GET") {
      if (!env.DB) return json({ ok: false, error: "D1 binding DB is not configured" }, 503);
      const counts = await env.DB.prepare(
        "SELECT status, COUNT(*) AS count FROM delivery_jobs WHERE destination = 'filo' GROUP BY status"
      ).all();
      return json({
        ok: true,
        destination: "filo",
        connectorConfigured: Boolean(env.FILO_UPLOAD_BRIDGE_URL && env.FILO_UPLOAD_BRIDGE_TOKEN),
        adapterMode: "external connector contract",
        note: "No public Filo upload API was verified. Configure a legitimate connector that performs the actual Filo upload; no post is sent until then.",
        queue: counts.results || []
      });
    }

    if (url.pathname === "/admin/filo/queue" && request.method === "POST") {
      if (!env.DB) return json({ ok: false, error: "D1 binding DB is not configured" }, 503);
      const body = await request.json().catch(() => null);
      if (!body || !body.video_id) return json({ error: "video_id is required" }, 400);
      const videoId = String(body.video_id).trim().slice(0, 200);
      const authorizedVideo = await env.DB.prepare(
        "SELECT c.video_id, p.status AS authorization_status, p.media_url " +
        "FROM video_candidates c LEFT JOIN publication_authorizations p ON p.video_id = c.video_id " +
        "WHERE c.video_id = ? LIMIT 1"
      ).bind(videoId).first();

      if (!authorizedVideo) return json({ error: "candidate_not_found; scan before queueing" }, 404);
      if (authorizedVideo.authorization_status !== "approved") {
        return json({ error: "publication_blocked: verified commercial-use authorization is required" }, 403);
      }
      if (!authorizedVideo.media_url) {
        return json({ error: "media_url_required: add a direct HTTPS media URL to the verified authorization" }, 400);
      }

      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO delivery_jobs (video_id, destination, status, attempt_count, next_attempt_at, created_at, updated_at) " +
        "VALUES (?, 'filo', 'pending', 0, ?, ?, ?)"
      ).bind(videoId, now, now, now).run();
      const job = await env.DB.prepare(
        "SELECT id AS job_id, video_id, destination, status, attempt_count, next_attempt_at, destination_post_id, last_error, created_at, updated_at " +
        "FROM delivery_jobs WHERE video_id = ? AND destination = 'filo' LIMIT 1"
      ).bind(videoId).first();
      return json({
        ok: true,
        job,
        auto_dispatch_ready: Boolean(env.FILO_UPLOAD_BRIDGE_URL && env.FILO_UPLOAD_BRIDGE_TOKEN),
        note: "Queueing is not confirmation of a Filo upload. The Filo connector must be configured and must return a confirmed post ID."
      }, 201);
    }

    if (url.pathname === "/admin/filo/dispatch" && request.method === "POST") {
      return json(await dispatchFiloJobs(env, clampInt(url.searchParams.get("limit"), 2, 1, 5)));
    }

    if (url.pathname === "/admin/filo/jobs" && request.method === "GET") {
      if (!env.DB) return json({ ok: false, error: "D1 binding DB is not configured" }, 503);
      const limit = clampInt(url.searchParams.get("limit"), 30, 1, 100);
      const jobs = await env.DB.prepare(
        "SELECT d.id AS job_id, d.video_id, d.destination, d.status, d.attempt_count, d.next_attempt_at, " +
        "d.destination_post_id, d.last_error, d.created_at, d.updated_at, c.title, c.source_url " +
        "FROM delivery_jobs d JOIN video_candidates c ON c.video_id = d.video_id " +
        "WHERE d.destination = 'filo' ORDER BY d.created_at DESC LIMIT ?"
      ).bind(limit).all();
      return json({ ok: true, count: (jobs.results || []).length, jobs: jobs.results || [] });
    }


    if (url.pathname === "/admin/candidates" && request.method === "GET") {
      if (!env.DB) return json({ error: "D1 binding DB is not configured" }, 503);
      const limit = clampInt(url.searchParams.get("limit"), 30, 1, 100);
      const state = url.searchParams.get("state");
      let result;
      if (state) {
        result = await env.DB.prepare(
          "SELECT video_id, source_url, title, channel_title, published_at, view_count, " +
          "views_per_minute, previous_views_per_minute, growth_ratio, growth_score, snapshot_count, " +
          "trend_state, content_fit, language_hint, fit_reason, license_status, updated_at FROM video_candidates " +
          "WHERE trend_state = ? ORDER BY CASE content_fit WHEN 'persian_priority' THEN 0 " +
          "WHEN 'language_neutral_candidate' THEN 1 ELSE 2 END, growth_score DESC LIMIT ?"
        ).bind(state, limit).all();
      } else {
        result = await env.DB.prepare(
          "SELECT video_id, source_url, title, channel_title, published_at, view_count, " +
          "views_per_minute, previous_views_per_minute, growth_ratio, growth_score, snapshot_count, " +
          "trend_state, content_fit, language_hint, fit_reason, license_status, updated_at FROM video_candidates " +
          "ORDER BY CASE content_fit WHEN 'persian_priority' THEN 0 " +
          "WHEN 'language_neutral_candidate' THEN 1 ELSE 2 END, growth_score DESC, last_seen_at DESC LIMIT ?"
        ).bind(limit).all();
      }
      return json({ ok: true, count: (result.results || []).length, candidates: result.results || [] });
    }

    if (url.pathname === "/admin/authorizations" && request.method === "POST") {
      if (!env.DB) return json({ error: "D1 binding DB is not configured" }, 503);
      const body = await request.json().catch(() => null);
      if (!body || !body.video_id || !body.license_type || !body.evidence_url) {
        return json({ error: "video_id, license_type and evidence_url are required" }, 400);
      }
      const allowedTypes = ["owner_permission", "public_domain", "cc_commercial", "other_verified"];
      if (!allowedTypes.includes(body.license_type)) return json({ error: "unsupported license_type" }, 400);
      let evidenceUrl;
      try { evidenceUrl = new URL(body.evidence_url); } catch { return json({ error: "evidence_url must be a valid HTTPS URL" }, 400); }
      if (evidenceUrl.protocol !== "https:") return json({ error: "evidence_url must use HTTPS" }, 400);
      let mediaUrl = null;
      if (body.media_url) {
        try { mediaUrl = new URL(body.media_url); } catch { return json({ error: "media_url must be a valid HTTPS URL" }, 400); }
        if (mediaUrl.protocol !== "https:") return json({ error: "media_url must use HTTPS" }, 400);
      }
      const existing = await env.DB.prepare("SELECT video_id FROM video_candidates WHERE video_id = ? LIMIT 1")
        .bind(String(body.video_id)).first();
      if (!existing) return json({ error: "candidate_not_found; scan before authorizing" }, 404);
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO publication_authorizations " +
        "(video_id, status, license_type, evidence_url, media_url, notes, approved_at, updated_at) " +
        "VALUES (?, 'approved', ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(video_id) DO UPDATE SET status='approved', license_type=excluded.license_type, " +
        "evidence_url=excluded.evidence_url, media_url=excluded.media_url, notes=excluded.notes, updated_at=excluded.updated_at"
      ).bind(String(body.video_id), body.license_type, evidenceUrl.toString(), mediaUrl ? mediaUrl.toString() : null,
        String(body.notes || "").slice(0, 1000), now, now).run();
      await env.DB.prepare("UPDATE video_candidates SET license_status='approved' WHERE video_id=?")
        .bind(String(body.video_id)).run();
      return json({ ok: true, video_id: String(body.video_id), license_status: "approved" }, 201);
    }

    if (url.pathname === "/admin/runs" && request.method === "GET") {
      if (!env.DB) return json({ error: "D1 binding DB is not configured" }, 503);
      const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
      const result = await env.DB.prepare(
        "SELECT id, source, started_at, finished_at, status, candidate_count, emerging_count, note " +
        "FROM scan_runs ORDER BY started_at DESC LIMIT ?"
      ).bind(limit).all();
      return json({ ok: true, runs: result.results || [] });
    }

    return json({ error: "not_found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    if (env.FILO_UPLOAD_BRIDGE_URL && env.FILO_UPLOAD_BRIDGE_TOKEN && env.DB) {
      ctx.waitUntil(dispatchFiloJobs(env).then(result => {
        if (!result.ok) console.error("Filo dispatch not successful: " + safeError(result.reason || result.error || "unknown"));
      }).catch(error => console.error("Filo dispatch error: " + safeError(error))));
    }
  }
};
