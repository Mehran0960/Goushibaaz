'use strict';

const assert = require('node:assert/strict');
const {
  mergeCandidate,
  refreshQueryDefinitions,
  selectQueriesForRun,
  applyQueryResult
} = require('./filo_trend_search_worker.cjs');

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
state.queries['inactive-old-topic'] = {
  query: 'موضوع قدیمی',
  normalized: 'موضوعقدیمی',
  nextPage: 21,
  complete: false,
  activeInLatestFeed: false,
  createdAt: '2026-11-01T00:00:00.000Z'
};
const selected = selectQueriesForRun(state);
assert.ok(selected.length > 0);
assert.equal(selected.some(item => item.normalized === 'موضوعقدیمی'), false,
  'queries for topics no longer in the live RSS should not consume the current search batch');
assert.ok(selected.length <= 8);

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
