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

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function parseVideo(item) {
  const stats = item.statistics || {};
  const snippet = item.snippet || {};
  const details = item.contentDetails || {};
  const viewCount = Number(stats.viewCount);
  if (!item.id || !Number.isFinite(viewCount)) return null;
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

async function runScan(env, source) {
  if (!env.DB) return { ok: false, status: "configuration_required", missing: ["D1 binding DB"] };
  if (!env.YOUTUBE_API_KEY) return { ok: false, status: "configuration_required", missing: ["YOUTUBE_API_KEY secret"] };

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const observedAt = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  const regionCode = String(env.YT_REGION_CODE || "IR").toUpperCase();
  await env.DB.prepare(
    "INSERT INTO scan_runs (id, source, started_at, status) VALUES (?, ?, ?, 'running')"
  ).bind(runId, source, startedAt).run();

  try {
    const chartData = await youtube("videos", {
      part: "snippet,statistics,contentDetails,status",
      chart: "mostPopular",
      regionCode,
      maxResults: 50
    }, env.YOUTUBE_API_KEY);
    const itemsById = new Map();
    for (const item of (chartData.items || [])) {
      const parsed = parseVideo(item);
      if (parsed) itemsById.set(parsed.id, parsed);
    }

    let searchWarning = null;
    const lastSearchRow = await env.DB.prepare(
      "SELECT value FROM app_config WHERE key = 'last_search_at' LIMIT 1"
    ).first();
    const lastSearchAt = lastSearchRow && lastSearchRow.value ? Date.parse(lastSearchRow.value) : 0;
    if (!lastSearchAt || Date.now() - lastSearchAt >= 30 * 60 * 1000) {
      try {
        const searchData = await youtube("search", {
          part: "snippet",
          type: "video",
          order: "date",
          regionCode,
          relevanceLanguage: "fa",
          publishedAfter: new Date(Date.now() - 12 * 3600000).toISOString(),
          maxResults: 50
        }, env.YOUTUBE_API_KEY);
        const ids = [...new Set((searchData.items || [])
          .map(item => item && item.id && item.id.videoId)
          .filter(Boolean))]
          .filter(id => !itemsById.has(String(id)));
        if (ids.length) {
          const detailData = await youtube("videos", {
            part: "snippet,statistics,contentDetails,status",
            id: ids.slice(0, 50).join(",")
          }, env.YOUTUBE_API_KEY);
          for (const item of (detailData.items || [])) {
            const parsed = parseVideo(item);
            if (parsed) itemsById.set(parsed.id, parsed);
          }
        }
      } catch (error) {
        searchWarning = safeError(error);
      } finally {
        await env.DB.prepare(
          "INSERT INTO app_config (key, value, updated_at) VALUES ('last_search_at', ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).bind(observedAt, observedAt).run();
      }
    }

    const videos = [...itemsById.values()];
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
        "views_per_minute, previous_views_per_minute, growth_ratio, growth_score, snapshot_count, trend_state, updated_at) " +
        "VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(video_id) DO UPDATE SET " +
        "source_url=excluded.source_url, title=excluded.title, channel_id=excluded.channel_id, " +
        "channel_title=excluded.channel_title, published_at=excluded.published_at, last_seen_at=excluded.last_seen_at, " +
        "view_count=excluded.view_count, like_count=excluded.like_count, comment_count=excluded.comment_count, " +
        "duration=excluded.duration, source_license=excluded.source_license, views_per_minute=excluded.views_per_minute, " +
        "previous_views_per_minute=excluded.previous_views_per_minute, growth_ratio=excluded.growth_ratio, " +
        "growth_score=excluded.growth_score, snapshot_count=video_candidates.snapshot_count + 1, trend_state=excluded.trend_state, " +
        "updated_at=excluded.updated_at"
      ).bind(
        video.id, video.sourceUrl, video.title, video.channelId, video.channelTitle, video.publishedAt,
        observedAt, observedAt, video.views, video.likes, video.comments, video.duration, video.sourceLicense,
        score.currentRate, score.previousRate, score.growthRatio, score.growthScore, score.snapshotCount,
        score.state, observedAt
      ));
    }
    if (candidateStatements.length) await env.DB.batch(candidateStatements);
    if (snapshotStatements.length) await env.DB.batch(snapshotStatements);

    const finishedAt = new Date().toISOString();
    const note = searchWarning ? "Search discovery warning: " + searchWarning : null;
    await env.DB.prepare(
      "UPDATE scan_runs SET finished_at = ?, status = 'success', candidate_count = ?, emerging_count = ?, note = ? WHERE id = ?"
    ).bind(finishedAt, videos.length, emergingCount, note, runId).run();

    return {
      ok: true,
      runId,
      source,
      regionCode,
      scanned: videos.length,
      emerging: emergingCount,
      searchWarning,
      observedAt
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = safeError(error);
    await env.DB.prepare(
      "UPDATE scan_runs SET finished_at = ?, status = 'failed', note = ? WHERE id = ?"
    ).bind(finishedAt, message, runId).run().catch(() => {});
    return { ok: false, runId, status: "scan_failed", error: message };
  }
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
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "goushibaaz-trend-scout",
        version: "0.1.0",
        configured: {
          database: Boolean(env.DB),
          youtubeApiKey: Boolean(env.YOUTUBE_API_KEY),
          adminToken: Boolean(env.ADMIN_TOKEN)
        }
      });
    }
    if (!url.pathname.startsWith("/admin/")) return json({ error: "not_found" }, 404);
    const auth = await authorized(request, env);
    if (!auth.ok) return auth.response;

    if (url.pathname === "/admin/scan" && request.method === "POST") {
      return json(await runScan(env, "manual"));
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
          "trend_state, license_status, updated_at FROM video_candidates " +
          "WHERE trend_state = ? ORDER BY growth_score DESC LIMIT ?"
        ).bind(state, limit).all();
      } else {
        result = await env.DB.prepare(
          "SELECT video_id, source_url, title, channel_title, published_at, view_count, " +
          "views_per_minute, previous_views_per_minute, growth_ratio, growth_score, snapshot_count, " +
          "trend_state, license_status, updated_at FROM video_candidates " +
          "ORDER BY growth_score DESC, last_seen_at DESC LIMIT ?"
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
    ctx.waitUntil(runScan(env, "cron").then(result => {
      if (!result.ok) console.error("scheduled scan not successful: " + safeError(result.error || result.status));
    }).catch(error => console.error("scheduled scan error: " + safeError(error))));
  }
};
