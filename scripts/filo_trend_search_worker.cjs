'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fetchIranGoogleTrends } = require('./google_trends_iran.cjs');
const {
  buildFiloTrendQueries,
  searchFiloGlobalTopic,
  mapWithConcurrency,
  normalizePersian
} = require('./filo_global_search.cjs');
const {
  login,
  fetchFiloGlobalSearchPage
} = require('./filo_native_republish.cjs');

const BASE = 'https://ifilo.net';
const STATE_PATH = path.join('state', 'filo-global-search-candidates.json');
const REPORT_PATH = path.join('out', 'filo-global-search-worker.json');
const MAX_TOPICS = 40;
const MAX_QUERIES_PER_TOPIC = 3;
const MAX_QUERIES_PER_RUN = 8;
const PAGES_PER_QUERY_PER_RUN = 20;
const SEARCH_CONCURRENCY = 4;
const MAX_CACHED_CANDIDATES = 5000;
const QUERY_RETRY_COOLDOWN_MS = 4 * 60 * 1000;
const COMPLETED_QUERY_REFRESH_MS = 60 * 60 * 1000;
const REFRESH_TOP_PAGES = 5;
const ACTIVE_QUERY_TTL_MS = 72 * 60 * 60 * 1000;

const isoNow = () => new Date().toISOString();
const safeNumber = value => {
  const n = Number(String(value ?? '').replace(/[۰-۹٠-٩]/g, ch => {
    const fa = '۰۱۲۳۴۵۶۷۸۹';
    const ar = '٠١٢٣٤٥٦٧٨٩';
    const i = fa.indexOf(ch);
    return String(i >= 0 ? i : ar.indexOf(ch));
  }));
  return Number.isFinite(n) ? n : 0;
};

function readJson(filePath, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function loadState() {
  const saved = readJson(STATE_PATH, null);
  if (!saved || saved.schemaVersion !== 1 || !saved.queries || !saved.items) {
    return {
      schemaVersion: 1,
      createdAt: isoNow(),
      updatedAt: null,
      trendsFetchedAt: null,
      trends: [],
      queries: {},
      items: {},
      totalPagesFetched: 0,
      totalVideosSeen: 0
    };
  }
  return saved;
}

function compactVideo(item) {
  const fields = [
    'video_code', 'title', 'description', 'sender_name',
    'category_id', 'duration', 'duration_seconds', 'duration_minutes',
    'visit_count', 'view_count', 'views', 'play_count', 'share_count',
    'favorite_count', 'create_date', 'styled_create_date', 'created_at',
    'active', 'file_deleted', 'only_in_filo', 'has_audio',
    'can_republish', 'can_make_money', 'is_publish_able', 'status_id'
  ];
  const output = {};
  for (const key of fields) {
    const value = item && item[key];
    if (value !== undefined && value !== null && value !== '') output[key] = value;
  }
  output.video_code = String(output.video_code || item && (item.videoCode || item.code) || '').trim();
  output.title = String(output.title || '').replace(/\s+/g, ' ').trim();
  return output;
}

function candidateRetentionScore(item) {
  const views = safeNumber(item.visit_count ?? item.views ?? item.view_count);
  const plays = safeNumber(item.play_count);
  const shares = safeNumber(item.share_count);
  const favorites = safeNumber(item.favorite_count);
  const engagement = views + 2 * plays + 3 * shares + 2 * favorites;
  const matches = Array.isArray(item.globalTrendSearchMatches) ? item.globalTrendSearchMatches.length : 0;
  const persianBonus = /[\u0600-\u06FF]/.test(String(item.title || '')) ? 4 : 0;
  const textBonus = String(item.title || '').length >= 15 ? 2 : 0;
  return Math.log1p(engagement) * 3 + Math.min(12, matches * 3) + persianBonus + textBonus;
}

function mergeCandidate(itemsByCode, incoming) {
  const compact = compactVideo(incoming);
  const code = compact.video_code;
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(code) || compact.title.length < 5) return false;

  const previous = itemsByCode[code] || {};
  const previousMatches = Array.isArray(previous.globalTrendSearchMatches)
    ? previous.globalTrendSearchMatches : [];
  const currentMatch = incoming.globalTrendSearch || null;
  const matches = [...previousMatches];
  if (currentMatch) {
    const identity = normalizePersian(currentMatch.trendTitle || currentMatch.query);
    const queryIdentity = normalizePersian(currentMatch.query);
    if (!matches.some(match =>
      normalizePersian(match.trendTitle || match.query) === identity &&
      normalizePersian(match.query) === queryIdentity
    )) matches.push(currentMatch);
  }

  itemsByCode[code] = {
    ...previous,
    ...compact,
    globalTrendSearchMatches: matches.slice(-12),
    lastTrendMatchedAt: isoNow()
  };
  return true;
}

