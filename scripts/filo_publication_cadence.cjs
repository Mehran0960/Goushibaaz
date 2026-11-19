'use strict';

const DEFAULT_MIN_PUBLICATION_GAP_MS = 0;
const DEFAULT_MAX_DAILY_PUBLICATIONS = 36;
const OPERATION_STATUSES = new Set([
  'public_verified',
  'published',
  'submit_started',
  'submitted_pending_approval',
  'submitted_unconfirmed',
  'submit_result_unconfirmed',
  'upload_staged_unpublished',
  'rejected_by_filo'
]);

function operationTimestamp(post) {
  if (!post || typeof post !== 'object') return null;
  const value = post.submittedAt || post.attemptedAt || post.publishedAt || post.checkedAt || post.at;
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isPublicationOperation(post) {
  return Boolean(post && OPERATION_STATUSES.has(String(post.status || '')));
}

function getCombinedPublicationOperationTimes({
  nativePosts = [],
  externalPosts = [],
  now = Date.now()
} = {}) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return [...(Array.isArray(nativePosts) ? nativePosts : []),
    ...(Array.isArray(externalPosts) ? externalPosts : [])]
    .filter(isPublicationOperation)
    .map(operationTimestamp)
    .filter(timestamp => Number.isFinite(timestamp) && timestamp <= nowMs)
    .sort((a, b) => a - b);
}

function evaluatePublicationCadence({
  nativePosts = [],
  externalPosts = [],
  now = Date.now(),
  minGapMs = DEFAULT_MIN_PUBLICATION_GAP_MS,
  maxDaily = DEFAULT_MAX_DAILY_PUBLICATIONS
} = {}) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const safeGap = Math.max(0, Number(minGapMs) || 0);
  const times = getCombinedPublicationOperationTimes({ nativePosts, externalPosts, now: nowMs });
  const windowStart = nowMs - 24 * 60 * 60 * 1000;
  const rolling24h = times.filter(timestamp => timestamp > windowStart);
  const todayCount = rolling24h.length;
  const lastOperationMs = times.at(-1) ?? null;
  const gapNextEligibleMs = lastOperationMs === null ? null : lastOperationMs + safeGap;
  const cooldown = gapNextEligibleMs !== null && gapNextEligibleMs > nowMs;
  const validDailyCap = Number.isFinite(Number(maxDaily)) && Number(maxDaily) > 0
    ? Number(maxDaily)
    : null;
  const dailyLimit = validDailyCap !== null && todayCount >= validDailyCap;
  // When already over the cap, wait until enough old operations expire from the rolling window.
  const dailyReleaseIndex = dailyLimit ? todayCount - validDailyCap : -1;
  const dailyLimitReleaseMs = dailyLimit
    ? rolling24h[dailyReleaseIndex] + 24 * 60 * 60 * 1000
    : null;
  const blocked = cooldown || dailyLimit;
  const nextAllowedMs = Math.max(
    cooldown ? gapNextEligibleMs : nowMs,
    dailyLimit ? dailyLimitReleaseMs : nowMs
  );

  return {
    allowed: !blocked,
    status: dailyLimit ? 'daily_limit_reached' : cooldown ? 'publication_cooldown' : 'allowed',
    todayCount,
    maxDaily: validDailyCap,
    minGapMs: safeGap,
    lastOperationAt: lastOperationMs === null ? null : new Date(lastOperationMs).toISOString(),
    nextAllowedAt: blocked ? new Date(nextAllowedMs).toISOString() : null,
    remainingMs: blocked ? Math.max(0, nextAllowedMs - nowMs) : 0
  };
}
}

module.exports = {
  DEFAULT_MIN_PUBLICATION_GAP_MS,
  DEFAULT_MAX_DAILY_PUBLICATIONS,
  OPERATION_STATUSES,
  operationTimestamp,
  isPublicationOperation,
  getCombinedPublicationOperationTimes,
  evaluatePublicationCadence
};
