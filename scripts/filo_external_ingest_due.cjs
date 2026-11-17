'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_MIN_PUBLICATION_GAP_MS,
  evaluatePublicationCadence
} = require('./filo_publication_cadence.cjs');

const NATIVE_REPORT_PATH = path.join('out', 'filo-native-republish.json');
const NATIVE_STATE_PATH = path.join('state', 'filo-native-republished.json');
const EXTERNAL_STATE_PATH = path.join('state', 'filo-published.json');
const SCHEDULE_STATE_PATH = path.join('state', 'filo-external-ingest-schedule.json');
const EXTERNAL_SCAN_INTERVAL_MS = 2 * 60 * 60 * 1000;
const NATIVE_FALLBACK_STATUSES = new Set([
  'no_candidate_passed_measured_velocity_gate',
  'no_recent_feed_candidates',
  'no_feed_candidates_after_safety_filters'
]);

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function evaluateExternalIngestDue({
  nativeReport,
  nativeState = {},
  externalState = {},
  scheduleState = {},
  now = Date.now(),
  minGapMs = DEFAULT_MIN_PUBLICATION_GAP_MS,
  intervalMs = EXTERNAL_SCAN_INTERVAL_MS
} = {}) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (!nativeReport || !NATIVE_FALLBACK_STATUSES.has(String(nativeReport.status || ''))) {
    return { due: false, reason: 'native_cycle_not_eligible_for_external_fallback' };
  }

  const priorCandidates = [
    scheduleState.lastAttemptAt,
    externalState.lastOutcome && externalState.lastOutcome.checkedAt
  ].map(value => Date.parse(value || '')).filter(Number.isFinite);
  const priorAt = priorCandidates.length ? Math.max(...priorCandidates) : Number.NaN;
  if (Number.isFinite(priorAt) && priorAt > nowMs) {
    return { due: false, reason: 'external_scan_timestamp_in_future', lastAttemptAt: new Date(priorAt).toISOString() };
  }
  if (Number.isFinite(priorAt) && nowMs - priorAt < intervalMs) {
    return {
      due: false,
      reason: 'external_scan_interval_not_elapsed',
      lastAttemptAt: new Date(priorAt).toISOString(),
      nextDueAt: new Date(priorAt + intervalMs).toISOString()
    };
  }

  const cadence = evaluatePublicationCadence({
    nativePosts: nativeState.posts,
    externalPosts: externalState.posts,
    now: nowMs,
    minGapMs
  });
  if (!cadence.allowed) {
    return {
      due: false,
      reason: cadence.status,
      lastOperationAt: cadence.lastOperationAt,
      nextAllowedAt: cadence.nextAllowedAt
    };
  }

  return {
    due: true,
    reason: 'native_has_no_growth_candidate_and_external_scan_is_due',
    lastAttemptAt: Number.isFinite(priorAt) ? new Date(priorAt).toISOString() : null,
    nextDueAt: new Date(nowMs + intervalMs).toISOString(),
    cadence
  };
}

function main() {
  const now = new Date();
  const nativeReport = readJson(NATIVE_REPORT_PATH, null);
  const nativeState = readJson(NATIVE_STATE_PATH, { posts: [] });
  const externalState = readJson(EXTERNAL_STATE_PATH, { posts: [] });
  const scheduleState = readJson(SCHEDULE_STATE_PATH, {});
  const decision = evaluateExternalIngestDue({
    nativeReport,
    nativeState,
    externalState,
    scheduleState,
    now: now.getTime()
  });

  if (decision.due) {
    fs.mkdirSync(path.dirname(SCHEDULE_STATE_PATH), { recursive: true });
    fs.writeFileSync(SCHEDULE_STATE_PATH, JSON.stringify({
      schemaVersion: 1,
      lastAttemptAt: now.toISOString(),
      trigger: 'native_no_candidate_fallback',
      intervalMs: EXTERNAL_SCAN_INTERVAL_MS
    }, null, 2) + '\n', 'utf8');
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'due=' + String(decision.due) + '\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'reason=' + String(decision.reason || 'unknown') + '\n');
  }
  console.log('FILO_EXTERNAL_INGEST_DUE ' + JSON.stringify({
    ...decision,
    checkedAt: now.toISOString(),
    scanIntervalMs: EXTERNAL_SCAN_INTERVAL_MS,
    minPublicationGapMs: DEFAULT_MIN_PUBLICATION_GAP_MS
  }));
}

if (require.main === module) main();

module.exports = {
  EXTERNAL_SCAN_INTERVAL_MS,
  evaluateExternalIngestDue
};
