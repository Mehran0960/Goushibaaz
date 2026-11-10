'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { buildTrendWeights, categoryFor } = require('./quality_rank.cjs');

const BASE = 'https://ifilo.net';
const STATE_PATH = path.join('state', 'filo-native-republished.json');
const REPORT_PATH = path.join('out', 'filo-native-republish.json');
const PLATFORM_TRENDS_PATH = path.join('state', 'platform-trends.json');
const PLATFORM_TRENDS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const FALLBACK_CATEGORY_IDS = [6, 11, 13, 29, 2, 22, 17, 25, 15, 3];
const FALLBACK_VIDEO_TAG_FEEDS = [
  { key: 'all', label: 'همه' },
  { key: 'q-آهنگ', label: 'آهنگ' },
  { key: 'q-آشپزی', label: 'آشپزی' },
  { key: 'q-ورزش', label: 'ورزش' },
  { key: 'q-خلاقیت', label: 'خلاقیت' },
  { key: 'q-مذهبی', label: 'مذهبی' },
  { key: 'q-خبری', label: 'خبری' },
  { key: 'q-تکنولوژی', label: 'تکنولوژی' },
  { key: 'q-بازی', label: 'بازی' },
  { key: 'q-طبیعت', label: 'طبیعت' },
  { key: 'q-فیلم', label: 'فیلم' },
  { key: 'q-سریال', label: 'سریال' },
  { key: 'q-کارتون', label: 'کارتون' },
  { key: 'q-طنز', label: 'طنز' },
  { key: 'q-مستند', label: 'مستند' },
  { key: 'q-آموزش', label: 'آموزش' },
  { key: 'q-سلامت', label: 'سلامت' },
  { key: 'q-سفر', label: 'سفر' },
  { key: 'q-حیوانات', label: 'حیوانات' },
  { key: 'q-خودرو', label: 'خودرو' }
];
const MAX_DISCOVERED_CATEGORY_IDS = 64;
const MAX_PAGES_PER_CATEGORY = 18;
const MAX_TOTAL_CATEGORY_PAGE_REQUESTS = 112;
const CATEGORY_PAGE_CONCURRENCY = 4;
const CATEGORY_SCAN_BUDGET_MS = 4 * 60 * 1000;
const CATEGORY_LOOKBACK_HOURS = 24;
const MIN_CYCLE_INTERVAL_MS = 4 * 60 * 1000;
const DEPTH_CATEGORIES_PER_CYCLE = 21;
const DEPTH_PAGES_PER_CATEGORY_PER_CYCLE = 4;
const TOPIC_DUPLICATE_WINDOW_MS = 48 * 60 * 60 * 1000;
const CANDIDATE_REJECTION_TTL_MS = 6 * 60 * 60 * 1000;
const ACCOUNT_REPUBLISH_QUOTA_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const MIN_PUBLISH_GAP_MS = 20 * 60 * 1000;
const MAX_PUBLICATIONS_PER_ROLLING_HOUR = 3;
const MAX_PUBLICATIONS_PER_24H = 36;
const MAX_DETAIL_CHECKS = 90;
const MIN_DURATION_SECONDS = 10;
const CAPTION_POLICY_VERSION = 8;
const TITLE_REWRITE_POLICY_VERSION = 7;
const FILO_TITLE_MIN_CHARS = 5;
const FILO_TITLE_MAX_CHARS = 80;
const FILO_DESCRIPTION_MIN_CHARS = 30;
const CANDIDATE_METRIC_HISTORY_TTL_MS = 60 * 60 * 1000;
const CANDIDATE_METRIC_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const CANDIDATE_METRIC_HISTORY_SAMPLES = 8;
const CANDIDATE_METRIC_RATE_WINDOW_SAMPLES = 6;
const CANDIDATE_CATALOG_24H_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_CANDIDATE_METRICS = 5000;
const MAX_TRACKED_24H_CANDIDATES = 5000;
const MIN_ACCELERATION_SAMPLES = 3;

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

function ageHours(item, now = Date.now()) {
  const raw = normalizeDigits(item && (item.create_date || item.styled_create_date || item.created_at) || '');
  const lower = raw.toLowerCase();
  const jalaliTimestamp = jalaliDateToGregorianTimestamp(raw);
  if (jalaliTimestamp !== null) return Math.max(0, (now - jalaliTimestamp) / 3600000);
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
  if (Number.isFinite(absolute)) return Math.max(0, (now - absolute) / 3600000);
  return 36;
}


function shouldStartPublishingCycle(lastStartedAt, now = Date.now(), minIntervalMs = MIN_CYCLE_INTERVAL_MS) {
  const previous = Date.parse(lastStartedAt || '');
  const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (!Number.isFinite(previous)) return true;
  return current - previous >= Math.max(0, Number(minIntervalMs) || 0);
}

function jalaliDateToGregorianTimestamp(value) {
  const raw = normalizeDigits(String(value || '').trim());
  const match = raw.match(/(?:^|[^\d])(13\d{2}|14\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:[^\d]{0,12}(\d{1,2}):(\d{2})(?::(\d{2}))?)?/u);
  if (!match) return null;
  const jy = Number(match[1]), jm = Number(match[2]), jd = Number(match[3]);
  const hour = Number(match[4] || 0), minute = Number(match[5] || 0), second = Number(match[6] || 0);
  if (jm < 1 || jm > 12 || jd < 1 || jd > 31 || hour > 23 || minute > 59 || second > 59) return null;

  // Jalali (Solar Hijri) to Gregorian conversion. Filo date strings use Tehran local time.
  const y = jy + 1595;
  let days = -355668 + 365 * y + Math.floor(y / 33) * 8 + Math.floor((y % 33 + 3) / 4) + jd;
  days += jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186;
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthDays = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  while (gm <= 12 && gd > monthDays[gm]) {
    gd -= monthDays[gm];
    gm++;
  }
  if (gm > 12) return null;
  const tehranOffsetMs = 210 * 60 * 1000;
  return Date.UTC(gy, gm - 1, gd, hour, minute, second) - tehranOffsetMs;
}

function reliableFeedAgeBounds(item, now = Date.now()) {
  if (!item || typeof item !== 'object') return null;
  const fields = [
    'create_date', 'styled_create_date', 'created_at', 'createdAt', 'created',
    'created_time', 'create_time', 'published_at', 'publish_date', 'post_date', 'date', 'cd'
  ];

  for (const field of fields) {
    const value = item[field];
    if (value === undefined || value === null || value === '') continue;

    if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
      const numeric = Number(value);
      const timestamp = numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : NaN;
      if (Number.isFinite(timestamp)) {
        const centerHours = Math.max(0, (now - timestamp) / 3600000);
        return { centerHours, lowerHours: Math.max(0, centerHours - 1 / 7200), upperHours: centerHours + 1 / 7200, precisionHours: 1 / 3600, chronologyReliable: true };
      }
    }

    const raw = normalizeDigits(value).trim().toLowerCase();
    if (!raw) continue;

    const jalaliTimestamp = jalaliDateToGregorianTimestamp(raw);
    if (jalaliTimestamp !== null) {
      const centerHours = Math.max(0, (now - jalaliTimestamp) / 3600000);
      const hasClock = /(?:^|[^\d])\d{1,2}:\d{2}/u.test(raw);
      const precisionHours = hasClock ? 1 / 60 : 24;
      return {
        centerHours,
        lowerHours: Math.max(0, centerHours - precisionHours / 2),
        upperHours: centerHours + precisionHours / 2,
        precisionHours,
        chronologyReliable: true
      };
    }

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
        precisionHours,
        chronologyReliable: Boolean(hourMatch || minuteMatch)
      };
    }

    if (/لحظاتی پیش|همین الان|اکنون|just now|moments ago/.test(raw)) {
      return { centerHours: 0.1, lowerHours: 0, upperHours: 0.25, precisionHours: 0.25, chronologyReliable: true };
    }
    if (/دیروز|yesterday/.test(raw)) {
      return { centerHours: 36, lowerHours: 24, upperHours: 48, precisionHours: 24, chronologyReliable: false };
    }
    if (/امروز|today/.test(raw)) {
      return { centerHours: 12, lowerHours: 0, upperHours: 24, precisionHours: 24, chronologyReliable: false };
    }

    const absolute = Date.parse(raw);
    if (Number.isFinite(absolute)) {
      const centerHours = Math.max(0, (now - absolute) / 3600000);
      const hasClock = /(?:t|\b)\d{1,2}:\d{2}/i.test(raw);
      const precisionHours = hasClock ? 1 / 60 : 24;
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
  const precisionReliable = ageDataComplete && ages.every(age => age.precisionHours <= 24.01 && age.chronologyReliable !== false);
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
  const previousPrecision = Number(previousLastAge.precisionHours) || 0;
  const currentPrecision = Number(currentFirstAge.precisionHours) || 0;
  if (previousPrecision > 1.1 || currentPrecision > 1.1) {
    // For day-level timestamps, prove the ranges do not overlap; same-day ordering is unknown.
    return Number.isFinite(previousLastAge.upperHours) &&
      Number.isFinite(currentFirstAge.lowerHours) &&
      currentFirstAge.lowerHours >= previousLastAge.upperHours - 0.01;
  }
  const tolerance = Math.max(0.03, (previousPrecision + currentPrecision) * 0.5);
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

function isMetadataValidationRejectionReason(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return /(?:توضیح|شرح).{0,40}(?:بسیار\s+)?(?:کوتاه|کم)|(?:description).{0,30}(?:too\s+short|too\s+brief)|(?:طول\s+عنوان|عنوان).{0,70}(?:کمتر\s+از|بیشتر\s+از|حداکثر|بسیار\s+کم|خیلی\s+کوتاه|بسیار\s+کوتاه|۱۰۰|100)|(?:title).{0,50}(?:too\s+short|100\s+characters|maximum)/iu.test(text);
}

function metadataValidationReasonFromPost(post) {
  if (!post || post.status !== 'rejected_by_filo') return null;
  const diagnostics = post.responseDiagnostics && typeof post.responseDiagnostics === 'object'
    ? post.responseDiagnostics : {};
  const messages = [
    post.reason,
    ...(Array.isArray(diagnostics.uiErrors) ? diagnostics.uiErrors : []),
    diagnostics.detail,
    diagnostics.message
  ];
  return messages.find(isMetadataValidationRejectionReason) || null;
}

function hasRetryableMetadataRejection(ledger, code) {
  const posts = ledger && Array.isArray(ledger.posts) ? ledger.posts : [];
  const sameSource = posts.filter(post => post && post.sourceCode === code);
  if (sameSource.some(post =>
    ['submitted_pending_approval', 'submitted_unconfirmed', 'public_verified'].includes(post.status)
  )) return false;
  const rejectedPosts = sameSource.filter(post => post && post.status === 'rejected_by_filo');
  // A metadata retry is safe only when every rejection for this source is a
  // recognized title/description validation failure. Never let a second,
  // non-metadata rejection be hidden by a metadata-retry exception.
  if (!rejectedPosts.length || rejectedPosts.some(post => !metadataValidationReasonFromPost(post))) return false;
  const metadataRejections = rejectedPosts;
  return !metadataRejections.some(post =>
    post.metadataRetryTitlePolicyVersion === TITLE_REWRITE_POLICY_VERSION &&
    post.metadataRetryCaptionPolicyVersion === CAPTION_POLICY_VERSION
  );
}

function isSourceAlreadyAttempted(ledger, code) {
  const posts = ledger && Array.isArray(ledger.posts) ? ledger.posts : [];
  const sameSource = posts.filter(post => post && post.sourceCode === code);
  if (sameSource.some(post =>
    ['submitted_pending_approval', 'submitted_unconfirmed', 'public_verified'].includes(post.status)
  )) return true;
  if (sameSource.some(post => post.status === 'rejected_by_filo')) {
    return !hasRetryableMetadataRejection(ledger, code);
  }
  return false;
}

function markMetadataPolicyRetry(ledger, code, now = Date.now()) {
  if (!hasRetryableMetadataRejection(ledger, code)) return false;
  const posts = ledger && Array.isArray(ledger.posts) ? ledger.posts : [];
  const target = [...posts].reverse().find(post =>
    post && post.sourceCode === code && metadataValidationReasonFromPost(post) &&
    post.metadataRetryTitlePolicyVersion !== TITLE_REWRITE_POLICY_VERSION
  );
  if (!target) return false;
  target.metadataRetryTitlePolicyVersion = TITLE_REWRITE_POLICY_VERSION;
  target.metadataRetryCaptionPolicyVersion = CAPTION_POLICY_VERSION;
  target.metadataRetryAt = new Date(Number(now) || Date.now()).toISOString();
  return true;
}

function feedCandidateEligible(item, ledger) {
  if (!item || typeof item !== 'object') return false;
  const code = String(item.video_code || item.videoCode || item.code || '').trim();
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) return false;
  if (isSourceAlreadyAttempted(ledger, code)) return false;
  if (policyTextRiskReason(item)) return false;

  // Feed flags are hints, not authorization. Every candidate still passes
  // detailGate() and the immediate pre-submission permission recheck.
  return true;
}

function feedGateHintScore(item) {
  const fields = ['can_republish', 'is_publish_able', 'active', 'has_audio', 'can_make_money'];
  let score = 0;
  for (const field of fields) {
    if (item && item[field] !== undefined && item[field] !== null) {
      score += isFlag(item[field]) ? 2 : -2;
    }
  }
  if (item && item.status_id !== undefined && item.status_id !== null) {
    score += num(item.status_id) === 1 ? 1 : -2;
  }
  if (item && item.duration !== undefined && item.duration !== null) {
    const duration = num(item.duration, -1);
    score += duration >= MIN_DURATION_SECONDS ? 1 : -1;
  }
  if (isFlag(item && item.file_deleted)) score -= 4;
  if (num(item && item.only_in_filo) === 1) score -= 4;
  return score;
}

function summarizeFeedGateSignals(items, ledger) {
  const fields = ['can_republish', 'is_publish_able', 'active', 'has_audio', 'can_make_money'];
  const summary = {
    totalItems: Array.isArray(items) ? items.length : 0,
    flags: Object.fromEntries(fields.map(field => [field, { true: 0, false: 0, missing: 0 }])),
    duration: { meetsMinimum: 0, belowMinimum: 0, missing: 0 },
    status: { publishable: 0, other: 0, missing: 0 },
    hardPrefilter: { invalidCode: 0, duplicateOrAlreadyAttempted: 0, metadataPolicyRetryEligible: 0, sparseText: 0, policyRisk: 0, passed: 0 }
  };
  for (const item of Array.isArray(items) ? items : []) {
    for (const field of fields) {
      const value = item && item[field];
      if (value === undefined || value === null || value === '') summary.flags[field].missing++;
      else if (isFlag(value)) summary.flags[field].true++;
      else summary.flags[field].false++;
    }
    const duration = item && item.duration;
    if (duration === undefined || duration === null || duration === '') summary.duration.missing++;
    else {
      const value = num(duration, -1);
      if (value >= MIN_DURATION_SECONDS) summary.duration.meetsMinimum++;
      else summary.duration.belowMinimum++;
    }
    if (!item || item.status_id === undefined || item.status_id === null || item.status_id === '') {
      summary.status.missing++;
    } else if (num(item.status_id) === 1) summary.status.publishable++;
    else summary.status.other++;

    const code = String(item && (item.video_code || item.videoCode || item.code) || '').trim();
    if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) summary.hardPrefilter.invalidCode++;
    else {
      const ledgerDuplicate = isSourceAlreadyAttempted(ledger, code);
      if (ledgerDuplicate) summary.hardPrefilter.duplicateOrAlreadyAttempted++;
      else if (hasRetryableMetadataRejection(ledger, code)) summary.hardPrefilter.metadataPolicyRetryEligible++;
      else {
        if (sourceText(item).length < 8) summary.hardPrefilter.sparseText++;
        if (policyTextRiskReason(item)) summary.hardPrefilter.policyRisk++;
        else summary.hardPrefilter.passed++;
      }
    }
  }
  return summary;
}

function summarizeCandidateChecks(checked) {
  const reasonCounts = {};
  const detailFetchErrors = {};
  let metadataFailures = 0;
  let cachedRejections = 0;
  for (const item of Array.isArray(checked) ? checked : []) {
    const reason = String(item && (item.metadataError || item.publishError || item.gate) || 'unknown');
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    if (item && item.metadataError) metadataFailures++;
    if (item && item.gate === 'cached_candidate_rejection') cachedRejections++;
    if (item && item.detailFetchError) {
      detailFetchErrors[item.detailFetchError] = (detailFetchErrors[item.detailFetchError] || 0) + 1;
    }
  }
  return { total: Array.isArray(checked) ? checked.length : 0, reasonCounts, detailFetchErrors, metadataFailures, cachedRejections };
}

function candidateMetricSnapshot(item, keys) {
  const values = keys.map(key => ({ key, raw: item && item[key] }))
    .filter(entry => entry.raw !== undefined && entry.raw !== null && entry.raw !== '')
    .map(entry => ({ key: entry.key, value: num(entry.raw, -1) }))
    .filter(entry => entry.value >= 0);
  if (!values.length) return { value: 0, available: false, field: null };
  const selected = values.reduce((best, entry) => entry.value > best.value ? entry : best);
  return { value: selected.value, available: true, field: selected.key };
}