function pruneCandidates(itemsByCode) {
  const entries = Object.entries(itemsByCode);
  if (entries.length <= MAX_CACHED_CANDIDATES) return entries.length;
  entries.sort((a, b) =>
    candidateRetentionScore(b[1]) - candidateRetentionScore(a[1]) ||
    String(b[1].lastTrendMatchedAt || '').localeCompare(String(a[1].lastTrendMatchedAt || ''))
  );
  const keep = entries.slice(0, MAX_CACHED_CANDIDATES);
  for (const [code] of entries.slice(MAX_CACHED_CANDIDATES)) delete itemsByCode[code];
  return keep.length;
}

function refreshQueryDefinitions(state, trends, now = Date.now()) {
  const definitions = buildFiloTrendQueries(trends, {
    maxTopics: MAX_TOPICS,
    maxQueriesPerTopic: MAX_QUERIES_PER_TOPIC
  });
  const currentKeys = new Set();
  for (const query of Object.values(state.queries)) query.activeInLatestFeed = false;

  for (const definition of definitions) {
    const key = normalizePersian(definition.query);
    if (!key) continue;
    currentKeys.add(key);
    const existing = state.queries[key] || {
      query: definition.query,
      normalized: key,
      nextPage: 1,
      complete: false,
      pagesFetched: 0,
      videosSeen: 0,
      createdAt: isoNow(),
      lastAttemptAt: null,
      lastError: null
    };
    existing.query = definition.query;
    existing.trendTitle = definition.trendTitle;
    existing.trendTraffic = definition.trendTraffic;
    existing.trendPublishedAt = definition.trendPublishedAt;
    existing.trendKeywords = definition.trendKeywords;
    existing.lastTrendSeenAt = isoNow();
    existing.activeInLatestFeed = true;
    state.queries[key] = existing;
  }

  for (const [key, query] of Object.entries(state.queries)) {
    const seenAt = Date.parse(query && query.lastTrendSeenAt || query && query.createdAt || '');
    if (!currentKeys.has(key) && Number.isFinite(seenAt) && now - seenAt > ACTIVE_QUERY_TTL_MS) {
      delete state.queries[key];
    }
  }
  return definitions.length;
}

