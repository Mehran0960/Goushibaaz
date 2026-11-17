'use strict';

const assert = require('node:assert/strict');
const {
  mergeCandidate,
  compactVideo,
  candidateRetentionScore,
  refreshQueryDefinitions,
  selectQueriesForRun,
  applyQueryResult
} = require('./filo_trend_search_worker.cjs');

const metricAliases = compactVideo({
  videoCode: 'Metric01', title: 'رشد بازدید و پخش', visit_count: 100,
  plays: 75, shares: 5, favorites: 3
});
assert.equal(metricAliases.video_code, 'Metric01');
const compactFiloAliases = compactVideo({
  v: 'Compact01', t: 'عنوان نتیجه جست‌وجوی فیلو', c: 6, du: 32,
  vc: 1234, pd: 321, cd: '۲ ساعت پیش', hst: 1, co: 1, cr: 1, ac: 1
});
assert.equal(compactFiloAliases.video_code, 'Compact01');
assert.equal(compactFiloAliases.title, 'عنوان نتیجه جست‌وجوی فیلو');
assert.equal(compactFiloAliases.category_id, 6);
assert.equal(compactFiloAliases.visit_count, 1234);
assert.equal(compactFiloAliases.play_count, 321);
assert.equal(compactFiloAliases.can_republish, 1,
  'compact Filo search flags must be normalized and retained for the authoritative detail recheck');
assert.equal(metricAliases.plays, 75);
assert.ok(candidateRetentionScore(metricAliases) > candidateRetentionScore({
  ...metricAliases, plays: 0, shares: 0, favorites: 0
}), 'cache retention must use normalized engagement aliases');

const state = {
  schemaVersion: 1,
  queries: {},
  items: {},
  totalPagesFetched: 0,
  totalVideosSeen: 0
};
const trends = [{
  title: 'نتیجه بازی تراکتور امروز',
  keywords: ['نتیجه', 'بازی', 'تراکتور'],
  traffic: 500000,
  publishedAt: '2026-11-02T17:30:00.000Z',
  newsItems: [{ title: 'گزارش بازی تراکتور در لیگ برتر' }]
}];

const definitions = refreshQueryDefinitions(state, trends);
assert.ok(definitions >= 2, 'trend phrase, simplified query, and useful related-news query should be indexed');
const now = Date.now();
state.queries['inactive-old-topic'] = {
  query: 'موضوع قدیمی',
  normalized: 'موضوعقدیمی',
  nextPage: 21,
  complete: false,
  activeInLatestFeed: false,
  createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
  lastTrendSeenAt: new Date(now - 60 * 60 * 1000).toISOString()
};
state.queries['expired-old-topic'] = {
  query: 'موضوع منقضی',
  normalized: 'موضوعمنقضی',
  nextPage: 21,
  complete: false,
  activeInLatestFeed: false,
  createdAt: new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString(),
  lastTrendSeenAt: new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString()
};
const selected = selectQueriesForRun(state, now);
assert.ok(selected.length > 0);
assert.equal(selected.some(item => item.normalized === 'موضوعقدیمی'), true,
  'recently trending incomplete queries must continue in the backlog after leaving the live RSS feed');
assert.equal(selected.some(item => item.normalized === 'موضوعمنقضی'), false,
  'expired historical queries must not consume search capacity');
assert.ok(selected.length <= 14);
const backlogIndex = selected.findIndex(item => item.normalized === 'موضوعقدیمی');
const currentIndex = selected.findIndex(item => item.activeInLatestFeed !== false);
assert.ok(currentIndex >= 0 && currentIndex < backlogIndex,
  'current trend searches must retain priority over backlog searches');

const query = selected[0];
const added = applyQueryResult(state, query, {
  results: [{
    video_code: 'Trend001',
    title: 'لحظه دیدنی بازی تراکتور',
    duration: 25,
    globalTrendSearch: {
      query: query.query,
      trendTitle: query.trendTitle,
      trendKeywords: query.trendKeywords
    }
  }],
  pagesFetched: 3,
  nextPage: 4,
  complete: false,
  termination: 'max_pages_reached',
  totalUniqueVideos: 1
});
assert.equal(added.added, 1);
assert.equal(state.items.Trend001.title, 'لحظه دیدنی بازی تراکتور');
assert.equal(state.items.Trend001.globalTrendSearchMatches.length, 1);
assert.ok(Number.isFinite(Date.parse(state.items.Trend001.lastMetricsFetchedAt)),
  'global-search candidates must retain the timestamp at which Filo returned their metrics');
assert.equal(state.queries[query.normalized].nextPage, 4);
assert.equal(state.totalPagesFetched, 3);

const duplicateAdded = mergeCandidate(state.items, {
  video_code: 'Trend001',
  title: 'لحظه دیدنی بازی تراکتور',
  globalTrendSearch: {
    query: query.query,
    trendTitle: query.trendTitle,
    trendKeywords: query.trendKeywords
  }
});
assert.equal(duplicateAdded, true);
assert.equal(state.items.Trend001.globalTrendSearchMatches.length, 1,
  'the same trend/query association must not be duplicated');

const nextBatch = selectQueriesForRun(state, Date.now() + 5 * 60 * 1000);
assert.ok(nextBatch.some(item => item.normalized === query.normalized));
assert.equal(nextBatch.find(item => item.normalized === query.normalized).nextPage, 4,
  'a later worker run must resume at the first unsearched page');


const completedQuery = state.queries[query.normalized];
completedQuery.complete = true;
completedQuery.completedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
completedQuery.activeInLatestFeed = true;
const refreshBatch = selectQueriesForRun(state, Date.now());
const refreshQuery = refreshBatch.find(item => item.normalized === query.normalized);
assert.ok(refreshQuery);
assert.equal(refreshQuery.refreshOnly, true);
assert.equal(refreshQuery.nextPage, 1);

applyQueryResult(state, refreshQuery, {
  results: [],
  pagesFetched: 5,
  nextPage: 6,
  complete: false,
  termination: 'max_pages_reached',
  totalUniqueVideos: 0
});
assert.equal(completedQuery.complete, true, 'a fresh first-page sweep should complete its refresh cycle');
assert.equal(completedQuery.nextPage, 1, 'a refresh cycle must not overwrite the full-search pagination cursor');
assert.equal(completedQuery.refreshOnly, false);
assert.ok(completedQuery.lastRefreshAt);

console.log('FILO_TREND_SEARCH_WORKER_TESTS_PASSED');
