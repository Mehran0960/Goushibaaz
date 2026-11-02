'use strict';

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 60;
const QUERY_STOP_WORDS = new Set([
  'این','آن','از','با','برای','به','در','را','روی','و','یا','اما','اگر','هم','یک',
  'چه','چرا','چی','چطور','امروز','دیروز','فردا','شد','شده','شود','است','هست',
  'بود','بودن','می','های','ها','the','and','for','with','from','into','what',
  'when','where','why','how','who','today','tomorrow','yesterday'
]);

function normalizePersian(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('fa-IR')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u200c\u200e\u200f\u0640]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTokens(value) {
  return normalizePersian(value)
    .split(' ')
    .filter(token => token.length >= 2 && !QUERY_STOP_WORDS.has(token));
}

function buildFiloTrendQueries(trends, options = {}) {
  const maxTopics = Math.max(1, Math.min(30, Math.floor(Number(options.maxTopics) || 10)));
  const maxQueriesPerTopic = Math.max(1, Math.min(3, Math.floor(Number(options.maxQueriesPerTopic) || 2)));
  const topics = (Array.isArray(trends) ? trends : [])
    .filter(item => item && String(item.title || '').trim())
    .slice(0, maxTopics);
  const queries = [];
  const seen = new Set();

  for (const trend of topics) {
    const title = String(trend.title).replace(/\s+/g, ' ').trim();
    const candidates = [title];
    const simplified = [...new Set(Array.isArray(trend.keywords) && trend.keywords.length
      ? trend.keywords.map(normalizePersian).filter(Boolean)
      : queryTokens(title))].slice(0, 5).join(' ');
    if (simplified && normalizePersian(simplified) !== normalizePersian(title)) {
      candidates.push(simplified);
    }

    let added = 0;
    for (const query of candidates) {
      const normalized = normalizePersian(query);
      if (!normalized || seen.has(normalized)) continue;
      if (queryTokens(query).length === 0) continue;
      seen.add(normalized);
      queries.push({
        query,
        normalized,
        trendTitle: title.slice(0, 180),
        trendTraffic: Number(trend.traffic) || 0,
        trendPublishedAt: trend.publishedAt || null,
        trendAgeHours: Number.isFinite(trend.ageHours) ? trend.ageHours : null,
        trendKeywords: Array.isArray(trend.keywords) ? trend.keywords.slice(0, 10) : queryTokens(title)
      });
      added += 1;
      if (added >= maxQueriesPerTopic) break;
    }
  }

  return queries;
}

function responseRoot(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload;
}

function responseItems(root) {
  if (Array.isArray(root)) return root;
  if (Array.isArray(root.items)) return root.items;
  if (Array.isArray(root.l)) return root.l;
  if (Array.isArray(root.v)) return root.v;
  return [];
}

function asBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return value == null ? null : false;
  const text = String(value).trim().toLowerCase();
  if (['1','true','yes','on'].includes(text)) return true;
  if (['0','false','no','off',''].includes(text)) return false;
  return null;
}

function normalizeFiloSearchItem(item, topicSearch = {}) {
  if (!item || typeof item !== 'object') return null;
  const videoCode = String(
    item.video_code || item.videoCode || item.code || item.v || item.id || item.i || ''
  ).trim();
  const title = String(item.title || item.t || item.name || '').replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(videoCode) || title.length < 5) return null;

  const description = String(item.description || item.desc || item.summary || item.d || '').trim();
  const duration = item.duration ?? item.duration_seconds ?? item.video_duration ?? item.time_seconds;
  const categoryId = item.category_id ?? item.categoryId ?? item.category ?? item.cat_id;
  return {
    ...item,
    video_code: videoCode,
    title,
    description,
    ...(categoryId == null ? {} : { category_id: categoryId }),
    ...(duration == null ? {} : { duration }),
    globalTrendSearch: {
      query: String(topicSearch.query || '').slice(0, 180),
      trendTitle: String(topicSearch.trendTitle || topicSearch.query || '').slice(0, 180),
      trendTraffic: Number(topicSearch.trendTraffic) || 0,
      trendPublishedAt: topicSearch.trendPublishedAt || null,
      page: Number(topicSearch.page) || null
    }
  };
}

async function searchFiloGlobalTopic(query, fetchPage, options = {}) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');
  const normalizedQuery = normalizePersian(query);
  if (!normalizedQuery) return {
    query: String(query || ''),
    results: [],
    pagesFetched: 0,
    complete: true,
    termination: 'empty_query'
  };

  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || DEFAULT_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.min(200, Math.floor(Number(options.maxPages) || DEFAULT_MAX_PAGES)));
  const results = [];
  const seenCodes = new Set();
  const pages = [];
  let complete = false;
  let termination = 'max_pages_reached';

  for (let page = 1; page <= maxPages; page += 1) {
    let payload;
    try {
      payload = await fetchPage({
        query: String(query),
        rowCount: null,
        page,
        needAllData: 0,
        windowWidth: Number(options.windowWidth) || 1365
      });
    } catch (error) {
      termination = 'request_failed';
      pages.push({ page, error: String(error && error.message || error).slice(0, 180) });
      break;
    }

    if (payload && Number(payload.status) >= 400) {
      termination = 'http_' + Number(payload.status);
      pages.push({ page, status: Number(payload.status), error: String(payload.error || 'http_error').slice(0, 180) });
      break;
    }

    const raw = payload && Object.prototype.hasOwnProperty.call(payload, 'body')
      ? payload.body
      : payload;
    const root = responseRoot(raw);
    const items = responseItems(root);
    const pageCodes = [];
    let added = 0;

    for (const rawItem of items) {
      const normalized = normalizeFiloSearchItem(rawItem, { ...options.topicSearch, query, page });
      if (!normalized || seenCodes.has(normalized.video_code)) continue;
      seenCodes.add(normalized.video_code);
      results.push(normalized);
      pageCodes.push(normalized.video_code);
      added += 1;
    }

    const hasMore = asBoolean(
      root.has_more_load ?? root.hasMoreLoad ?? root.hml ?? root.hm
    );
    pages.push({
      page,
      received: items.length,
      added,
      returnedPage: Number(root.page ?? root.p) || null,
      rowCount: Number(root.row_count ?? root.rowCount) || null,
      hasMore
    });

    if (items.length === 0) {
      complete = true;
      termination = 'empty_page';
      break;
    }
    if (hasMore === false) {
      complete = true;
      termination = 'has_more_load_false';
      break;
    }
    if (hasMore === null && items.length < pageSize) {
      complete = true;
      termination = 'short_final_page';
      break;
    }
    if (page > 1 && added === 0) {
      complete = false;
      termination = 'pagination_no_new_results';
      break;
    }
  }

  return {
    query: String(query),
    results,
    pagesFetched: pages.length,
    complete,
    termination,
    totalUniqueVideos: results.length,
    pages
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const source = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(source.length || 1, Math.floor(Number(concurrency) || 1)));
  const output = new Array(source.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= source.length) return;
      output[index] = await mapper(source[index], index);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return output;
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  DEFAULT_MAX_PAGES,
  normalizePersian,
  queryTokens,
  buildFiloTrendQueries,
  responseRoot,
  responseItems,
  normalizeFiloSearchItem,
  searchFiloGlobalTopic,
  mapWithConcurrency
};