function selectQueriesForRun(state, now = Date.now()) {
  for (const query of Object.values(state.queries)) {
    if (!query || !query.complete || !query.activeInLatestFeed) continue;
    const completedAt = Date.parse(query.completedAt || query.lastAttemptAt || '');
    if (Number.isFinite(completedAt) && now - completedAt >= COMPLETED_QUERY_REFRESH_MS) {
      query.complete = false;
      query.refreshOnly = true;
      query.nextPage = 1;
      query.lastAttemptAt = null;
    }
  }

  const recentlySeen = query => {
    if (query.activeInLatestFeed !== false) return true;
    const seenAt = Date.parse(query.lastTrendSeenAt || query.createdAt || '');
    return Number.isFinite(seenAt) && now - seenAt <= ACTIVE_QUERY_TTL_MS;
  };
  const eligible = Object.values(state.queries)
    .filter(query => query && !query.complete && recentlySeen(query))
    .filter(query => {
      const lastAttempt = Date.parse(query.lastAttemptAt || '');
      return !Number.isFinite(lastAttempt) || now - lastAttempt >= QUERY_RETRY_COOLDOWN_MS;
    });

  const byOldestAttempt = (a, b) => {
    const aTime = Date.parse(a.lastAttemptAt || a.createdAt || '') || 0;
    const bTime = Date.parse(b.lastAttemptAt || b.createdAt || '') || 0;
    return aTime - bTime || Number(a.nextPage || 1) - Number(b.nextPage || 1);
  };
  const current = eligible.filter(query => query.activeInLatestFeed !== false).sort(byOldestAttempt);
  const backlog = eligible.filter(query => query.activeInLatestFeed === false).sort(byOldestAttempt);

  // Reserve two of eight slots for recently trending topics that have since
  // left the live RSS feed. This prevents incomplete global searches from
  // being abandoned while still giving current topics scheduling priority.
  const backlogSlots = Math.min(2, backlog.length, MAX_QUERIES_PER_RUN);
  const currentSlots = Math.min(current.length, MAX_QUERIES_PER_RUN - backlogSlots);
  return [
    ...current.slice(0, currentSlots),
    ...backlog.slice(0, backlogSlots),
    ...current.slice(currentSlots),
    ...backlog.slice(backlogSlots)
  ].slice(0, MAX_QUERIES_PER_RUN);
}

function applyQueryResult(state, query, result) {
  const key = query.normalized;
  const target = state.queries[key];
  if (!target) return { added: 0 };

  let added = 0;
  for (const item of result.results || []) {
    if (mergeCandidate(state.items, item)) added += 1;
  }

  target.pagesFetched = safeNumber(target.pagesFetched) + safeNumber(result.pagesFetched);
  target.videosSeen = safeNumber(target.videosSeen) + safeNumber(result.totalUniqueVideos);
  const refreshFailed = result.termination === 'request_failed' || /^http_\d+/.test(String(result.termination || ''));
  target.nextPage = query.refreshOnly
    ? 1
    : Math.max(1, safeNumber(result.nextPage) || safeNumber(target.nextPage) || 1);
  target.complete = query.refreshOnly
    ? !refreshFailed
    : Boolean(result.complete);
  target.termination = query.refreshOnly && !refreshFailed
    ? 'recent_first_pages_refreshed'
    : String(result.termination || '');
  if (query.refreshOnly && !refreshFailed) {
    target.refreshOnly = false;
    target.lastRefreshAt = isoNow();
  }
  target.lastAttemptAt = isoNow();
  target.lastError = refreshFailed
    ? String(result.pages && result.pages.at(-1) && result.pages.at(-1).error || result.termination).slice(0, 180)
    : null;
  if (target.complete) target.completedAt = isoNow();
  state.totalPagesFetched = safeNumber(state.totalPagesFetched) + safeNumber(result.pagesFetched);
  state.totalVideosSeen = safeNumber(state.totalVideosSeen) + safeNumber(result.results && result.results.length);
  return { added };
}

async function runSearchBatch(context, selectedQueries) {
  return mapWithConcurrency(selectedQueries, SEARCH_CONCURRENCY, async query => {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    try {
      await page.goto(BASE + '/upload', { waitUntil: 'domcontentloaded', timeout: 25000 });
      return await searchFiloGlobalTopic(
        query.query,
        params => fetchFiloGlobalSearchPage(page, params),
        {
          startPage: query.nextPage || 1,
          maxPages: query.refreshOnly ? REFRESH_TOP_PAGES : PAGES_PER_QUERY_PER_RUN,
          pageSize: 20,
          windowWidth: 1365,
          topicSearch: query
        }
      );
    } finally {
      await page.close().catch(() => {});
    }
  });
}

