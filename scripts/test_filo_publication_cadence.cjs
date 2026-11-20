'use strict';

const assert = require('node:assert/strict');
const {
  DEFAULT_MIN_PUBLICATION_GAP_MS,
  getCombinedPublicationOperationTimes,
  evaluatePublicationCadence
} = require('./filo_publication_cadence.cjs');

const now = Date.parse('2026-11-17T10:00:00.000Z');
const nativePosts = [
  { status: 'public_verified', submittedAt: '2026-11-17T09:30:00.000Z' },
  { status: 'rejected_by_filo', attemptedAt: '2026-11-17T09:45:00.000Z' },
  { status: 'ignored', submittedAt: '2026-11-17T09:59:00.000Z' }
];
const externalPosts = [
  { status: 'submitted_pending_approval', submittedAt: '2026-11-17T09:50:00.000Z' },
  { status: 'published', publishedAt: '2026-11-17T11:00:00.000Z' }
];

assert.deepEqual(
  getCombinedPublicationOperationTimes({ nativePosts, externalPosts, now }),
  [
    Date.parse('2026-11-17T09:30:00.000Z'),
    Date.parse('2026-11-17T09:45:00.000Z'),
    Date.parse('2026-11-17T09:50:00.000Z')
  ],
  'both ledgers are combined, ignored statuses are skipped and future timestamps do not count'
);

const immediatelyBlocked = evaluatePublicationCadence({ nativePosts, externalPosts, now });
assert.equal(immediatelyBlocked.allowed, false);
assert.equal(immediatelyBlocked.status, 'publication_cooldown');
assert.equal(immediatelyBlocked.minGapMs, 40 * 60 * 1000);
assert.equal(immediatelyBlocked.nextAllowedAt, '2026-11-17T10:30:00.000Z',
  'native and external paths share one 40-minute rolling publication interval');

const exactBoundary = evaluatePublicationCadence({
  nativePosts: [{ status: 'public_verified', submittedAt: new Date(now - DEFAULT_MIN_PUBLICATION_GAP_MS).toISOString() }],
  externalPosts: [],
  now
});
assert.equal(exactBoundary.allowed, true, 'a new slot opens exactly 40 minutes after the previous operation');

const dailyCap = evaluatePublicationCadence({
  nativePosts: Array.from({ length: 3 }, (_, index) => ({
    status: 'public_verified',
    submittedAt: new Date(now - (index + 1) * 30 * 60 * 1000).toISOString()
  })),
  externalPosts: [],
  now,
  minGapMs: 0,
  maxDaily: 3
});
assert.equal(dailyCap.allowed, false);
assert.equal(dailyCap.status, 'daily_limit_reached');
const sharedRollingCap = evaluatePublicationCadence({
  nativePosts: Array.from({ length: 35 }, (_, index) => ({
    status: 'public_verified',
    submittedAt: new Date(now - (index + 1) * 60 * 1000).toISOString()
  })),
  externalPosts: [{
    status: 'rejected_by_filo',
    attemptedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
  }],
  now,
  maxDaily: 36
});
assert.equal(sharedRollingCap.allowed, false);
assert.equal(sharedRollingCap.status, 'daily_limit_reached');
assert.equal(sharedRollingCap.todayCount, 36);
assert.equal(
  sharedRollingCap.nextAllowedAt,
  new Date(now - 2 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000).toISOString(),
  'the oldest counted operation must expire before the next slot opens'
);
console.log('FILO_SHARED_PUBLICATION_CADENCE_TESTS_OK');
