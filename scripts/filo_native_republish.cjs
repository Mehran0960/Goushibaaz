'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fetchIranGoogleTrends, scoreGoogleTrendRelevance } = require('./google_trends_iran.cjs');
const { buildFiloTrendQueries, searchFiloGlobalTopic, mapWithConcurrency, queryTokens } = require('./filo_global_search.cjs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const BASE = 'https://ifilo.net';
const STATE_PATH = path.join('state', 'filo-native-republished.json');
const REPORT_PATH = path.join('out', 'filo-native-republish.json');
const CATEGORY_IDS = [6, 11, 13, 29, 2, 22, 17, 25, 15, 3];
const PAGES_PER_CATEGORY = 3;
const MAX_DETAIL_CHECKS = 30;
const MIN_DURATION_SECONDS = 10;
const MAX_DURATION_SECONDS = 180;
const MIN_PUBLISH_GAP_MS = 5 * 60 * 1000;
const MAX_DAILY_PUBLICATIONS = 288;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function isFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'True';
}

function num(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(/[۰-۹٠-٩]/g, ch => {
    const fa = '۰۱۲۳۴۵۶۷۸۹';
    const ar = '٠١٢٣٤٥٦٧٨٩';
    const i = fa.indexOf(ch);
    return String(i >= 0 ? i : ar.indexOf(ch));
  }));
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDigits(value) {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  return String(value || '').replace(/[۰-۹٠-٩]/g, ch => {
    const i = fa.indexOf(ch);
    return String(i >= 0 ? i : ar.indexOf(ch));
  });
}

function ageHours(item) {
  const raw = normalizeDigits(item && (item.create_date || item.styled_create_date || item.created_at) || '');
  const lower = raw.toLowerCase();
  let m = lower.match(/(\d+(?:\.\d+)?)\s*(?:دقیقه|min)/);
  if (m) return Math.max(0, num(m[1]) / 60);
  m = lower.match(/(\d+(?:\.\d+)?)\s*(?:ساعت|hour|hr)/);
  if (m) return Math.max(0, num(m[1]));
  m = lower.match(/(\d+(?:\.\d+)?)\s*(?:روز|day)/);
  if (m) return Math.max(0, num(m[1]) * 24);
  if (/لحظاتی پیش|همین الان|اکنون|just now|moments ago/.test(lower)) return 0.1;
  if (/دیروز|yesterday/.test(lower)) return 30;
  if (/امروز|today/.test(lower)) return 8;
  return 36;
}

function sourceText(item) {
  return [item && item.title, item && item.description, item && item.sender_name]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function categoryBase(categoryId) {
  const map = {
    6: 30,   // طنز و سرگرمی
    11: 27,  // ورزش
    13: 25,  // حیوانات
    29: 25,  // غذا
    2: 23,   // علم و فناوری
    22: 22,  // طبیعت و گردشگری
    17: 22,  // بازی
    25: 21,  // وسایل نقلیه
    15: 20,  // فرهنگ و هنر
    3: 19    // فیلم و سینما
  };
  return map[String(categoryId)] || 8;
}

const EXCLUDED = /(?:اخبار|خبر فوری|تحلیل سیاسی|سیاست|سیاسی|انتخابات|جنگ|حمله نظامی|موشک|انفجار|تروریست|ترور|اعدام|شلیک|سلاح|خشونت|مداحی|تبلیغات|کازینو|شرط.?بندی|قمار|محتوای بزرگسال|پورنو|قتل|خودکشی|خودآزاری|صحنه دلخراش|تصادف مرگبار|حیوان.?آزاری|رقص|حرکات موزون|تک.?خوانی.{0,8}زن|خوانندگی.{0,8}زن|فحاشی|الفاظ رکیک|افترا|تهمت|دوربین مداربسته)/i;
const HOOK = /(?:خنده|طنز|بامزه|سوتی|دوربین مخفی|چالش|غافلگیر|غیرمنتظره|باورنکردنی|عجیب|جالب|دیدنی|سوپرگل|گل تماشایی|مهارت|ترفند|قبل و بعد|بازسازی|واکنش|رقابت|مسابقه|رکورد|حیوان|گربه|سگ|آشپزی|غذا|فوتبال|کشتی|بسکتبال|والیبال|فناوری|گجت|funny|comedy|surprise|unexpected|challenge|trick|skill|goal|animal|cat|dog|cooking|satisfying)/i;
const PERSIAN = /[\u0600-\u06FF]/;

function feedCandidateEligible(item, ledger) {
  if (!item || typeof item !== 'object') return false;
  const code = String(item.video_code || item.videoCode || item.code || '').trim();
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) return false;
  if (!isFlag(item.can_republish) || !isFlag(item.is_publish_able)) return false;
  if (item.active !== undefined && !isFlag(item.active)) return false;
  if (item.status_id !== undefined && num(item.status_id) !== 1) return false;
  if (isFlag(item.file_deleted)) return false;
  if (num(item.only_in_filo) === 1) return false;
  const duration = num(item.duration, -1);
  if (duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) return false;
  if (item.has_audio !== undefined && !isFlag(item.has_audio)) return false;
  if (item.can_make_money !== undefined && !isFlag(item.can_make_money)) return false;
  if (ledger && ledger.posts && ledger.posts.some(post =>
    post && post.sourceCode === code &&
    ['submitted_pending_approval', 'submitted_unconfirmed', 'public_verified', 'rejected_by_filo'].includes(post.status)
  )) return false;
  const text = sourceText(item);
  if (text.length < 8 || EXCLUDED.test(text)) return false;
  return true;
}

function searchCandidateEligible(item, ledger) {
  if (!item || typeof item !== 'object') return false;
  const code = String(item.video_code || item.videoCode || item.code || '').trim();
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) return false;
  if (ledger && ledger.posts && ledger.posts.some(post =>
    post && post.sourceCode === code &&
    ['submitted_pending_approval', 'submitted_unconfirmed', 'public_verified', 'rejected_by_filo'].includes(post.status)
  )) return false;
  if (item.active !== undefined && !isFlag(item.active)) return false;
  if (isFlag(item.file_deleted) || num(item.only_in_filo) === 1) return false;
  const duration = num(item.duration, -1);
  if (duration > 0 && (duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS)) return false;
  const text = sourceText(item);
  return text.length >= 8 && !EXCLUDED.test(text);
}

