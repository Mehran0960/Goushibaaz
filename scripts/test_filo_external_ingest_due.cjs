'use strict';

const assert = require('node:assert/strict');
const { evaluateExternalIngestDue, EXTERNAL_SCAN_INTERVAL_MS } = require('./filo_external_ingest_due.cjs');

const now = Date.parse('2026-11-17T10:00:00.000Z');
const nativeReport = { status: 'no_candidate_passed_measured_velocity_gate' };

assert.equal(evaluateExternalIngestDue({ nativeReport: null, now }).due, false);
assert.equal(evaluateExternalIngestDue({ nativeReport: { status: 'unrecognized_or_missing_status' }, now }).due, false);
for (const status of ['public_verified','no_candidate_passed_measured_velocity_gate','no_recent_feed_candidates',
  'no_feed_candidates_after_safety_filters','no_candidate_published_this_cycle']) {
  assert.equal(evaluateExternalIngestDue({ nativeReport:{status}, now }).due, true,
    `the licensed source scan is independent of native status (${status})`);
}

const tooSoon = evaluateExternalIngestDue({
  nativeReport,
  scheduleState: { lastAttemptAt: new Date(now - 10 * 60 * 1000).toISOString() },
  now
});
assert.equal(tooSoon.due, false);
assert.equal(tooSoon.reason, 'external_scan_interval_not_elapsed',
  'the external scan interval should be 15 minutes, not a two-hour blind window');

const crossPathNoLocalGap = evaluateExternalIngestDue({
  nativeReport,
  nativeState: { posts: [{ status: 'public_verified', submittedAt: new Date(now - 5 * 60 * 1000).toISOString() }] },
  scheduleState: { lastAttemptAt: new Date(now - EXTERNAL_SCAN_INTERVAL_MS).toISOString() },
  now
});
assert.equal(crossPathNoLocalGap.due, true,
  'a completed native operation does not impose a local 17-minute cross-path publishing delay');

const due = evaluateExternalIngestDue({
  nativeReport,
  externalState: { lastOutcome: { checkedAt: new Date(now - 3 * EXTERNAL_SCAN_INTERVAL_MS).toISOString() }, posts: [] },
  scheduleState: { lastAttemptAt: new Date(now - 3 * EXTERNAL_SCAN_INTERVAL_MS).toISOString() },
  now
});
assert.equal(due.due, true);
assert.equal(due.reason, 'independent_licensed_external_scan_is_due');

const atSharedCap = evaluateExternalIngestDue({
  nativeReport,
  nativeState: { posts: Array.from({ length: 35 }, (_, index) => ({
    status: 'public_verified',
    submittedAt: new Date(now - (index + 1) * 60 * 1000).toISOString()
  })) },
  externalState: { posts: [{
    status: 'rejected_by_filo',
    attemptedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString()
  }] },
  scheduleState: { lastAttemptAt: new Date(now - EXTERNAL_SCAN_INTERVAL_MS).toISOString() },
  now
});
assert.equal(atSharedCap.due, false);
assert.equal(atSharedCap.reason, 'daily_limit_reached',
  'external discovery must not dispatch a publish operation after the shared cap is reached');

const activeAccountCooldown = evaluateExternalIngestDue({
  nativeReport,
  nativeState: {
    posts: [],
    accountRepublishQuotaCooldown: {
      retryAfterAt: new Date(now + 6 * 60 * 60 * 1000).toISOString()
    }
  },
  scheduleState: { lastAttemptAt: new Date(now - EXTERNAL_SCAN_INTERVAL_MS).toISOString() },
  now
});
assert.equal(activeAccountCooldown.due, false);
assert.equal(activeAccountCooldown.reason, 'filo_account_republish_quota_cooldown');
console.log('FILO_EXTERNAL_INGEST_DUE_TESTS_OK');