function candidateMetricValue(item, keys) {
  return candidateMetricSnapshot(item, keys).value;
}

function update24HourCandidateCatalog(state, items, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const catalog = state.candidateCatalog24h && typeof state.candidateCatalog24h === 'object'
    ? state.candidateCatalog24h : {};
  const nowIso = new Date(nowMs).toISOString();
  const currentSampleFor = item => {
    const viewMetric = candidateMetricSnapshot(item, ['visit_count', 'view_count', 'views', 'visits']);
    const playMetric = candidateMetricSnapshot(item, ['play_count', 'plays', 'playCount']);
    return {
      at: nowIso,
      views: viewMetric.value,
      viewsAvailable: viewMetric.available,
      plays: playMetric.value,
      playsAvailable: playMetric.available
    };
  };
  let observedThisCycle = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const code = String(item && (item.video_code || item.videoCode || item.code) || '').trim();
    if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) continue;
    const publishedAgeHours = ageHours(item, nowMs);
    if (!Number.isFinite(publishedAgeHours) || publishedAgeHours < 0 || publishedAgeHours > 24) continue;

    const previous = catalog[code] && typeof catalog[code] === 'object' ? catalog[code] : {};
    const currentSample = currentSampleFor(item);
    const previousLatestAt = Date.parse(previous.latestSample && previous.latestSample.at || '');
    const firstSampleAt = Date.parse(previous.firstSample && previous.firstSample.at || '');
    const keepPreviousBaseline = Number.isFinite(firstSampleAt) &&
      nowMs - firstSampleAt >= 0 && nowMs - firstSampleAt <= CANDIDATE_CATALOG_24H_TTL_MS;
    const firstSample = keepPreviousBaseline ? previous.firstSample : currentSample;
    const observations = Number.isFinite(previousLatestAt) &&
      nowMs - previousLatestAt >= CANDIDATE_METRIC_SAMPLE_INTERVAL_MS
      ? Math.max(1, Math.trunc(num(previous.observations, 1)) + 1)
      : Math.max(1, Math.trunc(num(previous.observations, 0)) || 1);

    catalog[code] = {
      firstSeenAt: previous.firstSeenAt || nowIso,
      lastSeenAt: nowIso,
      publishedAgeHours,
      title: String(item && item.title || previous.title || '').slice(0, 180),
      categoryId: item && (item.feed_tag || item.category_id) != null
        ? String(item.feed_tag || item.category_id) : previous.categoryId || null,
      categoryLabel: String(item && (item.feed_tag_label || item.category_name || item.category_title) ||
        previous.categoryLabel || '').slice(0, 80),
      firstSample,
      latestSample: currentSample,
      observations,
      hasViewCounter: currentSample.viewsAvailable || previous.hasViewCounter === true,
      hasPlayCounter: currentSample.playsAvailable || previous.hasPlayCounter === true
    };
    observedThisCycle++;
  }

  const retained = Object.entries(catalog)
    .filter(([, entry]) => {
      const seenAt = Date.parse(entry && entry.lastSeenAt || '');
      const lastSeenAgeMs = nowMs - seenAt;
      const ageAtLastSeen = num(entry && entry.publishedAgeHours, 25);
      const estimatedPublishedAgeHours = ageAtLastSeen +
        (Number.isFinite(lastSeenAgeMs) && lastSeenAgeMs > 0 ? lastSeenAgeMs / 3600000 : 0);
      return Number.isFinite(seenAt) && lastSeenAgeMs >= 0 &&
        lastSeenAgeMs <= CANDIDATE_CATALOG_24H_TTL_MS &&
        estimatedPublishedAgeHours <= 24;
    })
    .sort((a, b) => String(b[1].lastSeenAt || '').localeCompare(String(a[1].lastSeenAt || '')))
    .slice(0, MAX_TRACKED_24H_CANDIDATES);
  state.candidateCatalog24h = Object.fromEntries(retained);

  const entries = retained.map(([code, entry]) => {
    const first = entry.firstSample || null;
    const latest = entry.latestSample || null;
    const viewsDelta = first && latest && first.viewsAvailable === true &&
      latest.viewsAvailable === true ? num(latest.views) - num(first.views) : null;
    const playsDelta = first && latest && first.playsAvailable === true &&
      latest.playsAvailable === true ? num(latest.plays) - num(first.plays) : null;
    const sampleWindowHours = first && latest
      ? Math.max(0, (Date.parse(latest.at) - Date.parse(first.at)) / 3600000) : 0;
    return {
      code,
      title: entry.title,
      categoryLabel: entry.categoryLabel,
      sampleCount: Math.trunc(num(entry.observations, 1)),
      sampleWindowHours: Math.round(sampleWindowHours * 100) / 100,
      viewsDelta,
      playsDelta,
      hasViewCounter: entry.hasViewCounter === true,
      hasPlayCounter: entry.hasPlayCounter === true
    };
  });

  const withBaseline = entries.filter(entry => entry.sampleCount >= 2 && entry.sampleWindowHours > 0);
  const positivePlayGrowth = withBaseline.filter(entry => entry.playsDelta !== null && entry.playsDelta > 0);
  const positiveViewGrowth = withBaseline.filter(entry => entry.viewsDelta !== null && entry.viewsDelta > 0);
  const categoryCounts = {};
  for (const entry of retained.map(([, value]) => value)) {
    const label = entry.categoryLabel || 'نامشخص';
    categoryCounts[label] = (categoryCounts[label] || 0) + 1;
  }

  return {
    windowHours: 24,
    uniqueVideos: retained.length,
    observedThisCycle,
    withPlayCounter: entries.filter(entry => entry.hasPlayCounter).length,
    withViewCounter: entries.filter(entry => entry.hasViewCounter).length,
    withComparableBaseline: withBaseline.length,
    positiveObservedWindowPlayGrowth: positivePlayGrowth.length,
    positiveObservedWindowViewGrowth: positiveViewGrowth.length,
    topObservedGrowth: [...entries]
      .sort((a, b) => (b.playsDelta ?? -1) - (a.playsDelta ?? -1) ||
        (b.viewsDelta ?? -1) - (a.viewsDelta ?? -1))
      .slice(0, 10),
    topCategories: Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([category, videoCount]) => ({ category, videoCount })),
    coverageComplete: null
  };
}

function trailingMetricRate(samples, valueKey, availableKey) {
  const valid = (Array.isArray(samples) ? samples : [])
    .filter(sample => sample && sample[availableKey] === true &&
      sample[valueKey] !== undefined && sample[valueKey] !== null &&
      Number.isFinite(Number(sample[valueKey])) &&
      Number.isFinite(Date.parse(sample.at)))
    .slice(-CANDIDATE_METRIC_RATE_WINDOW_SAMPLES);
  if (valid.length < 2) return { ratePerMinute: null, sampleCount: valid.length, windowMinutes: 0 };

  // Counter resets can occur after backend refreshes. Start a new baseline
  // after a decrease instead of interpreting the reset as negative growth.
  let monotonic = [valid[0]];
  for (const sample of valid.slice(1)) {
    const previous = monotonic.at(-1);
    if (num(sample[valueKey]) < num(previous[valueKey])) monotonic = [sample];
    else monotonic.push(sample);
  }
  if (monotonic.length < 2) {
    return { ratePerMinute: null, sampleCount: monotonic.length, windowMinutes: 0 };
  }

  const firstAt = Date.parse(monotonic[0].at);
  const xValues = monotonic.map(sample => (Date.parse(sample.at) - firstAt) / 60000);
  const yValues = monotonic.map(sample => num(sample[valueKey]));
  const meanX = xValues.reduce((sum, value) => sum + value, 0) / xValues.length;
  const meanY = yValues.reduce((sum, value) => sum + value, 0) / yValues.length;
  const denominator = xValues.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  if (!(denominator > 0)) {
    return { ratePerMinute: null, sampleCount: monotonic.length, windowMinutes: 0 };
  }
  const numerator = xValues.reduce((sum, value, index) =>
    sum + (value - meanX) * (yValues[index] - meanY), 0);
  const windowMinutes = xValues.at(-1) - xValues[0];
  return {
    ratePerMinute: Math.max(0, numerator / denominator),
    sampleCount: monotonic.length,
    windowMinutes
  };
}