async function main() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const state = loadState();
  const report = {
    createdAt: isoNow(),
    status: 'started',
    trends: { status: 'not_fetched', count: 0 },
    errors: [],
    search: { queriesSelected: 0, queriesCompleted: 0, pagesFetched: 0, newCandidates: 0, results: [] }
  };
  let browser;

  try {
    const feed = await fetchIranGoogleTrends({ timeoutMs: 8000, maxItems: 40 });
    const trends = Array.isArray(feed.items) ? feed.items : [];
    report.trends = {
      status: feed.ok ? 'active' : 'unavailable',
      source: feed.source,
      fetchedAt: feed.fetchedAt,
      count: trends.length,
      error: feed.error || null,
      topics: trends.slice(0, 20).map(item => ({ title: item.title, traffic: item.traffic }))
    };
    if (feed.ok) {
      state.trendsFetchedAt = feed.fetchedAt;
      state.trends = trends.slice(0, MAX_TOPICS).map(item => ({
        title: item.title,
        keywords: item.keywords,
        traffic: item.traffic,
        publishedAt: item.publishedAt,
        ageHours: item.ageHours
      }));
      refreshQueryDefinitions(state, trends);
    } else {
      // A temporary Trends RSS outage must not erase the last valid active-topic set.
      for (const query of Object.values(state.queries)) {
        if (query && query.activeInLatestFeed === undefined) query.activeInLatestFeed = true;
      }
    }

    const selected = selectQueriesForRun(state);
    report.search.queriesSelected = selected.length;
    if (!selected.length) {
      report.status = Object.keys(state.queries).length ? 'all_current_queries_complete' : 'no_searchable_trends';
    } else {
      if (!process.env.FILO_USER || !process.env.FILO_PASS) throw new Error('filo_credentials_missing');
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        locale: 'fa-IR',
        viewport: { width: 1365, height: 1000 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129 Safari/537.36'
      });
      const loginPage = await context.newPage();
      loginPage.setDefaultTimeout(12000);
      report.login = await login(loginPage);
      await loginPage.close().catch(() => {});

      const results = await runSearchBatch(context, selected);
      let addedCandidates = 0;
      for (let i = 0; i < results.length; i += 1) {
        const query = selected[i];
        const result = results[i];
        const applied = applyQueryResult(state, query, result);
        addedCandidates += applied.added;
        report.search.pagesFetched += safeNumber(result.pagesFetched);
        if (result.complete) report.search.queriesCompleted += 1;
        report.search.results.push({
          query: query.query,
          startPage: result.startPage,
          nextPage: result.nextPage,
          pagesFetched: result.pagesFetched,
          uniqueVideos: result.totalUniqueVideos,
          complete: result.complete,
          termination: result.termination
        });
      }
      report.search.newCandidates = addedCandidates;
      report.search.queriesInProgress = Object.values(state.queries).filter(query => !query.complete).length;
      report.search.queriesCompleteTotal = Object.values(state.queries).filter(query => query.complete).length;
      report.search.queriesTotal = Object.keys(state.queries).length;
      report.search.candidatesRetained = pruneCandidates(state.items);
      report.status = 'search_batch_completed';
    }
  } catch (error) {
    report.status = 'failed';
    report.error = String(error && error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 600);
  } finally {
    if (browser) await browser.close().catch(() => {});
    state.updatedAt = isoNow();
    report.state = {
      updatedAt: state.updatedAt,
      queryCount: Object.keys(state.queries).length,
      completedQueries: Object.values(state.queries).filter(query => query.complete).length,
      totalPagesFetched: state.totalPagesFetched,
      totalVideosSeen: state.totalVideosSeen,
      candidatesRetained: Object.keys(state.items).length
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('FILO_GLOBAL_TREND_SEARCH_RESULT ' + JSON.stringify(report));
  }

  if (report.status === 'failed') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error('FILO_GLOBAL_TREND_SEARCH_FATAL', String(error && error.message || error).slice(0, 600));
    process.exitCode = 1;
  });
}

module.exports = {
  compactVideo,
  candidateRetentionScore,
  mergeCandidate,
  pruneCandidates,
  refreshQueryDefinitions,
  selectQueriesForRun,
  applyQueryResult
};
