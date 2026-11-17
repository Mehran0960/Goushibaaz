'use strict';

const assert = require('node:assert/strict');
const { evaluateExternalIngestDue, EXTERNAL_SCAN_INTERVAL_MS } = require('./filo_external_ingest_due.cjs');

const now = Date.parse('2026-11-17T10:00:00.000Z');
const nativeReport = { status: 'no_candidate_passed_measured_velocity_gate' };

assert.equal(evaluateExternalIngestDue({ nativeReport: null, now }).due, false);
assert.equal(evaluateExternalIngestDue({ nativeReport: { status: 'no_candidate_published_this_cycle' }, now }).due, false);
assert.equal(evaluateExternalIngestDue({
  nativeReport: { status: 'no_recent_feed_candidates' },
  now
}).due, true, 'an empty recent Filo feed should activate the independent licensed fallback');
assert.equal(evaluateExternalIngestDue({
  nativeReport: { status: 'no_feed_candidates_after_safety_filters' },
  now
}).due, true, 'a Filo feed with no safe candidates should still allow a separately rights-cleared source search');

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
assert.equal(due.reason, 'native_has_no_growth_candidate_and_external_scan_is_due');
console.log('FILO_EXTERNAL_INGEST_DUE_TESTS_OK');