function updateCandidateMomentum(state, items, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const history = state.candidateMomentum && typeof state.candidateMomentum === 'object'
    ? state.candidateMomentum : {};
  const observed = {};
  const nowIso = new Date(nowMs).toISOString();

  for (const item of Array.isArray(items) ? items : []) {
    const code = String(item && (item.video_code || item.videoCode || item.code) || '').trim();
    if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) continue;
    const viewMetric = candidateMetricSnapshot(item, ['visit_count', 'view_count', 'views', 'visits']);
    const playMetric = candidateMetricSnapshot(item, ['play_count', 'plays', 'playCount']);
    const entry = history[code] && typeof history[code] === 'object' ? history[code] : {};
    let samples = Array.isArray(entry.samples) ? entry.samples.filter(sample => {
      const at = Date.parse(sample && sample.at || '');
      return Number.isFinite(at) && nowMs - at >= 0 &&
        nowMs - at <= CANDIDATE_METRIC_HISTORY_TTL_MS;
    }).slice(-CANDIDATE_METRIC_HISTORY_SAMPLES) : [];

    const lastSampleAt = samples.length ? Date.parse(samples.at(-1).at) : NaN;
    if (!Number.isFinite(lastSampleAt) ||
        nowMs - lastSampleAt >= CANDIDATE_METRIC_SAMPLE_INTERVAL_MS) {
      samples.push({
        at: nowIso,
        views: viewMetric.value,
        viewsAvailable: viewMetric.available,
        plays: playMetric.value,
        playsAvailable: playMetric.available
      });
      samples = samples.slice(-CANDIDATE_METRIC_HISTORY_SAMPLES);
    }

    const views = trailingMetricRate(samples, 'views', 'viewsAvailable');
    const plays = trailingMetricRate(samples, 'plays', 'playsAvailable');
    const previousRate = entry.lastRate && typeof entry.lastRate === 'object'
      ? entry.lastRate : null;
    const viewsAcceleration = views.ratePerMinute !== null && previousRate &&
      previousRate.viewsPerMinute !== null && previousRate.viewsPerMinute !== undefined
      ? Math.max(0, views.ratePerMinute - Math.max(0, num(previousRate.viewsPerMinute))) : 0;
    const playsAcceleration = plays.ratePerMinute !== null && previousRate &&
      previousRate.playsPerMinute !== null && previousRate.playsPerMinute !== undefined
      ? Math.max(0, plays.ratePerMinute - Math.max(0, num(previousRate.playsPerMinute))) : 0;

    const rate = {
      viewsPerMinute: views.ratePerMinute === null
        ? null : Math.round(views.ratePerMinute * 100) / 100,
      playsPerMinute: plays.ratePerMinute === null
        ? null : Math.round(plays.ratePerMinute * 100) / 100,
      viewsAccelerationPerMinute: Math.round(viewsAcceleration * 100) / 100,
      playsAccelerationPerMinute: Math.round(playsAcceleration * 100) / 100,
      accelerationPerMinute: Math.round(viewsAcceleration * 100) / 100,
      playsAvailable: playMetric.available,
      playCounterPresent: playMetric.available,
      viewsAvailable: viewMetric.available,
      playsSampleCount: plays.sampleCount,
      viewsSampleCount: views.sampleCount,
      sampleCount: samples.length,
      viewsWindowMinutes: Math.round(views.windowMinutes * 100) / 100,
      playsWindowMinutes: Math.round(plays.windowMinutes * 100) / 100
    };

    const nextEntry = { ...entry, samples, lastSeenAt: nowIso, lastRate: { ...rate, at: nowIso } };
    history[code] = nextEntry;
    observed[code] = rate;
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

function classifyAudienceFit(item) {
  const text = [
    item && item.title, item && item.description,
    item && item.category_name, item && item.category_title,
    item && item.category
  ].filter(Boolean).join(' ').toLocaleLowerCase('fa-IR');

  const groups = [
    {
      score: 3,
      label: 'comedy_entertainment',
      pattern: /(?:طنز|خنده|خنده.?دار|بامزه|کمدی|شوخی|سرگرمی|استند.?آپ|دوربین.?مخفی|سوتی|واکنش.?خنده.?دار)/i
    },
    {
      score: 3,
      label: 'practical_tutorial',
      pattern: /(?:ترفند|آموزش|چگونه|روشِ?\s|روش\s|راهنما|کاربردی|نکته.?آموزشی|تعمیر|ساختن?|آشپزی|طرز.?تهیه|طرز.?پخت|دستور.?تهیه|مهارت)/i
    },
    {
      score: 3,
      label: 'celebrity_pop_culture',
      pattern: /(?:سلبریتی|بازیگر|خواننده|هنرمند|مجری|فوتبالیست|چهره.?معروف|ستاره|بهنام.?بانی|بهرام.?افشاری|حواشی.?چهره)/i
    },
    {
      score: 2,
      label: 'secondary_interest',
      pattern: /(?:فوتبال|ورزش|کشتی|بسکتبال|غذا|خوراک|حیوان|طبیعت|جنگل|منظره|حیات.?وحش|سفر|گردشگری|دانستنی|معما|راز|علمی|خودرو|ماشین)/i
    }
  ];
  return groups.find(group => group.pattern.test(text)) || { score: 1, label: 'general' };
}


function candidateTopicKey(item, audienceFit = classifyAudienceFit(item)) {
  const feedTag = String(item && item.feed_tag || '').trim().toLocaleLowerCase('fa-IR');
  if (feedTag && feedTag !== 'all') return 'feed:' + feedTag;
  const categoryId = String(item && item.category_id != null ? item.category_id : '').trim();
  if (categoryId) return 'category:' + categoryId;
  const categoryLabel = String(item && (item.category_name || item.category_title) || '')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase('fa-IR');
  if (categoryLabel) return 'category-label:' + categoryLabel;
  return 'audience:' + audienceFit.label;
}

function durationPreferenceScore(item) {
  const raw = item && item.duration;
  if (raw === undefined || raw === null || raw === '') return 50;
  const duration = num(raw, -1);
  if (duration < MIN_DURATION_SECONDS) return 0;
  if (duration <= 30) return 100;
  if (duration <= 60) return 90;
  if (duration <= 100) return 75;
  if (duration <= 180) return 55;
  if (duration <= 600) return 30;
  return 10;
}

function logScaleScore(value, ceiling) {
  const n = Math.max(0, num(value));
  const cap = Math.max(1, num(ceiling, 1));
  return Math.max(0, Math.min(100, Math.log1p(n) / Math.log1p(cap) * 100));
}

function summarizeTopicDemand(entries) {
  const groups = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = String(entry && entry.topicKey || '');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const result = {};
  for (const [key, group] of groups.entries()) {
    const growing = group.filter(entry => entry.hasPositivePlayGrowth || entry.hasPositiveViewGrowth);
    const velocities = growing.map(entry => entry.hasPositivePlayGrowth
      ? num(entry.momentum.playsPerMinute)
      : num(entry.momentum.viewsPerMinute));
    const accelerations = growing.map(entry => entry.hasPositivePlayGrowth
      ? num(entry.momentum.playsAccelerationPerMinute)
      : num(entry.momentum.viewsAccelerationPerMinute ?? entry.momentum.accelerationPerMinute));
    const averageVelocity = velocities.length
      ? velocities.reduce((sum, value) => sum + value, 0) / velocities.length : 0;
    const averageAcceleration = accelerations.length
      ? accelerations.reduce((sum, value) => sum + value, 0) / accelerations.length : 0;
    const growthShareScore = group.length ? growing.length / group.length * 100 : 0;
    const activityIntensityScore =
      0.6 * logScaleScore(averageVelocity, 20) +
      0.4 * logScaleScore(averageAcceleration, 5);
    const breadthScore = logScaleScore(group.length, 10);
    // A single item cannot establish topic-wide demand. Require corroboration
    // from at least two distinct candidates in the current Filo feed scan.
    const demandScore = group.length < 2 || growing.length < 2 ? 0 :
      Math.round((0.55 * growthShareScore + 0.30 * activityIntensityScore + 0.15 * breadthScore) * 100) / 100;
    result[key] = {
      demandScore,
      candidateCount: group.length,
      growingCandidateCount: growing.length,
      averageVelocity: Math.round(averageVelocity * 100) / 100,
      averageAcceleration: Math.round(averageAcceleration * 100) / 100
    };
  }
  return result;
}

function candidateMomentumScore(entry) {
  if (entry.hasPositivePlayGrowth) {
    return 0.65 * logScaleScore(entry.momentum.playsPerMinute, 20) +
      0.35 * logScaleScore(entry.momentum.playsAccelerationPerMinute, 5);
  }
  if (entry.hasPositiveViewGrowth) {
    return 0.65 * logScaleScore(entry.momentum.viewsPerMinute, 20) +
      0.35 * logScaleScore(
        entry.momentum.viewsAccelerationPerMinute ?? entry.momentum.accelerationPerMinute, 5
      );
  }
  if (entry.playMetric.available && entry.playMetric.value > 0) {
    return logScaleScore(entry.playMetric.value, 1000000);
  }
  if (entry.viewMetric.available && entry.viewMetric.value > 0) {
    return logScaleScore(entry.viewMetric.value, 1000000);
  }
  return 0;
}

function candidateAccelerationEvidence(entry) {
  const momentum = entry && entry.momentum && typeof entry.momentum === 'object'
    ? entry.momentum : {};
  const playCounterAvailable = Boolean(entry && entry.playMetric && entry.playMetric.available);
  const playCounterZeroStalled = Boolean(entry && entry.playCounterZeroStalled === true);

  if (playCounterAvailable && !playCounterZeroStalled) {
    const sampleCount = Math.trunc(num(momentum.playsSampleCount, num(momentum.sampleCount, 0)));
    if (sampleCount < MIN_ACCELERATION_SAMPLES) {
      return {
        passed: false,
        reason: 'insufficient_play_samples',
        metric: 'plays',
        sampleCount,
        minimumSamples: MIN_ACCELERATION_SAMPLES,
        velocityPerMinute: null,
        accelerationPerMinute: null
      };
    }
    const velocity = num(momentum.playsPerMinute, 0);
    const acceleration = num(momentum.playsAccelerationPerMinute, 0);
    return {
      passed: entry.hasPositivePlayGrowth === true && velocity > 0,
      reason: entry.hasPositivePlayGrowth !== true || velocity <= 0
        ? 'no_positive_play_velocity'
        : acceleration <= 0 ? 'positive_play_velocity_without_acceleration'
          : 'positive_play_acceleration',
      metric: 'plays',
      sampleCount,
      minimumSamples: MIN_ACCELERATION_SAMPLES,
      velocityPerMinute: velocity,
      accelerationPerMinute: acceleration
    };
  }

  if (entry && entry.hasPositiveViewGrowth &&
      (!playCounterAvailable || playCounterZeroStalled)) {
    const sampleCount = Math.trunc(num(momentum.viewsSampleCount, num(momentum.sampleCount, 0)));
    if (sampleCount < MIN_ACCELERATION_SAMPLES) {
      return {
        passed: false,
        reason: 'insufficient_view_samples',
        metric: 'views',
        sampleCount,
        minimumSamples: MIN_ACCELERATION_SAMPLES,
        velocityPerMinute: null,
        accelerationPerMinute: null
      };
    }
    const velocity = num(momentum.viewsPerMinute, 0);
    const acceleration = num(
      momentum.viewsAccelerationPerMinute ?? momentum.accelerationPerMinute, 0
    );
    const zeroPlayFallback = playCounterAvailable && playCounterZeroStalled;
    return {
      passed: velocity > 0,
      reason: velocity <= 0 ? 'no_positive_view_velocity'
        : acceleration <= 0 ? zeroPlayFallback
          ? 'positive_view_velocity_zero_play_counter_stalled'
          : 'positive_view_velocity_without_acceleration'
        : zeroPlayFallback ? 'positive_view_acceleration_zero_play_counter_stalled'
          : 'positive_view_acceleration',
      metric: 'views',
      fallbackReason: zeroPlayFallback ? 'play_counter_zero_for_three_independent_samples'
        : !playCounterAvailable ? 'play_counter_unavailable' : null,
      sampleCount,
      minimumSamples: MIN_ACCELERATION_SAMPLES,
      velocityPerMinute: velocity,
      accelerationPerMinute: acceleration
    };
  }

  return {
    passed: false,
    reason: 'no_measured_positive_velocity',
    metric: null,
    sampleCount: Math.max(
      Math.trunc(num(momentum.playsSampleCount, 0)),
      Math.trunc(num(momentum.viewsSampleCount, 0)),
      Math.trunc(num(momentum.sampleCount, 0))
    ),
    minimumSamples: MIN_ACCELERATION_SAMPLES,
    velocityPerMinute: null,
    accelerationPerMinute: null
  };
}

function loadPlatformTrendSnapshot() {
  try {
    const snapshot = JSON.parse(fs.readFileSync(PLATFORM_TRENDS_PATH, 'utf8'));
    return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

function buildFreshPlatformTrendWeights(snapshot, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {};
  const updatedAt = Date.parse(snapshot.updated_at || snapshot.updatedAt || '');
  if (!Number.isFinite(updatedAt) ||
      nowMs - updatedAt > PLATFORM_TRENDS_MAX_AGE_MS ||
      updatedAt > nowMs + 5 * 60 * 1000) return {};
  const hasSupportedSource = ['telegram', 'aparat', 'youtube_cc'].some(group =>
    snapshot[group] && typeof snapshot[group] === 'object' && !Array.isArray(snapshot[group])
  );
  if (!hasSupportedSource) return {};
  try {
    // Reuse the project's shared, tested trend aggregation. It scores
    // corroborated observations from Telegram, Aparat and YouTube CC;
    // stale per-item records are filtered by buildTrendWeights itself.
    return buildTrendWeights(snapshot, nowMs);
  } catch {
    return {};
  }
}

function candidateExternalTopicKey(item) {
  const sourceText = [
    item && item.title,
    item && item.description,
    item && item.category_name,
    item && item.category_title,
    item && item.feed_tag_label,
    item && item.feed_tag
  ].filter(Boolean).join(' ');
  const detectedTopic = categoryFor(sourceText);
  if (detectedTopic !== 'general_entertainment') return detectedTopic;

  // Filo's native category labels do not always use the vocabulary of the
  // shared trend classifier (for example, "آهنگ" and "موزیک ویدیو").
  // Bridge explicit feed labels to the existing taxonomy rather than
  // treating these known categories as generic entertainment.
  const feedLabels = [
    item && item.feed_tag_label,
    item && item.category_name,
    item && item.category_title
  ].filter(Boolean).join(' ').toLocaleLowerCase('fa');
  const labelAliases = [
    { topic: 'performance_magic', pattern: /آهنگ|ترانه|موزیک|موسیقی|خوانندگی|نوازندگی|دابسمش|رقص|music video|music performance|singer|song|dance/i },
    { topic: 'persian_comedy', pattern: /طنز|خنده|بامزه|کمدی|شوخی|دوربین مخفی|comedy|funny|humou?r/i },
    { topic: 'technology_demo', pattern: /هوش مصنوعی|فناوری|تکنولوژی|ربات|گجت|دستگاه هوشمند|technology|robot|gadget|AI/i },
    { topic: 'food_cooking', pattern: /آشپزی|غذا|خوراکی|دستور پخت|شیرینی|نان.?پزی|cooking|recipe|food/i },
    { topic: 'travel_culture', pattern: /سفر|گردشگری|ایرانگردی|جاذبه|معماری|فرهنگ|travel|tourism|culture/i },
    { topic: 'sports_skill', pattern: /ورزش|فوتبال|بسکتبال|والیبال|ورزشکار|sports?|football|basketball/i },
    { topic: 'pets_animals', pattern: /گربه|سگ|حیوان|جانور|پرنده|طوطی|حیات وحش|cats?|dogs?|animals?|wildlife/i },
    { topic: 'science_tech', pattern: /علمی|آزمایش|نجوم|فیزیک|کهکشان|خطای دید|معما|science|experiment|astronomy|puzzle/i },
    { topic: 'satisfying_craft', pattern: /کاردستی|ساختنی|نجاری|سفال|بازسازی|رضایت.?بخش|craft|restoration|woodworking/i },
    { topic: 'surprise_reveal', pattern: /غافلگیر|غیرمنتظره|راز|نتیجه نهایی|آخرش|surprise|unexpected|reveal/i },
    { topic: 'heartwarming', pattern: /تولد|روز دختر|روز پدر|ولادت|تبریک|جشن|مبارک|birthday|celebration|congratulations/i }
  ];
  for (const alias of labelAliases) {
    if (alias.pattern.test(feedLabels)) return alias.topic;
  }
  return detectedTopic;
}

function rankCandidatesByMomentum(items, state, now = Date.now(), platformTopicWeights = {}, currentRatesOverride = null) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const currentRates = currentRatesOverride && typeof currentRatesOverride === 'object'
    ? currentRatesOverride : updateCandidateMomentum(state, items, nowMs);
  const trendWeights = platformTopicWeights && typeof platformTopicWeights === 'object'
    ? platformTopicWeights : {};
  const recentCategories = (state && Array.isArray(state.posts) ? state.posts : [])
    .filter(post => post && (post.feedTag != null || post.categoryId != null) &&
      ['public_verified', 'submitted_pending_approval', 'submitted_unconfirmed'].includes(post.status))
    .filter(post => {
      const at = Date.parse(post.submittedAt || post.at || '');
      return Number.isFinite(at) && nowMs - at <= 48 * 60 * 60 * 1000;
    })
    .sort((a, b) => Date.parse(b.submittedAt || b.at || '') - Date.parse(a.submittedAt || a.at || ''))
    .slice(0, 2)
    .map(post => String(post.feedTag || post.categoryId));
  const recentCategorySet = new Set(recentCategories);

  const prepared = (Array.isArray(items) ? items : []).map(item => {
    const code = String(item && (item.video_code || item.videoCode || item.code) || '').trim();
    const saved = state && state.candidateMomentum && state.candidateMomentum[code];
    const lastRate = saved && saved.lastRate;
    const lastRateAt = Date.parse(lastRate && lastRate.at || '');
    const recentSavedRate = Number.isFinite(lastRateAt) && nowMs - lastRateAt <= 15 * 60 * 1000
      ? lastRate : null;
    const playMetric = candidateMetricSnapshot(item, ['play_count', 'plays', 'playCount']);
    const viewMetric = candidateMetricSnapshot(item, ['visit_count', 'view_count', 'views', 'visits']);
    const momentum = currentRates[code] || recentSavedRate || {
      viewsPerMinute: null,
      playsPerMinute: null,
      viewsAccelerationPerMinute: 0,
      playsAccelerationPerMinute: 0,
      accelerationPerMinute: 0,
      playsAvailable: playMetric.available,
      playCounterPresent: playMetric.available,
      sampleCount: 1
    };
    const audienceFit = classifyAudienceFit(item);
    const categoryId = item && (item.feed_tag || item.category_id != null)
      ? String(item.feed_tag || item.category_id) : '';
    const hasPositivePlayGrowth = Boolean(momentum.playsAvailable === true &&
      momentum.playsPerMinute !== null && momentum.playsPerMinute !== undefined &&
      num(momentum.playsPerMinute) > 0);
    const hasPositiveViewGrowth = Boolean(momentum.viewsPerMinute !== null &&
      momentum.viewsPerMinute !== undefined && num(momentum.viewsPerMinute) > 0);
    const age = ageHours(item);
    const feedHintScore = feedGateHintScore(item);
    let rankingMetric = 'freshness';
    let selectionMode = 'freshness_fallback';
    if (hasPositivePlayGrowth) {
      rankingMetric = 'plays';
      selectionMode = 'measured_play_growth';
    } else if (hasPositiveViewGrowth) {
      rankingMetric = 'views';
      selectionMode = 'measured_view_growth';
    } else if (playMetric.available && playMetric.value > 0) {
      rankingMetric = 'cumulative_plays';
      selectionMode = 'cumulative_play_fallback';
    } else if (viewMetric.available && viewMetric.value > 0) {
      rankingMetric = 'cumulative_views';
      selectionMode = 'cumulative_view_fallback';
    }
    const rankingTier = hasPositivePlayGrowth ? 4
      : hasPositiveViewGrowth ? 3
      : playMetric.available && playMetric.value > 0 ? 2
      : viewMetric.available && viewMetric.value > 0 ? 1 : 0;
    const metricHistory = state && state.candidateMomentum &&
      state.candidateMomentum[code] && Array.isArray(state.candidateMomentum[code].samples)
      ? state.candidateMomentum[code].samples : [];
    const recentPlaySamples = metricHistory
      .filter(sample => sample && sample.playsAvailable === true && Number.isFinite(Number(sample.plays)))
      .slice(-MIN_ACCELERATION_SAMPLES);
    const playCounterZeroStalled = Boolean(
      playMetric.available && playMetric.value === 0 &&
      recentPlaySamples.length >= MIN_ACCELERATION_SAMPLES &&
      recentPlaySamples.every(sample => sample && sample.playsAvailable === true &&
        num(sample.plays, -1) === 0)
    );
    const entry = {
      item,
      momentum,
      playMetric,
      viewMetric,
      playCounterZeroStalled,
      ageHours: age,
      hasPositivePlayGrowth,
      hasPositiveViewGrowth,
      hasMeasuredGrowth: hasPositivePlayGrowth || hasPositiveViewGrowth,
      rankingMetric,
      selectionMode,
      rankingTier,
      feedHintScore,
      audienceFit: audienceFit.label,
      audienceFitScore: audienceFit.score,
      topicKey: candidateTopicKey(item, audienceFit),
      externalTopicKey: candidateExternalTopicKey(item),
      topicLabel: String(item && (item.feed_tag_label || item.category_name || item.category_title) ||
        audienceFit.label),
      durationPreferenceScore: durationPreferenceScore(item),
      freshnessScore: Math.max(0, Math.min(100, (24 - age) / 24 * 100)),
      recentCategoryPenalty: categoryId && recentCategorySet.has(categoryId) ? 1 : 0
    };
    entry.accelerationEvidence = candidateAccelerationEvidence(entry);
    entry.growthGatePassed = entry.accelerationEvidence.passed;
    entry.hasPositiveAcceleration = num(entry.accelerationEvidence.accelerationPerMinute, 0) > 0;
    entry.momentumScore = candidateMomentumScore(entry);
    return entry;
  }).filter(entry => entry.ageHours <= 24);

  const topicDemand = summarizeTopicDemand(prepared);
  return prepared.map(entry => {
    const topic = topicDemand[entry.topicKey] || {
      demandScore: 0, candidateCount: 1, growingCandidateCount: 0,
      averageVelocity: 0, averageAcceleration: 0
    };
    const externalTopicTrendScore = Math.max(0, Math.min(100,
      num(trendWeights[entry.externalTopicKey]) * 10
    ));
    const audienceFitRankScore = Math.max(0, Math.min(100, entry.audienceFitScore / 3 * 100));
    const rankingScore =
      0.64 * entry.momentumScore +
      0.10 * topic.demandScore +
      0.12 * externalTopicTrendScore +
      0.08 * entry.durationPreferenceScore +
      0.02 * entry.freshnessScore +
      0.04 * audienceFitRankScore;
    return {
      ...entry,
      topicDemandScore: topic.demandScore,
      externalTopicTrendScore,
      topicCandidateCount: topic.candidateCount,
      topicGrowingCandidateCount: topic.growingCandidateCount,
      topicAverageVelocity: topic.averageVelocity,
      topicAverageAcceleration: topic.averageAcceleration,
      audienceFitRankScore,
      rankingScore: Math.round(rankingScore * 100) / 100
    };
  }).sort((a, b) => {
    // Keep the established evidence hierarchy: measured plays growth first,
    // then measured views growth, then cumulative counters, then freshness.
    if (a.rankingTier !== b.rankingTier) return b.rankingTier - a.rankingTier;
    if (Math.abs(b.rankingScore - a.rankingScore) > 0.001) {
      return b.rankingScore - a.rankingScore;
    }
    if (a.feedHintScore !== b.feedHintScore) return b.feedHintScore - a.feedHintScore;
    if (a.playMetric.available !== b.playMetric.available) {
      return Number(b.playMetric.available) - Number(a.playMetric.available);
    }
    if (a.playMetric.value !== b.playMetric.value) return b.playMetric.value - a.playMetric.value;
    if (a.viewMetric.value !== b.viewMetric.value) return b.viewMetric.value - a.viewMetric.value;
    return b.audienceFitScore - a.audienceFitScore ||
      a.recentCategoryPenalty - b.recentCategoryPenalty ||
      b.durationPreferenceScore - a.durationPreferenceScore ||
      a.ageHours - b.ageHours;
  });
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
  if (duration < MIN_DURATION_SECONDS) {
    return { eligible: false, reason: 'duration_below_monetization_minimum' };
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
    .replace(/^\s*(?:ویدئو|ویدیو|فیلم)\s+/iu, '')
    .replace(/^\s*کلیپ\s+(?!(?:های|ها)(?:\s|$))/iu, '')
    .replace(/[\\/|]{2,}/gu, ' ')
    .replace(/(?:^|[\s،؛,|/–—-])(?:برای\s+کلیپ(?:\s+های)?\s+بیشتر|کانال\s*(?:ما|مارا|رو|را)\s*(?:را\s*)?دنبال\s*کنید|ما\s*را\s*دنبال\s*کنید|لایک\s*(?:کنید|کنین)?|فالو\s*(?:کنید|کنین)?|حمایت\s*(?:کنید|کنین)?|یادتون\s+نره|سابسکرایب\s*(?:کنید|کنین)?|عضو\s*(?:شوید|بشید))[^]*$/iu, ' ')
    .replace(/\p{Extended_Pictographic}|[\uFE0E\uFE0F]/gu, ' ')
    .replace(/([!?؟،؛:,.…–—-])\1+/gu, '$1')
    .replace(/([^\s\p{P}\p{S}])\1{3,}/gu, '$1$1')
    .replace(/\s+(?:این\s+)?(?:حتماً?\s*)?(?:ببینید|ببنید|تماشا کنید|مشاهده کنید|از دست ندید|از دست ندهید)\s*$/iu, '')
    .replace(/\s+([،؛:,.!?؟])/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return trimAtWord(title, 176);
}

function fitFiloTitleLength(value) {
  let title = String(value || '').replace(/\s+/g, ' ').trim();
  if (title.length > FILO_TITLE_MAX_CHARS) title = trimAtWord(title, FILO_TITLE_MAX_CHARS);
  return title.length >= FILO_TITLE_MIN_CHARS ? title : 'عنوان اصلی نامشخص';
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

function editorialTitleQualityReason(value) {
  const title = normalizeCaptionEditorialText(value);
  if (!title) return 'title_without_safe_editorial_rewrite';
  if (/^(?:و\s*)?(?:نظر\s+خود\s+را\s+بنویسید|نظرت(?:ان|ون)\s+را?\s+بنویسید|نظرت(?:ان|ون)\s+رو\s+بگید|کامنت\s+بگذارید|نظر\s+بدید|نظرت(?:ان|ون)\s+چیه)\s*[!؟.]*$/iu.test(title) ||
      /(?:نظر\s+خود\s+را\s+بنویسید|نظرت(?:ان|ون)\s+رو\s+بگید|کامنت\s+بگذارید)\s*[!؟.]*$/iu.test(title)) {
    return 'title_engagement_bait_without_subject';
  }
  if (/(?:لایک|لایك|فالو|فالوو|حمایت(?:\s*کنید|\s*کنین)?|یادتون\s+نره|دنبال(?:\s*کنید|\s*کنین)|عضو\s*(?:شوید|بشید)|سابسکرایب|زنگوله|برای\s+کلیپ(?:های)?\s+بیشتر|کانال\s*(?:ما|مارا|رو|را))/iu.test(title)) {
    return 'title_promotional_or_call_to_action';
  }
  const tokens = editorialTitleTokens(title);
  const substantive = tokens.filter(token =>
    !/^(?:پارت|قسمت|بخش|part|episode|کمدی|طنز|خنده|دار|کلیپ|ویدئو|ویدیو|فیلم|شماره|\d+)$/iu.test(token)
  );
  if (/(?:پارت|قسمت|episode|part)\s*[0-9۰-۹]+/iu.test(title) && substantive.length < 2 &&
      !/(?:طنز|خنده|آشپزی|آهنگ|ترانه|ورزش|فوتبال|حیوان|ترفند|آموزش)/iu.test(title)) {
    return 'title_generic_episode_label';
  }
  if (/^(?:یک\s+)?(?:فیلم|کلیپ|ویدئو|ویدیو)\s+(?:بسیار\s+|خیلی\s+)?(?:زیبا|جذاب|عالی|رمانتیک|فوق.?العاده)(?:\s+و\s+(?:بسیار\s+)?(?:زیبا|جذاب|عالی|رمانتیک))?.{0,70}$/iu.test(title)) {
    return 'title_generic_praise_without_subject';
  }
  if (tokens.length < 2 && !(/(?:پارت|قسمت|episode|part)\s*[0-9۰-۹]+/iu.test(title) &&
      /(?:طنز|خنده|آشپزی|آهنگ|ترانه|ورزش|فوتبال|حیوان|ترفند|آموزش)/iu.test(title))) {
    return 'title_not_distinct_or_editorially_clean';
  }
  return null;
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

function removeRepeatedTrailingPhrase(value) {
  const words=String(value||'').trim().split(/\s+/).filter(Boolean);
  if(words.length<4)return words.join(' ');
  const normalizeWord=word=>normalizeCaptionEditorialText(word).toLocaleLowerCase('fa-IR');
  for(let n=Math.min(3,Math.floor(words.length/2));n>=1;n--){
    const tail=words.slice(-n).map(normalizeWord);
    for(let start=0;start<=words.length-(2*n);start++){
      const prior=words.slice(start,start+n).map(normalizeWord);
      if(prior.every((word,index)=>word&&word===tail[index])){
        const reduced=words.slice(0,-n).join(' ').trim();
        if(editorialTitleTokens(reduced).length>=2)return reduced;
      }
    }
  }
  return words.join(' ');
}

function descriptionBasedTitleCandidate(sourceDescription, sourceTitle = '') {
  const normalizedSourceTitle = String(sourceTitle || '').trim();
  const cleanedSourceTitle = normalizedSourceTitle
    ? cleanRepostCaptionTitle(normalizedSourceTitle)
    : '';
  const raw = normalizeCaptionEditorialText(sourceDescription)
    .replace(/https?:\/\/\S+|www\.\S+/giu, ' ')
    .replace(/#[^\s#]+/gu, ' ')
    .replace(/@[\p{L}\p{N}_.-]+/gu, ' ')
    .replace(/^(?:(?:در\s+این\s+(?:ویدئو|ویدیو|کلیپ|فیلم)|موضوع\s+(?:این\s+)?ویدئو)\s*[:،؛-]?\s*)+/iu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;
  const sentences = raw.split(/(?<=[.!؟])\s+|[\n\r]+/u);
  for (const rawSentence of sentences) {
    const sentence = rawSentence
      .replace(/^(?:(?:در\s+این\s+(?:ویدئو|ویدیو|کلیپ|فیلم)|موضوع\s+(?:این\s+)?ویدئو)\s*[:،؛-]?\s*)+/iu, '')
      .replace(/^(?:(?:لطفاً|لطفا)\s*)?(?:این\s+)?(?:ویدئو|ویدیو|کلیپ)\s+(?:را\s+)?(?:ببینید|تماشا کنید|مشاهده کنید)\s*[:،؛-]?\s*/iu, '')
      .replace(/[.!؟،؛,;]+$/u, '')
      .trim();
    if (sentence.length < 10) continue;
    let candidate;
    try { candidate = cleanRepostCaptionTitle(sentence); } catch { continue; }
    // A description is useful only when it contributes a genuinely distinct
    // factual subject. Rewording the same generic source title is not a rewrite.
    if (cleanedSourceTitle && characterBigramDice(cleanedSourceTitle, candidate) >= 0.72) continue;
    if (editorialTitleQualityReason(candidate)) continue;
    if (policyTextRiskReason({ title: candidate })) continue;
    return fitFiloTitleLength(candidate);
  }
  return null;
}

function createDistinctRepostTitle(sourceTitle, sourceDescription = '', sourceCode = '') {
  let cleaned = '';
  try { cleaned = cleanRepostCaptionTitle(sourceTitle); } catch { cleaned = ''; }

  const rules = [
    [/^بلوچی\s+آهنگ\s+بلوچی\s+(.+)$/u,m=>['ترانه بلوچی «'+m[1]+'»']],
    [/^دانلود\s+آهنگ(?:\s+جدید)?\s+(.+?)\s+به\s+نام\s+(.+)$/u,m=>['ترانه «'+m[2]+'» از '+m[1]]],
    [/^آهنگ\s+(افشین\s+آذری)\s+و\s+(وفا\s+شریفوا)\s+(.+)$/u,m=>['همخوانی '+m[1]+' و '+m[2]+' با ترانه «'+m[3]+'»']],
    [/^(?:خنده\s*دار|طنز|کلیپ\s+طنز)\s+(?:پارت|قسمت)\s*([0-9۰-۹]+)(?:\s+.*)?$/u,m=>['کلیپ طنز، قسمت '+m[1]]],
    [/^([0-9۰-۹]{1,2})\s+آبان\s+ماهی\s+عزیز\s+تولدت\s+مبارک$/u,m=>['تبریک تولد به متولد '+m[1]+' آبان']],
    [/^طنر\s+بازی\s+کردن\s+با\s+(.+)$/u,m=>['بازی با '+m[1]+' در قالب طنز']],
    [/^طنز\s+بهترین\s+رفیق\s+ها$/u,()=>['بهترین رفیق‌ها در قاب طنز']],
    [/^طنز\s+دیدار\s+(.+)$/u,m=>['شوخی با دیدار '+m[1]]],
    [/^طرز\s+تهیه\s+(.+)$/u,m=>['روش پخت '+m[1],'پخت '+m[1]]],
    [/^دستور\s+تهیه\s+(.+)$/u,m=>['روش آماده‌سازی '+m[1],'آماده‌سازی '+m[1]]],
    [/^پاک\s+کردن\s+(.+?)\s+به\s+سبک\s+(.+)$/u,m=>['روش '+m[2]+' برای پاک کردن '+m[1]]],
    [/^(.+?)\s+به\s+سبک\s+(.+)$/u,m=>['روش '+m[2]+' برای '+m[1]]],
    [/^کتاب\s+صوتی\s+(.+?)\s+با\s+صدای\s+(.+)$/u,m=>['شنیدن '+m[1]+' با صدای '+m[2]]],
    [/^آموزش\s+(.+)$/u,m=>['راهنمای '+m[1]]],
    [/^چگونه\s+(.+)$/u,m=>['روش '+m[1]]],
    [/^(.+?)\s+در\s+(.+)$/u,m=>[m[2]+'؛ '+m[1]]]
  ];

  const drafts = [];
  for (const [pattern, rewrite] of rules) {
    const match = cleaned.match(pattern);
    if (match) { drafts.push(...rewrite(match)); break; }
  }
  const descriptionCandidate = descriptionBasedTitleCandidate(sourceDescription, sourceTitle);
  if (descriptionCandidate) drafts.push(descriptionCandidate);
  if (cleaned && !editorialTitleQualityReason(cleaned) && !policyTextRiskReason({ title: cleaned })) {
    drafts.push(cleaned);
  }

  const candidates = [];
  for (const draft of drafts) {
    const candidate = fitFiloTitleLength(removeRepeatedTrailingPhrase(draft));
    if (candidates.includes(candidate)) continue;
    if (editorialTitleQualityReason(candidate)) continue;
    const tokens = editorialTitleTokens(candidate);
    if (tokens.length < 2 && !/(?:پارت|قسمت|episode|part)\s*[0-9۰-۹]+/iu.test(candidate)) continue;
    if (candidate.length < FILO_TITLE_MIN_CHARS || candidate.length > FILO_TITLE_MAX_CHARS) continue;
    const contentWords = normalizeCaptionEditorialText(candidate).toLocaleLowerCase('fa-IR')
      .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/).filter(token => token.length > 1 && !EDITORIAL_TITLE_STOPWORDS.has(token));
    const counts = new Map();
    for (const token of contentWords) counts.set(token, (counts.get(token) || 0) + 1);
    if ([...counts.values()].some(count => count > 1)) continue;
    if (characterBigramDice(sourceTitle, candidate) > 0.86) continue;
    if (policyTextRiskReason({ title: candidate })) continue;
    candidates.push(candidate);
  }
  if (candidates.length) return candidates[0];

  // Editorial quality rules are preferences, not eligibility gates. When a
  // rewrite cannot be built, use safe, sanitized source text if available.
  const fallbackDescription = normalizeCaptionEditorialText(sourceDescription)
    .replace(/https?:\/\/\S+|www\.\S+/giu, ' ')
    .replace(/#[^\s#]+/gu, ' ')
    .replace(/@[\p{L}\p{N}_.-]+/gu, ' ')
    .split(/(?<=[.!؟])\s+|[\n\r]+/u)
    .map(part => cleanRepostCaptionTitle(part))
    .find(part => part.length >= 5 &&
      !editorialTitleQualityReason(part) &&
      !policyTextRiskReason({ title: part }));

  for (const fallback of [cleaned, fallbackDescription]) {
    const value = String(fallback || '').trim();
    if (value.length < 5 || policyTextRiskReason({ title: value })) continue;
    const qualityReason = editorialTitleQualityReason(value);
    if (qualityReason === 'title_promotional_or_call_to_action' ||
        qualityReason === 'title_engagement_bait_without_subject' ||
        qualityReason === 'title_generic_episode_label' ||
        qualityReason === 'title_generic_praise_without_subject' ||
        qualityReason === 'title_not_distinct_or_editorially_clean') continue;
    return fitFiloTitleLength(value);
  }

  return 'عنوان اصلی نامشخص';
}

function cleanRepostDescription(sourceDescription, sourceTitle, repostTitle) {
  const sourceParts = normalizeCaptionEditorialText(sourceDescription)
    .split(/(?<=[.!؟])\s+|[\n\r]+/u)
    .map(part => part.trim())
    .filter(part => part && !/(?:لایک|لایك|فالو|حمایت|یادتون\s+نره|دنبال(?:\s*کنید|\s*کنین)|عضو\s*(?:شوید|بشید)|سابسکرایب|برای\s+کلیپ(?:های)?\s+بیشتر|کانال\s*(?:ما|مارا|رو|را)|لذت\s+ببرید|نظر\s+خود\s+را\s+بنویسید|نظرت(?:ان|ون)\s+رو\s+بگید|کامنت\s+بگذارید)/iu.test(part));
  const seenDescriptionParts = new Set();
  const source = sourceParts.filter(part => {
    const key = normalizeComparable(part);
    if (!key || seenDescriptionParts.has(key)) return false;
    seenDescriptionParts.add(key);
    return true;
  }).join(' ');
  const description = source
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
  // A concise factual fallback avoids Filo's "description too short" rejection.
  // It is grounded only in the already-authorized source title and preserves any
  // remaining factual source description; it does not invent scene details.
  const topic = cleanRepostCaptionTitle(sourceTitle);
  const groundedFallback = topic && !policyTextRiskReason({ title: topic })
    ? `این ویدئو دربارهٔ «${topic}» است.` : '';
  const finalDescription = description.length >= FILO_DESCRIPTION_MIN_CHARS
    ? description
    : [groundedFallback, description].filter(Boolean).join(' ');
  return trimAtWord(finalDescription || topic || 'توضیحات تکمیلی در متن اصلی موجود نیست.', 900);
}

function createRepostMetadata(video, sourceCode) {
  const sourceTitle = String(video && video.title || '').replace(/\s+/g, ' ').trim();
  const sourceDescription = String(video && video.description || '').replace(/\s+/g, ' ').trim();
  const risk = policyTextRiskReason(video);
  if (risk) throw new Error('filo_policy_text_risk:' + risk);
  const title = createDistinctRepostTitle(sourceTitle, sourceDescription, sourceCode);
  const description = cleanRepostDescription(sourceDescription, sourceTitle, title);
  return { title, description, sourceTitle, sourceDescription, sourceCode };
}

function topicDuplicateMatch(state,title,now=Date.now()) {
  const nowMs=Number.isFinite(Number(now))?Number(now):Date.now();
  const tokens=editorialTitleTokens(title);
  if(tokens.length<3)return {duplicate:false,reason:'insufficient_topic_tokens'};
  const current=new Set(tokens);
  const recent=(state&&Array.isArray(state.posts)?state.posts:[])
    .filter(post=>post&&['public_verified','submitted_pending_approval','submitted_unconfirmed'].includes(post.status))
    .filter(post=>{
      const at=Date.parse(post.submittedAt||post.at||'');
      return Number.isFinite(at)&&at<=nowMs&&nowMs-at<=TOPIC_DUPLICATE_WINDOW_MS;
    })
    .sort((a,b)=>Date.parse(b.submittedAt||b.at||'')-Date.parse(a.submittedAt||a.at||''));
  for(const post of recent){
    const previousTitle=post.repostTitle||post.sourceTitle||'';
    const previous=new Set(editorialTitleTokens(previousTitle));
    if(previous.size<3)continue;
    const common=[...current].filter(token=>previous.has(token));
    const unionSize=new Set([...current,...previous]).size;
    const jaccard=common.length/unionSize;
    const smallerSetCoverage=common.length/Math.min(current.size,previous.size);
    const characterSimilarity=characterBigramDice(title,previousTitle);
    const sameSpecificTopic=common.length>=3&&jaccard>=0.65&&smallerSetCoverage>=0.9;
    const nearlySameTitle=characterSimilarity>=0.91;
    if(sameSpecificTopic||nearlySameTitle){
      return {
        duplicate:true,matchedTitle:String(previousTitle).slice(0,180),
        matchedSourceCode:post.sourceCode||null,commonTokens:common.slice(0,8),
        jaccard:Math.round(jaccard*100)/100,
        characterSimilarity:Math.round(characterSimilarity*100)/100
      };
    }
  }
  return {duplicate:false};
}

function candidateMetadataFingerprint(video) {
  const title=normalizeCaptionEditorialText(video&&video.title||'');
  const description=normalizeCaptionEditorialText(video&&video.description||'');
  return crypto.createHash('sha256').update(title+'\0'+description).digest('hex');
}

function isTitleRewriteRejectionReason(reason) {
  return reason === 'title_without_safe_editorial_rewrite' ||
    reason === 'title_engagement_bait_without_subject' ||
    reason === 'title_not_distinct_or_editorially_clean' ||
    reason === 'source_title_too_short' ||
    reason === 'title_promotional_or_call_to_action' ||
    reason === 'title_generic_episode_label' ||
    reason === 'title_generic_praise_without_subject';
}

function detailFetchHttpDisposition(status) {
  const code = Number(status);
  if (code === 401) return 'session_expired';
  if (code === 403) return 'candidate_access_denied';
  if (code === 408 || code === 425 || code === 429 || code >= 500) return 'retryable';
  return 'permanent';
}


function isAccountRepublishQuotaMessage(value) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase('fa-IR');
  return /سقف.{0,35}(?:بازنشر|انتشار|آپلود).{0,40}(?:تموم|تمام|پر|تکمیل|به پایان)|(?:ساعاتی|چند ساعت).{0,30}(?:بعد|دیگر).{0,30}(?:بازنشر|انتشار|مراجعه)|(?:repost|republish|upload).{0,30}(?:limit|quota).{0,30}(?:reached|exceeded|used up)/iu.test(text);
}

function setAccountRepublishQuotaCooldown(state, now = Date.now()) {
  if (!state || typeof state !== 'object') return null;
  const detectedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const recentEvents = (Array.isArray(state.accountRepublishQuotaEvents)
    ? state.accountRepublishQuotaEvents : [])
    .map(value => Date.parse(value))
    .filter(at => Number.isFinite(at) && at <= detectedAt && detectedAt - at <= 24 * 60 * 60 * 1000);
  recentEvents.push(detectedAt);
  state.accountRepublishQuotaEvents = recentEvents
    .sort((a, b) => a - b)
    .slice(-6)
    .map(at => new Date(at).toISOString());
  const occurrenceCount = state.accountRepublishQuotaEvents.length;
  const cooldownMs = occurrenceCount === 1
    ? ACCOUNT_REPUBLISH_QUOTA_COOLDOWN_MS
    : Math.min(6 * 60 * 60 * 1000,
      ACCOUNT_REPUBLISH_QUOTA_COOLDOWN_MS * Math.pow(2, occurrenceCount - 1));
  const entry = {
    reason: 'filo_account_republish_quota_reached',
    detectedAt: new Date(detectedAt).toISOString(),
    retryAfterAt: new Date(detectedAt + cooldownMs).toISOString(),
    cooldownMs,
    occurrenceCountIn24h: occurrenceCount
  };
  state.accountRepublishQuotaCooldown = entry;
  return entry;
}

function getAccountRepublishQuotaCooldown(state, now = Date.now()) {
  const entry = state && state.accountRepublishQuotaCooldown;
  if (!entry) return null;
  const retryAfter = Date.parse(entry.retryAfterAt || '');
  const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (!Number.isFinite(retryAfter) || retryAfter <= current) {
    delete state.accountRepublishQuotaCooldown;
    return null;
  }
  return { ...entry, remainingMs: retryAfter - current };
}


function releaseOneLegacy403CacheForAccountQuotaProbe(state, ranked, now = Date.now()) {
  if (!state || state.accountQuota403ProbeMigrationAt) return null;
  const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (getAccountRepublishQuotaCooldown(state, current)) return null;
  const cache = state.candidateRejections && typeof state.candidateRejections === 'object'
    ? state.candidateRejections : {};
  for (const entry of (Array.isArray(ranked) ? ranked : []).slice(0, MAX_DETAIL_CHECKS)) {
    const code = String(entry && entry.item && entry.item.video_code || '').trim();
    if (!code) continue;
    const rejection = cache[code];
    if (!rejection || rejection.reason !== 'detail_fetch:forbidden_403') continue;
    const retryAt = Date.parse(rejection.retryAfterAt || '');
    if (!Number.isFinite(retryAt) || retryAt <= current) continue;
    // Historical versions cached Filo's account-wide quota message as a
    // per-video 403. Release exactly one top-ranked entry to obtain one
    // authoritative detail response; never fan out retries across the cache.
    delete cache[code];
    state.accountQuota403ProbeMigrationAt = new Date(current).toISOString();
    state.accountQuota403ProbeCode = code;
    return code;
  }
  state.accountQuota403ProbeMigrationAt = new Date(current).toISOString();
  return null;
}

function getCachedDetailAccessRejection(state,code,now=Date.now()) {
  const entry = state && state.candidateRejections && state.candidateRejections[String(code || '').trim()];
  if (!entry || entry.reason !== 'detail_fetch:forbidden_403') return null;
  const retryAt = Date.parse(entry.retryAfterAt || '');
  if (!Number.isFinite(retryAt) || retryAt <= now) {
    delete state.candidateRejections[String(code || '').trim()];
    return null;
  }
  return entry;
}

function getCachedCandidateRejection(state,code,video,now=Date.now()) {
  const cache=state&&state.candidateRejections&&typeof state.candidateRejections==='object'
    ?state.candidateRejections:{};
  const key=String(code||'').trim(),entry=cache[key];
  if(!entry)return null;
  // Older publisher versions cached explicit Filo metadata rejections under the
  // generic API reason. If the ledger proves this source was rejected only for
  // title/description validation, let the one-time new-policy retry proceed.
  if(entry.reason==='filo_publish_not_accepted' && hasRetryableMetadataRejection(state,key)){
    delete cache[key];
    return null;
  }
  const retryAt=Date.parse(entry.retryAfterAt||'');
  const titlePolicyStale = isTitleRewriteRejectionReason(entry.reason) &&
    entry.titleRewritePolicyVersion !== TITLE_REWRITE_POLICY_VERSION;
  const filoMetadataPolicyStale = isMetadataValidationRejectionReason(entry.reason) &&
    (entry.titleRewritePolicyVersion !== TITLE_REWRITE_POLICY_VERSION ||
     entry.captionPolicyVersion !== CAPTION_POLICY_VERSION);
  // Older runs cached durations above 180 seconds as ineligible. That cap is
  // removed, so those stale local rejections must be reconsidered immediately.
  const obsoleteDurationMaximum = entry.reason === 'detail_gate:duration_out_of_short_form_range';
  if(titlePolicyStale || filoMetadataPolicyStale || obsoleteDurationMaximum || entry.fingerprint!==candidateMetadataFingerprint(video)||
     !Number.isFinite(retryAt)||retryAt<=now){
    delete cache[key];
    return null;
  }
  return entry;
}

function cacheCandidateRejection(state,code,video,reason,now=Date.now(),ttlMs=CANDIDATE_REJECTION_TTL_MS) {
  if(!state||!/^[A-Za-z0-9_-]{5,40}$/.test(String(code||'')))return;
  if(!state.candidateRejections||typeof state.candidateRejections!=='object')state.candidateRejections={};
  const normalizedReason=String(reason||'static_metadata_rejection').slice(0,220);
  state.candidateRejections[code]={
    fingerprint:candidateMetadataFingerprint(video),
    reason:normalizedReason,
    titleRewritePolicyVersion:(isTitleRewriteRejectionReason(normalizedReason)||isMetadataValidationRejectionReason(normalizedReason))?TITLE_REWRITE_POLICY_VERSION:null,
    captionPolicyVersion:CAPTION_POLICY_VERSION,
    rejectedAt:new Date(now).toISOString(),
    retryAfterAt:new Date(now+ttlMs).toISOString()
  };
  state.candidateRejections=Object.fromEntries(
    Object.entries(state.candidateRejections)
      .sort((a,b)=>String(b[1].rejectedAt||'').localeCompare(String(a[1].rejectedAt||'')))
      .slice(0,400)
  );
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

function normalizePublishFieldName(value) {
  return String(value || '').replace(/[^a-z0-9\u0600-\u06ff]/gi, '').toLocaleLowerCase('en');
}

function flattenPublishBodyObject(value, params, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 5) return;
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      if (!params.has(key)) params.set(key, String(item));
    } else if (typeof item === 'object' && !Array.isArray(item)) {
      flattenPublishBodyObject(item, params, depth + 1);
    }
  }
}

function parseMultipartPublishBody(body, boundary) {
  const params = new Map();
  if (!boundary) return params;
  const delimiter = '--' + boundary;
  const chunks = String(body || '').split(delimiter);
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith('--')) continue;
    const normalized = chunk.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const separator = normalized.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = normalized.slice(0, separator);
    const name = (headers.match(/content-disposition:[^\r\n]*\bname="([^"]+)"/i) || [])[1];
    if (!name) continue;
    const value = normalized.slice(separator + 4).replace(/\r?\n$/, '');
    params.set(name, value);
  }
  return params;
}

function parseFiloPublishRequestBody(body, contentType = '') {
  const raw = String(body || '');
  const type = String(contentType || '').toLowerCase();
  if (type.includes('application/json') || (!type && /^\s*[\[{]/.test(raw))) {
    try {
      const json = JSON.parse(raw);
      const params = new Map();
      flattenPublishBodyObject(json, params);
      return { format: 'json', contentType: String(contentType || ''), raw, json, params, keys: [...params.keys()] };
    } catch {
      if (type.includes('application/json')) {
        return { format: 'invalid_json', contentType: String(contentType || ''), raw, json: null, params: new Map(), keys: [] };
      }
    }
  }
  if (type.includes('multipart/form-data')) {
    const boundary = (String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i) || [])[1] ||
      (String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i) || [])[2] || '';
    const params = parseMultipartPublishBody(raw, boundary.trim());
    return { format: 'multipart', contentType: String(contentType || ''), raw, boundary: boundary.trim(), json: null, params, keys: [...params.keys()] };
  }
  if (type.includes('application/x-www-form-urlencoded') || !type) {
    const params = new URLSearchParams(raw);
    if (params.size || !raw) {
      return { format: 'urlencoded', contentType: String(contentType || ''), raw, json: null, params: new Map(params.entries()), keys: [...params.keys()] };
    }
  }
  return { format: 'unknown', contentType: String(contentType || ''), raw, json: null, params: new Map(), keys: [] };
}

function getPublishBodyParam(params, ...aliases) {
  const entries = params instanceof Map ? [...params.entries()] : [];
  const normalized = new Map(entries.map(([key, value]) => [normalizePublishFieldName(key), value]));
  for (const alias of aliases) {
    const key = normalizePublishFieldName(alias);
    if (normalized.has(key)) return normalized.get(key);
  }
  return '';
}

function setJsonPublishBodyField(json, key, value, depth = 0) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || depth > 5) return false;
  if (Object.prototype.hasOwnProperty.call(json, key)) {
    json[key] = value;
    return true;
  }
  for (const child of Object.values(json)) {
    if (child && typeof child === 'object' && !Array.isArray(child) &&
        setJsonPublishBodyField(child, key, value, depth + 1)) return true;
  }
  json[key] = value;
  return true;
}

function serializeFiloPublishRequestBody(parsed) {
  if (!parsed || !(parsed.params instanceof Map)) return null;
  if (parsed.format === 'urlencoded') {
    const params = new URLSearchParams();
    for (const [key, value] of parsed.params.entries()) params.append(key, value);
    return params.toString();
  }
  if (parsed.format === 'json') return JSON.stringify(parsed.json);
  // Multipart bodies may contain binary or browser-managed fields. Preserve byte-for-byte;
  // the cover is optional and must never force a malformed multipart reconstruction.
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

function publicationOperationTimestamp(post) {
  const value = post && (post.submittedAt || post.attemptedAt || post.at);
  const at = Date.parse(value || '');
  return Number.isFinite(at) ? at : null;
}

function isPublicationOperation(post) {
  return Boolean(post && [
    'public_verified',
    'submitted_pending_approval',
    'submitted_unconfirmed',
    'rejected_by_filo'
  ].includes(post.status));
}

function getPublicationOperationTimes(state, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return (state && Array.isArray(state.posts) ? state.posts : [])
    .filter(isPublicationOperation)
    .map(post => publicationOperationTimestamp(post))
    .filter(at => Number.isFinite(at) && at <= nowMs)
    .sort((a, b) => a - b);
}

function dailyCount(state, now = Date.now()) {
  const windowStart = now - 24 * 60 * 60 * 1000;
  return getPublicationOperationTimes(state, now)
    .filter(at => at > windowStart).length;
}

function getPublicationPacingGate(state, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const times = getPublicationOperationTimes(state, nowMs);
  const hourStart = nowMs - 60 * 60 * 1000;
  const dayStart = nowMs - 24 * 60 * 60 * 1000;
  const rollingHour = times.filter(at => at > hourStart);
  const rolling24h = times.filter(at => at > dayStart);
  const latestOperationAt = times.at(-1) ?? null;
  const nextEligibleCandidates = [];
  const reasons = [];

  if (latestOperationAt !== null && nowMs - latestOperationAt < MIN_PUBLISH_GAP_MS) {
    reasons.push('minimum_gap_between_republish_operations');
    nextEligibleCandidates.push(latestOperationAt + MIN_PUBLISH_GAP_MS);
  }
  if (rollingHour.length >= MAX_PUBLICATIONS_PER_ROLLING_HOUR) {
    reasons.push('rolling_hour_operation_cap');
    nextEligibleCandidates.push(rollingHour[rollingHour.length - MAX_PUBLICATIONS_PER_ROLLING_HOUR] +
      60 * 60 * 1000);
  }
  if (rolling24h.length >= MAX_PUBLICATIONS_PER_24H) {
    reasons.push('rolling_24h_operation_cap');
    nextEligibleCandidates.push(rolling24h[rolling24h.length - MAX_PUBLICATIONS_PER_24H] +
      24 * 60 * 60 * 1000);
  }

  const nextEligibleAt = nextEligibleCandidates.length
    ? Math.max(nowMs, ...nextEligibleCandidates) : null;
  return {
    blocked: reasons.length > 0 && nextEligibleAt > nowMs,
    reasons,
    nextEligibleAt: nextEligibleAt === null ? null : new Date(nextEligibleAt).toISOString(),
    minimumGapMs: MIN_PUBLISH_GAP_MS,
    maxOperationsPerRollingHour: MAX_PUBLICATIONS_PER_ROLLING_HOUR,
    maxOperationsPerRolling24h: MAX_PUBLICATIONS_PER_24H,
    lastOperationAt: latestOperationAt === null ? null : new Date(latestOperationAt).toISOString(),
    rollingHourOperations: rollingHour.length,
    rolling24hOperations: rolling24h.length
  };
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

  const loginPageResponse = await page.goto(BASE + '/login?m=3&r=%2Fupload', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  const loginPageHttpStatus = loginPageResponse ? loginPageResponse.status() : null;
  if (loginPageHttpStatus !== null && loginPageHttpStatus >= 400) {
    throw new Error('filo_login_page_http_' + loginPageHttpStatus);
  }
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
  const uploadRouteResponse = await page.goto(BASE + '/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const uploadRouteHttpStatus = uploadRouteResponse ? uploadRouteResponse.status() : null;
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
    const accessDenied = /دسترسی غیرمجاز|access denied|forbidden/i.test(document.title + ' ' + bodyText);
    return {
      path,
      title: document.title || '',
      hasLogoutLink,
      hasPasswordField,
      hasFileInput,
      hasUploadForm,
      loginPrompt,
      accessDenied
    };
  }).catch(() => ({
    path: new URL(page.url()).pathname,
    title: '',
    hasLogoutLink: false,
    hasPasswordField: false,
    hasFileInput: false,
    hasUploadForm: false,
    loginPrompt: true,
    accessDenied: false
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
  if ((uploadRouteHttpStatus !== null && uploadRouteHttpStatus >= 400) || pageEvidence.accessDenied) {
    throw new Error('filo_upload_route_access_denied:' + JSON.stringify({
      loginPageHttpStatus,
      loginApiHttpStatus: responseStatus,
      uploadRouteHttpStatus,
      pageTitle: String(pageEvidence.title || '').slice(0, 120)
    }));
  }

  const verifiedBy = pageEvidence.hasLogoutLink
    ? 'logout_link'
    : routeHasNoLoginScreen && (hasSessionCookie || pageEvidence.hasFileInput || pageEvidence.hasUploadForm)
      ? 'authenticated_upload_route'
      : null;

  if (!verifiedBy) {
    throw new Error('filo_login_not_confirmed:' + JSON.stringify({
      loginPageHttpStatus,
      loginApiHttpStatus: responseStatus,
      uploadRouteHttpStatus,
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
    loginPageHttpStatus,
    loginApiHttpStatus: responseStatus,
    uploadRouteHttpStatus,
    responseKeys,
    hasSessionCookie
  };
}

function extractCategoryIds(payload) {
  const ids=new Set();
  const categoryKeys=new Set([
    'c','cfs','categories','categoriesforside','categories_for_side',
    'category','categorylist','category_list','maincategories','main_categories',
    'sidecategories','side_categories','categorydata','category_data',
    'categoryitems','category_items'
  ]);
  const wrapperKeys=new Set([
    'data','d','r','result','payload','master','response','content',
    'bind','binding','menu','menus','site','config'
  ]);
  const validId=value=>{
    const raw=String(value==null?'':value).trim();
    if(!/^\d{1,6}$/.test(raw))return null;
    const n=Number(raw);
    return Number.isInteger(n)&&n>0?n:null;
  };
  const visitCollection=(node,depth=0)=>{
    if(!node||depth>8)return;
    if(Array.isArray(node)){
      for(const item of node)visitCollection(item,depth+1);
      return;
    }
    if(typeof node!=='object')return;
    for(const key of ['id','i','category_id','categoryId','categoryID','cid','cat_id','catId','c_id','ci']){
      const id=validId(node[key]);
      if(id!==null){ids.add(id);break;}
    }
    for(const [key,value] of Object.entries(node)){
      const mapId=validId(key);
      if(mapId!==null&&value&&typeof value==='object')ids.add(mapId);
      if(value&&typeof value==='object')visitCollection(value,depth+1);
    }
  };
  const findCollections=(node,depth=0)=>{
    if(!node||depth>6)return;
    if(Array.isArray(node)){
      if(depth===0)visitCollection(node);
      return;
    }
    if(typeof node!=='object')return;
    for(const [key,value] of Object.entries(node)){
      const normalizedKey=String(key).replace(/[-\s]/g,'').toLowerCase();
      if(categoryKeys.has(normalizedKey))visitCollection(value);
      else if(wrapperKeys.has(normalizedKey)&&value&&typeof value==='object')findCollections(value,depth+1);
      else if(value&&typeof value==='object'&&depth<2)findCollections(value,depth+1);
    }
  };
  findCollections(payload);
  return [...ids].sort((a,b)=>a-b);
}

function summarizeCategoryCatalogPayload(payload) {
  const keysOf=value=>value&&typeof value==='object'&&!Array.isArray(value)
    ?Object.keys(value).slice(0,24):[];
  const topLevelKeys=keysOf(payload);
  const nested={};
  for(const key of topLevelKeys.slice(0,16)){
    const value=payload[key];
    if(value&&typeof value==='object'){
      nested[key]=Array.isArray(value)
        ?{
          type:'array',
          length:value.length,
          itemKeys:value.filter(item=>item&&typeof item==='object'&&!Array.isArray(item))
            .slice(0,3).map(item=>Object.keys(item).slice(0,24))
        }
        :{type:'object',keys:keysOf(value).slice(0,20)};
    }
  }
  return {
    rootType:Array.isArray(payload)?'array':payload===null?'null':typeof payload,
    rootArrayLength:Array.isArray(payload)?payload.length:null,
    topLevelKeys,nested
  };
}

async function discoverCategoryCatalog(page) {
  try {
    const payload=await page.evaluate(async()=>{
      const response=await fetch('/api/v1/bind/master',{
        method:'POST',credentials:'include',
        headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded;charset=utf-8'},
        body:'',signal:AbortSignal.timeout(9000)
      });
      if(!response.ok)throw new Error('category_catalog_http_'+response.status);
      return await response.json();
    });
    const shape=summarizeCategoryCatalogPayload(payload);
    const catalogIds=extractCategoryIds(payload);
    const ids=[...new Set([...catalogIds,...FALLBACK_CATEGORY_IDS])].slice(0,MAX_DISCOVERED_CATEGORY_IDS);
    return {
      ids,catalogIds,shape,
      source:catalogIds.length?'filo_bind_master_plus_legacy_fallback':'legacy_fallback',
      error:null
    };
  } catch(error) {
    return {
      ids:[...FALLBACK_CATEGORY_IDS],catalogIds:[],shape:null,source:'legacy_fallback',
      error:String(error&&error.message||error).slice(0,220)
    };
  }
}

function normalizeVideoFeedItem(item) {
  if (!item || typeof item !== 'object') return item;
  const normalized = { ...item };
  const alias = (target, keys) => {
    if (normalized[target] !== undefined && normalized[target] !== null) return;
    for (const key of keys) {
      if (item[key] !== undefined && item[key] !== null) {
        normalized[target] = item[key];
        return;
      }
    }
  };
  alias('video_code', ['videoCode', 'code', 'v']);
  alias('title', ['t']);
  alias('description', ['desc', 'description_text', 'de']);
  alias('category_id', ['categoryId', 'c']);
  alias('duration', ['du']);
  alias('visit_count', ['view_count', 'views', 'vc']);
  alias('play_count', ['plays', 'playCount', 'pd']);
  alias('create_date', ['styled_create_date', 'created_at', 'createdAt', 'created_time', 'create_time', 'published_at', 'publish_date', 'post_date', 'date', 'cd']);
  alias('has_audio', ['hst']);
  alias('can_republish', ['co']);
  alias('can_make_money', ['cr']);
  alias('active', ['ac']);
  return normalized;
}

function extractVideoTagFeeds(payload) {
  const root = parseApiBody(payload) || payload;
  const tags = root && Array.isArray(root.tags) ? root.tags
    : root && root.data && Array.isArray(root.data.tags) ? root.data.tags
    : root && root.d && Array.isArray(root.d.tags) ? root.d.tags
    : root && root.result && Array.isArray(root.result.tags) ? root.result.tags : [];
  const feeds = [];
  const seen = new Set();
  for (const item of tags) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = Object.entries(item).find(([key, label]) =>
      typeof key === 'string' && typeof label === 'string' && label.trim()
    );
    if (!entry) continue;
    const [key, label] = entry;
    const cleanKey = key.trim();
    if (!/^(?:all|\d{1,10}|q-[^/?#]{1,100})$/u.test(cleanKey) || seen.has(cleanKey)) continue;
    seen.add(cleanKey);
    feeds.push({ key: cleanKey, label: label.trim() });
  }
  return feeds;
}

function summarizeVideoTagPayload(payload) {
  const root = parseApiBody(payload) || payload;
  const tags = root && Array.isArray(root.tags) ? root.tags
    : root && root.data && Array.isArray(root.data.tags) ? root.data.tags
    : root && root.d && Array.isArray(root.d.tags) ? root.d.tags : [];
  return {
    rootType: Array.isArray(root) ? 'array' : root === null ? 'null' : typeof root,
    rootKeys: root && typeof root === 'object' && !Array.isArray(root)
      ? Object.keys(root).slice(0, 24) : [],
    tagCount: tags.length,
    tagItemKeys: tags.slice(0, 4).map(item =>
      item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item).slice(0, 4) : []
    )
  };
}

async function discoverVideoTagFeeds(page) {
  try {
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/v1/video/recommend-user-tags', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(9000)
      });
      return {
        status: response.status,
        body: await response.text(),
        contentType: response.headers.get('content-type') || 'unknown'
      };
    });
    if (!result || result.status !== 200) {
      const hint = result ? categoryApiErrorHint(result) : 'empty_response';
      throw new Error('filo_tag_catalog_http_' + (result && result.status) + ':' + hint);
    }
    const payload = parseJson(result.body);
    const feeds = extractVideoTagFeeds(payload);
    if (!feeds.length) throw new Error('filo_tag_catalog_empty');
    return {
      feeds: feeds.slice(0, MAX_DISCOVERED_CATEGORY_IDS),
      source: 'filo_recommend_user_tags',
      error: null,
      shape: summarizeVideoTagPayload(payload)
    };
  } catch (error) {
    return {
      feeds: FALLBACK_VIDEO_TAG_FEEDS.slice(),
      source: 'static_filo_tag_fallback',
      error: String(error && error.message || error).slice(0, 220),
      shape: null
    };
  }
}

function categoryApiErrorHint(result) {
  const parsed = parseJson(result && result.body);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed).slice(0, 12);
    for (const key of ['r', 'message', 'detail', 'error', 'errors', 'reason']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        const safe = value.replace(/[\r\n]+/g, ' ').replace(/https?:\/\/\S+/gi, '[url]').trim();
        if (!/(?:token|password|secret|cookie|authorization|session)/i.test(safe)) {
          return ('message:' + safe.slice(0, 180));
        }
      }
    }
    return 'body_keys:' + keys.join(',');
  }
  const contentType = String(result && result.contentType || 'unknown').split(';')[0].slice(0, 70);
  return 'non_json_body;content_type:' + contentType;
}

function rotatingDepthSelection(categoryIds,cursor,limit=DEPTH_CATEGORIES_PER_CYCLE) {
  const ids=Array.isArray(categoryIds)?categoryIds:[];
  if(!ids.length)return {categoryIds:[],nextCursor:0};
  const start=((num(cursor,0)%ids.length)+ids.length)%ids.length;
  const count=Math.min(ids.length,Math.max(0,Math.trunc(num(limit,DEPTH_CATEGORIES_PER_CYCLE))));
  return {
    categoryIds:Array.from({length:count},(_,index)=>ids[(start+index)%ids.length]),
    nextCursor:(start+count)%ids.length
  };
}

function nextCategoryDepthPage(currentPage) {
  const page=Math.trunc(num(currentPage,2));
  return page>=MAX_PAGES_PER_CATEGORY?2:Math.max(2,page+1);
}

function resolveDepthScanStartPage(currentPage, evidence) {
  let pageNo = Math.trunc(num(currentPage, 2));
  if (pageNo < 2 || pageNo > MAX_PAGES_PER_CATEGORY) pageNo = 2;
  const lastPageNo = Math.trunc(num(evidence && evidence.lastPageNo, 0));
  // Previous runs wrapped page 12 back to page 2 but retained pagination evidence.
  if (pageNo === 2 && lastPageNo >= 12 && lastPageNo < MAX_PAGES_PER_CATEGORY) return lastPageNo + 1;
  if (pageNo > 2 && (!evidence || lastPageNo !== pageNo - 1)) return 2;
  return pageNo;
}

function buildCategoryPageRequestPayload(pageNo, windowWidth) {
  const normalizedWidth = Math.trunc(num(windowWidth, 0));
  return {
    rowCount: 0,
    page: Math.max(1, Math.trunc(num(pageNo, 1))),
    needAllData: 0,
    windowWidth: normalizedWidth > 0 ? normalizedWidth : 1365
  };
}

function buildVideoTagFeedPath(tagKey) {
  const key = String(tagKey || '').trim();
  if (!/^(?:all|\d{1,10}|q-[^/?#]{1,100})$/u.test(key)) {
    throw new Error('filo_tag_key_invalid');
  }
  return '/api/v1/video/ai-tag/' + encodeURIComponent(key);
}

async function fetchCategoryPage(page, categoryId, pageNo) {
  // Match the current Filo VideoSection frontend: POST JSON to /video/ai-tag/{tagKey}.
  const windowWidth = await page.evaluate(() => Number(window.innerWidth) || 1365);
  const requestPayload = buildCategoryPageRequestPayload(pageNo, windowWidth);
  const requestPath = buildVideoTagFeedPath(categoryId);
  const result = await page.evaluate(async ({ requestPath, requestPayload }) => {
    const response = await fetch(requestPath, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify(requestPayload),
      signal: AbortSignal.timeout(9000)
    });
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get('content-type') || 'unknown'
    };
  }, { requestPath, requestPayload });

  if (!result || result.status !== 200) {
    const hint = result ? categoryApiErrorHint(result) : 'empty_response';
    throw new Error(('filo_tag_feed_http_' + (result && result.status) + ':' + hint).slice(0, 260));
  }
  const data = parseApiBody(result.body);
  if (!data) throw new Error('filo_tag_feed_invalid_json');
  const items = Array.isArray(data.items) ? data.items :
    Array.isArray(data.l) ? data.l :
    Array.isArray(data.v) ? data.v : [];
  return items.map(normalizeVideoFeedItem);
}


async function getRepublishDetail(page, code) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let result;
    try {
      result = await page.evaluate(async code => {
        const response = await fetch('/api/v1/republish/' + encodeURIComponent(code), {
          method: 'GET',
          credentials: 'include',
          referrer: location.origin + '/republish/' + encodeURIComponent(code),
          referrerPolicy: 'same-origin',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          },
          cache: 'no-store',
          signal: AbortSignal.timeout(7000)
        });
        return {
          status: response.status,
          body: await response.text(),
          contentType: response.headers.get('content-type') || 'unknown'
        };
      }, code);
    } catch (error) {
      lastError = 'republish_detail_network_error:' + String(error && error.message || error).slice(0, 140);
      if (attempt < 2) {
        await sleep(350 * attempt);
        continue;
      }
      throw new Error(lastError);
    }

    if (!result) throw new Error('republish_detail_empty_response');
    if (result.status !== 200) {
      const disposition = detailFetchHttpDisposition(result.status);
      if (disposition === 'candidate_access_denied') {
        const safeHint = categoryApiErrorHint(result);
        throw new Error('republish_detail_forbidden_403:' + safeHint);
      }
      if (disposition === 'session_expired') throw new Error('republish_detail_session_expired_401');
      lastError = 'republish_detail_http_' + Number(result.status || 0);
      if (disposition === 'retryable' && attempt < 2) {
        await sleep(500 * attempt);
        continue;
      }
      throw new Error(lastError);
    }

    const root = parseApiBody(result.body);
    if (!root || typeof root !== 'object') throw new Error('republish_detail_invalid_json');
    const video = root.republish_video || root.video || null;
    if (!video || typeof video !== 'object') throw new Error('republish_detail_video_missing');
    return { root, video };
  }
  throw new Error(lastError || 'republish_detail_unavailable');
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
    const requestHeaders = request.headers();
    const parsedBody = parseFiloPublishRequestBody(
      request.postData() || '',
      requestHeaders['content-type'] || requestHeaders['Content-Type'] || ''
    );
    const params = parsedBody.params;
    const readParam = (...aliases) => getPublishBodyParam(params, ...aliases);
    const postedFrame = readParam('selectedFrame', 'selected_frame') || '';
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
    if(selectedFrame) {
      params.set('selectedFrame',selectedFrame);
      if (parsedBody.format === 'json') {
        setJsonPublishBodyField(parsedBody.json, 'selectedFrame', selectedFrame);
      }
    } else {
      params.delete('selectedFrame');
    }
    const coverDimensions = imageDimensionsFromDataUrl(selectedFrame);
    const coverAspectRatio = coverDimensions ? coverDimensions.width / coverDimensions.height : 0;
    const coverAspectOk = Boolean(coverDimensions && Math.abs(coverAspectRatio - (16 / 9)) <= 0.02);
    const republishFrom = readParam('republishFrom', 'republish_from', 'sourceCode', 'source_code', 'from_code');
    const videoCode = readParam('videoCode', 'video_code', 'newVideoCode', 'new_video_code');
    const isMadeByMe = readParam('isMadeByMe', 'is_made_by_me');
    const canRepublish = readParam('canRepublish', 'can_republish');
    const canMakeMoney = readParam('canMakeMoney', 'can_make_money');
    const dontPublish = readParam('dontPublish', 'dont_publish', 'do_not_publish');
    const outgoingTitle = readParam('title', 'videoTitle', 'video_title') || '';
    const outgoingDescription = readParam('description', 'videoDescription', 'video_description') || '';
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
      category: readParam('category', 'categoryId', 'category_id') || '',
      selectedFramePresent: frameOk,
      coverStatus: !frameOk ? 'cover_omitted_optional'
        : coverAspectOk ? 'cover_ready_16_9' : 'video_frame_fallback_non_16_9',
      selectedFrameLength: selectedFrame.length,
      selectedFrameType: selectedFrame.slice(0, 40),
      coverSourceDimensions: coverComposition.sourceDimensions || null,
      coverDimensions,
      coverAspectRatio: coverAspectRatio || null,
      coverAspectOk,
      requestBodyFormat: parsedBody.format,
      requestContentType: parsedBody.contentType || null,
      requestBodyKeys: parsedBody.keys.slice(0, 40),
      requestBodyLength: parsedBody.raw.length,
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
    if (parsedBody.format === 'multipart' || parsedBody.format === 'unknown' || parsedBody.format === 'invalid_json') {
      await route.continue();
      return;
    }
    const serializedBody = serializeFiloPublishRequestBody(parsedBody);
    if (serializedBody === null) {
      await route.continue();
      return;
    }
    await route.continue({ postData: serializedBody });
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
      categories: [],
      categoryLabels: {},
      paginationMode: 'rotating_recent_window',
      lookbackHours: CATEGORY_LOOKBACK_HOURS,
      depthCategoriesPerCycle: DEPTH_CATEGORIES_PER_CYCLE,
      depthPagesPerCategoryPerCycle: DEPTH_PAGES_PER_CATEGORY_PER_CYCLE,
      maxPagesPerCategory: MAX_PAGES_PER_CATEGORY,
      maxTotalCategoryPageRequests: MAX_TOTAL_CATEGORY_PAGE_REQUESTS,
      categoryPageConcurrency: CATEGORY_PAGE_CONCURRENCY,
      categoryScanBudgetMs: CATEGORY_SCAN_BUDGET_MS,
      categoryCatalogSource: 'not_loaded',
      categoryCatalogCount: 0,
      categoryCatalogError: null,
      categoryCatalogShape: null,
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
  const platformTrendSnapshot = loadPlatformTrendSnapshot();
  const platformTopicWeights = buildFreshPlatformTrendWeights(
    platformTrendSnapshot, Date.parse(report.createdAt)
  );
  const platformTrendUpdatedAt = Date.parse(
    platformTrendSnapshot && (platformTrendSnapshot.updated_at || platformTrendSnapshot.updatedAt) || ''
  );
  report.discovery.crossPlatformTrendSignals = {
    source: PLATFORM_TRENDS_PATH,
    snapshotAvailable: Boolean(platformTrendSnapshot),
    snapshotUpdatedAt: Number.isFinite(platformTrendUpdatedAt)
      ? new Date(platformTrendUpdatedAt).toISOString() : null,
    snapshotAgeMinutes: Number.isFinite(platformTrendUpdatedAt)
      ? Math.round((Date.parse(report.createdAt) - platformTrendUpdatedAt) / 60000) : null,
    weightsAvailable: Object.keys(platformTopicWeights).length > 0,
    activeTopicCount: Object.keys(platformTopicWeights).length,
    topTopics: Object.entries(platformTopicWeights)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 8)
      .map(([topic, score]) => ({ topic, score }))
  };
  let browser;

  try {
    const previousCycleStartedAt = state.lastCycleStartedAt || null;
    if (!shouldStartPublishingCycle(previousCycleStartedAt, Date.parse(report.createdAt))) {
      report.status = 'cycle_throttled';
      report.cycleThrottle = {
        minimumIntervalMs: MIN_CYCLE_INTERVAL_MS,
        previousCycleStartedAt,
        note: 'A more recent Filo cycle already started; this overlapping scheduler trigger was safely skipped.'
      };
      report.result = {
        status: report.status,
        reason: 'minimum_cycle_interval_not_elapsed',
        retryOnNextScheduledRun: true
      };
      return;
    }
    state.lastCycleStartedAt = report.createdAt;
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');

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
    const categoryCatalog = await discoverVideoTagFeeds(page);
    const tagByKey = new Map(categoryCatalog.feeds.map(feed => [feed.key, feed]));
    report.discovery.categories = categoryCatalog.feeds.map(feed => feed.key);
    report.discovery.categoryLabels = Object.fromEntries(categoryCatalog.feeds.map(feed => [feed.key, feed.label]));
    report.discovery.categoryCatalogSource = categoryCatalog.source;
    report.discovery.categoryCatalogCount = categoryCatalog.feeds.length;
    report.discovery.categoryCatalogError = categoryCatalog.error;
    report.discovery.categoryCatalogShape = categoryCatalog.shape || null;
    const byCode = new Map();
    const categoryScanStartedAt = Date.now();
    const categoryTrackers = categoryCatalog.feeds.map(feed => ({
      categoryId:feed.key,categoryLabel:feed.label,pagesFetched:0,scannedItems:0,newestAgeHours:null,oldestAgeHours:null,
      chronologyVerified:false,depthPageNo:null,stopReason:'first_page_pending',coverageComplete:false
    }));
    const trackerById=new Map(categoryTrackers.map(tracker=>[String(tracker.categoryId),tracker]));
    const firstPageAnalysis=new Map();
    let totalCategoryPageRequests=0;
    let paginationStopReason=null;

    const ingestItems=(items,tagKey)=>{
      const feed = tagByKey.get(String(tagKey));
      for(const rawItem of items||[]){
        if(!rawItem||typeof rawItem!=='object')continue;
        const item=normalizeVideoFeedItem(rawItem);
        const code=String(item.video_code||item.videoCode||item.code||'');
        if(!code)continue;
        const candidate={...item,video_code:code,feed_tag:String(tagKey),
          feed_tag_label:feed&&feed.label||String(tagKey)};
        const existing=byCode.get(code);
        if(!existing){byCode.set(code,candidate);continue;}
        const mergedTags=[...new Set([...(existing.feed_tags||[existing.feed_tag]),tagKey].filter(Boolean))];
        const preferredTag=existing.feed_tag&&existing.feed_tag!=='all'
          ?existing.feed_tag:(tagKey!=='all'?tagKey:existing.feed_tag||tagKey);
        const preferredFeed=tagByKey.get(String(preferredTag));
        const chosen=num(candidate.visit_count)+num(candidate.play_count)>
          num(existing.visit_count)+num(existing.play_count)?candidate:existing;
        byCode.set(code,{...chosen,feed_tag:String(preferredTag),
          feed_tag_label:preferredFeed&&preferredFeed.label||chosen.feed_tag_label,feed_tags:mergedTags});
      }
    };

    const scanTasks=async tasks=>{
      const results=[];
      for(let offset=0;offset<tasks.length;offset+=CATEGORY_PAGE_CONCURRENCY){
        if(totalCategoryPageRequests>=MAX_TOTAL_CATEGORY_PAGE_REQUESTS){
          paginationStopReason='global_page_request_cap';break;
        }
        if(Date.now()-categoryScanStartedAt>=CATEGORY_SCAN_BUDGET_MS){
          paginationStopReason='discovery_time_budget';break;
        }
        const remaining=MAX_TOTAL_CATEGORY_PAGE_REQUESTS-totalCategoryPageRequests;
        const batch=tasks.slice(offset,offset+Math.min(CATEGORY_PAGE_CONCURRENCY,remaining));
        if(!batch.length){paginationStopReason='global_page_request_cap';break;}
        totalCategoryPageRequests+=batch.length;
        report.discovery.categoryPagesAttempted=totalCategoryPageRequests;
        const batchResults=await Promise.all(batch.map(async task=>{
          try{return {...task,items:await fetchCategoryPage(page,task.categoryId,task.pageNo),error:null};}
          catch(error){return {...task,items:null,error:String(error&&error.message||error).slice(0,240)};}
        }));
        results.push(...batchResults);
      }
      return results;
    };

    // Refresh page one for every category each cycle to preserve timely growth samples.
    const firstPageResults=await scanTasks(categoryCatalog.feeds.map(feed=>({
      categoryId:feed.key,pageNo:1,scanType:'first'
    })));
    for(const result of firstPageResults){
      const tracker=trackerById.get(String(result.categoryId));
      if(!tracker)continue;
      if(result.error){
        tracker.stopReason='first_page_error';
        report.discovery.errors.push({categoryId:result.categoryId,pageNo:1,error:result.error});
        continue;
      }
      const items=result.items||[];
      const analysis=analyzeCategoryFeedPage(items,Date.parse(report.createdAt));
      firstPageAnalysis.set(String(result.categoryId),analysis);
      tracker.pagesFetched++;
      tracker.scannedItems+=items.length;
      report.discovery.scannedItems+=items.length;
      tracker.newestAgeHours=analysis.newestAgeHours;
      tracker.oldestAgeHours=analysis.oldestAgeHours;
      tracker.chronologyVerified=analysis.chronologyConsistent;
      ingestItems(items,result.categoryId);
      tracker.stopReason=items.length?'first_page_scanned':'empty_first_page';
      tracker.coverageComplete=items.length===0;
    }

    // Scan up to three consecutive deep pages for each selected category per cycle.
    const depthSelection=rotatingDepthSelection(
      categoryCatalog.feeds.map(feed=>feed.key),state.categoryDepthCursor||0,DEPTH_CATEGORIES_PER_CYCLE
    );
    state.categoryDepthCursor=depthSelection.nextCursor;
    if(!state.categoryDepthPages||typeof state.categoryDepthPages!=='object')state.categoryDepthPages={};
    if(!state.categoryDepthEvidence||typeof state.categoryDepthEvidence!=='object')state.categoryDepthEvidence={};
    const nextDepthPageByCategory=new Map();
    for(const categoryId of depthSelection.categoryIds){
      const tracker=trackerById.get(String(categoryId));
      if(!tracker||tracker.stopReason==='empty_first_page'||!firstPageAnalysis.has(String(categoryId)))continue;
      const categoryKey=String(categoryId);
      const evidence=state.categoryDepthEvidence[categoryKey];
      const pageNo=resolveDepthScanStartPage(state.categoryDepthPages[categoryKey],evidence);
      state.categoryDepthPages[categoryKey]=pageNo;
      if(pageNo===2 && evidence && Math.trunc(num(evidence.lastPageNo,0))!==1){
        delete state.categoryDepthEvidence[categoryKey];
      }
      nextDepthPageByCategory.set(categoryKey,pageNo);
    }

    const depthResults=[];
    for(let round=0;round<DEPTH_PAGES_PER_CATEGORY_PER_CYCLE;round++){
      const depthTasks=[...nextDepthPageByCategory.entries()].map(([categoryId,pageNo])=>({
        categoryId,pageNo,scanType:'depth'
      }));
      if(!depthTasks.length)break;
      const roundResults=await scanTasks(depthTasks);
      depthResults.push(...roundResults);
      for(const result of roundResults){
        const pageKey=String(result.categoryId);
        const tracker=trackerById.get(pageKey);
        if(!tracker)continue;
        if(result.error){
          tracker.stopReason='depth_page_error';
          state.categoryDepthPages[pageKey]=result.pageNo;
          nextDepthPageByCategory.delete(pageKey);
          report.discovery.errors.push({categoryId:result.categoryId,pageNo:result.pageNo,error:result.error});
          continue;
        }

        const items=result.items||[];
        const analysis=analyzeCategoryFeedPage(items,Date.parse(report.createdAt));
        tracker.pagesFetched++;
        tracker.scannedItems+=items.length;
        report.discovery.scannedItems+=items.length;
        tracker.depthPageNo=result.pageNo;
        if(analysis.newestAgeHours!==null)tracker.newestAgeHours=tracker.newestAgeHours===null
          ?analysis.newestAgeHours:Math.min(tracker.newestAgeHours,analysis.newestAgeHours);
        if(analysis.oldestAgeHours!==null)tracker.oldestAgeHours=tracker.oldestAgeHours===null
          ?analysis.oldestAgeHours:Math.max(tracker.oldestAgeHours,analysis.oldestAgeHours);
        ingestItems(items,result.categoryId);

        if(!items.length){
          state.categoryDepthPages[pageKey]=2;
          delete state.categoryDepthEvidence[pageKey];
          tracker.stopReason='empty_depth_page';
          tracker.coverageComplete=true;
          nextDepthPageByCategory.delete(pageKey);
          continue;
        }

        const previousEvidence=state.categoryDepthEvidence[pageKey]||null;
        const previousAgeBounds=result.pageNo===2
          ?(firstPageAnalysis.get(pageKey)||{}).lastAgeBounds
          :previousEvidence&&previousEvidence.lastPageNo===result.pageNo-1?previousEvidence.lastAgeBounds:null;
        const previousChronologyVerified=result.pageNo===2
          ?Boolean((firstPageAnalysis.get(pageKey)||{}).chronologyConsistent)
          :Boolean(previousEvidence&&previousEvidence.lastPageNo===result.pageNo-1&&previousEvidence.chronologyVerified);
        const boundaryOrdered=categoryFeedBoundaryOrdered(previousAgeBounds,analysis.firstAgeBounds);
        const chronologyVerified=Boolean(analysis.chronologyConsistent&&previousChronologyVerified&&boundaryOrdered);
        tracker.chronologyVerified=chronologyVerified;
        state.categoryDepthEvidence[pageKey]={
          lastPageNo:result.pageNo,lastAgeBounds:analysis.lastAgeBounds,chronologyVerified
        };

        if(shouldStopCategoryPagination({
          pageCount:result.pageNo,pageAnalysis:analysis,chronologyVerified,
          lookbackHours:CATEGORY_LOOKBACK_HOURS
        })){
          state.categoryDepthPages[pageKey]=2;
          delete state.categoryDepthEvidence[pageKey];
          tracker.stopReason='lookback_window_reached';
          tracker.coverageComplete=true;
          nextDepthPageByCategory.delete(pageKey);
        }else if(result.pageNo>=MAX_PAGES_PER_CATEGORY){
          state.categoryDepthPages[pageKey]=2;
          delete state.categoryDepthEvidence[pageKey];
          tracker.stopReason='max_pages_per_category_cycle';
          nextDepthPageByCategory.delete(pageKey);
        }else{
          const nextPageNo=nextCategoryDepthPage(result.pageNo);
          state.categoryDepthPages[pageKey]=nextPageNo;
          tracker.stopReason='depth_page_scanned';
          nextDepthPageByCategory.set(pageKey,nextPageNo);
        }
      }
      if(roundResults.length<depthTasks.length)break;
    }

    for(const [categoryId] of nextDepthPageByCategory){
      const tracker=trackerById.get(categoryId);
      if(tracker&&tracker.stopReason==='first_page_scanned')tracker.stopReason='depth_scan_deferred_or_incomplete';
    }

    for(const tracker of categoryTrackers){
      if(tracker.stopReason==='first_page_pending')tracker.stopReason='first_page_not_scanned';
    }
    report.discovery.categoryScanElapsedMs=Date.now()-categoryScanStartedAt;
    report.discovery.paginationStopReason=paginationStopReason;
    report.discovery.categoryScan=categoryTrackers.map(tracker=>({
      categoryId:tracker.categoryId,categoryLabel:tracker.categoryLabel,
      pagesFetched:tracker.pagesFetched,scannedItems:tracker.scannedItems,
      newestAgeHours:tracker.newestAgeHours,oldestAgeHours:tracker.oldestAgeHours,
      chronologyVerified:tracker.chronologyVerified,deepPageNo:tracker.depthPageNo,
      stopReason:tracker.stopReason,coverageComplete:tracker.coverageComplete
    }));
    report.discovery.categoryCoverage={
      categoriesTotal:categoryTrackers.length,
      categoriesWithFirstPage:categoryTrackers.filter(x=>x.pagesFetched>=1).length,
      firstPageCoverageComplete:categoryTrackers.every(x=>x.pagesFetched>=1||x.stopReason==='empty_first_page'),
      depthPageRequests:depthResults.length,
      depthPagesSucceeded:depthResults.filter(x=>!x.error).length,
      categoriesPastLookback:categoryTrackers.filter(x=>x.stopReason==='lookback_window_reached').length,
      categoriesExhausted:categoryTrackers.filter(x=>x.stopReason==='empty_depth_page'||x.stopReason==='empty_first_page').length,
      categoriesAtPageCap:categoryTrackers.filter(x=>x.stopReason==='max_pages_per_category_cycle').length,
      categoriesWithPageErrors:categoryTrackers.filter(x=>x.stopReason==='first_page_error'||x.stopReason==='depth_page_error').length,
      complete24HourCoverage:categoryTrackers.every(x=>x.coverageComplete)
    };

    const discoveredItems = [...byCode.values()];
    const cycleAt = Date.parse(report.createdAt);
    const currentMomentumRates = updateCandidateMomentum(state, discoveredItems, cycleAt);
    report.discovery.catalog24h = update24HourCandidateCatalog(state, discoveredItems, cycleAt);
    report.discovery.catalog24h.coverageComplete = Boolean(
      report.discovery.categoryCoverage &&
      report.discovery.categoryCoverage.complete24HourCoverage === true
    );
    report.discovery.feedGateSignals = summarizeFeedGateSignals(discoveredItems, state);
    const feedCandidates = discoveredItems.filter(item => feedCandidateEligible(item, state));
    report.discovery.eligibleFeedItems = feedCandidates.length;

    const ranked = rankCandidatesByMomentum(
      feedCandidates, state, cycleAt, platformTopicWeights, currentMomentumRates
    );
    const accelerationQualified = ranked.filter(entry =>
      entry.accelerationEvidence && entry.accelerationEvidence.passed
    );
    report.discovery.rankedCandidates = ranked.length;
    report.discovery.measuredCandidates = ranked.filter(entry => entry.hasMeasuredGrowth).length;
    report.discovery.accelerationFilter = {
      mode: 'positive_velocity_required_acceleration_rank_bonus',
      minimumIndependentSamples: MIN_ACCELERATION_SAMPLES,
      candidatesEvaluated: ranked.length,
      candidatesWithMeasuredGrowth: ranked.filter(entry => entry.hasMeasuredGrowth).length,
      candidatesPassingVelocityGate: accelerationQualified.length,
      candidatesWithZeroPlayCounterStalled: ranked.filter(entry =>
        entry.playCounterZeroStalled === true
      ).length,
      candidatesUsingZeroPlayViewFallback: accelerationQualified.filter(entry =>
        entry.accelerationEvidence.metric === 'views' && entry.playCounterZeroStalled === true
      ).length,
      candidatesWithInsufficientSamples: ranked.filter(entry =>
        entry.accelerationEvidence.reason === 'insufficient_independent_samples'
      ).length,
      candidatesWithPositiveVelocityButNoPositiveAcceleration: ranked.filter(entry =>
        ['positive_play_velocity_without_acceleration',
          'positive_view_velocity_without_acceleration',
          'positive_view_velocity_zero_play_counter_stalled'].includes(
          entry.accelerationEvidence.reason
        )
      ).length,
      accelerationQualifiedCandidates: accelerationQualified.length,
      cumulativeOnlyFallbackExcluded: ranked.filter(entry =>
        ['cumulative_play_fallback', 'cumulative_view_fallback', 'freshness_fallback'].includes(
          entry.selectionMode
        )
      ).length,
      fallbackToCumulativeCountsAllowedForPublication: false
    };
    report.discovery.accelerationQualifiedCandidates = accelerationQualified.length;
    report.discovery.selectionFallbackUsed = false;
    report.discovery.topMomentum = ranked.slice(0, 5).map(entry => ({
      code: String(entry.item.video_code),
      selectionMode: entry.selectionMode,
      growthGatePassed: entry.growthGatePassed === true,
      accelerationBonusActive: entry.hasPositiveAcceleration,
      accelerationEvidence: entry.accelerationEvidence,
      playCounterZeroStalled: entry.playCounterZeroStalled === true,
      feedHintScore: entry.feedHintScore,
      cumulativePlays: entry.playMetric.value,
      cumulativeViews: entry.viewMetric.value,
      rankingMetric: entry.rankingMetric,
      hasPlayCounter: entry.momentum.playCounterPresent === true,
      playsPerMinute: entry.momentum.playsPerMinute,
      playAccelerationPerMinute: entry.momentum.playsAccelerationPerMinute || 0,
      viewsPerMinute: entry.momentum.viewsPerMinute,
      viewAccelerationPerMinute: entry.momentum.viewsAccelerationPerMinute ?? entry.momentum.accelerationPerMinute ?? 0,
      audienceFit: entry.audienceFit,
      feedTag: entry.item.feed_tag || null,
      feedTagLabel: entry.item.feed_tag_label || null,
      topicLabel: entry.topicLabel,
      topicDemandScore: entry.topicDemandScore,
      externalTopicKey: entry.externalTopicKey,
      externalTopicTrendScore: entry.externalTopicTrendScore,
      topicCandidateCount: entry.topicCandidateCount,
      topicGrowingCandidateCount: entry.topicGrowingCandidateCount,
      durationPreferenceScore: entry.durationPreferenceScore,
      momentumScore: Math.round(entry.momentumScore * 100) / 100,
      rankingScore: entry.rankingScore,
      ageHours: entry.ageHours
    }));
    report.discovery.topVelocityQualified = accelerationQualified.slice(0, 10).map(entry => ({
      code: String(entry.item.video_code),
      title: String(entry.item.title || '').slice(0, 160),
      metric: entry.accelerationEvidence.metric,
      playCounterZeroStalled: entry.playCounterZeroStalled === true,
      fallbackReason: entry.accelerationEvidence.fallbackReason || null,
      velocityPerMinute: entry.accelerationEvidence.velocityPerMinute,
      accelerationPerMinute: entry.accelerationEvidence.accelerationPerMinute,
      sampleCount: entry.accelerationEvidence.sampleCount,
      ageHours: entry.ageHours,
      category: entry.item.feed_tag_label || entry.item.feed_tag || null
    }));
    report.discovery.topicDemandSummary = [...new Map(ranked.map(entry => [entry.topicKey, {
      topicKey: entry.topicKey,
      topicLabel: entry.topicLabel,
      externalTopicKey: entry.externalTopicKey,
      externalTopicTrendScore: entry.externalTopicTrendScore,
      demandScore: entry.topicDemandScore,
      candidateCount: entry.topicCandidateCount,
      growingCandidateCount: entry.topicGrowingCandidateCount,
      averageVelocity: entry.topicAverageVelocity,
      averageAcceleration: entry.topicAverageAcceleration
    }])).values()]
      .sort((a, b) => b.demandScore - a.demandScore || b.candidateCount - a.candidateCount)
      .slice(0, 12);
    const quotaCheckAt = Date.parse(report.createdAt);
    const activeAccountQuotaCooldown = getAccountRepublishQuotaCooldown(state, quotaCheckAt);
    const legacy403ProbeCode = activeAccountQuotaCooldown || !accelerationQualified.length
      ? null
      : releaseOneLegacy403CacheForAccountQuotaProbe(state, accelerationQualified, quotaCheckAt);
    report.discovery.legacy403QuotaProbeTriggered = Boolean(legacy403ProbeCode);
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');

    if (!ranked.length) {
      report.status = feedCandidates.length ? 'no_recent_feed_candidates' : 'no_feed_candidates_after_safety_filters';
      report.result = {
        status: report.status,
        reason: feedCandidates.length
          ? 'no_candidate_has_reliable_age_metadata_within_the_24_hour_window'
          : 'all_discovered_items_failed_code_deduplication_or_content_safety_prefilters',
        retryOnNextScheduledRun: true
      };
      return;
    }

    if (activeAccountQuotaCooldown) {
      report.discovery.globalGateBlock = 'filo_account_republish_quota_cooldown';
      report.discovery.globalGateRetryAfterAt = activeAccountQuotaCooldown.retryAfterAt;
      report.status = 'filo_global_publish_gate_blocked';
      report.result = {
        status: report.status,
        reason: 'Filo reported the account repost quota is exhausted; fresh feed discovery and momentum sampling continue, but detail and publish requests are deferred during the cooldown',
        retryAfterAt: activeAccountQuotaCooldown.retryAfterAt,
        retryOnNextScheduledRun: true,
        discoveryContinues: true
      };
      return;
    }

    if (!accelerationQualified.length) {
      report.status = 'no_candidate_passed_measured_velocity_gate';
      report.result = {
        status: report.status,
        reason: 'No candidate had at least three independent metric samples and positive measured velocity; cumulative counts are not accepted as a publication fallback.',
        retryOnNextScheduledRun: true,
        discoveryContinues: true
      };
      return;
    }

    const publicationPacing = getPublicationPacingGate(state, quotaCheckAt);
    report.discovery.publicationPacing = publicationPacing;
    report.discovery.dailyPublicationOperationCount = dailyCount(state, quotaCheckAt);
    if (publicationPacing.blocked) {
      report.status = 'filo_publication_pacing_deferred';
      report.result = {
        status: report.status,
        reason: publicationPacing.reasons.join(','),
        retryAfterAt: publicationPacing.nextEligibleAt,
        retryOnNextScheduledRun: true,
        discoveryContinues: true
      };
      return;
    }

    let selected = null;
    let result = null;
    const checked = [];
    const filoRejections = [];
    const MAX_CONFIRMED_FILO_REJECTIONS_PER_CYCLE = 3;
    for (const entry of accelerationQualified.slice(0, MAX_DETAIL_CHECKS)) {
      const code = entry.item.video_code;
      const cachedAccessRejection = getCachedDetailAccessRejection(state,code,Date.parse(report.createdAt));
      if(cachedAccessRejection){
        checked.push({
          code,sourceTitle:String(entry.item.title||'').slice(0,180),
          feedTag:entry.item.feed_tag||null,detailFetchError:'republish_detail_forbidden_403',
          gate:'republish_detail_access_denied_403_cached',
          retryAfterAt:cachedAccessRejection.retryAfterAt
        });
        continue;
      }
      let detail = null;
      let detailFetchError = null;
      try {
        detail = await getRepublishDetail(page, code);
      } catch (error) {
        detailFetchError = String(error && error.message || error).slice(0, 180);
      }
      const check = {
        code, rankingMetric: entry.rankingMetric, selectionMode: entry.selectionMode,
        playsPerMinute: entry.momentum.playsPerMinute, viewsPerMinute: entry.momentum.viewsPerMinute,
        ageHours: entry.ageHours,
        sourceTitle: String(detail && detail.video && detail.video.title || entry.item.title || '').slice(0, 180),
        feedTag: entry.item.feed_tag || null, detailFetchError, gate: null
      };
      if (!detail && detailFetchError && isAccountRepublishQuotaMessage(detailFetchError)) {
        const cooldown = setAccountRepublishQuotaCooldown(state, Date.parse(report.createdAt));
        check.gate = 'filo_account_republish_quota_reached';
        check.detailFetchDisposition = 'global_account_quota_block';
        check.retryAfterAt = cooldown && cooldown.retryAfterAt || null;
        checked.push(check);
        report.discovery.globalGateBlock = 'filo_account_republish_quota_reached';
        report.discovery.globalGateRetryAfterAt = check.retryAfterAt;
        break;
      }
      if(!detail&&detailFetchError&&detailFetchError.startsWith('republish_detail_forbidden_403')){
        const retryAt=Date.parse(report.createdAt)+6*60*60*1000;
        cacheCandidateRejection(state,code,entry.item,'detail_fetch:forbidden_403',Date.parse(report.createdAt),6*60*60*1000);
        check.gate='republish_detail_access_denied_403';
        check.detailFetchDisposition='candidate_specific_forbidden';
        check.retryAfterAt=new Date(retryAt).toISOString();
        checked.push(check);
        continue;
      }
      if(!detail&&detailFetchError==='republish_detail_session_expired_401'){
        check.gate='filo_session_expired_401';
        check.detailFetchDisposition='global_session_failure';
        checked.push(check);
        report.discovery.globalGateBlock='filo_session_expired_401';
        break;
      }
      if (detail && detail.video) {
        const cachedRejection = getCachedCandidateRejection(state, code, detail.video, Date.parse(report.createdAt));
        if (cachedRejection) {
          check.gate = 'cached_candidate_rejection';
          check.cachedReason = cachedRejection.reason;
          check.retryAfterAt = cachedRejection.retryAfterAt;
          checked.push(check);
          continue;
        }
      }
      const gate = detail ? detailGate(detail.root, detail.video) : { eligible: false, reason: detailFetchError ? 'republish_detail_fetch_failed' : 'republish_detail_unavailable' };
      check.gate = gate.reason;
      checked.push(check);
      if (!gate.eligible) {
        const globalBlockReasons = new Set([
          'filo_republish_route_not_allowed',
          'filo_upload_temporarily_stopped',
          'filo_daily_upload_limit_reached',
          'filo_session_expired_401'
        ]);
        if (globalBlockReasons.has(gate.reason)) {
          report.discovery.globalGateBlock = gate.reason;
          break;
        }
        if (detail && detail.video && gate.reason !== 'republish_detail_missing') {
          cacheCandidateRejection(
            state, code, detail.video, 'detail_gate:' + gate.reason,
            Date.parse(report.createdAt), 60 * 60 * 1000
          );
          if (!Array.isArray(report.discovery.detailGateRejections)) report.discovery.detailGateRejections = [];
          report.discovery.detailGateRejections.push({ code, reason: gate.reason });
        }
        continue;
      }

      let candidateMetadata;
      try {
        candidateMetadata = createRepostMetadata(detail.video, code);
      } catch (error) {
        check.gate = 'metadata_not_compliant';
        check.metadataError = String(error && error.message || error).slice(0, 160);
        cacheCandidateRejection(state,code,detail.video,check.metadataError,Date.parse(report.createdAt));
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

      const candidate = { ...entry.item, editorialScore: entry.rankingScore, scoreDetails: entry.momentum, momentum: entry.momentum, rankingMetric: entry.rankingMetric, selectionMode: entry.selectionMode, audienceFit: entry.audienceFit, ageHours: entry.ageHours, detail };
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

      if (markMetadataPolicyRetry(state, candidate.video_code, Date.parse(report.createdAt))) {
        check.metadataPolicyRetryAttempted = true;
      }
      if(isCandidateLevelFiloRejection(attemptResult)){
        const validationMessage = (attemptResult.responseDiagnostics &&
          Array.isArray(attemptResult.responseDiagnostics.uiErrors)
          ? attemptResult.responseDiagnostics.uiErrors : []).find(isMetadataValidationRejectionReason);
        const rejection={
          sourceCode:candidate.video_code,
          score:candidate.editorialScore,
          reason:validationMessage || attemptResult.reason||'filo_publish_not_accepted',
          httpStatus:attemptResult.httpStatus,
          responseDiagnostics:attemptResult.responseDiagnostics||null,
          attemptedAt:new Date().toISOString()
        };
        filoRejections.push(rejection);
        cacheCandidateRejection(state,candidate.video_code,candidate.detail.video,rejection.reason,Date.parse(report.createdAt));
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
    report.discovery.checkedCandidateSummary = summarizeCandidateChecks(checked);
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
    state.posts=state.posts.slice(-1200);
    state.updatedAt=new Date().toISOString();
    // Persist momentum, depth rotation and metadata cooldowns together.
    fs.writeFileSync(STATE_PATH,JSON.stringify(state,null,2)+'\n','utf8');
    if (!selected) {
      report.status = report.discovery.globalGateBlock ? 'filo_global_publish_gate_blocked' : 'no_candidate_published_this_cycle';
      report.result = {
        status: report.status,
        reason: report.discovery.globalGateBlock
          ? report.discovery.globalGateBlock
          : filoRejections.length
            ? 'Filo explicitly rejected the checked candidates; the slot was closed safely and will retry on the next scheduled run'
            : 'no_candidate_passed_authoritative_native_permission_and_metadata_gates',
        checkedCandidates: checked.length,
        checkedCandidateSummary: report.discovery.checkedCandidateSummary,
        detailGateRejections: report.discovery.detailGateRejections || [],
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
      rankingMetric: selected.rankingMetric,
      selectionMode: selected.selectionMode,
      audienceFit: selected.audienceFit,
      feedTag: selected.feed_tag || null,
      feedTagLabel: selected.feed_tag_label || null,
      topicLabel: selected.topicLabel,
      externalTopicKey: selected.externalTopicKey,
      externalTopicTrendScore: selected.externalTopicTrendScore,
      topicDemandScore: selected.topicDemandScore,
      topicCandidateCount: selected.topicCandidateCount,
      topicGrowingCandidateCount: selected.topicGrowingCandidateCount,
      durationPreferenceScore: selected.durationPreferenceScore,
      momentumScore: Math.round(selected.momentumScore * 100) / 100,
      rankingScore: selected.rankingScore,
      playCounterPresent: selected.momentum.playCounterPresent === true,
      playsPerMinute: selected.momentum.playsPerMinute,
      playAccelerationPerMinute: selected.momentum.playsAccelerationPerMinute || 0,
      viewsPerMinute: selected.momentum.viewsPerMinute,
      viewAccelerationPerMinute: selected.momentum.viewsAccelerationPerMinute ?? selected.momentum.accelerationPerMinute ?? 0,
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
        feedTag: selected.feed_tag || null,
        feedTagLabel: selected.feed_tag_label || null,
        externalTopicKey: selected.externalTopicKey,
        externalTopicTrendScore: selected.externalTopicTrendScore,
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
      feedGateSignals: report.discovery.feedGateSignals,
      detailGateRejections: (report.discovery.detailGateRejections || []).slice(0, 10),
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
  shouldStartPublishingCycle,
  ageHours,
  feedCandidateEligible,
  isMetadataValidationRejectionReason,
  hasRetryableMetadataRejection,
  isSourceAlreadyAttempted,
  markMetadataPolicyRetry,
  feedGateHintScore,
  summarizeFeedGateSignals,
  summarizeCandidateChecks,
  fitFiloTitleLength,
  cleanRepostCaptionTitle,
  cleanRepostDescription,
  policyTextRiskReason,
  imageDimensionsFromDataUrl,
  rankCandidatesByMomentum,
  createRepostMetadata,
  normalizeComparable,
  detailGate,
  buildNativePublishGuardFailures,
  detailFetchHttpDisposition,
  isAccountRepublishQuotaMessage,
  setAccountRepublishQuotaCooldown,
  getAccountRepublishQuotaCooldown,
  releaseOneLegacy403CacheForAccountQuotaProbe,
  durationPreferenceScore,
  summarizeTopicDemand,
  buildFreshPlatformTrendWeights,
  candidateExternalTopicKey,
  getCachedDetailAccessRejection,
  jalaliDateToGregorianTimestamp,
  editorialTitleQualityReason,
  parseFiloPublishRequestBody,
  parseMultipartPublishBody,
  getPublishBodyParam,
  serializeFiloPublishRequestBody,
  setJsonPublishBodyField,
  safeApiDiagnosticValue,
  categoryApiErrorHint,
  buildUnconfirmedSubmissionResult,
  composeFiloCoverDataUrl,
  dailyCount,
  getPublicationOperationTimes,
  getPublicationPacingGate,
  buildCategoryPageRequestPayload,
  buildVideoTagFeedPath,
  normalizeVideoFeedItem,
  extractVideoTagFeeds,
  summarizeVideoTagPayload,
  candidateMetricValue,
  candidateMetricSnapshot,
  updateCandidateMomentum,
  update24HourCandidateCatalog,
  candidateAccelerationEvidence,
  classifyAudienceFit,
  extractCategoryIds,
  summarizeCategoryCatalogPayload,
  rotatingDepthSelection,
  nextCategoryDepthPage,
  resolveDepthScanStartPage,
  candidateMetadataFingerprint,
  getCachedCandidateRejection,
  isTitleRewriteRejectionReason,
  cacheCandidateRejection,
  removeRepeatedTrailingPhrase,
  discoverCategoryCatalog,
  reliableFeedAgeBounds,
  analyzeCategoryFeedPage,
  categoryFeedBoundaryOrdered,
  shouldStopCategoryPagination,
  editorialTitleTokens,
  characterBigramDice,
  createDistinctRepostTitle,
  descriptionBasedTitleCandidate,
  topicDuplicateMatch,
  isCandidateLevelFiloRejection
};
