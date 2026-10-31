'use strict';

const assert = require('node:assert/strict');
const {
  buildTrendSearches,
  rotateSearchBatch,
  scoreTrendTitleOverlap
} = require('./trend_discovery.cjs');

const now = Date.parse('2026-10-30T16:00:00.000Z');
const snapshot = {
  telegram: {
    comedy: {
      title: 'Unexpected football legend trick shot in Tehran #shorts',
      url: 'https://t.me/example/100',
      lane: 'comedy',
      velocity_kind: 'observed',
      velocity_per_hour: 12000,
      last_seen_at: new Date(now).toISOString()
    },
    politics: {
      title: 'Election rally unexpected footage',
      url: 'https://t.me/example/101',
      lane: 'news_or_current_affairs',
      velocity_kind: 'observed',
      velocity_per_hour: 900000,
      last_seen_at: new Date(now).toISOString()
    },
    stale: {
      title: 'Funny dog trick',
      url: 'https://t.me/example/102',
      lane: 'animals',
      velocity_kind: 'observed',
      velocity_per_hour: 50000,
      last_seen_at: new Date(now - 40 * 3600000).toISOString()
    },
    estimated: {
      title: 'Surprising pet moment',
      url: 'https://t.me/example/103',
      lane: 'animals',
      velocity_kind: 'estimated_from_lifetime_views',
      velocity_per_hour: 999999,
      last_seen_at: new Date(now).toISOString()
    },
    comedy2: {
      title: 'Funny cooking surprise reveal',
      url: 'https://t.me/example/104',
      lane: 'food_cooking',
      velocity_kind: 'observed',
      velocity_per_hour: 8000,
      last_seen_at: new Date(now).toISOString()
    }
  }
};

const firstSlot = buildTrendSearches(snapshot, { nowMs: now });
assert.equal(firstSlot.length, 1);
assert.match(firstSlot[0].query, /^filetype:video /);
assert.ok(firstSlot[0].trendTitle);
assert.ok(['comedy', 'food_cooking'].includes(firstSlot[0].trendLane));
assert.equal(firstSlot[0].trendUrl.startsWith('https://t.me/'), true);

const twoLeads = buildTrendSearches({
  social: {
    social1: {
      title: 'Unexpected satisfying restoration reveal',
      url: 'https://www.instagram.com/reel/ABC123/',
      lane: 'transformation_or_satisfying',
      velocity_kind: 'observed',
      velocity_per_hour: 7000,
      acceleration_per_hour2: 9000,
      last_seen_at: new Date(now).toISOString()
    }
  },
  ...snapshot
}, { nowMs: now, limit: 2 });
assert.equal(twoLeads.length, 2);
assert.ok(twoLeads.some(item => item.trendAcceleration > 0));

const nextSlot = buildTrendSearches(snapshot, { nowMs: now + 5 * 60000 });
assert.notEqual(nextSlot[0].trendUrl, firstSlot[0].trendUrl,
  'the observed trend lead should rotate on the next five-minute slot');

const batch = rotateSearchBatch(['a','b','c','d','e','f','g'], 3, now);
assert.deepEqual(batch.length, 3);
assert.notDeepEqual(batch, rotateSearchBatch(['a','b','c','d','e','f','g'], 3, now + 5 * 60000),
  'archive query batches should rotate between five-minute slots');

assert.ok(scoreTrendTitleOverlap(
  'Football legend performs an incredible trick shot',
  'Unexpected football legend trick shot in Tehran'
) >= 4, 'clear title overlap should add a meaningful trend relevance signal');
assert.equal(scoreTrendTitleOverlap(
  'A squirrel eats a nut',
  'Unexpected football legend trick shot in Tehran'
), 0, 'unrelated media should not receive a trend title-match bonus');

console.log('TREND_DISCOVERY_TESTS_PASSED');
