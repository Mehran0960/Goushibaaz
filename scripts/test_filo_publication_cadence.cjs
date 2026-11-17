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

const blocked = evaluatePublicationCadence({ nativePosts, externalPosts, now });
assert.equal(blocked.allowed, false);
assert.equal(blocked.status, 'publication_cooldown');
assert.equal(blocked.nextAllowedAt, '2026-11-17T10:07:00.000Z',
  'a native or external operation blocks the other path for the full shared 17-minute gap');

const exactBoundary = evaluatePublicationCadence({
  nativePosts: [{ status: 'public_verified', submittedAt: new Date(now - DEFAULT_MIN_PUBLICATION_GAP_MS).toISOString() }],
  externalPosts: [],
  now
});
assert.equal(exactBoundary.allowed, true, 'publishing is allowed exactly at the 17-minute boundary');

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
console.log('FILO_SHARED_PUBLICATION_CADENCE_TESTS_OK');
