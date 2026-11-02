'use strict';

const assert = require('node:assert/strict');
const {
  buildFiloTrendQueries,
  searchFiloGlobalTopic,
  normalizeFiloSearchItem,
  mapWithConcurrency
} = require('./filo_global_search.cjs');

const trends = [
  {
    title: 'نتیجه بازی تراکتور امروز',
    keywords: ['نتیجه', 'بازی', 'تراکتور'],
    traffic: 500000,
    publishedAt: '2026-11-02T17:30:00.000Z'
  },
  {
    title: 'شکیرا',
    keywords: ['شکیرا'],
    traffic: 100000
  }
];

const queries = buildFiloTrendQueries(trends);
assert.equal(queries.length, 3);
assert.equal(queries[0].query, 'نتیجه بازی تراکتور امروز');
assert.equal(queries[1].query, 'نتیجه بازی تراکتور');
assert.equal(queries[0].trendTitle, trends[0].title);
assert.equal(buildFiloTrendQueries(trends, { maxTopics: 1 }).length, 2);
const newsVariant = buildFiloTrendQueries([{
  title: 'شکیرا',
  keywords: ['شکیرا'],
  newsItems: [
    { title: 'اجرای تازه شکیرا در کنسرت مادرید' },
    { title: 'انتخابات میان‌دوره آمریکا و بیتکوین' }
  ]
}], { maxTopics: 1, maxQueriesPerTopic: 3 });
assert.equal(newsVariant.length, 2, 'related Google Trends news headlines should become extra search variants');
assert.equal(newsVariant[1].query, 'اجرای تازه شکیرا در کنسرت مادرید');

const calls = [];
const pages = {
  1: {
    page: 1,
    row_count: 40,
    has_more_load: 1,
    items: Array.from({ length: 20 }, (_, i) => ({
      video_code: 'video' + String(i).padStart(5, '0'),
      title: 'نتیجه بازی تراکتور شماره ' + i,
      duration: 24,
      category_id: 11
    }))
  },
  2: {
    page: 2,
    row_count: 40,
    has_more_load: '0',
    items: Array.from({ length: 20 }, (_, i) => ({
      video_code: 'second' + String(i).padStart(5, '0'),
      title: 'گل تراکتور شماره ' + i,
      duration: 31,
      category_id: 11
    }))
  }
};

(async () => {
  const result = await searchFiloGlobalTopic('نتیجه بازی تراکتور امروز', async params => {
    calls.push(params);
    return pages[params.page];
  }, { maxPages: 10, pageSize: 20, topicSearch: { trendTitle: trends[0].title, trendTraffic: 500000 } });

  assert.equal(result.complete, true);
  assert.equal(result.termination, 'has_more_load_false');
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.totalUniqueVideos, 40);
  assert.deepEqual(calls.map(x => x.page), [1, 2]);
  assert.equal(calls[0].rowCount, null);
  assert.equal(result.results[0].video_code, 'video00000');
  assert.equal(result.results[0].globalTrendSearch.trendTitle, trends[0].title);
  assert.deepEqual(result.results[0].globalTrendSearch.trendKeywords, trends[0].keywords);

  const nested = await searchFiloGlobalTopic('nested', async () => ({
    data: { p: 1, hm: 0, l: [{ v: 'Nested01', t: 'عنوان ویدئو' }] }
  }));
  assert.equal(nested.complete, true);
  assert.equal(nested.results[0].video_code, 'Nested01');

  const shortPage = await searchFiloGlobalTopic('short', async () => ({
    items: [{ code: 'Short01', title: 'عنوان ویدئو' }]
  }));
  assert.equal(shortPage.complete, true);
  assert.equal(shortPage.termination, 'short_final_page');

  const capped = await searchFiloGlobalTopic('long', async params => ({
    items: Array.from({ length: 20 }, (_, i) => ({
      code: 'page' + params.page + 'item' + i,
      title: 'عنوان ویدئو'
    })),
    has_more_load: 1
  }), { maxPages: 2 });
  assert.equal(capped.complete, false);
  assert.equal(capped.termination, 'max_pages_reached');
  assert.equal(capped.pagesFetched, 2);

  const resumedCalls = [];
  const resumed = await searchFiloGlobalTopic('resume', async params => {
    resumedCalls.push(params.page);
    return {
      items: Array.from({ length: 20 }, (_, i) => ({
        code: 'resume' + params.page + 'item' + i,
        title: 'عنوان ویدئو'
      })),
      has_more_load: 1
    };
  }, { startPage: 3, maxPages: 2, pageSize: 20 });
  assert.equal(resumed.startPage, 3);
  assert.equal(resumed.nextPage, 5);
  assert.deepEqual(resumedCalls, [3, 4]);
  assert.equal(resumed.complete, false);

  const bad = await searchFiloGlobalTopic('bad', async () => {
    throw new Error('network unavailable');
  });
  assert.equal(bad.complete, false);
  assert.equal(bad.termination, 'request_failed');

  const mapped = await mapWithConcurrency([1, 2, 3, 4], 2, async n => n * 2);
  assert.deepEqual(mapped, [2, 4, 6, 8]);

  const sample = normalizeFiloSearchItem({
    i: 'alias01',
    t: 'عنوان کوتاه'
  }, { query: 'موضوع' });
  assert.equal(sample.video_code, 'alias01');
  assert.equal(sample.title, 'عنوان کوتاه');

  console.log('FILO_GLOBAL_SEARCH_TESTS_PASSED');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
