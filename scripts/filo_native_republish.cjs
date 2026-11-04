'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = 'https://ifilo.net';
const STATE_PATH = path.join('state', 'filo-native-republished.json');
const REPORT_PATH = path.join('out', 'filo-native-republish.json');
const FALLBACK_CATEGORY_IDS = [6, 11, 13, 29, 2, 22, 17, 25, 15, 3];
const CATEGORY_IDS = FALLBACK_CATEGORY_IDS;
const MAX_DISCOVERED_CATEGORY_IDS = 48;
const MIN_PAGES_PER_CATEGORY = 3;
const MAX_PAGES_PER_CATEGORY = 12;
const MAX_TOTAL_CATEGORY_PAGE_REQUESTS = 240;
const CATEGORY_PAGE_CONCURRENCY = 4;
const CATEGORY_SCAN_BUDGET_MS = 8 * 60 * 1000;
const CATEGORY_LOOKBACK_HOURS = 24;
const TOPIC_DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DETAIL_CHECKS = 90;
const MIN_DURATION_SECONDS = 10;
const MAX_DURATION_SECONDS = 180;
const MAX_PUBLICATIONS_PER_24H = 288;
const CAPTION_POLICY_VERSION = 5;
const CANDIDATE_METRIC_HISTORY_TTL_MS = 30 * 60 * 1000;
const CANDIDATE_METRIC_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TRACKED_CANDIDATE_METRICS = 1500;

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
  const absolute = Date.parse(raw);
  if (Number.isFinite(absolute)) return Math.max(0, (Date.now() - absolute) / 3600000);
  return 36;
}


function reliableFeedAgeBounds(item, now = Date.now()) {
  if (!item || typeof item !== 'object') return null;
  const fields = ['create_date', 'styled_create_date', 'created_at', 'createdAt', 'created', 'date'];

  for (const field of fields) {
    const value = item[field];
    if (value === undefined || value === null || value === '') continue;

    if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
      const numeric = Number(value);
      const timestamp = numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : NaN;
      if (Number.isFinite(timestamp)) {
        const centerHours = Math.max(0, (now - timestamp) / 3600000);
        return { centerHours, lowerHours: Math.max(0, centerHours - 1 / 7200), upperHours: centerHours + 1 / 7200, precisionHours: 1 / 3600 };
      }
    }

    const raw = normalizeDigits(value).trim().toLowerCase();
    if (!raw) continue;

    const dayMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:روز|day|days)/i);
    const hourMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:ساعت|hour|hours|hr|hrs)/i);
    const minuteMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:دقیقه|دقایق|min|mins|minute|minutes)/i);
    if (dayMatch || hourMatch || minuteMatch) {
      const toNumber = match => match ? num(match[1].replace(',', '.')) : 0;
      const centerHours = toNumber(dayMatch) * 24 + toNumber(hourMatch) + toNumber(minuteMatch) / 60;
      const precisionHours = minuteMatch ? 1 / 60 : hourMatch ? 1 : 24;
      return {
        centerHours: Math.max(0, centerHours),
        lowerHours: Math.max(0, centerHours - precisionHours / 2),
        upperHours: centerHours + precisionHours / 2,
        precisionHours
      };
    }

    if (/لحظاتی پیش|همین الان|اکنون|just now|moments ago/.test(raw)) {
      return { centerHours: 0.1, lowerHours: 0, upperHours: 0.25, precisionHours: 0.25 };
    }
    if (/دیروز|yesterday|امروز|today/.test(raw)) continue;

    const absolute = Date.parse(raw);
    if (Number.isFinite(absolute)) {
      const centerHours = Math.max(0, (now - absolute) / 3600000);
      const hasClock = /(?:t|\b)\d{1,2}:\d{2}/i.test(raw);
      const precisionHours = hasClock ? 1 / 3600 : 24;
      return {
        centerHours,
        lowerHours: Math.max(0, centerHours - precisionHours / 2),
        upperHours: centerHours + precisionHours / 2,
        precisionHours
      };
    }
  }
  return null;
}

function analyzeCategoryFeedPage(items, now = Date.now(), lookbackHours = CATEGORY_LOOKBACK_HOURS) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return {
      itemCount: 0,
      ageDataComplete: true,
      chronologyConsistent: true,
      allItemsOlderThanLookback: false,
      firstAgeBounds: null,
      lastAgeBounds: null,
      newestAgeHours: null,
      oldestAgeHours: null
    };
  }

  const ages = list.map(item => reliableFeedAgeBounds(item, now));
  const ageDataComplete = ages.every(Boolean);
  const precisionReliable = ageDataComplete && ages.every(age => age.precisionHours <= 1.1);
  let chronologyConsistent = precisionReliable;

  if (chronologyConsistent) {
    for (let index = 1; index < ages.length; index++) {
      const previous = ages[index - 1];
      const current = ages[index];
      const tolerance = Math.max(0.03, (previous.precisionHours + current.precisionHours) * 0.5);
      if (current.centerHours + tolerance < previous.centerHours) {
        chronologyConsistent = false;
        break;
      }
    }
  }

  const centers = ages.filter(Boolean).map(age => age.centerHours);
  return {
    itemCount: list.length,
    ageDataComplete,
    chronologyConsistent,
    allItemsOlderThanLookback: ageDataComplete && ages.every(age => age.lowerHours > lookbackHours),
    firstAgeBounds: ages[0] || null,
    lastAgeBounds: ages.at(-1) || null,
    newestAgeHours: centers.length ? Math.min(...centers) : null,
    oldestAgeHours: centers.length ? Math.max(...centers) : null
  };
}

function categoryFeedBoundaryOrdered(previousLastAge, currentFirstAge) {
  if (!previousLastAge || !currentFirstAge) return false;
  const tolerance = Math.max(0.03, (previousLastAge.precisionHours + currentFirstAge.precisionHours) * 0.5);
  return currentFirstAge.centerHours + tolerance >= previousLastAge.centerHours;
}

function shouldStopCategoryPagination({ pageCount, pageAnalysis, chronologyVerified, lookbackHours = CATEGORY_LOOKBACK_HOURS }) {
  return Number(pageCount) >= 2 &&
    chronologyVerified === true &&
    pageAnalysis &&
    pageAnalysis.allItemsOlderThanLookback === true &&
    pageAnalysis.oldestAgeHours !== null &&
    pageAnalysis.oldestAgeHours > lookbackHours;
}