function globalSearchRelevanceBonus(item) {
  const candidate = new Set(queryTokens(sourceText(item)));
  const matches = Array.isArray(item && item.globalTrendSearchMatches)
    ? item.globalTrendSearchMatches
    : item && item.globalTrendSearch ? [item.globalTrendSearch] : [];
  let best = { bonus: 0, trendTitle: null, overlap: [] };
  for (const match of matches) {
    const terms = Array.isArray(match && match.trendKeywords) ? match.trendKeywords : queryTokens(match && match.trendTitle);
    const overlap = [...new Set(terms.map(String))].filter(token => candidate.has(token));
    const bonus = overlap.length >= 2 ? Math.min(7, 2 + overlap.length * 1.5)
      : overlap.length === 1 && overlap[0].length >= 4 ? 2 : 0;
    if (bonus > best.bonus) best = {
      bonus,
      trendTitle: match.trendTitle || match.query || null,
      overlap: overlap.slice(0, 6)
    };
  }
  return { ...best, bonus: Math.round(best.bonus * 10) / 10 };
}

async function fetchFiloGlobalSearchPage(page, params) {
  const result = await page.evaluate(async ({ query, pageNo, windowWidth }) => {
    const response = await fetch('/api/v2/videos/search/' + encodeURIComponent(query), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        rowCount: null,
        page: pageNo,
        needAllData: 0,
        windowWidth
      }),
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : {}; }
    catch { body = { raw: text.slice(0, 500) }; }
    return { status: response.status, body };
  }, {
    query: params.query,
    pageNo: params.page,
    windowWidth: params.windowWidth || 1365
  });

  if (!result || result.status !== 200) {
    throw new Error('filo_global_search_http_' + (result && result.status || 'no_response'));
  }
  if (!result.body || result.body.raw) throw new Error('filo_global_search_invalid_json');
  return { status: result.status, body: result.body };
}

async function searchFiloTrendingTopics(page, trends) {
  const queries = buildFiloTrendQueries(trends, {
    maxTopics: 40,
    maxQueriesPerTopic: 2
  });
  const searches = await mapWithConcurrency(queries, 4, async topicSearch => {
    return searchFiloGlobalTopic(
      topicSearch.query,
      params => fetchFiloGlobalSearchPage(page, params),
      {
        maxPages: 60,
        pageSize: 20,
        windowWidth: 1365,
        topicSearch
      }
    );
  });

  const byCode = new Map();
  for (const search of searches) {
    for (const item of search.results || []) {
      const code = String(item.video_code || '');
      if (!code) continue;
      const previous = byCode.get(code);
      const previousMatches = previous && Array.isArray(previous.globalTrendSearchMatches)
        ? previous.globalTrendSearchMatches : [];
      const currentMatch = item.globalTrendSearch || null;
      const matches = [...previousMatches];
      if (currentMatch && !matches.some(match =>
        match.trendTitle === currentMatch.trendTitle && match.query === currentMatch.query
      )) matches.push(currentMatch);

      const merged = previous ? { ...item, ...previous } : { ...item };
      merged.globalTrendSearchMatches = matches;
      byCode.set(code, merged);
    }
  }

  return {
    queriesRequested: queries.length,
    queriesCompleted: searches.filter(item => item.complete).length,
    complete: searches.every(item => item.complete),
    pagesFetched: searches.reduce((sum, item) => sum + item.pagesFetched, 0),
    uniqueVideos: byCode.size,
    results: [...byCode.values()],
    queries: searches.map(item => ({
      query: item.query,
      pagesFetched: item.pagesFetched,
      resultCount: item.totalUniqueVideos,
      complete: item.complete,
      termination: item.termination
    }))
  };
}

function scoreFeedCandidate(item, trendWeights = {}, googleTrends = []) {
  const text = sourceText(item);
  const categoryId = num(item.category_id);
  const duration = num(item.duration, 0);
  const age = ageHours(item);
  const visits = num(item.visit_count ?? item.views ?? item.view_count);
  const plays = num(item.play_count);
  const shares = num(item.share_count);
  const favorites = num(item.favorite_count);
  const engagement = visits + 2 * plays + 3 * shares + 2 * favorites;

  let score = categoryBase(categoryId);
  score += Math.min(24, Math.log1p(engagement) * 4.2);
  score += age <= 2 ? 14 : age <= 6 ? 11 : age <= 12 ? 8 : age <= 24 ? 5 : age <= 48 ? 1 : -8;
  score += HOOK.test(text) ? 10 : -8;
  score += PERSIAN.test(text) ? 7 : 0;
  score += duration <= 30 ? 7 : duration <= 60 ? 5 : duration <= 120 ? 2 : -4;
  const topic = String(item.category_id || '');
  score += Math.min(5, num(trendWeights[topic]));
  const googleTrend = scoreGoogleTrendRelevance(text, googleTrends);
  score += googleTrend.score;
  if (text.length < 16) score -= 5;

  return {
    score: Math.round(score * 10) / 10,
    ageHours: Math.round(age * 10) / 10,
    engagement,
    categoryId,
    durationSeconds: duration,
    visits,
    plays,
    googleTrend
  };
}

function detailGate(root, video) {
  if (!root || !video) return { eligible: false, reason: 'republish_detail_missing' };
  if (!isFlag(root.is_republish)) return { eligible: false, reason: 'filo_republish_route_not_allowed' };
  if (isFlag(root.stop_upload)) return { eligible: false, reason: 'filo_upload_temporarily_stopped' };
  if (root.limited_minutes === true || root.limited_minutes === 1 || root.limited_minutes === '1') {
    return { eligible: false, reason: 'filo_daily_upload_limit_reached' };
  }
  if (!isFlag(video.can_republish)) return { eligible: false, reason: 'creator_republish_permission_missing' };
  if (video.active !== undefined && !isFlag(video.active)) return { eligible: false, reason: 'source_not_active' };
  if (num(video.status_id) !== 1) return { eligible: false, reason: 'source_status_not_publishable' };
  if (isFlag(video.file_deleted)) return { eligible: false, reason: 'source_file_deleted' };
  if (num(video.only_in_filo) === 1) return { eligible: false, reason: 'source_only_in_filo' };
  if (!isFlag(video.has_audio)) return { eligible: false, reason: 'source_audio_missing' };
  if (!isFlag(video.can_make_money)) return { eligible: false, reason: 'source_monetization_not_enabled' };
  const duration = num(video.duration, 0);
  if (duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
    return { eligible: false, reason: 'duration_out_of_short_form_range' };
  }
  return { eligible: true, reason: 'filo_native_republish_permitted' };
}


function normalizeComparable(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('fa-IR')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\s\u200c\u200e\u200f\u0640،؛:,.!?؟"'«»()\[\]{}\-–—_]/g, '');
}

