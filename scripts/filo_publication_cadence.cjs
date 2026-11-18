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

function getActiveAccountQuotaCooldown(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const retryAfter = Date.parse(entry.retryAfterAt || '');
  if (!Number.isFinite(retryAfter) || retryAfter <= current) return null;
  return { ...entry, remainingMs: retryAfter - current };
}

function evaluatePublicationCadence({
  nativePosts = [],
  externalPosts = [],
  now = Date.now(),
  minGapMs = DEFAULT_MIN_PUBLICATION_GAP_MS,
  maxDaily = null
} = {}) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const safeGap = Math.max(0, Number(minGapMs) || 0);
  const times = getCombinedPublicationOperationTimes({ nativePosts, externalPosts, now: nowMs });
  const windowStart = nowMs - 24 * 60 * 60 * 1000;
  const todayCount = times.filter(timestamp => timestamp > windowStart).length;
  const lastOperationMs = times.at(-1) ?? null;
  const nextEligibleMs = lastOperationMs === null ? null : lastOperationMs + safeGap;
  const cooldown = nextEligibleMs !== null && nextEligibleMs > nowMs;
  const dailyLimit = Number.isFinite(Number(maxDaily)) && Number(maxDaily) > 0 &&
    todayCount >= Number(maxDaily);

  return {
    allowed: !cooldown && !dailyLimit,
    status: dailyLimit ? 'daily_limit_reached' : cooldown ? 'publication_cooldown' : 'allowed',
    todayCount,
    maxDaily: Number.isFinite(Number(maxDaily)) && Number(maxDaily) > 0 ? Number(maxDaily) : null,
    minGapMs: safeGap,
    lastOperationAt: lastOperationMs === null ? null : new Date(lastOperationMs).toISOString(),
    nextAllowedAt: cooldown ? new Date(nextEligibleMs).toISOString() : null,
    remainingMs: cooldown ? Math.max(0, nextEligibleMs - nowMs) : 0
  };
}

module.exports = {
  DEFAULT_MIN_PUBLICATION_GAP_MS,
  DEFAULT_MAX_DAILY_PUBLICATIONS,
  OPERATION_STATUSES,
  operationTimestamp,
  isPublicationOperation,
  getActiveAccountQuotaCooldown,
  getCombinedPublicationOperationTimes,
  evaluatePublicationCadence
};
