'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_DIR = '.scheduler-state';
const STATE_PATH = path.join(STATE_DIR, 'state.json');
// Register every active publisher here. Each one is dispatched concurrently in the same publication slot.
const ACTIVE_PLATFORMS = [
  { key: 'filo', workflow: 'publish-approved-video-to-filo.yml', stateFile: 'state/filo-published.json' },
  { key: 'rubika', workflow: 'publish-approved-video-to-rubika.yml', stateFile: 'state/rubika-published.json' }
];
// Reserve quota for two planned future platform adapters.
const FUTURE_PLATFORM_RESERVE = 2;
const MAX_DESTINATION_STARTS_PER_UTC_DAY = 900;
const INTERVALS = [7, 17, 27, 37, 47, 57, 77, 97, 127, 157, 187, 217, 247, 277, 337, 397, 457, 517, 637, 757, 877, 997, 1117, 1237, 1357];
const API_VERSION = '2022-11-28';
const TOKEN = process.env.GH_TOKEN;
const CURRENT_REPO = process.env.GITHUB_REPOSITORY;
const OTHER_PUBLIC_REPOS = ['Mehran0960/ai_news_bot', 'Mehran0960/TrendsUpLoader'];
const RECENT_WINDOW_MS = 60 * 60 * 1000;
const OUTCOME_FRESH_MS = 2 * 60 * 60 * 1000;
const KNOWN_ELIGIBLE = new Set([
  'candidate_ready', 'published', 'submitted_pending_approval', 'submit_result_unconfirmed',
  'submitted_unconfirmed', 'upload_failed_retryable', 'dry_run_ready_no_post_sent'
]);

const output = (key, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, key + '=' + String(value) + '\n');
const log = (event, details = {}) => console.log(event, JSON.stringify(details));
const iso = value => new Date(value).toISOString();

function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

function nextUtcMidnight(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 2, 0);
}

function freshState(now) {
  return {
    schema: 2,
    utcDay: utcDay(now),
    daily: { total: 0, filo: 0, rubika: 0 },
    lastIntervalMinutes: null,
    lastDispatchAt: null,
    nextDueAt: null,
    pendingDestinations: [],
    lastDecision: 'initialized'
  };
}

function normalizeState(state, now) {
  if (!state || state.schema !== 2) {
    const priorDue = state && state.nextDueAt;
    const priorInterval = state && state.lastIntervalMinutes;
    state = freshState(now);
    state.nextDueAt = priorDue || null;
    state.lastIntervalMinutes = Number.isFinite(Number(priorInterval)) ? Number(priorInterval) : null;
    state.lastDecision = 'migrated_to_synchronized_cadence';
  }
  if (!state.daily || typeof state.daily !== 'object') state.daily = { total: 0 };
  const cleanCount = value => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  state.daily.total = cleanCount(state.daily.total);
  for (const p of ACTIVE_PLATFORMS) state.daily[p.key] = cleanCount(state.daily[p.key]);
  if (state.utcDay !== utcDay(now)) {
    state.utcDay = utcDay(now);
    state.daily = { total: 0 };
    for (const p of ACTIVE_PLATFORMS) state.daily[p.key] = 0;
    state.pendingDestinations = [];
    state.lastDecision = 'daily_counters_reset';
  }
  if (!Array.isArray(state.pendingDestinations)) state.pendingDestinations = [];
  state.pendingDestinations = [...new Set(state.pendingDestinations)].filter(
    key => ACTIVE_PLATFORMS.some(p => p.key === key)
  );
  if (![...INTERVALS, null].includes(state.lastIntervalMinutes)) state.lastIntervalMinutes = null;
  return state;
}

async function api(url, options = {}) {
  if (!TOKEN) throw new Error('GITHUB_TOKEN_unavailable');
  return fetch(url, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + TOKEN,
      'x-github-api-version': API_VERSION,
      'user-agent': 'GoushibaazSynchronizedPublisherScheduler/1.0',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(15000)
  });
}

async function publicRuns(repo) {
  const response = await fetch('https://api.github.com/repos/' + repo + '/actions/runs?per_page=100', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'GoushibaazSynchronizedPublisherScheduler/1.0' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) return { ok: false, status: response.status, runs: [] };
  const payload = await response.json();
  return { ok: true, status: response.status, runs: payload.workflow_runs || [] };
}

