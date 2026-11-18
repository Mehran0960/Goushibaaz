'use strict';

const assert = require('node:assert/strict');
const {
  DEFAULT_MIN_PUBLICATION_GAP_MS,
  DEFAULT_MAX_DAILY_PUBLICATIONS,
  getCombinedPublicationOperationTimes,
  getActiveAccountQuotaCooldown,
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

const immediatelyEligible = evaluatePublicationCadence({ nativePosts, externalPosts, now });
assert.equal(immediatelyEligible.allowed, true);
assert.equal(immediatelyEligible.status, 'allowed');
assert.equal(immediatelyEligible.minGapMs, 0);
assert.equal(immediatelyEligible.nextAllowedAt, null,
  'native and external paths share one ledger but no artificial 17-minute minimum gap');

const exactBoundary = evaluatePublicationCadence({
  nativePosts: [{ status: 'public_verified', submittedAt: new Date(now - DEFAULT_MIN_PUBLICATION_GAP_MS).toISOString() }],
  externalPosts: [],
  now
});
assert.equal(exactBoundary.allowed, true, 'publishing is allowed without an artificial minimum gap');

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
assert.equal(DEFAULT_MAX_DAILY_PUBLICATIONS, 36,
  'the shared Filo account publication ceiling is 36 over a rolling 24-hour window');

const combinedAccountCap = evaluatePublicationCadence({
  nativePosts: Array.from({length:18},(_,i)=>({status:'public_verified',submittedAt:new Date(now-(i+1)*60*1000).toISOString()})),
  externalPosts: Array.from({length:18},(_,i)=>({status:'submitted_pending_approval',submittedAt:new Date(now-(i+20)*60*1000).toISOString()})),
  now,
  maxDaily:36
});
assert.equal(combinedAccountCap.allowed,false,
  'native and licensed-source ledgers share one account-wide 36-operation ceiling');
assert.equal(combinedAccountCap.todayCount,36);

const quotaCooldown = getActiveAccountQuotaCooldown({retryAfterAt:new Date(now+60*60*1000).toISOString()},now);
assert.equal(quotaCooldown.remainingMs,60*60*1000,
  'the licensed-source path must honor an active account-level Filo cooldown');
assert.equal(getActiveAccountQuotaCooldown({retryAfterAt:new Date(now-1).toISOString()},now),null,
  'an expired account-level cooldown no longer blocks publication');
console.log('FILO_SHARED_PUBLICATION_CADENCE_TESTS_OK');
