'use strict';

const assert = require('node:assert/strict');
const {
  RSS_URL,
  parseTraffic,
  parseIranTrendsRss,
  scoreGoogleTrendRelevance,
  fetchIranGoogleTrends
} = require('./google_trends_iran.cjs');

const NOW = Date.parse('2026-11-02T18:00:00.000Z');
const fixture = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss"><channel>',
  '<item><title>نتیجه بازی تراکتور امروز</title><ht:approx_traffic>500,000+</ht:approx_traffic><pubDate>Mon, 02 Nov 2026 17:30:00 GMT</pubDate>',
  '<ht:news_item><ht:news_item_title>گزارش دیدار تراکتور</ht:news_item_title><ht:news_item_source>نمونه</ht:news_item_source></ht:news_item></item>',
  '<item><title>شکیرا</title><ht:approx_traffic>100K+</ht:approx_traffic><pubDate>Mon, 02 Nov 2026 16:00:00 GMT</pubDate></item>',
  '<item><title>وضعیت هوای تهران فردا</title><ht:approx_traffic>200K+</ht:approx_traffic><pubDate>Mon, 02 Nov 2026 17:00:00 GMT</pubDate></item>',
  '<item><title>weather tomorrow</title><ht:approx_traffic>5K+</ht:approx_traffic><pubDate>Mon, 02 Nov 2026 17:10:00 GMT</pubDate></item>',
  '<item><title>رمزارز</title><ht:approx_traffic>50K+</ht:approx_traffic><pubDate>Mon, 02 Nov 2026 17:20:00 GMT</pubDate></item>',
  '<item><title>حمله آمریکا</title><ht:approx_traffic>20K+</ht:approx_traffic><pubDate>Mon, 02 Nov 2026 17:25:00 GMT</pubDate></item>',
  '<item><title>بیتکوین</title><ht:approx_traffic>500K+</ht:approx_traffic><pubDate>Mon, 02 Nov 2026 17:28:00 GMT</pubDate></item>',
  '<item><title>سپاه پاسداران انقلاب اسلامی</title><ht:approx_traffic>100K+</ht:approx_traffic><pubDate>Mon, 02 Nov 2026 17:29:00 GMT</pubDate></item>',
  '<item><title>افغانی افغانستان</title><ht:approx_traffic>5K+</ht:approx_traffic><pubDate>Mon, 02 Nov 2026 17:29:30 GMT</pubDate></item>',
  '<item><title>ترند قدیمی سرگرمی</title><ht:approx_traffic>1M+</ht:approx_traffic><pubDate>Fri, 30 Oct 2026 10:00:00 GMT</pubDate></item>',
  '</channel></rss>'
].join('\n');

assert.equal(RSS_URL, 'https://trends.google.com/trending/rss?geo=IR');
assert.equal(parseTraffic('500,000+'), 500000);
assert.equal(parseTraffic('1.2M+'), 1200000);

const trends = parseIranTrendsRss(fixture, { nowMs: NOW, maxItems: 20 });
assert.equal(trends.length, 2, 'weather and stale topics should be discarded');
assert.equal(trends[0].title, 'نتیجه بازی تراکتور امروز');
assert.equal(trends[0].newsItems[0].title, 'گزارش دیدار تراکتور');

const match = scoreGoogleTrendRelevance(
  'خلاصه ویدئویی نتیجه بازی تراکتور با گل تماشایی',
  trends
);
assert.ok(match.score >= 5);
assert.equal(match.match.title, 'نتیجه بازی تراکتور امروز');

const singleWordMatch = scoreGoogleTrendRelevance('اجرای زنده شکیرا روی صحنه', trends);
assert.ok(singleWordMatch.score > 0);
assert.equal(scoreGoogleTrendRelevance('گربه بازیگوش در خانه', trends).score, 0);

(async () => {
  let requested = '';
  const fetched = await fetchIranGoogleTrends({
    nowMs: NOW,
    fetchImpl: async url => {
      requested = String(url);
      return { ok: true, status: 200, text: async () => fixture };
    }
  });
  assert.equal(requested, RSS_URL);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.items.length, 2);

  const failed = await fetchIranGoogleTrends({
    nowMs: NOW,
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' })
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.items.length, 0);

  console.log('GOOGLE_TRENDS_IRAN_TESTS_PASSED');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