async function readOutcome(file) {
  try {
    const response = await api('https://api.github.com/repos/' + CURRENT_REPO + '/contents/' + file + '?ref=main');
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload.content) return null;
    const state = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8'));
    return state.lastOutcome && typeof state.lastOutcome === 'object' ? state.lastOutcome : null;
  } catch {
    return null;
  }
}

function outcomeFresh(outcome, now) {
  const age = outcome && Date.parse(outcome.checkedAt);
  return Number.isFinite(age) && age <= now && now - age <= OUTCOME_FRESH_MS;
}

function intervalForPressure({ accountActive, recentRuns, remaining, outcomesComplete, outcomes, budgetedPlatforms }) {
  let floor = 7;
  // Conservative estimate against the lowest standard GitHub-hosted runner concurrency tier.
  const projectedConcurrency = accountActive + ACTIVE_PLATFORMS.length + FUTURE_PLATFORM_RESERVE;
  if (projectedConcurrency >= 20) floor = Math.max(floor, 97);
  else if (projectedConcurrency >= 17) floor = Math.max(floor, 57);
  else if (projectedConcurrency >= 14) floor = Math.max(floor, 37);
  else if (projectedConcurrency >= 11) floor = Math.max(floor, 27);
  else if (projectedConcurrency >= 8) floor = Math.max(floor, 17);

  // Recent runs are a pressure signal, not a claim about exact billing or remaining minutes.
  if (recentRuns >= 90) floor = Math.max(floor, 97);
  else if (recentRuns >= 70) floor = Math.max(floor, 57);
  else if (recentRuns >= 50) floor = Math.max(floor, 37);
  else if (recentRuns >= 30) floor = Math.max(floor, 27);
  else if (recentRuns >= 18) floor = Math.max(floor, 17);

  // GITHUB_TOKEN's actual response headers are authoritative for this repository's API quota.
  if (remaining !== null) {
    if (remaining <= 25) floor = Math.max(floor, 1357);
    else if (remaining <= 75) floor = Math.max(floor, 97);
    else if (remaining <= 150) floor = Math.max(floor, 57);
    else if (remaining <= 250) floor = Math.max(floor, 37);
    else if (remaining <= 400) floor = Math.max(floor, 27);
    else if (remaining <= 600) floor = Math.max(floor, 17);
  }
  if (!outcomesComplete) floor = Math.max(floor, 17);

  const fresh = outcomes.filter(x => outcomeFresh(x, Date.now()));
  const noCandidates = fresh.filter(x => x.status === 'no_eligible_candidate').length;
  const positive = fresh.some(x => KNOWN_ELIGIBLE.has(x.status));
  if (!positive && noCandidates >= ACTIVE_PLATFORMS.length) floor = Math.max(floor, 27);
  else if (!positive && noCandidates > 0) floor = Math.max(floor, 17);

  // The daily cap includes the two future-platform slots in its forecast.
  const choices = INTERVALS.filter(n =>
    n >= floor && budgetedPlatforms * Math.ceil(1440 / n) <= MAX_DESTINATION_STARTS_PER_UTC_DAY
  );
  const selected = choices[0] || INTERVALS[INTERVALS.length - 1];
  return {
    selected,
    floor,
    projectedStartsAtSelected: budgetedPlatforms * Math.ceil(1440 / selected)
  };
}

async function persist(state, changed) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
  output('state_changed', changed ? 'true' : 'false');
}

async function dispatchOne(platform) {
  try {
    const response = await api('https://api.github.com/repos/' + CURRENT_REPO + '/actions/workflows/' + platform.workflow + '/dispatches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'main' })
    });
    if (response.status === 204) return { key: platform.key, workflow: platform.workflow, ok: true, status: 204 };
    const body = (await response.text()).slice(0, 350);
    return {
      key: platform.key, workflow: platform.workflow, ok: false, status: response.status, error: body,
      remaining: response.headers.get('x-ratelimit-remaining'), reset: response.headers.get('x-ratelimit-reset')
    };
  } catch (error) {
    return { key: platform.key, workflow: platform.workflow, ok: false, status: 0,
      error: String(error && error.message || error).slice(0, 250) };
  }
}