function trimAtWord(text, maxLength) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  const clipped = value.slice(0, maxLength);
  const boundary = clipped.lastIndexOf(' ');
  return (boundary > maxLength * 0.65 ? clipped.slice(0, boundary) : clipped).trim();
}

function createRepostMetadata(video, sourceCode) {
  const sourceTitle = String(video && video.title || '').replace(/#[^\s#]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sourceDescription = String(video && video.description || '').replace(/\s+/g, ' ').trim();
  if (sourceTitle.length < 5) throw new Error('source_title_too_short_for_compliant_rewrite');

  let core = sourceTitle
    .replace(/^(?:(?:طنز|کلیپ|ویدیو|ویدئوی|فیلم)\s+)*(?:(?:خنده.?دار|بامزه|جالب|دیدنی|جذاب|کوتاه)\s+)*(?:از\s+)?/i, '')
    .replace(/^[-:،؛|\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (core.length < 5) core = sourceTitle;
  core = trimAtWord(core, 132);

  let title = trimAtWord(core, 176);
  if (normalizeComparable(title) === normalizeComparable(sourceTitle)) {
    title = trimAtWord('روایت تصویری: ' + core, 176);
  }

  const description = trimAtWord(
    'در این ویدئوی کوتاه، ' + core +
    ' را در قالب یک روایت تصویری می‌بینید. این نسخه از مسیر بازنشر رسمی فیلو و با اجازه‌ای که منتشرکننده‌ی اصلی برای بازنشر فعال کرده، منتشر می‌شود.',
    1100
  );

  if (normalizeComparable(title) === normalizeComparable(sourceTitle)) throw new Error('repost_title_not_distinct_from_original');
  if (normalizeComparable(description) === normalizeComparable(sourceDescription)) throw new Error('repost_description_not_distinct_from_original');
  if (/(?:https?:\/\/|www\.)/i.test(description)) throw new Error('repost_description_contains_unapproved_external_link');

  return { title, description, sourceTitle, sourceDescription, sourceCode };
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (data && Array.isArray(data.posts)) return data;
  } catch {}
  return { schemaVersion: 1, posts: [] };
}

function dailyCount(state, now = Date.now()) {
  const utcDay = new Date(now).toISOString().slice(0, 10);
  return state.posts.filter(post =>
    post && post.submittedAt && post.submittedAt.slice(0, 10) === utcDay &&
    ['submitted_pending_approval', 'submitted_unconfirmed', 'public_verified'].includes(post.status)
  ).length;
}

function lastSubmissionTime(state) {
  const times = state.posts
    .filter(post => post && post.submittedAt &&
      ['submitted_pending_approval', 'submitted_unconfirmed', 'public_verified'].includes(post.status))
    .map(post => Date.parse(post.submittedAt))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

function millisecondsUntilNextPublication(state, now = Date.now()) {
  const last = lastSubmissionTime(state);
  return last ? Math.max(0, last + MIN_PUBLISH_GAP_MS - now) : 0;
}

function parseApiBody(raw) {
  const outer = parseJson(raw);
  if (!outer) return null;
  if (outer.data && typeof outer.data === 'object') return outer.data;
  if (outer.r && typeof outer.r === 'object') return outer.r;
  return outer;
}

async function visibleFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function login(page) {
  if (!process.env.FILO_USER || !process.env.FILO_PASS) throw new Error('filo_credentials_missing');

  await page.goto(BASE + '/login?m=3&r=%2Fupload', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  const password = page.locator('input[type="password"]').first();
  await password.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(1200);

  const username = await visibleFirst(page, [
    'input[autocomplete="username"]',
    'input[type="tel"]',
    'input[name*="phone" i]',
    'input[name*="mobile" i]',
    'input[placeholder*="شماره"]',
    'input[placeholder*="موبایل"]',
    'input[placeholder*="ایمیل"]',
    'input[type="email"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[type="text"]'
  ]);
  if (!username) throw new Error('filo_username_field_not_found');

  await username.fill(process.env.FILO_USER);
  await password.fill(process.env.FILO_PASS);
  await password.press('Tab').catch(() => {});

  const submit = await visibleFirst(page, ['button[type="submit"]', 'input[type="submit"]']);
  if (!submit || !(await submit.isEnabled().catch(() => false))) {
    throw new Error('filo_login_submit_not_ready');
  }

  const loginResponsePromise = page.waitForResponse(response => {
    try {
      const url = new URL(response.url());
      return url.hostname === 'ifilo.net' &&
        url.pathname === '/api/v1/users/login' &&
        response.request().method() === 'POST';
    } catch { return false; }
  }, { timeout: 15000 }).catch(() => null);

  await submit.click();
  const loginResponse = await loginResponsePromise;
  let responsePayload = null;
  if (loginResponse) {
    const responseText = await loginResponse.text().catch(() => '');
    responsePayload = parseJson(responseText);
  }

  const responseStatus = loginResponse ? loginResponse.status() : null;
  const responseKeys = responsePayload && typeof responsePayload === 'object'
    ? Object.keys(responsePayload).slice(0, 12)
    : [];
  const explicitApiRejection = Boolean(responsePayload && typeof responsePayload === 'object' && (
    responsePayload.success === false ||
    responsePayload.status === false ||
    responsePayload.error ||
    responsePayload.errors
  ));
  if (loginResponse && (responseStatus < 200 || responseStatus >= 400 || explicitApiRejection)) {
    throw new Error('filo_login_api_rejected:' + JSON.stringify({
      httpStatus: responseStatus,
      responseKeys,
      explicitApiRejection
    }));
  }

  await sleep(1800);
  await page.goto(BASE + '/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1200);

  const pageEvidence = await page.evaluate(() => {
    const bodyText = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1600);
    const path = location.pathname;
    const hasLogoutLink = Array.from(document.querySelectorAll('a')).some(a =>
      /خروج|logout|sign.?out/i.test((a.innerText || '') + ' ' + (a.getAttribute('href') || ''))
    );
    const hasPasswordField = Array.from(document.querySelectorAll('input[type="password"]'))
      .some(input => input.offsetParent !== null);
    const hasFileInput = Boolean(document.querySelector('input[type="file"]'));
    const hasUploadForm = Boolean(document.querySelector('form[action*="upload" i], [data-upload-form], .upload-form'));
    const loginPrompt = /ورود به حساب|وارد حساب شوید|لطفا وارد شوید|رمز عبور|sign in to|please log in|login required/i.test(bodyText);
    return {
      path,
      title: document.title || '',
      hasLogoutLink,
      hasPasswordField,
      hasFileInput,
      hasUploadForm,
      loginPrompt
    };
  }).catch(() => ({
    path: new URL(page.url()).pathname,
    title: '',
    hasLogoutLink: false,
    hasPasswordField: false,
    hasFileInput: false,
    hasUploadForm: false,
    loginPrompt: true
  }));

  const cookieNames = (await page.context().cookies(BASE))
    .map(cookie => cookie.name)
    .filter(name => !/(csrf|xsrf)/i.test(name));
  const hasSessionCookie = cookieNames.some(name => /(session|auth|token|user|sid|jwt)/i.test(name));
  const isUploadRoute = /^\/upload(?:\/|$)/i.test(pageEvidence.path);
  const routeHasNoLoginScreen = isUploadRoute &&
    !pageEvidence.hasPasswordField &&
    !pageEvidence.loginPrompt &&
    !/\/login(?:\/|$)/i.test(pageEvidence.path);
  const verifiedBy = pageEvidence.hasLogoutLink
    ? 'logout_link'
    : routeHasNoLoginScreen && (hasSessionCookie || pageEvidence.hasFileInput || pageEvidence.hasUploadForm)
      ? 'authenticated_upload_route'
      : null;

  if (!verifiedBy) {
    throw new Error('filo_login_not_confirmed:' + JSON.stringify({
      httpStatus: responseStatus,
      responseKeys,
      hasSessionCookie,
      cookieNames: cookieNames.slice(0, 12),
      pageEvidence
    }));
  }

  return {
    authenticated: true,
    route: pageEvidence.path,
    verifiedBy,
    httpStatus: responseStatus,
    responseKeys,
    hasSessionCookie
  };
}

async function fetchCategoryPage(page, categoryId, pageNo) {
  const result = await page.evaluate(async ({ categoryId, pageNo }) => {
    const params = new URLSearchParams();
    params.set('rowCount', '0');
    params.set('page', String(pageNo));
    params.set('needAllData', '0');
    params.set('windowWidth', String(window.innerWidth || 1365));
    const response = await fetch('/api/v1/video/category/' + categoryId, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: params.toString()
    });
    return { status: response.status, body: await response.text() };
  }, { categoryId, pageNo });

  if (!result || result.status !== 200) throw new Error('filo_category_http_' + (result && result.status));
  const data = parseApiBody(result.body);
  if (!data) throw new Error('filo_category_invalid_json');
  const items = Array.isArray(data.items) ? data.items :
    Array.isArray(data.l) ? data.l :
    Array.isArray(data.v) ? data.v : [];
  return items;
}

async function getRepublishDetail(page, code) {
  const result = await page.evaluate(async code => {
    const response = await fetch('/api/v1/republish/' + encodeURIComponent(code), {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    return { status: response.status, body: await response.text() };
  }, code);

  if (!result || result.status !== 200) return null;
  const root = parseApiBody(result.body);
  if (!root || typeof root !== 'object') return null;
  return { root, video: root.republish_video || root.video || null };
}

async function seekVideoTo(page, targetSeconds) {
  return page.evaluate(async target => {
    const video = document.querySelector('#plr video');
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
      return { ok: false, reason: 'video_metadata_unavailable' };
    }
    video.pause();
    const safeTarget = Math.max(0.15, Math.min(video.duration - 0.15, target));
    if (Math.abs(video.currentTime - safeTarget) > 0.08) {
      await new Promise(resolve => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          video.removeEventListener('seeked', finish);
          resolve();
        };
        video.addEventListener('seeked', finish, { once: true });
        try {
          video.currentTime = safeTarget;
          setTimeout(finish, 4500);
        } catch {
          finish();
        }
      });
    }
    await new Promise(resolve => setTimeout(resolve, 140));
    return {
      ok: video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0,
      timeSeconds: Number(video.currentTime) || safeTarget,
      durationSeconds: Number(video.duration) || 0
    };
  }, targetSeconds);
}

async function selectThumbnailFrame(page, sourceCode, report) {
  const fallback = async reason => {
    const info = await page.locator('#plr video').first().evaluate(video => ({
      duration: Number(video.duration) || 0
    })).catch(() => ({ duration: 0 }));
    const target = info.duration > 2 ? Math.min(4, Math.max(1, info.duration * 0.12)) : 0.5;
    await seekVideoTo(page, target).catch(() => null);
    return {
      strategy: 'legacy_early_frame_fallback',
      fallback: true,
      reason: String(reason || 'thumbnail_analysis_unavailable').slice(0, 240),
      selectedTimeSeconds: target,
      framesAnalyzed: 0
    };
  };

  const videoInfo = await page.locator('#plr video').first().evaluate(video => ({
    duration: Number(video.duration) || 0,
    width: Number(video.videoWidth) || 0,
    height: Number(video.videoHeight) || 0
  })).catch(() => null);

  if (!videoInfo || videoInfo.duration < 2 || !videoInfo.width || !videoInfo.height) {
    const result = await fallback('video_metadata_unavailable');
    report.thumbnailSelection = result;
    return result;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-thumbnail-'));
  const frameCount = 18;
  const startRatio = 0.06;
  const endRatio = 0.94;
  const frames = [];
  let selected = null;

  try {
    const videoLocator = page.locator('#plr video').first();
    for (let index = 0; index < frameCount; index += 1) {
      const ratio = frameCount === 1 ? 0.5 : startRatio + (endRatio - startRatio) * index / (frameCount - 1);
      const target = Math.max(0.15, Math.min(videoInfo.duration - 0.15, videoInfo.duration * ratio));
      const seek = await seekVideoTo(page, target).catch(() => ({ ok: false }));
      if (!seek || !seek.ok) continue;
      const filePath = path.join(tempDir, 'frame-' + String(index).padStart(2, '0') + '.jpg');
      try {
        const image = await videoLocator.screenshot({ type: 'jpeg', quality: 88, timeout: 10000 });
        if (!image || image.length < 1500) continue;
        fs.writeFileSync(filePath, image);
        frames.push({ index, timeSeconds: Number(seek.timeSeconds || target), path: filePath });
      } catch {}
    }

    if (frames.length < 3) {
      const result = await fallback('insufficient_decoded_frames');
      report.thumbnailSelection = { ...result, framesAnalyzed: frames.length };
      return report.thumbnailSelection;
    }

    const scored = spawnSync('python3', ['scripts/score_filo_thumbnail.py'], {
      input: JSON.stringify({ frames }),
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 3 * 1024 * 1024
    });

    if (scored.error || scored.status !== 0) {
      const reason = scored.error ? scored.error.message : String(scored.stderr || 'thumbnail_scorer_failed').slice(0, 220);
      const result = await fallback(reason);
      report.thumbnailSelection = { ...result, framesAnalyzed: frames.length };
      return report.thumbnailSelection;
    }

    const analysis = parseJson(scored.stdout);
    if (!analysis || !Number.isInteger(analysis.selectedIndex)) {
      const result = await fallback('thumbnail_scorer_returned_invalid_result');
      report.thumbnailSelection = { ...result, framesAnalyzed: frames.length };
      return report.thumbnailSelection;
    }

    selected = frames.find(frame => frame.index === analysis.selectedIndex);
    if (!selected) {
      const result = await fallback('selected_thumbnail_frame_not_found');
      report.thumbnailSelection = { ...result, framesAnalyzed: frames.length };
      return report.thumbnailSelection;
    }

    await seekVideoTo(page, selected.timeSeconds);
    const summary = {
      strategy: 'multi_frame_face_expression_visual_quality_v1',
      fallback: false,
      framesAnalyzed: frames.length,
      selectedTimeSeconds: Math.round(selected.timeSeconds * 100) / 100,
      score: analysis.selected && analysis.selected.score,
      faceDetected: Boolean(analysis.selected && analysis.selected.faceDetected),
      faceCount: analysis.selected && analysis.selected.faceCount || 0,
      expressionScore: analysis.selected && analysis.selected.expressionScore,
      sharpnessScore: analysis.selected && analysis.selected.sharpnessScore,
      selectionReason: analysis.selectionReason || 'highest_composite_visual_score',
      topCandidates: (analysis.ranked || []).slice(0, 3).map(item => ({
        timeSeconds: Math.round(Number(item.timeSeconds) * 100) / 100,
        score: item.score,
        faceDetected: Boolean(item.faceDetected),
        faceCount: item.faceCount || 0,
        expressionScore: item.expressionScore
      }))
    };
    report.thumbnailSelection = summary;
    return summary;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function prepareAndPublish(page, candidate, detail, report) {
  const code = String(candidate.video_code || candidate.code);
  const sourceVideo = detail.video;
  const sourceTitle = String(sourceVideo.title || candidate.title || '').trim().slice(0, 180);
  if (!sourceTitle) throw new Error('source_title_missing');
  const repostMetadata = createRepostMetadata({ ...sourceVideo, category_id: sourceVideo.category_id || candidate.category_id }, code);

  await page.goto(BASE + '/republish/' + encodeURIComponent(code), {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1400);

  const titleField = page.locator('input[name="title"]').first();
  const descriptionField = page.locator('textarea').first();
  await titleField.waitFor({ state: 'visible', timeout: 12000 });
  await descriptionField.waitFor({ state: 'visible', timeout: 12000 });

  await titleField.fill(repostMetadata.title);
  await descriptionField.fill(repostMetadata.description);

  const videoReady = await page.waitForFunction(() => {
    const video = document.querySelector('#plr video');
    return Boolean(video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
  }, null, { timeout: 25000 }).then(() => true).catch(() => false);
  if (!videoReady) throw new Error('filo_source_player_not_ready_for_cover');

  const thumbnailSelection = await selectThumbnailFrame(page, code, report);

  const cropButton = page.locator('button.shot-btn').first();
  await cropButton.waitFor({ state: 'visible', timeout: 10000 });
  await cropButton.click();
  await page.waitForTimeout(500);

  let publishPayload = null;
  let thumbnailGuardBlocked = false;
  await page.route('**/api/v1/video/publish', async route => {
    const request = route.request();
    const params = new URLSearchParams(request.postData() || '');
    const selectedFrame = params.get('selectedFrame') || '';
    const republishFrom = params.get('republishFrom') || '';
    const videoCode = params.get('videoCode') || '';
    const isMadeByMe = params.get('isMadeByMe');
    const canRepublish = params.get('canRepublish');
    const canMakeMoney = params.get('canMakeMoney');
    const dontPublish = params.get('dontPublish');
    const outgoingTitle = params.get('title') || '';
    const outgoingDescription = params.get('description') || '';
    const titleDistinct = normalizeComparable(outgoingTitle) !== normalizeComparable(repostMetadata.sourceTitle);
    const descriptionDistinct = normalizeComparable(outgoingDescription) !== normalizeComparable(repostMetadata.sourceDescription);
    const metadataOk = outgoingTitle.length >= 8 && outgoingDescription.length >= 50 &&
      titleDistinct && descriptionDistinct && !/(?:https?:\/\/|www\.)/i.test(outgoingDescription);
    const frameOk = selectedFrame.startsWith('data:image/') && selectedFrame.length > 1000;
    const requestOk = republishFrom === code && /^[A-Za-z0-9_-]{5,40}$/.test(videoCode) &&
      isMadeByMe === 'false' && canRepublish === 'true' &&
      canMakeMoney === 'true' && dontPublish === '0' && frameOk && metadataOk;

    publishPayload = {
      sourceCode: republishFrom,
      newVideoCode: videoCode,
      title: outgoingTitle.slice(0, 180),
      descriptionDistinct,
      titleDistinct,
      category: params.get('category') || '',
      selectedFrameLength: selectedFrame.length,
      selectedFrameType: selectedFrame.slice(0, 40),
      thumbnailStrategy: report.thumbnailSelection && report.thumbnailSelection.strategy || 'legacy_fallback',
      thumbnailTimeSeconds: report.thumbnailSelection && report.thumbnailSelection.selectedTimeSeconds || null,
      thumbnailScore: report.thumbnailSelection && report.thumbnailSelection.score || null,
      thumbnailFaceDetected: Boolean(report.thumbnailSelection && report.thumbnailSelection.faceDetected),
      isMadeByMe,
      canRepublish,
      canMakeMoney,
      dontPublish,
      guardPassed: requestOk
    };

    if (!requestOk) {
      thumbnailGuardBlocked = true;
      await route.abort('blockedbyclient').catch(() => {});
      return;
    }
    await route.continue();
  });

  const publishButton = page.getByRole('button', { name: /انتشار ویدیو|انتشار ویدئو/ }).first();
  if (!(await publishButton.isVisible().catch(() => false)) ||
      !(await publishButton.isEnabled().catch(() => false))) {
    throw new Error('filo_publish_button_not_ready');
  }

  const responsePromise = page.waitForResponse(response => {
    try {
      const url = new URL(response.url());
      return url.hostname === 'ifilo.net' &&
        url.pathname === '/api/v1/video/publish' &&
        response.request().method() === 'POST';
    } catch { return false; }
  }, { timeout: 45000 }).catch(() => null);

  await publishButton.click();
  const publishResponse = await responsePromise;
  await page.waitForTimeout(1200);

  if (thumbnailGuardBlocked || !publishPayload || !publishPayload.guardPassed) {
    return {
      status: 'blocked_before_filo_submission',
      reason: 'native_republish_payload_failed_safety_guard',
      publishPayload
    };
  }
  if (!publishResponse) {
    return {
      status: 'submitted_unconfirmed',
      reason: 'publish_response_not_observed',
      publishPayload
    };
  }

  const responseBody = parseJson(await publishResponse.text().catch(() => ''));
  if (!responseBody || !isFlag(responseBody.s)) {
    return {
      status: 'rejected_by_filo',
      reason: String(responseBody && (responseBody.r || responseBody.message) || 'filo_publish_not_accepted').slice(0, 500),
      httpStatus: publishResponse.status(),
      publishPayload
    };
  }

  const result = {
    // The publish API accepted the request, but moderation/public visibility is not inferred.
    status: 'submitted_unconfirmed',
    sourceCode: code,
    newVideoCode: publishPayload.newVideoCode,
    httpStatus: publishResponse.status(),
    publishPayload,
    repostMetadata: { title: repostMetadata.title, descriptionLength: repostMetadata.description.length },
    thumbnailSelection: report.thumbnailSelection || null,
    responseSummary: {
      success: true,
      keys: Object.keys(responseBody).slice(0, 20),
      dataKeys: responseBody.d && typeof responseBody.d === 'object' ? Object.keys(responseBody.d).slice(0, 20) : []
    }
  };

  if (publishPayload.newVideoCode) {
    const publicUrl = await verifyPublicVideo(
      page,
      publishPayload.newVideoCode,
      repostMetadata.title
    ).catch(() => null);
    if (publicUrl) {
      result.status = 'public_verified';
      result.publicUrl = publicUrl;
    }
  }

  return result;
}

async function verifyPublicVideo(page, code, expectedTitle) {
  if (!code || !expectedTitle) return null;
  const expected = normalizeComparable(expectedTitle);
  if (!expected) return null;

  const response = await page.goto(BASE + '/v/' + encodeURIComponent(code), {
    waitUntil: 'domcontentloaded',
    timeout: 18000
  });
  await page.waitForTimeout(900);
  const visible = await page.locator('body').innerText().catch(() => '');
  const title = await page.title().catch(() => '');
  const observed = normalizeComparable(title + ' ' + visible);
  if (response && response.status() === 200 && observed.includes(expected)) {
    return BASE + '/v/' + encodeURIComponent(code);
  }
  return null;
}

async function reconcilePreviouslySubmitted(page, state) {
  const candidates = (state.posts || []).filter(post =>
    post &&
    ['submitted_pending_approval', 'submitted_unconfirmed'].includes(post.status) &&
    post.newVideoCode &&
    post.repostTitle
  );
  let verified = 0;
  for (const post of candidates) {
    const publicUrl = await verifyPublicVideo(page, post.newVideoCode, post.repostTitle).catch(() => null);
    if (!publicUrl) continue;
    post.status = 'public_verified';
    post.publicUrl = publicUrl;
    post.verifiedAt = new Date().toISOString();
    verified += 1;
  }
  if (verified) state.updatedAt = new Date().toISOString();
  return { checked: candidates.length, newlyPublic: verified, changed: verified > 0 };
}


function cleanLegacyRepostTitle(value) {
  return String(value || '')
    .replace(/^ماجرای\s+بامزه(?:‌ی|ی)?\s*[«"“”]?\s*/u, '')
    .replace(/[»"“”]\s*$/u, '')
    .trim();
}

async function fetchOwnVideoForCaptionEdit(page, videoCode) {
  const result = await page.evaluate(async ({ videoCode }) => {
    const params = new URLSearchParams();
    params.set('page', '1');
    params.set('rowCount', '24');
    params.set('vc', videoCode);
    const response = await fetch('/api/v1/my/videos', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8;' },
      body: params.toString()
    });
    return { status: response.status, body: await response.text() };
  }, { videoCode });

  if (!result || result.status !== 200) return null;
  const body = parseJson(result.body);
  const root = body && body.data && typeof body.data === 'object' ? body.data : body;
  const items = root && Array.isArray(root.items) ? root.items : [];
  return items.find(item => String(item.video_code || item.code || item.v || '') === videoCode) || null;
}

async function editOwnVideoTitle(page, item, videoCode, newTitle) {
  const form = await page.evaluate(async ({ videoCode, id }) => {
    const params = new URLSearchParams();
    params.set('c', videoCode);
    params.set('id', String(id));
    const response = await fetch('/api/v1/video/edit', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8;' },
      body: params.toString()
    });
    return { status: response.status, body: await response.text() };
  }, { videoCode, id: item.id });

  if (!form || form.status !== 200) return { ok: false, reason: 'edit_form_http_' + (form && form.status || 'no_response') };
  const loaded = parseJson(form.body);
  if (!loaded || !loaded.video) return { ok: false, reason: 'edit_form_invalid' };
  if (loaded.isLockEdit === true || loaded.isLockEdit === 1 || loaded.isLockEdit === '1') {
    return { ok: false, reason: 'filo_locked_video_edit' };
  }
  if (String(loaded.video.id) !== String(item.id)) {
    return { ok: false, reason: 'edit_form_owner_id_mismatch' };
  }
  if (num(loaded.video.status_id) === 11) {
    return { ok: false, reason: 'moderation_confirmation_required' };
  }

  const video = loaded.video;
  const model = {
    id: video.id,
    title: newTitle,
    description: String(video.description || ''),
    playlist_id: video.playlist_id ?? 0,
    category_id: video.category_id ?? 0,
    status_id: video.status_id ?? '',
    has_comment: !!video.has_comment,
    allow_download: !!video.allow_download,
    only_in_filo: Number(video.only_in_filo) || 0,
    made_for_kids: !!video.made_for_kids,
    over18: !!video.over18,
    can_republish: !!video.can_republish,
    made_by_me: !!video.made_by_me,
    is_republish: !!loaded.isRepublish,
    video_url: video.video_url || '',
    cards: Array.isArray(video.cards) ? video.cards : [],
    subtitle_file_name: video.subtitle_file_name || video.subtitleFileName || '',
    jost_save_cards: false
  };

  const saved = await page.evaluate(async model => {
    const response = await fetch('/api/v1/video/edit', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(model)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : {}; } catch {}
    return { status: response.status, body };
  }, model);

  if (!saved || saved.status !== 200 || !saved.body || !isFlag(saved.body.s)) {
    return {
      ok: false,
      reason: String(saved && saved.body && saved.body.r || 'filo_edit_not_accepted').slice(0, 180),
      httpStatus: saved && saved.status || null
    };
  }
  return { ok: true, httpStatus: saved.status };
}

async function cleanupLegacyRepostCaptions(page, state) {
  const targets = (state.posts || []).filter(post =>
    post &&
    post.status === 'public_verified' &&
    post.newVideoCode &&
    (post.captionCleanupPending ||
      /^ماجرای\s+بامزه/i.test(String(post.repostTitle || '')))
  );
  const report = { checked: targets.length, updated: [], pending: [], skipped: [], errors: [] };

  for (const post of targets) {
    const code = String(post.newVideoCode);
    const newTitle = cleanLegacyRepostTitle(post.repostTitle);
    if (!newTitle || normalizeComparable(newTitle) === normalizeComparable(post.repostTitle)) {
      if (post.captionCleanupPending) {
        const verified = await verifyPublicVideo(page, code, post.repostTitle).catch(() => null);
        if (verified) {
          post.captionCleanupPending = false;
          post.captionCleanupAt = new Date().toISOString();
          report.updated.push({ code, title: post.repostTitle, verified: true, previouslyAccepted: true });
        } else {
          report.pending.push({ code, title: post.repostTitle, reason: 'public_title_not_yet_verified' });
        }
      } else {
        report.skipped.push({ code, reason: 'no_legacy_lead_found' });
      }
      continue;
    }

    try {
      const ownVideo = await fetchOwnVideoForCaptionEdit(page, code);
      if (!ownVideo) {
        report.skipped.push({ code, reason: 'not_found_in_own_video_list' });
        continue;
      }
      if (String(ownVideo.video_code || ownVideo.code || ownVideo.v || '') !== code) {
        report.skipped.push({ code, reason: 'own_video_code_mismatch' });
        continue;
      }
      if (!(ownVideo.canEdit === 1 || ownVideo.canEdit === true || ownVideo.canEdit === '1')) {
        report.skipped.push({ code, reason: 'filo_can_edit_not_granted' });
        continue;
      }

      const edit = await editOwnVideoTitle(page, ownVideo, code, newTitle);
      if (!edit.ok) {
        report.skipped.push({ code, reason: edit.reason });
        continue;
      }

      post.repostTitle = newTitle;
      post.captionCleanupPending = true;
      post.captionCleanupRequestedAt = new Date().toISOString();
      const publicUrl = await verifyPublicVideo(page, code, newTitle).catch(() => null);
      if (publicUrl) {
        post.captionCleanupPending = false;
        post.captionCleanupAt = new Date().toISOString();
        report.updated.push({ code, title: newTitle, publicUrl, verified: true });
      } else {
        report.pending.push({ code, title: newTitle, reason: 'edit_accepted_public_verification_pending' });
      }
      state.updatedAt = new Date().toISOString();
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (error) {
      report.errors.push({ code, error: String(error && error.message || error).slice(0, 200) });
    }
  }

  return report;
}

async function main() {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const state = loadState();
  const report = {
    createdAt: new Date().toISOString(),
    status: 'started',
    discovery: { categories: CATEGORY_IDS, pagesPerCategory: PAGES_PER_CATEGORY, scannedItems: 0, eligibleFeedItems: 0, eligibleGlobalSearchItems: 0, combinedCandidates: 0, globalTrendSearch: null, errors: [] },
    selected: null,
    result: null,
    googleTrends: { status: 'not_fetched', itemCount: 0, topTopics: [] }
  };
  let browser;

  try {
    if (dailyCount(state) >= MAX_DAILY_PUBLICATIONS) {
      report.status = 'daily_publication_cap_reached';
      report.dailyCount = dailyCount(state);
      return;
    }
    const waitMs = millisecondsUntilNextPublication(state);
    if (waitMs > 0) {
      report.status = 'waiting_for_minimum_publication_gap';
      report.nextEligibleAt = new Date(Date.now() + waitMs).toISOString();
      report.waitMilliseconds = waitMs;
      console.log('FILO_NATIVE_REPUBLISH_WAITING_FOR_GAP ' + JSON.stringify({
        waitMilliseconds: waitMs,
        nextEligibleAt: report.nextEligibleAt
      }));
      await sleep(waitMs + 1000);
      report.waitCompletedAt = new Date().toISOString();
      if (millisecondsUntilNextPublication(state) > 0) {
        report.status = 'minimum_publication_gap_not_elapsed';
        return;
      }
    }

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'fa-IR',
      viewport: { width: 1365, height: 1000 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129 Safari/537.36'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);

    report.login = await login(page);
    const googleTrendsFeed = await fetchIranGoogleTrends({ timeoutMs: 8000, maxItems: 40 });
    const googleTrends = googleTrendsFeed.items || [];
    report.googleTrends = {
      status: googleTrendsFeed.ok ? 'active' : 'unavailable_non_blocking',
      source: googleTrendsFeed.source,
      fetchedAt: googleTrendsFeed.fetchedAt,
      itemCount: googleTrends.length,
      error: googleTrendsFeed.error || null,
      topTopics: googleTrends.slice(0, 12).map(item => ({
        title: item.title,
        traffic: item.traffic,
        publishedAt: item.publishedAt
      }))
    };
    report.reconciliation = await reconcilePreviouslySubmitted(page, state);
    if (report.reconciliation.changed) {
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
    }
    report.captionCleanup = await cleanupLegacyRepostCaptions(page, state);
    const trendWeights = {};
    try {
      const trend = JSON.parse(fs.readFileSync(path.join('state', 'platform-trends.json'), 'utf8'));
      for (const key of Object.keys(trend || {})) {
        const source = trend[key];
        if (!source || typeof source !== 'object') continue;
        for (const item of Object.values(source)) {
          const categoryId = String(item && item.category_id || '');
          if (categoryId) trendWeights[categoryId] = Math.min(5, (trendWeights[categoryId] || 0) + 0.25);
        }
      }
    } catch {}

    report.discovery.globalTrendSearch = {
      status: googleTrends.length ? 'searching' : 'skipped_no_google_trends',
      topicsAvailable: googleTrends.length,
      queriesRequested: 0,
      queriesCompleted: 0,
      pagesFetched: 0,
      uniqueVideos: 0,
      complete: googleTrends.length === 0,
      queries: []
    };
    let globalSearchCandidates = [];
    if (googleTrends.length) {
      try {
        const globalSearch = await searchFiloTrendingTopics(page, googleTrends);
        globalSearchCandidates = globalSearch.results;
        report.discovery.globalTrendSearch = {
          status: globalSearch.complete ? 'complete' : 'partial',
          topicsAvailable: googleTrends.length,
          queriesRequested: globalSearch.queriesRequested,
          queriesCompleted: globalSearch.queriesCompleted,
          pagesFetched: globalSearch.pagesFetched,
          uniqueVideos: globalSearch.uniqueVideos,
          complete: globalSearch.complete,
          queries: globalSearch.queries
        };
      } catch (error) {
        report.discovery.globalTrendSearch = {
          status: 'failed_non_blocking',
          topicsAvailable: googleTrends.length,
          complete: false,
          error: String(error && error.message || error).slice(0, 240)
        };
      }
    }

    const byCode = new Map();
    for (const categoryId of CATEGORY_IDS) {
      for (let pageNo = 1; pageNo <= PAGES_PER_CATEGORY; pageNo++) {
        try {
          const items = await fetchCategoryPage(page, categoryId, pageNo);
          report.discovery.scannedItems += items.length;
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (!item.category_id) item.category_id = categoryId;
            const code = String(item.video_code || item.videoCode || item.code || '');
            if (!code) continue;
            const existing = byCode.get(code);
            const candidate = { ...item, video_code: code };
            if (!existing || num(candidate.visit_count) + num(candidate.play_count) >
                num(existing.visit_count) + num(existing.play_count)) byCode.set(code, candidate);
          }
        } catch (error) {
          report.discovery.errors.push({
            categoryId,
            pageNo,
            error: String(error && error.message || error).slice(0, 240)
          });
        }
      }
    }

    const feedCandidates = [...byCode.values()].filter(item => feedCandidateEligible(item, state));
    report.discovery.eligibleFeedItems = feedCandidates.length;

    const globalCandidatesByCode = new Map();
    for (const item of globalSearchCandidates) {
      if (!searchCandidateEligible(item, state)) continue;
      const code = String(item.video_code || '');
      if (!code) continue;
      globalCandidatesByCode.set(code, item);
    }
    report.discovery.eligibleGlobalSearchItems = globalCandidatesByCode.size;

    const combinedByCode = new Map(feedCandidates.map(item => [String(item.video_code), item]));
    for (const [code, searchItem] of globalCandidatesByCode) {
      const existing = combinedByCode.get(code);
      if (existing) {
        const matches = [
          ...(Array.isArray(existing.globalTrendSearchMatches) ? existing.globalTrendSearchMatches : []),
          ...(Array.isArray(searchItem.globalTrendSearchMatches) ? searchItem.globalTrendSearchMatches : [])
        ];
        combinedByCode.set(code, { ...searchItem, ...existing, globalTrendSearchMatches: matches });
      } else {
        combinedByCode.set(code, searchItem);
      }
    }
    report.discovery.combinedCandidates = combinedByCode.size;

    const ranked = [...combinedByCode.values()]
      .map(item => {
        const rank = scoreFeedCandidate(item, trendWeights, googleTrends);
        const searchBonus = globalSearchRelevanceBonus(item);
        rank.score = Math.round((rank.score + searchBonus.bonus) * 10) / 10;
        rank.globalSearchRelevance = searchBonus;
        return { item, rank };
      })
      .filter(entry => entry.rank.score >= 30)
      .sort((a, b) => b.rank.score - a.rank.score);

    if (!ranked.length) {
      report.status = 'no_eligible_filo_native_reposts';
      return;
    }

    let selected = null;
    const checked = [];
    for (const entry of ranked.slice(0, MAX_DETAIL_CHECKS)) {
      const code = entry.item.video_code;
      const detail = await getRepublishDetail(page, code).catch(() => null);
      const gate = detail ? detailGate(detail.root, detail.video) : { eligible: false, reason: 'republish_detail_unavailable' };
      checked.push({ code, score: entry.rank.score, gate: gate.reason });
      if (gate.eligible) {
        selected = { ...entry.item, editorialScore: entry.rank.score, scoreDetails: entry.rank, detail };
        break;
      }
    }
    report.discovery.detailChecks = checked;
    if (!selected) {
      report.status = 'no_candidate_passed_filo_native_permission_gate';
      return;
    }

    report.selected = {
      sourceCode: selected.video_code,
      title: String(selected.detail.video.title || selected.title || '').slice(0, 220),
      repostTitle: createRepostMetadata(selected.detail.video, selected.video_code).title,
      categoryId: selected.detail.video.category_id,
      durationSeconds: num(selected.detail.video.duration),
      visits: num(selected.detail.video.visit_count),
      plays: num(selected.detail.video.play_count),
      score: selected.editorialScore,
      scoreDetails: selected.scoreDetails
    };

    const result = await prepareAndPublish(page, selected, selected.detail, report);
    report.result = result;
    report.status = result.status;

    if (['submitted_pending_approval', 'submitted_unconfirmed', 'public_verified'].includes(result.status)) {
      state.posts.push({
        sourceCode: result.sourceCode || selected.video_code,
        sourceTitle: report.selected.title,
        repostTitle: result.repostMetadata && result.repostMetadata.title || null,
        newVideoCode: result.newVideoCode || null,
        publicUrl: result.publicUrl || null,
        status: result.status,
        score: selected.editorialScore,
        submittedAt: new Date().toISOString()
      });
      state.posts = state.posts.slice(-1200);
      state.updatedAt = new Date().toISOString();
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } else if (result.status === 'rejected_by_filo') {
      state.posts.push({
        sourceCode: selected.video_code,
        sourceTitle: report.selected.title,
        status: 'rejected_by_filo',
        reason: result.reason || '',
        attemptedAt: report.createdAt
      });
      state.posts = state.posts.slice(-1200);
      state.updatedAt = new Date().toISOString();
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
    }
  } catch (error) {
    report.status = 'failed';
    report.error = String(error && error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 900);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('FILO_NATIVE_REPUBLISH_RESULT ' + JSON.stringify({
      status: report.status,
      scannedItems: report.discovery.scannedItems,
      eligibleFeedItems: report.discovery.eligibleFeedItems,
      selected: report.selected,
      result: report.result,
      errors: report.discovery.errors.slice(0, 8),
      googleTrends: report.googleTrends,
      globalTrendSearch: report.discovery.globalTrendSearch,
      captionCleanup: report.captionCleanup,
      error: report.error
    }));
  }

  if (report.status === 'failed') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error('FILO_NATIVE_REPUBLISH_FATAL', String(error && error.message || error).slice(0, 600));
    process.exitCode = 1;
  });
}

module.exports = {
  ageHours,
  feedCandidateEligible,
  searchCandidateEligible,
  cleanLegacyRepostTitle,
  scoreFeedCandidate,
  createRepostMetadata,
  normalizeComparable,
  detailGate,
  dailyCount,
  lastSubmissionTime,
  millisecondsUntilNextPublication
};
