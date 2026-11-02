'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

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

function scoreFeedCandidate(item, trendWeights = {}) {
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
  if (text.length < 16) score -= 5;

  return {
    score: Math.round(score * 10) / 10,
    ageHours: Math.round(age * 10) / 10,
    engagement,
    categoryId,
    durationSeconds: duration,
    visits,
    plays
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

  const category = Number(video && video.category_id);
  const lead = ({
    6: 'ماجرای بامزه‌ی',
    11: 'لحظه‌ی تماشاییِ',
    13: 'رفتار دیدنیِ',
    29: 'روایت خوشمزه‌ی',
    2: 'نگاهی کوتاه به',
    22: 'نمایی چشم‌نواز از',
    17: 'لحظه‌ای هیجان‌انگیز از',
    25: 'صحنه‌ای دیدنی از',
    15: 'روایتی جذاب از',
    3: 'نگاهی کوتاه به'
  })[category] || 'روایتی کوتاه از';

  let title = trimAtWord(lead + ' «' + core + '»', 176);
  if (normalizeComparable(title) === normalizeComparable(sourceTitle)) {
    title = trimAtWord('بازنشر مجاز: ' + title, 176);
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
  await sleep(1800);

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

  const loginResponse = page.waitForResponse(response => {
    try {
      const url = new URL(response.url());
      return url.hostname === 'ifilo.net' &&
        url.pathname === '/api/v1/users/login' &&
        response.request().method() === 'POST';
    } catch { return false; }
  }, { timeout: 15000 }).catch(() => null);

  await submit.click();
  await loginResponse;
  await sleep(1500);
  await page.goto(BASE + '/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(800);

  const signedIn = await page.locator('a').evaluateAll(links =>
    links.some(a => /خروج|logout|sign.?out/i.test((a.innerText || '') + ' ' + (a.getAttribute('href') || '')))
  ).catch(() => false);
  if (!signedIn) throw new Error('filo_login_not_confirmed');

  return { authenticated: true, route: '/upload' };
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

  await page.evaluate(async () => {
    const video = document.querySelector('#plr video');
    if (!video) return;
    video.pause();
    const duration = Number(video.duration) || 0;
    const target = duration > 2 ? Math.min(4, Math.max(1, duration * 0.12)) : 0;
    if (target > 0 && Math.abs(video.currentTime - target) > 0.3) {
      await new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          video.removeEventListener('seeked', finish);
          resolve();
        };
        video.addEventListener('seeked', finish, { once: true });
        setTimeout(finish, 5000);
        try { video.currentTime = target; } catch { finish(); }
      });
    }
  });

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
    status: 'submitted_pending_approval',
    sourceCode: code,
    newVideoCode: publishPayload.newVideoCode,
    httpStatus: publishResponse.status(),
    publishPayload,
    repostMetadata: { title: repostMetadata.title, descriptionLength: repostMetadata.description.length },
    responseSummary: {
      success: true,
      keys: Object.keys(responseBody).slice(0, 20),
      dataKeys: responseBody.d && typeof responseBody.d === 'object' ? Object.keys(responseBody.d).slice(0, 20) : []
    }
  };

  if (publishPayload.newVideoCode) {
    try {
      await page.goto(BASE + '/v/' + encodeURIComponent(publishPayload.newVideoCode), {
        waitUntil: 'domcontentloaded',
        timeout: 18000
      });
      await page.waitForTimeout(1200);
      const visible = await page.locator('body').innerText().catch(() => '');
      const title = await page.title().catch(() => '');
      if (title.includes(repostMetadata.title) || visible.includes(repostMetadata.title)) {
        result.status = 'public_verified';
        result.publicUrl = BASE + '/v/' + publishPayload.newVideoCode;
      }
    } catch {}
  }

  return result;
}

async function main() {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const state = loadState();
  const report = {
    createdAt: new Date().toISOString(),
    status: 'started',
    discovery: { categories: CATEGORY_IDS, pagesPerCategory: PAGES_PER_CATEGORY, scannedItems: 0, eligibleFeedItems: 0, errors: [] },
    selected: null,
    result: null
  };
  let browser;

  try {
    if (dailyCount(state) >= MAX_DAILY_PUBLICATIONS) {
      report.status = 'daily_publication_cap_reached';
      report.dailyCount = dailyCount(state);
      return;
    }
    const last = lastSubmissionTime(state);
    if (last && Date.now() - last < MIN_PUBLISH_GAP_MS) {
      report.status = 'minimum_publication_gap_not_elapsed';
      report.nextEligibleAt = new Date(last + MIN_PUBLISH_GAP_MS).toISOString();
      return;
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
    const ranked = feedCandidates
      .map(item => ({ item, rank: scoreFeedCandidate(item, trendWeights) }))
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
  scoreFeedCandidate,
  createRepostMetadata,
  normalizeComparable,
  detailGate,
  dailyCount,
  lastSubmissionTime
};