async function main() {
  const now = Date.now();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let state;
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { state = freshState(now); }
  const oldDay = state.utcDay;
  state = normalizeState(state, now);
  let changed = oldDay !== state.utcDay || !fs.existsSync(STATE_PATH);

  if (process.env.GITHUB_EVENT_NAME !== 'schedule') {
    log('SCHEDULER_NOOP', { reason: 'manual run is read-only; cron owns the cadence' });
    if (changed) await persist(state, true); else output('state_changed', 'false');
    return;
  }
  if (state.nextDueAt && Number.isFinite(Date.parse(state.nextDueAt)) && now < Date.parse(state.nextDueAt)) {
    log('SCHEDULER_NOT_DUE', { now: iso(now), nextDueAt: state.nextDueAt, daily: state.daily });
    if (changed) await persist(state, true); else output('state_changed', 'false');
    return;
  }

  const budgetedPlatforms = ACTIVE_PLATFORMS.length + FUTURE_PLATFORM_RESERVE;
  if (state.daily.total >= MAX_DESTINATION_STARTS_PER_UTC_DAY && state.pendingDestinations.length === 0) {
    state.nextDueAt = iso(nextUtcMidnight(now));
    state.lastDecision = 'daily_destination_start_cap_reached';
    await persist(state, true);
    log('SCHEDULER_DAILY_CAP', { cap: MAX_DESTINATION_STARTS_PER_UTC_DAY, daily: state.daily, nextDueAt: state.nextDueAt });
    return;
  }

  const runsResponse = await api('https://api.github.com/repos/' + CURRENT_REPO + '/actions/runs?per_page=100');
  const remainingHeader = runsResponse.headers.get('x-ratelimit-remaining');
  const remaining = remainingHeader === null ? null : Number(remainingHeader);
  if (!runsResponse.ok) {
    const retrySeconds = Number(runsResponse.headers.get('retry-after') || 0);
    const resetSeconds = Number(runsResponse.headers.get('x-ratelimit-reset') || 0);
    const waitMs = retrySeconds > 0 ? retrySeconds * 1000 + 15000
      : resetSeconds * 1000 > now ? resetSeconds * 1000 - now + 30000 : 27 * 60000;
    state.nextDueAt = iso(now + Math.max(7 * 60000, waitMs));
    state.lastDecision = 'github_run_status_api_blocked_' + runsResponse.status;
    await persist(state, true);
    log('SCHEDULER_GITHUB_API_BLOCKED', { status: runsResponse.status, remaining, nextDueAt: state.nextDueAt });
    return;
  }
  const currentPayload = await runsResponse.json();
  const currentRuns = currentPayload.workflow_runs || [];
  const publisherPathSet = new Set(ACTIVE_PLATFORMS.map(p => '.github/workflows/' + p.workflow));
  const activePublishers = currentRuns.filter(run => publisherPathSet.has(run.path) && ['queued', 'in_progress'].includes(run.status));
  if (activePublishers.length) {
    state.nextDueAt = iso(now + 7 * 60000);
    state.lastDecision = 'wait_for_previous_synchronized_publishers';
    await persist(state, true);
    log('SCHEDULER_DEFER_ACTIVE_PUBLISHER', {
      active: activePublishers.map(run => ({ path: run.path, status: run.status, id: run.id })),
      nextDueAt: state.nextDueAt
    });
    return;
  }

  // Include current activity from the user's other public publishing repositories in capacity decisions.
  const externalResults = await Promise.all(OTHER_PUBLIC_REPOS.map(publicRuns));
  const externalComplete = externalResults.every(x => x.ok);
  const allObservedRuns = [...currentRuns, ...externalResults.flatMap(x => x.runs)];
  // If an external public Actions endpoint is rate-limited, reserve extra headroom instead of treating its load as zero.
  const observedActive = allObservedRuns.filter(run => ['queued', 'in_progress'].includes(run.status)).length;
  const observedRecentRuns = allObservedRuns.filter(run => {
    const created = Date.parse(run.created_at || '');
    return Number.isFinite(created) && created >= now - RECENT_WINDOW_MS;
  }).length;
  const accountActive = observedActive + (externalComplete ? 0 : 6);
  const recentRuns = observedRecentRuns + (externalComplete ? 0 : 30);

  const outcomeResults = await Promise.all(ACTIVE_PLATFORMS.map(p => readOutcome(p.stateFile)));
  const outcomesComplete = outcomeResults.every(Boolean);
  const cadence = intervalForPressure({
    accountActive,
    recentRuns,
    remaining: Number.isFinite(remaining) ? remaining : null,
    outcomesComplete,
    outcomes: outcomeResults.filter(Boolean),
    budgetedPlatforms
  });
  let selectedInterval = cadence.selected;
  if (!externalComplete) selectedInterval = Math.max(selectedInterval, 27);

  const planned = state.pendingDestinations.length
    ? ACTIVE_PLATFORMS.filter(p => state.pendingDestinations.includes(p.key))
    : ACTIVE_PLATFORMS;
  // Avoid crowding the lowest standard hosted-runner concurrency tier; if capacity is tight, skip every platform together.
  const projectedConcurrency = accountActive + planned.length + FUTURE_PLATFORM_RESERVE;
  if (projectedConcurrency >= 20) {
    state.nextDueAt = iso(now + selectedInterval * 60000);
    state.lastIntervalMinutes = selectedInterval;
    state.lastDecision = 'deferred_for_account_runner_capacity';
    await persist(state, true);
    log('SCHEDULER_DEFER_ACCOUNT_CAPACITY', {
      accountActive,
      planned: planned.map(p => p.key),
      reserveForFuturePlatforms: FUTURE_PLATFORM_RESERVE,
      selectedInterval,
      nextDueAt: state.nextDueAt
    });
    return;
  }

  if (state.daily.total + planned.length > MAX_DESTINATION_STARTS_PER_UTC_DAY) {
    state.nextDueAt = iso(nextUtcMidnight(now));
    state.lastDecision = 'daily_start_cap_would_be_exceeded';
    await persist(state, true);
    log('SCHEDULER_DAILY_CAP', { cap: MAX_DESTINATION_STARTS_PER_UTC_DAY, daily: state.daily, planned: planned.map(p => p.key) });
    return;
  }

  // These REST dispatches are deliberately launched together for a synchronized publication slot.
  const dispatches = await Promise.all(planned.map(dispatchOne));
  const accepted = dispatches.filter(x => x.ok);
  const failed = dispatches.filter(x => !x.ok);
  for (const item of accepted) {
    state.daily.total += 1;
    state.daily[item.key] = Number(state.daily[item.key] || 0) + 1;
  }
  state.pendingDestinations = failed.map(x => x.key);
  state.lastDispatchAt = iso(now);
  state.lastIntervalMinutes = selectedInterval;
  state.nextDueAt = iso(now + selectedInterval * 60000);
  state.lastDecision = failed.length ? 'partial_synchronized_dispatch_retry_pending' : 'synchronized_dispatch_accepted';
  await persist(state, true);
  log('SCHEDULER_SYNCHRONIZED_DISPATCH', {
    platformCount: ACTIVE_PLATFORMS.length,
    attemptedTogether: planned.map(p => p.key),
    accepted,
    failed,
    nextIntervalMinutes: selectedInterval,
    nextDueAt: state.nextDueAt,
    accountLoad: { activeRuns: accountActive, recentRunsLastHour: recentRuns, externalMetricsComplete: externalComplete },
    apiQuota: { remaining, limit: runsResponse.headers.get('x-ratelimit-limit'), reset: runsResponse.headers.get('x-ratelimit-reset') },
    availabilityOutcomes: outcomeResults.map((outcome, i) => ({
      platform: ACTIVE_PLATFORMS[i].key,
      status: outcome && outcome.status || 'unknown',
      checkedAt: outcome && outcome.checkedAt || null
    })),
    daily: state.daily,
    dailyStartCap: MAX_DESTINATION_STARTS_PER_UTC_DAY,
    budgetedPlatformsIncludingFutureReserve: budgetedPlatforms,
    projectedDailyStartsAtSelectedInterval: cadence.projectedStartsAtSelected
  });
  if (failed.length) process.exitCode = 1;
}

main().catch(async error => {
  console.error('SCHEDULER_ERROR', String(error && error.message || error).slice(0, 400));
  output('state_changed', 'false');
  process.exitCode = 1;
});