function sourceText(item) {
  return [item && item.title, item && item.description, item && item.sender_name]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

const EXCLUDED = /(?:اخبار|خبر فوری|تحلیل سیاسی|سیاست|سیاسی|انتخابات|جنگ|حمله نظامی|موشک|انفجار|تروریست|ترور|اعدام|شلیک|سلاح|بمب|هسته.?ای|مواد منفجره|ساخت.?(?:بمب|سلاح|موشک)|شبیه.?ساز.{0,24}(?:بمب|موشک|سلاح)|پهپاد نظامی|مهمات|خشونت|مداحی|تبلیغات|کازینو|شرط.?بندی|قمار|محتوای بزرگسال|پورنو|قتل|خودکشی|خودآزاری|صحنه دلخراش|تصادف مرگبار|حیوان.?آزاری|رقص|حرکات موزون|تک.?خوانی.{0,8}زن|خوانندگی.{0,8}زن|فحاشی|الفاظ رکیک|افترا|تهمت|توهین|ناسزا|بددهنی|تحقیر|تمسخر|دوربین.?مداربسته|فیلم.?برداری.?مخفی|افشای اطلاعات|کد ملی|خبر جعلی|اطلاعات نادرست|فیلم سینمایی|فیلم ایرانی|سریال|مجموعه تلویزیونی|محصول نمایش خانگی|شبکه نمایش خانگی|صدا.?و.?سیما|فیلیمو|نماوا|فیلم.?نت|تلوبیون|آی.?آر.?مووی|IR.?Movie|مواد مخدر|مشروبات الکلی|برهنگی|محتوای جنسی)/i;
const POLICY_TEXT_RISKS = [
 {reason:'weapons_or_explosives',pattern:/(?:بمب\s*(?:اتم|هسته.?ای)?|سلاح\s*هسته.?ای|انفجار\s*هسته.?ای|مواد\s*منفجره|ساخت\s*(?:بمب|سلاح|موشک)|شبیه.?ساز.{0,24}(?:بمب|موشک|سلاح)|پهپاد\s*نظامی|مهمات)/i},
 {reason:'insult_or_defamation',pattern:/(?:توهین|توهین\s*آمیز|فحاشی|الفاظ\s*رکیک|ناسزا|بددهنی|افترا|تهمت|تحقیر|تمسخر)/i},
 {reason:'privacy_exposure',pattern:/(?:دوربین\s*مداربسته|\bCCTV\b|افشای\s*(?:اطلاعات|آدرس|شماره)|کد\s*ملی|شماره\s*(?:موبایل|تلفن)|آدرس\s*منزل|بدون\s*رضایت|فیلم.?برداری\s*مخفی)/i},
 {reason:'group_harassment',pattern:/(?:(?:تمسخر|توهین|تحقیر|نفرت.?پراکنی|نژاد.?پرستی|قوم.?ستیزی).{0,30}(?:قوم|نژاد|دین|مذهب|جنسیت|اقلیت)|(?:قوم|نژاد|دین|مذهب|جنسیت|اقلیت).{0,30}(?:تمسخر|توهین|تحقیر|نفرت.?پراکنی|نژاد.?پرستی|قوم.?ستیزی))/i},
 {reason:'copyrighted_film_or_series',pattern:/(?:فیلم\s*(?:سینمایی|ایرانی|فرار\s*از\s*زندان)|سریال(?:\s*تلویزیونی)?|مجموعه\s*تلویزیونی|سکانس\s*(?:از\s*)?(?:فیلم|سریال)|قسمت\s*کامل|محصول\s*نمایش\s*خانگی|شبکه\s*نمایش\s*خانگی|فیلیمو|نماوا|فیلم\s*نت|تلوبیون|صدا\s*و\s*سیما|صداوسیما|فرار\s*از\s*زندان|prison\s*break)/i},
 {reason:'external_video_service_advertising',pattern:/(?:آی[\s‌-]*آر[\s‌-]*مووی|ir[\s-]?movie|دانلود\s+(?:و\s+)?تماشای\s+رایگان|فیلم.{0,40}سریال.{0,30}درخواستی|سریال.{0,30}فیلم.{0,30}درخواستی|درخواست\s+(?:فیلم|سریال)|ویدیو(?:ها)?\s+درخواستی|رسانه\s+.{0,50}(?:فیلم|ویدیو)|سایت\s+.{0,50}(?:فیلم|سریال))/i},
 {reason:'prohibited_dance_or_solo_singing',pattern:/(?:رقص|حرکات\s*موزون|تک.?خوانی.{0,10}زن|خوانندگی.{0,10}زن)/i},
 {reason:'misleading_or_false_information',pattern:/(?:شایعه|خبر\s*جعلی|اطلاعات\s*نادرست|خبر\s*دروغ|اطلاعات\s*غیرواقعی)/i},
 {reason:'adult_or_sexual_content',pattern:/(?:محتوای\s*جنسی|پورنوگرافی|برهنگی|برهنه|جفت.?گیری\s*حیوانات)/i},
 {reason:'illegal_goods_or_gambling',pattern:/(?:مواد\s*مخدر|مشروبات\s*الکلی|کازینو|شرط.?بندی|قمار|فروش\s*(?:مشروب|مواد\s*مخدر|سلاح))/i}
];
function policyTextRiskReason(item){
 const text=[item&&item.title,item&&item.description].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
 if(!text)return null;
 for(const risk of POLICY_TEXT_RISKS)if(risk.pattern.test(text))return risk.reason;
 return EXCLUDED.test(text)?'prohibited_or_sensitive_content':null;
}

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
  if (text.length < 8 || policyTextRiskReason(item)) return false;
  return true;
}

function candidateMetricValue(item, keys) {
  const values = keys.map(key => item && item[key])
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(value => num(value, -1)).filter(value => value >= 0);
  return values.length ? Math.max(...values) : 0;
}

function updateCandidateMomentum(state, items, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const history = state.candidateMomentum && typeof state.candidateMomentum === 'object' ? state.candidateMomentum : {};
  const observed = {};
  const nowIso = new Date(nowMs).toISOString();

  for (const item of Array.isArray(items) ? items : []) {
    const code = String(item && (item.video_code || item.videoCode || item.code) || '').trim();
    if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) continue;
    const views = candidateMetricValue(item, ['visit_count', 'view_count', 'views', 'visits']);
    const plays = candidateMetricValue(item, ['play_count', 'plays', 'playCount']);
    const entry = history[code] && typeof history[code] === 'object' ? history[code] : {};
    let samples = Array.isArray(entry.samples) ? entry.samples.filter(sample => {
      const at = Date.parse(sample && sample.at || '');
      return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= CANDIDATE_METRIC_HISTORY_TTL_MS;
    }).slice(-4) : [];
    const previous = samples.at(-1) || null;
    let rate = null;

    if (previous) {
      const elapsedMs = nowMs - Date.parse(previous.at);
      if (elapsedMs >= CANDIDATE_METRIC_SAMPLE_INTERVAL_MS && elapsedMs <= CANDIDATE_METRIC_HISTORY_TTL_MS) {
        const deltaViews = views - candidateMetricValue(previous, ['views']);
        const deltaPlays = plays - candidateMetricValue(previous, ['plays']);
        if (deltaViews >= 0 && deltaPlays >= 0) {
          const elapsedMinutes = elapsedMs / 60000;
          const viewsPerMinute = deltaViews / elapsedMinutes;
          const playsPerMinute = deltaPlays / elapsedMinutes;
          const previousRate = entry.lastRate && typeof entry.lastRate === 'object' ? entry.lastRate : null;
          const acceleration = previousRate ? Math.max(0, viewsPerMinute - Math.max(0, num(previousRate.viewsPerMinute))) : 0;
          rate = {
            viewsPerMinute: Math.round(viewsPerMinute * 100) / 100,
            playsPerMinute: Math.round(playsPerMinute * 100) / 100,
            accelerationPerMinute: Math.round(acceleration * 100) / 100,
            sampleCount: samples.length + 1
          };
        } else {
          samples = [];
          delete entry.lastRate;
        }
      }
    }

    const lastSampleAt = samples.length ? Date.parse(samples.at(-1).at) : NaN;
    if (!Number.isFinite(lastSampleAt) || nowMs - lastSampleAt >= CANDIDATE_METRIC_SAMPLE_INTERVAL_MS) {
      samples.push({ at: nowIso, views, plays });
      samples = samples.slice(-4);
    }
    const nextEntry = { ...entry, samples, lastSeenAt: nowIso };
    if (rate) {
      nextEntry.lastRate = { ...rate, at: nowIso };
      observed[code] = rate;
    }
    history[code] = nextEntry;
  }

  const retained = Object.entries(history)
    .filter(([, entry]) => {
      const seenAt = Date.parse(entry && entry.lastSeenAt || '');
      return Number.isFinite(seenAt) && nowMs - seenAt <= CANDIDATE_METRIC_HISTORY_TTL_MS;
    })
    .sort((a, b) => String(b[1].lastSeenAt || '').localeCompare(String(a[1].lastSeenAt || '')))
    .slice(0, MAX_TRACKED_CANDIDATE_METRICS);
  state.candidateMomentum = Object.fromEntries(retained);
  return observed;
}

function rankCandidatesByMomentum(items, state, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const currentRates = updateCandidateMomentum(state, items, nowMs);
  const recentCategories = (state && Array.isArray(state.posts) ? state.posts : [])
    .filter(post => post && post.categoryId != null &&
      ['public_verified', 'submitted_pending_approval', 'submitted_unconfirmed'].includes(post.status))
    .filter(post => {
      const at = Date.parse(post.submittedAt || post.at || '');
      return Number.isFinite(at) && nowMs - at <= 48 * 60 * 60 * 1000;
    })
    .sort((a, b) => Date.parse(b.submittedAt || b.at || '') - Date.parse(a.submittedAt || a.at || ''))
    .slice(0, 2)
    .map(post => String(post.categoryId));
  const recentCategorySet = new Set(recentCategories);
  return (Array.isArray(items) ? items : []).map(item => {
    const code = String(item && (item.video_code || item.videoCode || item.code) || '').trim();
    const saved = state.candidateMomentum && state.candidateMomentum[code];
    const lastRate = saved && saved.lastRate;
    const lastRateAt = Date.parse(lastRate && lastRate.at || '');
    const recentSavedRate = Number.isFinite(lastRateAt) && nowMs - lastRateAt <= 15 * 60 * 1000
      ? lastRate : null;
    const momentum = currentRates[code] || recentSavedRate;
    const categoryId = item && item.category_id != null ? String(item.category_id) : '';
    return {
      item,
      momentum,
      ageHours: ageHours(item),
      recentCategoryPenalty: categoryId && recentCategorySet.has(categoryId) ? 1 : 0
    };
  }).filter(entry =>
    entry.momentum &&
    num(entry.momentum.viewsPerMinute) > 0 &&
    entry.ageHours <= 24
  ).sort((a, b) =>
    num(b.momentum.viewsPerMinute) - num(a.momentum.viewsPerMinute) ||
    num(b.momentum.accelerationPerMinute) - num(a.momentum.accelerationPerMinute) ||
    a.recentCategoryPenalty - b.recentCategoryPenalty ||
    a.ageHours - b.ageHours
  );
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
  const policyRisk = policyTextRiskReason(video);
  if (policyRisk) return { eligible: false, reason: 'filo_policy_text_risk:' + policyRisk };
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

function normalizeCaptionEditorialText(value) {
  return String(value || '').normalize('NFKC')
    .replace(/[\u200B-\u200F\u2060\uFE0E]/g, '')
    .replace(/ك/g, 'ک')
    .replace(/[يى]/g, 'ی')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanRepostCaptionTitle(sourceTitle) {
  const title = normalizeCaptionEditorialText(sourceTitle)
    .replace(/https?:\/\/\S+|www\.\S+/giu, ' ')
    .replace(/#[^\s#]+/gu, ' ')
    .replace(/@[\p{L}\p{N}_.-]+/gu, ' ')
    .replace(/^(?:(?:ماجرای\s+بامزه(?:‌ی|ی)?|روایت\s+تصویری|روایتی\s+از)\s*[:،؛-]?\s*)+/iu, '')
    .replace(/^\s*(?:کلیپ|ویدئو|ویدیو|فیلم)\s+/iu, '')
    .replace(/\s+(?:این\s+)?(?:حتماً?\s*)?(?:ببینید|ببنید|تماشا کنید|مشاهده کنید|از دست ندید|از دست ندهید)\s*$/iu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length < 5) throw new Error('source_title_too_short');
  return trimAtWord(title, 176);
}

const EDITORIAL_TITLE_STOPWORDS = new Set([
  'و', 'در', 'به', 'با', 'از', 'برای', 'که', 'این', 'آن', 'یک', 'را', 'های', 'ها',
  'کرد', 'شد', 'است', 'هست', 'هم', 'اما', 'یا', 'روی', 'تا', 'بر', 'پس', 'قبل',
  'کلیپ', 'ویدئو', 'ویدیو', 'فیلم', 'تصویر', 'تصاویر', 'طنز', 'خنده', 'بامزه',
  'جالب', 'دیدنی', 'لحظه', 'روایت', 'آموزشی'
]);

function editorialTitleTokens(value) {
  return [...new Set(normalizeCaptionEditorialText(value)
    .toLocaleLowerCase('fa-IR')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 1 && !EDITORIAL_TITLE_STOPWORDS.has(token)))];
}

function characterBigramDice(left, right) {
  const a = normalizeComparable(left);
  const b = normalizeComparable(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = value => {
    const counts = new Map();
    for (let i = 0; i < value.length - 1; i++) {
      const gram = value.slice(i, i + 2);
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    return counts;
  };
  const aa = grams(a), bb = grams(b);
  let overlap = 0;
  for (const [gram, count] of aa) overlap += Math.min(count, bb.get(gram) || 0);
  return (2 * overlap) / (a.length + b.length - 2);
}

function createDistinctRepostTitle(sourceTitle) {
  const cleaned = cleanRepostCaptionTitle(sourceTitle);
  const rules = [
    [/^طرز\s+تهیه\s+(.+)$/u, match => 'روش پخت ' + match[1]],
    [/^دستور\s+تهیه\s+(.+)$/u, match => 'روش آماده‌سازی ' + match[1]],
    [/^پاک\s+کردن\s+(.+?)\s+به\s+سبک\s+(.+)$/u, match => 'روش ' + match[2] + ' برای پاک کردن ' + match[1]],
    [/^(.+?)\s+به\s+سبک\s+(.+)$/u, match => 'روش ' + match[2] + ' برای ' + match[1]],
    [/^کتاب\s+صوتی\s+(.+?)\s+با\s+صدای\s+(.+)$/u, match => 'شنیدن ' + match[1] + ' با صدای ' + match[2]],
    [/^آموزش\s+(.+)$/u, match => 'راهنمای ' + match[1]],
    [/^چگونه\s+(.+)$/u, match => 'روش ' + match[1]],
    [/^(.+?)\s+در\s+(.+)$/u, match => match[2] + '؛ ' + match[1]],
    [/^(.+?)\s+با\s+(.+)$/u, match => match[1] + ' همراه ' + match[2]]
  ];
  let candidate = cleaned;
  for (const [pattern, rewrite] of rules) {
    const match = cleaned.match(pattern);
    if (match) {
      candidate = rewrite(match).replace(/\s+/g, ' ').trim();
      break;
    }
  }
  const tokens = editorialTitleTokens(candidate);
  if (tokens.length < 3) throw new Error('repost_title_not_informative_enough');
  const similarity = characterBigramDice(sourceTitle, candidate);
  if (similarity > 0.86) throw new Error('title_not_distinct_enough');
  if (candidate.length < 10 || candidate.length > 176) throw new Error('repost_title_length_invalid');
  return candidate;
}

function cleanRepostDescription(sourceDescription, sourceTitle, repostTitle) {
  const description = normalizeCaptionEditorialText(sourceDescription)
    .replace(/https?:\/\/\S+|www\.\S+/giu, ' ')
    .replace(/#[^\s#]+/gu, ' ')
    .replace(/@[\p{L}\p{N}_.-]+/gu, ' ')
    .replace(/برای\s+شما\s+(?:عزیزان|دوستان(?:\s+عزیز)?)/giu, ' ')
    .replace(/(?:دوستان\s+عزیز|عزیزانِ?\s+همراه)/giu, ' ')
    .replace(/(?:لطفاً|لطفا)\s*(?:لایک|پسند|فالو|دنبال|عضویت|اشتراک).{0,160}$/iu, ' ')
    .replace(/(?:با\s+ما\s+همراه\s+باشید|همراه\s+ما\s+باشید)(?:\s+و\s+)?(?:لذت\s+ببرید)?/giu, ' ')
    .replace(/لذت\s+ببرید/giu, ' ')
    .replace(/(?:لایک\s+کنید|فالو\s+کنید|ما\s+را\s+دنبال\s+کنید|عضو\s+شوید)/giu, ' ')
    .replace(/\s+([،؛:,.!?؟])/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // Keep source facts as supplied; a short caption is valid and no detail is invented.
  return trimAtWord(description || String(repostTitle || sourceTitle || '').trim(), 900);
}

function createRepostMetadata(video, sourceCode) {
  const sourceTitle = String(video && video.title || '').replace(/\s+/g, ' ').trim();
  const sourceDescription = String(video && video.description || '').replace(/\s+/g, ' ').trim();
  if (/(?:https?:\/\/|www\.)/i.test(sourceTitle)) throw new Error('repost_source_title_contains_external_link');
  const risk = policyTextRiskReason(video);
  if (risk) throw new Error('filo_policy_text_risk:' + risk);
  const title = createDistinctRepostTitle(sourceTitle);
  const description = cleanRepostDescription(sourceDescription, sourceTitle, title);
  return { title, description, sourceTitle, sourceDescription, sourceCode };
}

function topicDuplicateMatch(state, title, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const tokens = editorialTitleTokens(title);
  if (tokens.length < 2) return { duplicate: false, reason: 'insufficient_topic_tokens' };
  const current = new Set(tokens);
  const recent = (state && Array.isArray(state.posts) ? state.posts : [])
    .filter(post => post && ['public_verified', 'submitted_pending_approval', 'submitted_unconfirmed'].includes(post.status))
    .filter(post => {
      const at = Date.parse(post.submittedAt || post.at || '');
      return Number.isFinite(at) && at <= nowMs && nowMs - at <= TOPIC_DUPLICATE_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(b.submittedAt || b.at || '') - Date.parse(a.submittedAt || a.at || ''));
  for (const post of recent) {
    const previousTitle = post.repostTitle || post.sourceTitle || '';
    const previous = new Set(editorialTitleTokens(previousTitle));
    if (previous.size < 2) continue;
    const common = [...current].filter(token => previous.has(token));
    const unionSize = new Set([...current, ...previous]).size;
    const jaccard = common.length / unionSize;
    const smallerSetCoverage = common.length / Math.min(current.size, previous.size);
    const characterSimilarity = characterBigramDice(title, previousTitle);
    if ((common.length >= 2 && (jaccard >= 0.5 || smallerSetCoverage >= 0.8)) ||
        characterSimilarity >= 0.84) {
      return {
        duplicate: true,
        matchedTitle: String(previousTitle).slice(0, 180),
        matchedSourceCode: post.sourceCode || null,
        commonTokens: common.slice(0, 8),
        jaccard: Math.round(jaccard * 100) / 100,
        characterSimilarity: Math.round(characterSimilarity * 100) / 100
      };
    }
  }
  return { duplicate: false };
}

function isCandidateLevelFiloRejection(result) {
  if (!result || result.status !== 'rejected_by_filo' || !result.responseDiagnostics) return false;
  const diagnostics = result.responseDiagnostics;
  const keys = Array.isArray(diagnostics.bodyKeys) ? diagnostics.bodyKeys : [];
  const explicitKeys = new Set(['r', 'message', 'error', 'errors', 'reason', 'detail', 'details', 'status']);
  return keys.some(key => explicitKeys.has(String(key))) ||
    Boolean(diagnostics.r || diagnostics.message || diagnostics.error || diagnostics.reason || diagnostics.detail) ||
    (Array.isArray(diagnostics.uiErrors) && diagnostics.uiErrors.length > 0);
}

function imageDimensionsFromDataUrl(value) {
 const match=/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(value||''));
 if(!match)return null;
 const buffer=Buffer.from(match[2],'base64');
 if(match[1].toLowerCase()==='png'){
  const sig=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  if(buffer.length<24||!buffer.subarray(0,8).equals(sig))return null;
  const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);
  return width>0&&height>0?{width,height}:null;
 }
 const markers=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
 let offset=2;
 while(offset+9<buffer.length){
  if(buffer[offset]!==0xff){offset++;continue;}
  const marker=buffer[offset+1];offset+=2;
  if(marker===0xd8||marker===0xd9||(marker>=0xd0&&marker<=0xd7))continue;
  if(offset+7>=buffer.length)break;
  const length=buffer.readUInt16BE(offset);
  if(length<2||offset+length>buffer.length)break;
  if(markers.has(marker)&&length>=7){
   const height=buffer.readUInt16BE(offset+3),width=buffer.readUInt16BE(offset+5);
   return width>0&&height>0?{width,height}:null;
  }
  offset+=length;
 }
 return null;
}

function buildNativePublishGuardFailures({
 sourceCode,republishFrom,videoCode,isMadeByMe,canRepublish,canMakeMoney,dontPublish,metadataOk
}) {
 const failures=[];
 if(republishFrom!==sourceCode)failures.push('source_code_mismatch');
 if(!/^[A-Za-z0-9_-]{5,40}$/.test(String(videoCode||'')))failures.push('new_video_code_invalid');
 if(isMadeByMe!=='false')failures.push('source_is_not_other_user_content');
 if(canRepublish!=='true')failures.push('native_republish_permission_missing');
 if(canMakeMoney!=='true')failures.push('monetization_permission_missing');
 if(dontPublish!=='0')failures.push('source_marked_do_not_publish');
 if(!metadataOk)failures.push('metadata_policy_guard_failed');
 return failures;
}

function safeApiDiagnosticValue(value,depth=0) {
 if(value===null||value===undefined)return value;
 if(typeof value==='string')return value.replace(/[\r\n]+/g,' ').slice(0,260);
 if(typeof value==='number'||typeof value==='boolean')return value;
 if(Array.isArray(value))return value.slice(0,5).map(item=>safeApiDiagnosticValue(item,depth+1));
 if(typeof value==='object'&&depth<2){
  const output={};
  for(const key of Object.keys(value).slice(0,12))output[key]=safeApiDiagnosticValue(value[key],depth+1);
  return output;
 }
 return String(value).slice(0,120);
}

function buildUnconfirmedSubmissionResult({
 sourceCode,newVideoCode,publishPayload,repostTitle,repostDescription,reason,httpStatus,responseDiagnostics
}) {
 return {
  status:'submitted_unconfirmed',
  reason:String(reason||'publish_response_not_observed').slice(0,240),
  sourceCode:String(sourceCode||publishPayload&&publishPayload.sourceCode||''),
  newVideoCode:String(newVideoCode||publishPayload&&publishPayload.newVideoCode||'')||null,
  httpStatus:httpStatus||null,
  responseDiagnostics:responseDiagnostics||null,
  publishPayload,
  repostMetadata:repostTitle?{
   title:String(repostTitle).slice(0,180),
   description:String(repostDescription||''),
   descriptionLength:String(repostDescription||'').length
  }:null
 };
}



async function captureVideoFrameDataUrl(page) {
 const canvasFrame=await page.locator('#plr video').first().evaluate(video=>{
  if(!video||video.readyState<2||!video.videoWidth||!video.videoHeight)return null;
  try{
   const canvas=document.createElement('canvas');
   canvas.width=video.videoWidth;
   canvas.height=video.videoHeight;
   const context=canvas.getContext('2d');
   if(!context)return null;
   context.drawImage(video,0,0,canvas.width,canvas.height);
   const dataUrl=canvas.toDataURL('image/jpeg',0.92);
   return dataUrl&&dataUrl.startsWith('data:image/')?dataUrl:null;
  }catch{return null;}
 }).catch(()=>null);
 if(canvasFrame)return canvasFrame;
 const screenshot=await page.locator('#plr video').first()
  .screenshot({type:'jpeg',quality:90,timeout:7000}).catch(()=>null);
 return screenshot&&screenshot.length>1200
  ?'data:image/jpeg;base64,'+screenshot.toString('base64')
  :null;
}

async function composeFiloCoverDataUrl(page,sourceDataUrl) {
 const sourceDimensions=imageDimensionsFromDataUrl(sourceDataUrl);
 if(!sourceDimensions)return {ok:false,reason:'cover_source_image_invalid',sourceDimensions:null};
 try {
  const composed=await page.evaluate(async source=>{
   const image=new Image();
   image.src=source;
   try{await image.decode();}catch{return null;}
   if(!image.naturalWidth||!image.naturalHeight)return null;
   // Keep encoded form data comfortably below Filo's 1 MiB request-field limit.
   // URLSearchParams measures the actual x-www-form-urlencoded expansion.
   const maxEncodedLength=800000;
   const sizes=[[640,360],[480,270],[320,180]];
   for(const [width,height] of sizes){
    const canvas=document.createElement('canvas');
    canvas.width=width;
    canvas.height=height;
    const context=canvas.getContext('2d');
    if(!context)continue;
    context.fillStyle='#10141b';
    context.fillRect(0,0,width,height);
    const backgroundScale=Math.max(width/image.naturalWidth,height/image.naturalHeight)*1.12;
    const backgroundWidth=image.naturalWidth*backgroundScale;
    const backgroundHeight=image.naturalHeight*backgroundScale;
    context.save();
    context.filter='blur('+Math.max(12,Math.round(width*0.023))+'px) brightness(0.58) saturate(0.82)';
    context.drawImage(image,(width-backgroundWidth)/2,(height-backgroundHeight)/2,backgroundWidth,backgroundHeight);
    context.restore();
    context.fillStyle='rgba(5,8,13,0.12)';
    context.fillRect(0,0,width,height);
    const foregroundScale=Math.min(width/image.naturalWidth,height/image.naturalHeight);
    const foregroundWidth=image.naturalWidth*foregroundScale;
    const foregroundHeight=image.naturalHeight*foregroundScale;
    const x=(width-foregroundWidth)/2;
    const y=(height-foregroundHeight)/2;
    context.save();
    context.shadowColor='rgba(0,0,0,0.42)';
    context.shadowBlur=Math.max(8,Math.round(width*0.018));
    context.shadowOffsetY=Math.max(2,Math.round(height*0.007));
    context.drawImage(image,x,y,foregroundWidth,foregroundHeight);
    context.restore();
    const dataUrl=canvas.toDataURL('image/png');
    const encodedLength=new URLSearchParams({selectedFrame:dataUrl}).toString().length;
    if(encodedLength<=maxEncodedLength){
     return {dataUrl,encodedLength,width,height};
    }
   }
   return null;
  },sourceDataUrl);
  if(!composed||!composed.dataUrl)return {
   ok:false,reason:'cover_exceeds_filo_encoded_field_limit',sourceDimensions,
   encodedLength:null,dimensions:null,aspectRatio:null
  };
  const dimensions=imageDimensionsFromDataUrl(composed.dataUrl);
  const aspectRatio=dimensions?dimensions.width/dimensions.height:0;
  const ok=Boolean(dimensions&&Math.abs(aspectRatio-(16/9))<=0.02&&composed.encodedLength<=800000);
  return {
   ok,dataUrl:ok?composed.dataUrl:null,
   strategy:ok?'blurred_background_full_frame_contain_compact_png_v1':null,
   reason:ok?null:'cover_composition_output_invalid',
   sourceDimensions,dimensions,aspectRatio:aspectRatio||null,
   encodedLength:composed.encodedLength
  };
 }catch(error){
  return {ok:false,reason:'cover_composition_failed:'+String(error&&error.message||error).slice(0,140),
   sourceDimensions,dimensions:null,aspectRatio:null,encodedLength:null};
 }
}

function recordThumbnailSelection(report,selection) {
 const {coverFrameDataUrl,...summary}=selection||{};
 report.thumbnailSelection={...summary,coverFrameCaptureAvailable:Boolean(coverFrameDataUrl)};
 return selection;
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (data && Array.isArray(data.posts)) return data;
  } catch {}
  return { schemaVersion: 1, posts: [] };
}

function dailyCount(state, now = Date.now()) {
  const windowStart = now - 24 * 60 * 60 * 1000;
  return state.posts.filter(post => {
    const submittedAt = Date.parse(post && post.submittedAt || '');
    return Number.isFinite(submittedAt) &&
      submittedAt >= windowStart &&
      submittedAt <= now &&
      ['submitted_pending_approval', 'submitted_unconfirmed', 'public_verified'].includes(post.status);
  }).length;
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

function extractCategoryIds(payload) {
  const root = payload && payload.data && typeof payload.data === 'object' &&
    (payload.data.c || payload.data.cfs || payload.data.categories)
    ? payload.data : payload;
  const roots = [
    root && root.c,
    root && root.cfs,
    root && root.categories,
    root && root.categoriesForSide,
    root && root.categories_for_side
  ].filter(Boolean);
  const ids = new Set();
  const validId = value => {
    const raw = String(value == null ? '' : value).trim();
    if (!/^\d{1,6}$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const visit = (node, depth = 0) => {
    if (!node || depth > 7) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const idKeys = ['id', 'category_id', 'categoryId', 'categoryID', 'cid', 'cat_id', 'catId', 'c_id'];
    for (const key of idKeys) {
      const id = validId(node[key]);
      if (id !== null) { ids.add(id); break; }
    }
    for (const [key, value] of Object.entries(node)) {
      const mapId = validId(key);
      if (mapId !== null && value && typeof value === 'object') ids.add(mapId);
      if (value && typeof value === 'object') visit(value, depth + 1);
    }
  };
  for (const value of roots) visit(value);
  return [...ids].sort((a, b) => a - b);
}

async function discoverCategoryCatalog(page) {
  try {
    const payload = await page.evaluate(async () => {
      const response = await fetch('/api/v1/bind/master', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
        },
        body: '',
        signal: AbortSignal.timeout(9000)
      });
      if (!response.ok) throw new Error('category_catalog_http_' + response.status);
      return await response.json();
    });
    const catalogIds = extractCategoryIds(payload);
    const ids = [...new Set([...catalogIds, ...FALLBACK_CATEGORY_IDS])]
      .slice(0, MAX_DISCOVERED_CATEGORY_IDS);
    return {
      ids,
      catalogIds,
      source: catalogIds.length ? 'filo_bind_master_plus_legacy_fallback' : 'legacy_fallback',
      error: null
    };
  } catch (error) {
    return {
      ids: [...FALLBACK_CATEGORY_IDS],
      catalogIds: [],
      source: 'legacy_fallback',
      error: String(error && error.message || error).slice(0, 220)
    };
  }
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
      body: params.toString(),
      signal: AbortSignal.timeout(7000)
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
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(7000)
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

async function selectThumbnailFrame(page, report) {
  const videoInfo = await page.locator('#plr video').first().evaluate(video => ({
    duration: Number(video.duration) || 0
  })).catch(() => ({ duration: 0 }));
  const target = videoInfo.duration > 2 ? Math.min(4, Math.max(1, videoInfo.duration * 0.12)) : 0.5;
  const seek = await seekVideoTo(page, target).catch(() => ({ ok: false }));
  const coverFrameDataUrl = await captureVideoFrameDataUrl(page).catch(() => null);
  return recordThumbnailSelection(report, {
    strategy: 'single_early_player_frame',
    fallback: !seek || !seek.ok,
    reason: !coverFrameDataUrl ? 'player_frame_unavailable' : null,
    selectedTimeSeconds: target,
    framesAnalyzed: coverFrameDataUrl ? 1 : 0,
    coverFrameDataUrl
  });
}

async function prepareAndPublish(page, candidate, detail, report, beforeSubmit = null) {
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
  }, null, { timeout: 9000 }).then(() => true).catch(() => false);

  let thumbnailSelection=null;
  try {
    thumbnailSelection=videoReady
      ? await selectThumbnailFrame(page,report)
      : null;
  } catch(error) {
    report.thumbnailPreparationError=String(error&&error.message||error).slice(0,180);
  }
  if(!thumbnailSelection||!thumbnailSelection.coverFrameDataUrl) {
    const fallbackFrame=await captureVideoFrameDataUrl(page);
    thumbnailSelection=recordThumbnailSelection(report,{
      strategy:'best_effort_video_element_frame',
      fallback:true,
      reason:videoReady?'thumbnail_selection_failed':'video_player_not_ready',
      framesAnalyzed:thumbnailSelection&&thumbnailSelection.framesAnalyzed||0,
      coverFrameDataUrl:fallbackFrame
    });
  }

  // Cover controls are best-effort only; they must never block a publication.
  const cropButton=page.locator('button.shot-btn').first();
  if(await cropButton.isVisible().catch(()=>false)){
    await cropButton.click().catch(error=>{
      report.thumbnailButtonError=String(error&&error.message||error).slice(0,160);
    });
    await page.waitForTimeout(300);
  }else{
    report.thumbnailButtonUnavailable=true;
  }

  // Refresh native repost permission immediately before submission. The scheduler
  // and Filo's own upload-limit response determine the next eligible opportunity.
  if (typeof beforeSubmit === 'function') await beforeSubmit();

  let publishPayload = null;
  let thumbnailGuardBlocked = false;
  let resolveThumbnailGuardBlock;
  const thumbnailGuardBlockPromise=new Promise(resolve=>{resolveThumbnailGuardBlock=resolve;});
  await page.route('**/api/v1/video/publish', async route => {
    const request = route.request();
    const params = new URLSearchParams(request.postData() || '');
    const postedFrame = params.get('selectedFrame') || '';
    const preferredSourceFrame = thumbnailSelection.coverFrameDataUrl || postedFrame;
    let coverComposition = await composeFiloCoverDataUrl(page,preferredSourceFrame);
    if(!coverComposition.ok&&postedFrame&&postedFrame!==preferredSourceFrame){
      coverComposition=await composeFiloCoverDataUrl(page,postedFrame);
    }
    let selectedFrame=coverComposition.ok
      ?coverComposition.dataUrl
      :(preferredSourceFrame&&preferredSourceFrame.startsWith('data:image/')
        ?preferredSourceFrame:postedFrame);
    if(!coverComposition.ok){
      const nativeDimensions=imageDimensionsFromDataUrl(postedFrame);
      const nativeAspect=nativeDimensions?nativeDimensions.width/nativeDimensions.height:0;
      if(nativeDimensions&&Math.abs(nativeAspect-(16/9))<=0.02){
        selectedFrame=postedFrame;
        coverComposition={ok:true,strategy:'native_16_9_frame_fallback',reason:coverComposition.reason||null,
          sourceDimensions:nativeDimensions,dimensions:nativeDimensions,aspectRatio:nativeAspect};
      }
    }
    if(selectedFrame)params.set('selectedFrame',selectedFrame);
    else params.delete('selectedFrame');
    const coverDimensions = imageDimensionsFromDataUrl(selectedFrame);
    const coverAspectRatio = coverDimensions ? coverDimensions.width / coverDimensions.height : 0;
    const coverAspectOk = Boolean(coverDimensions && Math.abs(coverAspectRatio - (16 / 9)) <= 0.02);
    const republishFrom = params.get('republishFrom') || '';
    const videoCode = params.get('videoCode') || '';
    const isMadeByMe = params.get('isMadeByMe');
    const canRepublish = params.get('canRepublish');
    const canMakeMoney = params.get('canMakeMoney');
    const dontPublish = params.get('dontPublish');
    const outgoingTitle = params.get('title') || '';
    const outgoingDescription = params.get('description') || '';
    const outgoingTitleComparable = normalizeComparable(outgoingTitle);
    const outgoingDescriptionComparable = normalizeComparable(outgoingDescription);
    const sourceTitleComparable = normalizeComparable(repostMetadata.sourceTitle);
    const sourceDescriptionComparable = normalizeComparable(repostMetadata.sourceDescription);
    const metadataRisk = policyTextRiskReason({ title: outgoingTitle, description: outgoingDescription });
    const hasExternalLink = /(?:https?:\/\/|www\.)/i.test(outgoingTitle + ' ' + outgoingDescription);
    const metadataOk = outgoingTitle.length >= 5 && outgoingTitle.length <= 180 &&
      outgoingDescription.length <= 1100 && !metadataRisk && !hasExternalLink;
    const frameOk = selectedFrame.startsWith('data:image/') && selectedFrame.length > 1000;
    const guardFailures = buildNativePublishGuardFailures({
      sourceCode:code,republishFrom,videoCode,isMadeByMe,canRepublish,canMakeMoney,dontPublish,metadataOk
    });
    const requestOk = guardFailures.length === 0;

    publishPayload = {
      sourceCode: republishFrom,
      newVideoCode: videoCode,
      title: outgoingTitle.slice(0, 180),
      category: params.get('category') || '',
      selectedFramePresent: frameOk,
      coverStatus: !frameOk ? 'cover_omitted_optional'
        : coverAspectOk ? 'cover_ready_16_9' : 'video_frame_fallback_non_16_9',
      selectedFrameLength: selectedFrame.length,
      selectedFrameType: selectedFrame.slice(0, 40),
      coverSourceDimensions: coverComposition.sourceDimensions || null,
      coverDimensions,
      coverAspectRatio: coverAspectRatio || null,
      coverAspectOk,
      coverComposition: {
        ok: Boolean(coverComposition.ok),
        strategy: coverComposition.strategy || null,
        reason: coverComposition.reason || null,
        encodedLength: coverComposition.encodedLength || null
      },
      guardFailures,
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
      resolveThumbnailGuardBlock();
      await route.abort('blockedbyclient').catch(() => {});
      return;
    }
    await route.continue({postData:params.toString()});
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
  const publishOutcome=await Promise.race([
    responsePromise.then(response=>({response})),
    thumbnailGuardBlockPromise.then(()=>({blocked:true}))
  ]);
  await page.waitForTimeout(1200);

  if (publishOutcome.blocked || thumbnailGuardBlocked || !publishPayload || !publishPayload.guardPassed) {
    return {
      status: 'blocked_before_filo_submission',
      reason: 'native_republish_payload_failed_safety_guard',
      publishPayload
    };
  }
  const publishResponse=publishOutcome.response;
  if (!publishResponse) {
    return buildUnconfirmedSubmissionResult({
      sourceCode:code,
      newVideoCode:publishPayload.newVideoCode,
      publishPayload,
      repostTitle:repostMetadata.title,
      repostDescription:repostMetadata.description,
      reason:'publish_response_not_observed'
    });
  }

  const responseText=await publishResponse.text().catch(()=>'');
  const responseBody=parseJson(responseText);
  const httpStatus=publishResponse.status();
  if(httpStatus>=500){
    return buildUnconfirmedSubmissionResult({
      sourceCode:code,newVideoCode:publishPayload.newVideoCode,publishPayload,
      repostTitle:repostMetadata.title,repostDescription:repostMetadata.description,
      reason:'filo_server_error_after_publish_submission',httpStatus,
      responseDiagnostics:{bodyKeys:responseBody&&typeof responseBody==='object'?Object.keys(responseBody).slice(0,30):[],
        r:responseBody&&safeApiDiagnosticValue(responseBody.r),
        message:responseBody&&safeApiDiagnosticValue(responseBody.message)}
    });
  }
  if([401,403,408,425,429].includes(httpStatus)){
    return {
      status:'retryable_filo_failure',
      reason:String(responseBody&&(responseBody.r||responseBody.message)||('filo_http_'+httpStatus)).slice(0,500),
      httpStatus,
      responseDiagnostics:{bodyKeys:responseBody&&typeof responseBody==='object'?Object.keys(responseBody).slice(0,30):[],
        r:responseBody&&safeApiDiagnosticValue(responseBody.r),
        message:responseBody&&safeApiDiagnosticValue(responseBody.message)},
      publishPayload
    };
  }
  if (httpStatus>=400 || !responseBody || !isFlag(responseBody.s)) {
    const diagnostics={};
    if(responseBody&&typeof responseBody==='object'){
      diagnostics.bodyKeys=Object.keys(responseBody).slice(0,30);
      for(const key of ['s','r','message','error','errors','reason','code','status','field','fields','detail','details']){
        if(Object.prototype.hasOwnProperty.call(responseBody,key))
          diagnostics[key]=safeApiDiagnosticValue(responseBody[key]);
      }
      if(responseBody.d&&typeof responseBody.d==='object')
        diagnostics.dataKeys=Object.keys(responseBody.d).slice(0,20);
    }else{
      diagnostics.bodyPreview=String(responseText||'').replace(/[\r\n]+/g,' ').slice(0,600);
    }
    const responseHeaders=await publishResponse.allHeaders().catch(()=>({}));
    diagnostics.contentType=responseHeaders['content-type']||null;
    diagnostics.httpStatusText=publishResponse.statusText();
    diagnostics.uiErrors=await page.locator('[role="alert"], .alert, .toast, .toast-message, .invalid-feedback')
      .evaluateAll(nodes=>nodes.map(node=>String(node.innerText||node.textContent||'').replace(/\s+/g,' ').trim().slice(0,180)).filter(Boolean).slice(0,8))
      .catch(()=>[]);
    return {
      status: 'rejected_by_filo',
      reason: String(responseBody && (responseBody.r || responseBody.message) || 'filo_publish_not_accepted').slice(0, 500),
      httpStatus: publishResponse.status(),
      responseDiagnostics:diagnostics,
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
  ).sort((a,b)=>Date.parse(b.submittedAt||'')-Date.parse(a.submittedAt||'')).slice(0,1);
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


async function main() {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const state = loadState();
  const report = {
    createdAt: new Date().toISOString(),
    status: 'started',
    discovery: {
      categories: CATEGORY_IDS,
      paginationMode: 'adaptive_recent_window',
      lookbackHours: CATEGORY_LOOKBACK_HOURS,
      minPagesPerCategory: MIN_PAGES_PER_CATEGORY,
      maxPagesPerCategory: MAX_PAGES_PER_CATEGORY,
      maxTotalCategoryPageRequests: MAX_TOTAL_CATEGORY_PAGE_REQUESTS,
      categoryPageConcurrency: CATEGORY_PAGE_CONCURRENCY,
      categoryScanBudgetMs: CATEGORY_SCAN_BUDGET_MS,
      categoryCatalogSource: 'not_loaded',
      categoryCatalogCount: 0,
      categoryCatalogError: null,
      categoryPagesAttempted: 0,
      categoryScan: [],
      categoryCoverage: null,
      categoryScanElapsedMs: 0,
      paginationStopReason: null,
      scannedItems: 0,
      eligibleFeedItems: 0,
      measuredCandidates: 0,
      duplicateTopicsSkipped: [],
      errors: []
    },
    selected: null,
    result: null
  };
  let browser;

  try {
    state.lastCycleStartedAt = report.createdAt;
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');

    if (dailyCount(state) >= MAX_PUBLICATIONS_PER_24H) {
      report.status = 'daily_publication_cap_reached';
      report.dailyCount = dailyCount(state);
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
    report.reconciliation = await reconcilePreviouslySubmitted(page, state);
    if (report.reconciliation.changed) {
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
    }
    const categoryCatalog = await discoverCategoryCatalog(page);
    report.discovery.categories = categoryCatalog.ids;
    report.discovery.categoryCatalogSource = categoryCatalog.source;
    report.discovery.categoryCatalogCount = categoryCatalog.catalogIds.length;
    report.discovery.categoryCatalogError = categoryCatalog.error;
    const byCode = new Map();
    const categoryScanStartedAt = Date.now();
    const categoryTrackers = categoryCatalog.ids.map(categoryId => ({
      categoryId,
      pagesFetched: 0,
      scannedItems: 0,
      chronologyVerified: true,
      lastAgeBounds: null,
      newestAgeHours: null,
      oldestAgeHours: null,
      done: false,
      stopReason: null
    }));
    let totalCategoryPageRequests = 0;
    let paginationStopReason = null;

    for (let pageNo = 1; pageNo <= MAX_PAGES_PER_CATEGORY; pageNo++) {
      const pendingTrackers = categoryTrackers.filter(tracker => !tracker.done);
      if (!pendingTrackers.length) break;

      for (let offset = 0; offset < pendingTrackers.length; offset += CATEGORY_PAGE_CONCURRENCY) {
        if (totalCategoryPageRequests >= MAX_TOTAL_CATEGORY_PAGE_REQUESTS) {
          paginationStopReason = 'global_page_request_cap';
          break;
        }
        if (Date.now() - categoryScanStartedAt >= CATEGORY_SCAN_BUDGET_MS) {
          paginationStopReason = 'discovery_time_budget';
          break;
        }

        const remaining = MAX_TOTAL_CATEGORY_PAGE_REQUESTS - totalCategoryPageRequests;
        const batch = pendingTrackers.slice(offset, offset + Math.min(CATEGORY_PAGE_CONCURRENCY, remaining));
        if (!batch.length) {
          paginationStopReason = 'global_page_request_cap';
          break;
        }

        totalCategoryPageRequests += batch.length;
        report.discovery.categoryPagesAttempted = totalCategoryPageRequests;
        const results = await Promise.all(batch.map(async tracker => {
          try {
            return {
              tracker,
              items: await fetchCategoryPage(page, tracker.categoryId, pageNo),
              error: null
            };
          } catch (error) {
            return {
              tracker,
              items: null,
              error: String(error && error.message || error).slice(0, 240)
            };
          }
        }));

        for (const result of results) {
          const tracker = result.tracker;
          if (result.error) {
            tracker.done = true;
            tracker.stopReason = 'page_error';
            report.discovery.errors.push({
              categoryId: tracker.categoryId,
              pageNo,
              error: result.error
            });
            continue;
          }

          const items = result.items || [];
          const pageAnalysis = analyzeCategoryFeedPage(items, Date.parse(report.createdAt));
          const boundaryOrdered = tracker.pagesFetched === 0
            ? true
            : categoryFeedBoundaryOrdered(tracker.lastAgeBounds, pageAnalysis.firstAgeBounds);
          const chronologyVerified = tracker.chronologyVerified &&
            pageAnalysis.chronologyConsistent &&
            boundaryOrdered;

          report.discovery.scannedItems += items.length;
          tracker.scannedItems += items.length;
          tracker.pagesFetched += 1;
          tracker.chronologyVerified = chronologyVerified;

          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (item.category_id === undefined || item.category_id === null) item.category_id = tracker.categoryId;
            const code = String(item.video_code || item.videoCode || item.code || '');
            if (!code) continue;
            const existing = byCode.get(code);
            const candidate = { ...item, video_code: code };
            if (!existing || num(candidate.visit_count) + num(candidate.play_count) >
                num(existing.visit_count) + num(existing.play_count)) byCode.set(code, candidate);
          }

          if (pageAnalysis.newestAgeHours !== null) {
            tracker.newestAgeHours = tracker.newestAgeHours === null
              ? pageAnalysis.newestAgeHours : Math.min(tracker.newestAgeHours, pageAnalysis.newestAgeHours);
          }
          if (pageAnalysis.oldestAgeHours !== null) {
            tracker.oldestAgeHours = tracker.oldestAgeHours === null
              ? pageAnalysis.oldestAgeHours : Math.max(tracker.oldestAgeHours, pageAnalysis.oldestAgeHours);
          }

          if (!items.length) {
            tracker.done = true;
            tracker.stopReason = 'empty_page';
          } else if (shouldStopCategoryPagination({
            pageCount: tracker.pagesFetched,
            pageAnalysis,
            chronologyVerified,
            lookbackHours: CATEGORY_LOOKBACK_HOURS
          })) {
            tracker.done = true;
            tracker.stopReason = 'lookback_window_reached';
          } else if (pageNo === MAX_PAGES_PER_CATEGORY) {
            tracker.done = true;
            tracker.stopReason = 'max_pages_per_category';
          }

          tracker.lastAgeBounds = pageAnalysis.lastAgeBounds;
        }

        if (paginationStopReason) break;
      }
      if (paginationStopReason) break;
    }

    if (paginationStopReason) {
      for (const tracker of categoryTrackers) {
        if (!tracker.done) {
          tracker.done = true;
          tracker.stopReason = paginationStopReason;
        }
      }
    } else {
      for (const tracker of categoryTrackers) {
        if (!tracker.done) {
          tracker.done = true;
          tracker.stopReason = 'max_pages_per_category';
        }
      }
    }

    report.discovery.categoryScanElapsedMs = Date.now() - categoryScanStartedAt;
    report.discovery.paginationStopReason = paginationStopReason;
    report.discovery.categoryScan = categoryTrackers.map(tracker => ({
      categoryId: tracker.categoryId,
      pagesFetched: tracker.pagesFetched,
      scannedItems: tracker.scannedItems,
      newestAgeHours: tracker.newestAgeHours,
      oldestAgeHours: tracker.oldestAgeHours,
      chronologyVerified: tracker.chronologyVerified,
      stopReason: tracker.stopReason,
      coverageComplete: ['empty_page', 'lookback_window_reached'].includes(tracker.stopReason)
    }));
    report.discovery.categoryCoverage = {
      categoriesTotal: categoryTrackers.length,
      categoriesWithFirstPage: categoryTrackers.filter(tracker => tracker.pagesFetched >= 1).length,
      categoriesWithBaselineDepth: categoryTrackers.filter(tracker =>
        tracker.pagesFetched >= MIN_PAGES_PER_CATEGORY ||
        ['empty_page', 'lookback_window_reached'].includes(tracker.stopReason)
      ).length,
      categoriesPastLookback: categoryTrackers.filter(tracker => tracker.stopReason === 'lookback_window_reached').length,
      categoriesExhausted: categoryTrackers.filter(tracker => tracker.stopReason === 'empty_page').length,
      categoriesAtPageCap: categoryTrackers.filter(tracker => tracker.stopReason === 'max_pages_per_category').length,
      categoriesWithPageErrors: categoryTrackers.filter(tracker => tracker.stopReason === 'page_error').length,
      categoriesLimitedByGlobalCap: categoryTrackers.filter(tracker => tracker.stopReason === 'global_page_request_cap').length,
      categoriesLimitedByTimeBudget: categoryTrackers.filter(tracker => tracker.stopReason === 'discovery_time_budget').length,
      complete24HourCoverage: categoryTrackers.every(tracker =>
        ['empty_page', 'lookback_window_reached'].includes(tracker.stopReason)
      )
    };

    const feedCandidates = [...byCode.values()].filter(item => feedCandidateEligible(item, state));
    report.discovery.eligibleFeedItems = feedCandidates.length;

    const ranked = rankCandidatesByMomentum(feedCandidates, state, Date.parse(report.createdAt));
    report.discovery.measuredCandidates = ranked.length;
    report.discovery.topMomentum = ranked.slice(0, 5).map(entry => ({
      code: String(entry.item.video_code),
      viewsPerMinute: entry.momentum.viewsPerMinute,
      accelerationPerMinute: entry.momentum.accelerationPerMinute || 0,
      ageHours: entry.ageHours
    }));
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');

    if (!ranked.length) {
      report.status = 'waiting_for_measured_view_growth';
      report.result = {
        status: report.status,
        reason: 'no_fresh_candidate_has_positive_measured_view_growth_yet',
        retryOnNextScheduledRun: true
      };
      return;
    }

    let selected = null;
    let result = null;
    const checked = [];
    const filoRejections = [];
    const MAX_CONFIRMED_FILO_REJECTIONS_PER_CYCLE = 3;
    for (const entry of ranked.slice(0, MAX_DETAIL_CHECKS)) {
      const code = entry.item.video_code;
      const detail = await getRepublishDetail(page, code).catch(() => null);
      const gate = detail ? detailGate(detail.root, detail.video) : { eligible: false, reason: 'republish_detail_unavailable' };
      const check = { code, viewsPerMinute: entry.momentum.viewsPerMinute, ageHours: entry.ageHours, gate: gate.reason };
      checked.push(check);
      if (!gate.eligible) continue;

      let candidateMetadata;
      try {
        candidateMetadata = createRepostMetadata(detail.video, code);
      } catch (error) {
        check.gate = 'metadata_not_compliant';
        check.metadataError = String(error && error.message || error).slice(0, 160);
        continue;
      }

      const duplicateTopic = topicDuplicateMatch(state, candidateMetadata.title, Date.parse(report.createdAt));
      if (duplicateTopic.duplicate) {
        check.gate = 'recent_topic_duplicate';
        check.duplicateTopic = duplicateTopic;
        report.discovery.duplicateTopicsSkipped.push({
          sourceCode: code,
          title: candidateMetadata.title,
          matchedTitle: duplicateTopic.matchedTitle,
          matchedSourceCode: duplicateTopic.matchedSourceCode
        });
        continue;
      }

      const candidate = { ...entry.item, editorialScore: entry.momentum.viewsPerMinute, scoreDetails: entry.momentum, momentum: entry.momentum, ageHours: entry.ageHours, detail };
      let attemptResult;
      try {
        attemptResult = await prepareAndPublish(page, candidate, candidate.detail, report, async () => {
          const latestDetail = await getRepublishDetail(page, candidate.video_code).catch(() => null);
          const latestGate = latestDetail
            ? detailGate(latestDetail.root, latestDetail.video)
            : { eligible: false, reason: 'republish_detail_unavailable_before_submission' };
          if (!latestGate.eligible) {
            throw new Error('filo_permission_gate_changed_before_submission:' + latestGate.reason);
          }
          const latestMetadata = createRepostMetadata(latestDetail.video, candidate.video_code);
          const selectedMetadata = createRepostMetadata(candidate.detail.video, candidate.video_code);
          if (normalizeComparable(latestMetadata.title) !== normalizeComparable(selectedMetadata.title) ||
              normalizeComparable(latestMetadata.description) !== normalizeComparable(selectedMetadata.description)) {
            throw new Error('source_metadata_changed_before_submission');
          }
        });
      } catch (error) {
        const reason = String(error && error.message || error).slice(0, 220);
        check.publishError = reason;
        if (reason.startsWith('filo_permission_gate_changed_before_submission:') ||
            reason === 'source_metadata_changed_before_submission') {
          check.gate = 'permission_or_source_metadata_changed_before_submission';
          continue;
        }
        throw error;
      }

      if(isCandidateLevelFiloRejection(attemptResult)){
        const rejection={
          sourceCode:candidate.video_code,
          score:candidate.editorialScore,
          reason:attemptResult.reason||'filo_publish_not_accepted',
          httpStatus:attemptResult.httpStatus,
          responseDiagnostics:attemptResult.responseDiagnostics||null,
          attemptedAt:new Date().toISOString()
        };
        filoRejections.push(rejection);
        check.publishAttempt='rejected_by_filo_candidate_level';
        check.filoHttpStatus=attemptResult.httpStatus;
        check.filoReason=rejection.reason;
        if(filoRejections.length>=MAX_CONFIRMED_FILO_REJECTIONS_PER_CYCLE)break;
        continue;
      }

      selected = candidate;
      result = attemptResult;
      break;
    }
    report.discovery.detailChecks = checked;
    report.discovery.filoRejections = filoRejections;
    for(const rejected of filoRejections){
      state.posts.push({
        sourceCode:rejected.sourceCode,
        status:'rejected_by_filo',
        reason:rejected.reason,
        httpStatus:rejected.httpStatus,
        responseDiagnostics:rejected.responseDiagnostics,
        attemptedAt:rejected.attemptedAt
      });
    }
    if(filoRejections.length){
      state.posts=state.posts.slice(-1200);
      state.updatedAt=new Date().toISOString();
      fs.writeFileSync(STATE_PATH,JSON.stringify(state,null,2)+'\n','utf8');
    }
    if (!selected) {
      report.status = 'no_candidate_published_this_cycle';
      report.result = {
        status: report.status,
        reason: filoRejections.length
          ? 'Filo explicitly rejected the checked candidates; the slot was closed safely and will retry on the next scheduled run'
          : 'no_candidate_passed_native_permission_and_metadata_gates',
        filoRejections,
        retryOnNextScheduledRun: true
      };
      return;
    }

    const selectedMetadata = createRepostMetadata(selected.detail.video, selected.video_code);
     report.selected = {
      sourceCode: selected.video_code,
      title: String(selected.detail.video.title || selected.title || '').slice(0, 220),
      repostTitle: selectedMetadata.title,
      categoryId: selected.detail.video.category_id,
      durationSeconds: num(selected.detail.video.duration),
      visits: candidateMetricValue(selected.detail.video, ['visit_count', 'views', 'view_count', 'visits']),
      plays: candidateMetricValue(selected.detail.video, ['play_count', 'plays', 'playCount']),
      viewsPerMinute: selected.momentum.viewsPerMinute,
      accelerationPerMinute: selected.momentum.accelerationPerMinute || 0,
      ageHours: selected.ageHours,
      repostDescriptionLength: selectedMetadata.description.length
    };
    report.result = result;
    report.status = result.status;

    if (['submitted_pending_approval', 'submitted_unconfirmed', 'public_verified'].includes(result.status)) {
      state.posts.push({
        sourceCode: result.sourceCode || selected.video_code,
        sourceTitle: report.selected.title,
        repostTitle: result.repostMetadata && result.repostMetadata.title || selectedMetadata.title,
        repostDescription: result.repostMetadata && result.repostMetadata.description || selectedMetadata.description,
        captionPolicyVersion: CAPTION_POLICY_VERSION,
        categoryId: selected.detail.video.category_id || selected.category_id || null,
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
        categoryId: selected.detail.video.category_id || selected.category_id || null,
        reason: result.reason || '',
        httpStatus: result.httpStatus || null,
        responseDiagnostics: result.responseDiagnostics || null,
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
      categoryPageRequests: report.discovery.categoryPagesAttempted,
      categoryCoverage: report.discovery.categoryCoverage,
      paginationStopReason: report.discovery.paginationStopReason,
      selected: report.selected,
      result: report.result,
      filoRejections: report.discovery.filoRejections || [],
      errors: report.discovery.errors.slice(0, 8),
      error: report.error
    }));
  }

  if (['failed','rejected_by_filo','filo_rejected_candidates_no_success','retryable_filo_failure'].includes(report.status)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error('FILO_NATIVE_REPUBLISH_FATAL', String(error && error.message || error).slice(0, 600));
    process.exitCode = 1;
  });
}

module.exports = {
  login,
  ageHours,
  feedCandidateEligible,
  cleanRepostCaptionTitle,
  cleanRepostDescription,
  policyTextRiskReason,
  imageDimensionsFromDataUrl,
  rankCandidatesByMomentum,
  createRepostMetadata,
  normalizeComparable,
  detailGate,
  buildNativePublishGuardFailures,
  safeApiDiagnosticValue,
  buildUnconfirmedSubmissionResult,
  composeFiloCoverDataUrl,
  dailyCount,
  candidateMetricValue,
  updateCandidateMomentum,
  extractCategoryIds,
  discoverCategoryCatalog,
  reliableFeedAgeBounds,
  analyzeCategoryFeedPage,
  categoryFeedBoundaryOrdered,
  shouldStopCategoryPagination,
  editorialTitleTokens,
  characterBigramDice,
  createDistinctRepostTitle,
  topicDuplicateMatch,
  isCandidateLevelFiloRejection
};
