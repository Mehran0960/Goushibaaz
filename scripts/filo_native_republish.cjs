'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fetchIranGoogleTrends, scoreGoogleTrendRelevance } = require('./google_trends_iran.cjs');
const { queryTokens, normalizePersian } = require('./filo_global_search.cjs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const BASE = 'https://ifilo.net';
const STATE_PATH = path.join('state', 'filo-native-republished.json');
const REPORT_PATH = path.join('out', 'filo-native-republish.json');
const CATEGORY_IDS = [6, 11, 13, 29, 2, 22, 17, 25, 15, 3];
const PAGES_PER_CATEGORY = 3;
const MAX_DETAIL_CHECKS = 90;
const MIN_DURATION_SECONDS = 10;
const MAX_DURATION_SECONDS = 180;
const MAX_PUBLICATIONS_PER_24H = 288;

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

const EXCLUDED = /(?:اخبار|خبر فوری|تحلیل سیاسی|سیاست|سیاسی|انتخابات|جنگ|حمله نظامی|موشک|انفجار|تروریست|ترور|اعدام|شلیک|سلاح|خشونت|مداحی|تبلیغات|کازینو|شرط.?بندی|قمار|محتوای بزرگسال|پورنو|قتل|خودکشی|خودآزاری|صحنه دلخراش|تصادف مرگبار|حیوان.?آزاری|رقص|حرکات موزون|تک.?خوانی.{0,8}زن|خوانندگی.{0,8}زن|فحاشی|الفاظ رکیک|افترا|تهمت|توهین|ناسزا|بددهنی|تحقیر|تمسخر|دوربین.?مداربسته|فیلم.?برداری.?مخفی|افشای اطلاعات|کد ملی|خبر جعلی|اطلاعات نادرست|فیلم سینمایی|فیلم ایرانی|سریال|مجموعه تلویزیونی|محصول نمایش خانگی|شبکه نمایش خانگی|صدا.?و.?سیما|فیلیمو|نماوا|فیلم.?نت|تلوبیون|آی.?آر.?مووی|IR.?Movie|مواد مخدر|مشروبات الکلی|برهنگی|محتوای جنسی)/i;
const POLICY_TEXT_RISKS = [
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
  if (text.length < 8 || policyTextRiskReason(item)) return false;
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
  return text.length >= 8 && !policyTextRiskReason(item);
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


function loadGlobalSearchCache(currentTrends = [], now = Date.now()) {
  const file = path.join('state', 'filo-global-search-candidates.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const updatedAtMs = Date.parse(saved.updatedAt || '');
    const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : Infinity;
    if (ageMs > 36 * 60 * 60 * 1000) {
      return { status: 'stale', items: [], updatedAt: saved.updatedAt || null, ageMinutes: null };
    }
    const activeTitles = new Set((Array.isArray(currentTrends) ? currentTrends : [])
      .map(item => normalizeComparable(item && item.title))
      .filter(Boolean));
    const items = Object.values(saved.items || {}).filter(item => {
      const matches = Array.isArray(item && item.globalTrendSearchMatches)
        ? item.globalTrendSearchMatches : [];
      return matches.some(match => activeTitles.has(normalizeComparable(match && match.trendTitle)));
    });
    const queryValues = Object.values(saved.queries || {});
    const completedQueries = queryValues.filter(query => query && query.complete).length;
    const pagesFetched = queryValues.reduce((sum, query) => sum + Math.max(0, num(query && query.pagesFetched)), 0);
    return {
      status: queryValues.length && completedQueries === queryValues.length ? 'cached_complete' : 'cached_in_progress',
      items,
      updatedAt: saved.updatedAt || null,
      ageMinutes: Math.round(ageMs / 60000),
      topicsAvailable: Array.isArray(saved.trends) ? saved.trends.length : 0,
      queriesRequested: queryValues.length,
      queriesCompleted: completedQueries,
      pagesFetched,
      totalVideosRetained: Object.keys(saved.items || {}).length,
      complete: queryValues.length > 0 && completedQueries === queryValues.length
    };
  } catch {
    return {
      status: 'awaiting_search_worker',
      items: [],
      updatedAt: null,
      ageMinutes: null,
      topicsAvailable: 0,
      queriesRequested: 0,
      queriesCompleted: 0,
      pagesFetched: 0,
      totalVideosRetained: 0,
      complete: false
    };
  }
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

function cleanRepostCaptionTitle(sourceTitle) {
  const original = String(sourceTitle || '')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/[«»“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (original.length < 5) throw new Error('source_title_too_short_for_compliant_rewrite');

  let title = original
    .replace(/^(?:(?:ماجرای\s+بامزه(?:‌ی|ی)?|روایت\s+تصویری|روایتی\s+از)\s*[:،؛-]?\s*)+/iu, '')
    .replace(/^(?:(?:طنز|کلیپ|ویدیو|ویدئوی|ویدئو|فیلم|تصاویر|تصاویری)\s+)*(?:(?:خنده.?دار|بامزه|جالب|دیدنی|تماشایی|جذاب|کوتاه|باورنکردنی)(?:\s+و)?\s+)*(?:از\s+)?/iu, '')
    .replace(/^[-:،؛|\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  title = title
    .replace(/\s+(?:این\s+)?(?:حتماً?\s*)?(?:ببینید|ببنید|تماشا کنید|مشاهده کنید|از دست ندید|از دست ندهید)\s*$/iu, '')
    .replace(/(?:\s+(?:پوکیدم از خنده|ترکیدم از خنده|عالی بود|خیلی عالی بود|خیلی خنده.?دار بود|خیلی باحال بود|بسیار جالب بود))+\s*$/iu, '')
    .replace(/\s+(?:سرمربی|مربی|بازیکن|بازیگر|خواننده|قهرمان|مجری)\s+[\p{L}\p{N}‌_-]+(?:\s+[\p{L}\p{N}‌_-]+){0,2}(?=\s+(?:با|به|در|از)\s+)/u, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalizeComparable(title) === normalizeComparable(original)) {
    title = title
      .replace(/(?:عجیب\s+و\s+توهین\s+آمیز|توهین\s+آمیز|عجیب|باورنکردنی|دیدنی|تماشایی|جالب|فوق\s+العاده|عالی|خنده.?دار|بامزه)/giu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (normalizeComparable(title) === normalizeComparable(original)) {
    const words = title.split(' ').filter(Boolean);
    while (words.length > 2 && normalizeComparable(words.join(' ')) === normalizeComparable(original)) words.pop();
    title = words.join(' ').trim();
  }
  title = trimAtWord(title, 176);
  if (title.length < 8 || normalizeComparable(title) === normalizeComparable(original)) {
    throw new Error('no_clean_distinct_title_available_without_extra_words');
  }
  if (/(?:روایت\s+تصویری|ماجرای\s+بامزه|روایتی\s+از)/iu.test(title)) {
    throw new Error('repost_title_contains_editorial_wrapper');
  }
  return title;
}

function removeLiteralPhrase(text, phrase) {
 const value=String(phrase||'').trim();
 if(value.length<10)return String(text||'').trim();
 const escaped=value.replace(/[.*+?^{}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');
 return String(text||'').replace(new RegExp(escaped,'giu'),' ').replace(/\s+/g,' ').trim();
}
function cleanRepostDescription(sourceDescription, sourceTitle, repostTitle) {
 const raw=String(sourceDescription||'').replace(/\s+/g,' ').trim();
 if(raw.length<50)throw new Error('repost_description_source_too_short');
 let description=raw
  .replace(/https?:\/\/\S+|www\.\S+/giu,' ')
  .replace(/#[^\s#]+/gu,' ')
  .replace(/@[A-Za-z0-9_.-]+/g,' ')
  .replace(/(?:لطفاً|لطفا)\s*(?:لایک|پسند|فالو|دنبال|عضویت|اشتراک).{0,160}$/iu,' ')
  .replace(/(?:برای\s+(?:دیدن|تماشای|دنبال\s+کردن).{0,160})$/iu,' ')
  .replace(/(?:حتماً|حتما)\s*(?:ببینید|ببنید|تماشا\s+کنید|مشاهده\s+کنید).{0,100}$/iu,' ')
  .replace(/^(?:(?:در\s+)?این\s+(?:ویدئو|ویدیو|کلیپ|فیلم)\s*[,،:؛-]?\s*)+/iu,'')
  .replace(/\s+/g,' ').trim();
 description=removeLiteralPhrase(description,sourceTitle);
 description=removeLiteralPhrase(description,repostTitle);
 description=description
  .replace(/مشاهده\s+می‌کنید/giu,'دیده می‌شود')
  .replace(/می‌بینید/giu,'دیده می‌شود')
  .replace(/اتفاق\s+می‌افتد/giu,'رخ می‌دهد')
  .replace(/اتفاق\s+افتاده/giu,'رخ داده')
  .replace(/نشان\s+می‌دهد/giu,'نمایان می‌کند')
  .replace(/\s+/g,' ').trim();
 if(description.length<50)throw new Error('repost_description_lacks_substantive_detail');
 if(normalizeComparable(description)===normalizeComparable(raw))throw new Error('repost_description_not_rewritten_from_original');
 const descN=normalizeComparable(description),titleN=normalizeComparable(repostTitle),sourceTitleN=normalizeComparable(sourceTitle),sourceDescN=normalizeComparable(raw);
 if(titleN&&descN.includes(titleN))throw new Error('repost_description_repeats_repost_title');
 if(sourceTitleN&&sourceTitleN.length>=12&&descN.includes(sourceTitleN))throw new Error('repost_description_repeats_source_title');
 if(descN===sourceTitleN||descN===sourceDescN)throw new Error('repost_description_not_distinct_from_original');
 if(/(?:https?:\/\/|www\.)/i.test(description))throw new Error('repost_description_contains_unapproved_external_link');
 if(/(?:فیلیمو|نماوا|فیلم\s*نت|تلوبیون|تبلیغ\s+سرویس\s+اشتراک)/iu.test(description))throw new Error('repost_description_contains_video_service_promotion');
 const descTokens=new Set(queryTokens(description)),titleTokens=queryTokens(repostTitle).filter(t=>String(t).length>=3);
 if(!titleTokens.some(t=>descTokens.has(t)))throw new Error('repost_description_missing_relevant_title_keyword');
 const risk=policyTextRiskReason({title:repostTitle,description});
 if(risk)throw new Error('repost_description_policy_risk:'+risk);
 return trimAtWord(description,900);
}
function createRepostMetadata(video, sourceCode) {
 const sourceTitle=String(video&&video.title||'').replace(/#[^\s#]+/g,' ').replace(/\s+/g,' ').trim();
 const sourceDescription=String(video&&video.description||'').replace(/\s+/g,' ').trim();
 if(/(?:https?:\/\/|www\.)/i.test(sourceTitle))throw new Error('repost_source_title_contains_external_link');
 const risk=policyTextRiskReason(video);
 if(risk)throw new Error('filo_policy_text_risk:'+risk);
 const title=cleanRepostCaptionTitle(sourceTitle);
 const description=cleanRepostDescription(sourceDescription,sourceTitle,title);
 const titleN=normalizeComparable(title),sourceTitleN=normalizeComparable(sourceTitle),sourceDescN=normalizeComparable(sourceDescription);
 if(titleN===sourceTitleN||titleN===sourceDescN)throw new Error('repost_title_not_distinct_from_original_metadata');
 if(/(?:https?:\/\/|www\.)/i.test(description))throw new Error('repost_description_contains_unapproved_external_link');
 return {title,description,sourceTitle,sourceDescription,sourceCode};
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

function imageBufferFromDataUrl(value) {
 const match=/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i.exec(String(value||''));
 if(!match)return null;
 return {buffer:Buffer.from(match[2],'base64'),mimeType:match[1].toLowerCase()};
}

function trustedFiloMediaUrl(value) {
 const raw=String(value||'').trim();
 if(!raw)return null;
 try {
  const url=new URL(raw,BASE);
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||(host!=='ifilo.net'&&!host.endsWith('.ifilo.net')))return null;
  return url.toString();
 } catch {
  return null;
 }
}

async function extractHighResolutionSourceFrames(page,videoMetadata,sourceCode,durationSeconds,frameCount,tempDir) {
 const mediaUrl=trustedFiloMediaUrl(videoMetadata&&(videoMetadata.video_url||videoMetadata.videoUrl));
 const report={attempted:Boolean(mediaUrl),status:'not_attempted',reason:null,width:null,height:null,framesExtracted:0};
 if(!mediaUrl){
  report.reason='trusted_source_video_url_unavailable';
  return {ok:false,frames:[],report};
 }
 report.status='checking_source_media';
 let headers='';
 try {
  const cookies=await page.context().cookies(mediaUrl);
  const cookieHeader=cookies.map(cookie=>cookie.name+'='+cookie.value).join('; ');
  const userAgent=await page.evaluate(()=>navigator.userAgent).catch(()=>'Mozilla/5.0');
  headers=[
   'User-Agent: '+String(userAgent).replace(/[\\r\\n]/g,' '),
   'Referer: '+BASE+'/republish/'+encodeURIComponent(sourceCode),
   ...(cookieHeader?['Cookie: '+cookieHeader]:[])
  ].join('\\r\\n')+'\\r\\n';
 } catch {
  headers='Referer: '+BASE+'/republish/'+encodeURIComponent(sourceCode)+'\\r\\n';
 }
 const probe=spawnSync('ffprobe',[
  '-v','error','-headers',headers,'-select_streams','v:0',
  '-show_entries','stream=width,height:format=duration','-of','json',mediaUrl
 ],{encoding:'utf8',timeout:6000,maxBuffer:1024*1024});
 if(probe.error||probe.status!==0){
  report.status='probe_unavailable';
  report.reason=probe.error?String(probe.error.message||probe.error).slice(0,120):'source_media_probe_failed';
  return {ok:false,frames:[],report};
 }
 const metadata=parseJson(probe.stdout);
 const stream=metadata&&Array.isArray(metadata.streams)?metadata.streams[0]:null;
 const width=num(stream&&stream.width),height=num(stream&&stream.height);
 report.width=width||null;
 report.height=height||null;
 const duration=num(metadata&&metadata.format&&metadata.format.duration,durationSeconds);
 if(!width||!height){
  report.status='source_media_dimensions_unavailable';
  report.reason='source_video_has_no_readable_video_stream';
  return {ok:false,frames:[],report};
 }
 if(Math.max(width,height)<640||width*height<200000){
  report.status='source_media_not_high_resolution';
  report.reason='source_video_resolution_below_quality_threshold';
  return {ok:false,frames:[],report};
 }
 const clipDuration=Math.max(1,duration*0.88);
 const startAt=Math.max(0.1,duration*0.06);
 const pattern=path.join(tempDir,'source-frame-%02d.jpg');
 const fps=String(frameCount)+'/'+clipDuration.toFixed(3);
 const extracted=spawnSync('ffmpeg',[
  '-hide_banner','-loglevel','error','-headers',headers,
  '-ss',startAt.toFixed(3),'-i',mediaUrl,'-t',clipDuration.toFixed(3),
  '-map','0:v:0','-an','-sn','-dn','-vf','fps='+fps,
  '-frames:v',String(frameCount),'-q:v','2','-y',pattern
 ],{encoding:'utf8',timeout:12000,maxBuffer:1024*1024});
 const names=fs.readdirSync(tempDir)
  .filter(name=>/^source-frame-\\d+\\.jpg$/i.test(name)).sort();
 if(extracted.error||extracted.status!==0||names.length<3){
  for(const name of names)fs.rmSync(path.join(tempDir,name),{force:true});
  report.status='source_frame_extraction_unavailable';
  report.reason=extracted.error?String(extracted.error.message||extracted.error).slice(0,120):'source_frame_extraction_failed';
  return {ok:false,frames:[],report};
 }
 const frames=names.map((name,index)=>({
  index,timeSeconds:Math.round((startAt+index*(clipDuration/frameCount))*100)/100,
  path:path.join(tempDir,name),source:'original_video_file'
 }));
 report.status='high_resolution_frames_extracted';
 report.framesExtracted=frames.length;
 return {ok:true,frames,report};
}

async function captureVideoFrameDataUrl(page) {
 return page.locator('#plr video').first().evaluate(video=>{
  if(!video||video.readyState<2||!video.videoWidth||!video.videoHeight)return null;
  const canvas=document.createElement('canvas');
  canvas.width=video.videoWidth;
  canvas.height=video.videoHeight;
  const context=canvas.getContext('2d');
  if(!context)return null;
  context.drawImage(video,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/jpeg',0.94);
 }).catch(()=>null);
}

async function composeFiloCoverDataUrl(page,sourceDataUrl) {
 const sourceDimensions=imageDimensionsFromDataUrl(sourceDataUrl);
 if(!sourceDimensions)return {ok:false,reason:'cover_source_image_invalid',sourceDimensions:null};
 try {
  const dataUrl=await page.evaluate(async source=>{
   const image=new Image();
   image.src=source;
   try{await image.decode();}catch{return null;}
   if(!image.naturalWidth||!image.naturalHeight)return null;
   const width=1280,height=720;
   const canvas=document.createElement('canvas');
   canvas.width=width;
   canvas.height=height;
   const context=canvas.getContext('2d');
   if(!context)return null;
   context.fillStyle='#10141b';
   context.fillRect(0,0,width,height);
   const backgroundScale=Math.max(width/image.naturalWidth,height/image.naturalHeight)*1.12;
   const backgroundWidth=image.naturalWidth*backgroundScale;
   const backgroundHeight=image.naturalHeight*backgroundScale;
   context.save();
   context.filter='blur(30px) brightness(0.58) saturate(0.82)';
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
   context.shadowBlur=22;
   context.shadowOffsetY=5;
   context.drawImage(image,x,y,foregroundWidth,foregroundHeight);
   context.restore();
   // Filo's native cover capture submits PNG data URLs; preserve that exact format.
   return canvas.toDataURL('image/png');
  },sourceDataUrl);
  const dimensions=imageDimensionsFromDataUrl(dataUrl);
  const aspectRatio=dimensions?dimensions.width/dimensions.height:0;
  const ok=Boolean(dimensions&&Math.abs(aspectRatio-(16/9))<=0.02);
  return {ok,dataUrl:ok?dataUrl:null,strategy:ok?'blurred_background_full_frame_contain_v1':null,
   reason:ok?null:'cover_composition_output_invalid',sourceDimensions,dimensions,aspectRatio:aspectRatio||null};
 } catch(error) {
  return {ok:false,reason:'cover_composition_failed:'+String(error&&error.message||error).slice(0,140),
   sourceDimensions,dimensions:null,aspectRatio:null};
 }
}

function recordThumbnailSelection(report,selection) {
 const {coverFrameDataUrl,...summary}=selection||{};
 report.thumbnailSelection={...summary,coverFrameCaptureAvailable:Boolean(coverFrameDataUrl)};
 return selection;
}

function isRecoverableCoverPreparationError(reason) {
 return /^(?:filo_source_player_not_ready_for_cover|filo_cover_capture_control_unavailable|filo_cover_capture_click_failed|filo_thumbnail_frame_capture_failed)/i.test(String(reason||''));
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

async function selectThumbnailFrame(page, sourceCode, report, sourceVideo = null) {
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
      framesAnalyzed: 0,
      coverFrameDataUrl: await captureVideoFrameDataUrl(page)
    };
  };

  const videoInfo = await page.locator('#plr video').first().evaluate(video => ({
    duration: Number(video.duration) || 0,
    width: Number(video.videoWidth) || 0,
    height: Number(video.videoHeight) || 0
  })).catch(() => null);

  if (!videoInfo || videoInfo.duration < 2 || !videoInfo.width || !videoInfo.height) {
    const result = await fallback('video_metadata_unavailable');
    return recordThumbnailSelection(report,result);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-thumbnail-'));
  const frameCount = 18;
  const startRatio = 0.06;
  const endRatio = 0.94;
  const frames = [];
  let selected = null;
  let sourceUpgrade = null;

  try {
    const originalFrames = await extractHighResolutionSourceFrames(
      page, sourceVideo, sourceCode, videoInfo.duration, frameCount, tempDir
    ).catch(error => ({
      ok:false,frames:[],
      report:{attempted:true,status:'source_frame_extraction_error',reason:String(error&&error.message||error).slice(0,120),
        width:null,height:null,framesExtracted:0}
    }));
    sourceUpgrade = originalFrames.report;
    report.thumbnailSourceUpgrade = sourceUpgrade;
    if (originalFrames.ok) {
      frames.push(...originalFrames.frames);
    } else {
      const videoLocator = page.locator('#plr video').first();
      for (let index = 0; index < frameCount; index += 1) {
        const ratio = frameCount === 1 ? 0.5 : startRatio + (endRatio - startRatio) * index / (frameCount - 1);
        const target = Math.max(0.15, Math.min(videoInfo.duration - 0.15, videoInfo.duration * ratio));
        const seek = await seekVideoTo(page, target).catch(() => ({ ok: false }));
        if (!seek || !seek.ok) continue;
        const filePath = path.join(tempDir, 'frame-' + String(index).padStart(2, '0') + '.jpg');
        try {
          const frameDataUrl=await captureVideoFrameDataUrl(page);
          const captured=imageBufferFromDataUrl(frameDataUrl);
          let image=captured&&captured.buffer.length>1500?captured.buffer:null;
          if(!image)image=await videoLocator.screenshot({type:'jpeg',quality:90,timeout:10000});
          if(!image||image.length<1500)continue;
          fs.writeFileSync(filePath,image);
          frames.push({index,timeSeconds:Number(seek.timeSeconds||target),path:filePath,source:'player_video_element'});
        } catch {}
      }
    }

    if (frames.length < 3) {
      const result = await fallback('insufficient_decoded_frames');
      return recordThumbnailSelection(report,{...result,framesAnalyzed:frames.length});
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
      return recordThumbnailSelection(report,{...result,framesAnalyzed:frames.length});
    }

    const analysis = parseJson(scored.stdout);
    if (!analysis || !Number.isInteger(analysis.selectedIndex)) {
      const result = await fallback('thumbnail_scorer_returned_invalid_result');
      return recordThumbnailSelection(report,{...result,framesAnalyzed:frames.length});
    }

    selected = frames.find(frame => frame.index === analysis.selectedIndex);
    if (!selected) {
      const result = await fallback('selected_thumbnail_frame_not_found');
      return recordThumbnailSelection(report,{...result,framesAnalyzed:frames.length});
    }

    const selectedFromOriginal = selected.source === 'original_video_file';
    let coverFrameDataUrl;
    if (selectedFromOriginal) {
      const selectedBytes=fs.readFileSync(selected.path);
      coverFrameDataUrl='data:image/jpeg;base64,'+selectedBytes.toString('base64');
    } else {
      await seekVideoTo(page, selected.timeSeconds);
      coverFrameDataUrl=await captureVideoFrameDataUrl(page);
    }
    const summary = {
      strategy: selectedFromOriginal
        ? 'multi_frame_face_expression_visual_quality_v3_original_source_resolution'
        : 'multi_frame_face_expression_visual_quality_v3_player_fallback',
      fallback: !selectedFromOriginal,
      framesAnalyzed: frames.length,
      selectedTimeSeconds: Math.round(selected.timeSeconds * 100) / 100,
      sourceFrameDimensions: imageDimensionsFromDataUrl(coverFrameDataUrl),
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
    return recordThumbnailSelection(report,{...summary,coverFrameDataUrl});
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  }, null, { timeout: 25000 }).then(() => true).catch(() => false);
  if (!videoReady) throw new Error('filo_source_player_not_ready_for_cover');

  const thumbnailSelection = await selectThumbnailFrame(page, code, report, sourceVideo);

  const cropButton = page.locator('button.shot-btn').first();
  if(!(await cropButton.isVisible().catch(()=>false)))throw new Error('filo_cover_capture_control_unavailable');
  await cropButton.click().catch(()=>{throw new Error('filo_cover_capture_click_failed');});
  await page.waitForTimeout(500);

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
    let selectedFrame=coverComposition.ok?coverComposition.dataUrl:postedFrame;
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
    const titleDistinct = outgoingTitleComparable !== sourceTitleComparable && outgoingTitleComparable !== sourceDescriptionComparable;
    const descriptionDistinct = outgoingDescriptionComparable !== sourceDescriptionComparable && outgoingDescriptionComparable !== sourceTitleComparable;
    const descriptionDoesNotRepeatTitle = !outgoingDescriptionComparable.includes(outgoingTitleComparable);
    const metadataRisk = policyTextRiskReason({ title: outgoingTitle, description: outgoingDescription });
    const hasExternalLink = /(?:https?:\/\/|www\.)/i.test(outgoingTitle + ' ' + outgoingDescription);
    const metadataOk = outgoingTitle.length >= 8 && outgoingTitle.length <= 180 &&
      outgoingDescription.length >= 50 && outgoingDescription.length <= 1100 &&
      titleDistinct && descriptionDistinct && descriptionDoesNotRepeatTitle && !metadataRisk && !hasExternalLink;
    const frameOk = selectedFrame.startsWith('data:image/') && selectedFrame.length > 1000;
    const guardFailures = [];
    if (republishFrom !== code) guardFailures.push('source_code_mismatch');
    if (!/^[A-Za-z0-9_-]{5,40}$/.test(videoCode)) guardFailures.push('new_video_code_invalid');
    if (isMadeByMe !== 'false') guardFailures.push('source_is_not_other_user_content');
    if (canRepublish !== 'true') guardFailures.push('native_republish_permission_missing');
    if (canMakeMoney !== 'true') guardFailures.push('monetization_permission_missing');
    if (dontPublish !== '0') guardFailures.push('source_marked_do_not_publish');
    if (!frameOk) guardFailures.push('cover_frame_missing_or_invalid');
    if (!coverAspectOk) guardFailures.push('cover_aspect_not_16_9');
    if (!metadataOk) guardFailures.push('metadata_policy_guard_failed');
    const requestOk = guardFailures.length === 0;

    publishPayload = {
      sourceCode: republishFrom,
      newVideoCode: videoCode,
      title: outgoingTitle.slice(0, 180),
      descriptionDistinct,
      titleDistinct,
      category: params.get('category') || '',
      selectedFrameLength: selectedFrame.length,
      selectedFrameType: selectedFrame.slice(0, 40),
      coverSourceDimensions: coverComposition.sourceDimensions || null,
      coverDimensions,
      coverAspectRatio: coverAspectRatio || null,
      coverAspectOk,
      coverComposition: {
        ok: Boolean(coverComposition.ok),
        strategy: coverComposition.strategy || null,
        reason: coverComposition.reason || null
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


function cleanLegacyRepostTitle(value, sourceTitle = '') {
  const source = String(sourceTitle || '').trim();
  if (source) {
    try {
      return cleanRepostCaptionTitle(source);
    } catch {
      return String(value || source)
        .replace(/^(?:(?:ماجرای\s+بامزه(?:‌ی|ی)?|روایت\s+تصویری|روایتی\s+از)\s*[:،؛-]?\s*)+/iu, '')
        .replace(/[«»“”"]/g, '')
        .trim();
    }
  }
  return String(value || '')
    .replace(/^(?:(?:ماجرای\s+بامزه(?:‌ی|ی)?|روایت\s+تصویری|روایتی\s+از)\s*[:،؛-]?\s*)+/iu, '')
    .replace(/[«»“”"]/g, '')
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

async function editOwnVideoTitle(page, item, videoCode, newTitle, newDescription = null) {
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
    description: newDescription === null ? String(video.description || '') : String(newDescription),
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
 const targets=(state.posts||[]).filter(post=>post&&post.status==='public_verified'&&post.newVideoCode&&post.sourceCode&&(post.captionCleanupPending||post.captionPolicyVersion!==3));
 const report={checked:targets.length,updated:[],pending:[],skipped:[],errors:[]};
 for(const post of targets){
  const code=String(post.newVideoCode);
  if(post.captionCleanupLastAttemptAt&&Date.now()-Date.parse(post.captionCleanupLastAttemptAt)<12*60*60*1000){
   report.skipped.push({code,reason:'metadata_migration_retry_cooldown'});continue;
  }
  const markAttempt=()=>{post.captionCleanupLastAttemptAt=new Date().toISOString();state.updatedAt=post.captionCleanupLastAttemptAt;fs.writeFileSync(STATE_PATH,JSON.stringify(state,null,2)+'\n','utf8');};
  try{
   const sourceDetail=await getRepublishDetail(page,String(post.sourceCode)).catch(()=>null);
   if(!sourceDetail||!sourceDetail.video){report.skipped.push({code,reason:'original_source_metadata_unavailable'});markAttempt();continue;}
   const sourceGate=detailGate(sourceDetail.root,sourceDetail.video);
   if(!sourceGate.eligible){
    post.monetizationReviewRequired=true;
    post.monetizationReviewReason='original_source_no_longer_eligible:'+sourceGate.reason;
    post.monetizationReviewAt=new Date().toISOString();
    report.skipped.push({code,reason:'original_source_no_longer_eligible',detail:sourceGate.reason,manualReviewRequired:true});
    report.manualReview=(report.manualReview||[]).concat([{code,reason:post.monetizationReviewReason}]);
    markAttempt();continue;
   }
   const metadata=createRepostMetadata(sourceDetail.video,String(post.sourceCode));
   const newTitle=metadata.title,newDescription=metadata.description;
   const ownVideo=await fetchOwnVideoForCaptionEdit(page,code);
   if(!ownVideo){report.skipped.push({code,reason:'not_found_in_own_video_list'});markAttempt();continue;}
   if(String(ownVideo.video_code||ownVideo.code||ownVideo.v||'')!==code){report.skipped.push({code,reason:'own_video_code_mismatch'});markAttempt();continue;}
   const currentTitle=String(ownVideo.title||ownVideo.t||'').trim();
   const currentDescription=String(ownVideo.description||ownVideo.d||'').trim();
   if(normalizeComparable(currentTitle)===normalizeComparable(newTitle)&&normalizeComparable(currentDescription)===normalizeComparable(newDescription)){
    const publicUrl=await verifyPublicVideo(page,code,newTitle).catch(()=>null);
    if(publicUrl){
     post.repostTitle=newTitle;post.repostDescription=newDescription;post.captionCleanupPending=false;post.captionPolicyVersion=3;post.monetizationReviewRequired=false;delete post.monetizationReviewReason;delete post.monetizationReviewAt;post.captionCleanupAt=new Date().toISOString();
     markAttempt();report.updated.push({code,title:newTitle,descriptionUpdated:true,publicUrl,verified:true,unchanged:true});
    }else{report.pending.push({code,title:newTitle,reason:'public_title_not_yet_verified'});markAttempt();}
    continue;
   }
   if(!(ownVideo.canEdit===1||ownVideo.canEdit===true||ownVideo.canEdit==='1')){report.skipped.push({code,reason:'filo_can_edit_not_granted'});markAttempt();continue;}
   const edit=await editOwnVideoTitle(page,ownVideo,code,newTitle,newDescription);
   if(!edit.ok){report.skipped.push({code,reason:edit.reason});markAttempt();continue;}
   post.repostTitle=newTitle;post.repostDescription=newDescription;post.captionCleanupPending=true;post.captionPolicyVersion=3;post.captionCleanupRequestedAt=new Date().toISOString();
   const edited=await fetchOwnVideoForCaptionEdit(page,code).catch(()=>null);
   const ownMetadataVerified=Boolean(edited&&normalizeComparable(String(edited.title||edited.t||''))===normalizeComparable(newTitle)&&normalizeComparable(String(edited.description||edited.d||''))===normalizeComparable(newDescription));
   const publicUrl=ownMetadataVerified?await verifyPublicVideo(page,code,newTitle).catch(()=>null):null;
   if(publicUrl){post.captionCleanupPending=false;post.captionCleanupAt=new Date().toISOString();post.monetizationReviewRequired=false;delete post.monetizationReviewReason;delete post.monetizationReviewAt;report.updated.push({code,title:newTitle,descriptionUpdated:true,publicUrl,verified:true});}
   else report.pending.push({code,title:newTitle,reason:ownMetadataVerified?'public_title_not_yet_verified':'edited_metadata_not_yet_verified'});
   markAttempt();
  }catch(error){
    const reason=String(error&&error.message||error).slice(0,200);
    post.monetizationReviewRequired=true;
    post.monetizationReviewReason='metadata_migration_requires_review:'+reason;
    post.monetizationReviewAt=new Date().toISOString();
    report.errors.push({code,error:reason,manualReviewRequired:true});
    report.manualReview=(report.manualReview||[]).concat([{code,reason:post.monetizationReviewReason}]);
    markAttempt();
   }
 }
 return report;
}

function isRecoverableCoverGuardBlock(result) {
  const failures = result && result.publishPayload && result.publishPayload.guardFailures;
  const coverOnlyFailures = new Set(['cover_aspect_not_16_9', 'cover_frame_missing_or_invalid']);
  return Boolean(
    result &&
    result.status === 'blocked_before_filo_submission' &&
    Array.isArray(failures) &&
    failures.length > 0 &&
    failures.every(failure => coverOnlyFailures.has(failure))
  );
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

    const globalSearchCache = loadGlobalSearchCache(googleTrends);
    const globalSearchCandidates = globalSearchCache.items;
    report.discovery.globalTrendSearch = {
      status: globalSearchCache.status,
      topicsAvailable: googleTrends.length,
      queriesRequested: globalSearchCache.queriesRequested,
      queriesCompleted: globalSearchCache.queriesCompleted,
      pagesFetched: globalSearchCache.pagesFetched,
      uniqueVideos: globalSearchCache.totalVideosRetained,
      currentTrendMatches: globalSearchCandidates.length,
      complete: globalSearchCache.complete,
      cacheUpdatedAt: globalSearchCache.updatedAt,
      cacheAgeMinutes: globalSearchCache.ageMinutes
    };

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
      report.status = 'no_candidate_published_this_cycle';
      report.result = {
        status: 'no_candidate_published_this_cycle',
        reason: 'no_candidate_passed_feed_and_global_search_filters',
        retryOnNextScheduledRun: true
      };
      return;
    }

    let selected = null;
    let result = null;
    const checked = [];
    const coverGuardSkips = [];
    const coverPreparationSkips = [];
    for (const entry of ranked.slice(0, MAX_DETAIL_CHECKS)) {
      const code = entry.item.video_code;
      const detail = await getRepublishDetail(page, code).catch(() => null);
      const gate = detail ? detailGate(detail.root, detail.video) : { eligible: false, reason: 'republish_detail_unavailable' };
      const check = { code, score: entry.rank.score, gate: gate.reason };
      checked.push(check);
      if (!gate.eligible) continue;

      try {
        createRepostMetadata(detail.video, code);
      } catch (error) {
        check.gate = 'metadata_not_compliant';
        check.metadataError = String(error && error.message || error).slice(0, 160);
        continue;
      }

      const candidate = { ...entry.item, editorialScore: entry.rank.score, scoreDetails: entry.rank, detail };
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
        if(isRecoverableCoverPreparationError(reason)){
          check.gate='candidate_cover_preparation_unavailable';
          check.publishAttempt='skipped_candidate_cover_preparation';
          coverPreparationSkips.push({sourceCode:candidate.video_code,score:candidate.editorialScore,reason});
          continue;
        }
        throw error;
      }

      if (isRecoverableCoverGuardBlock(attemptResult)) {
        coverGuardSkips.push({
          sourceCode: candidate.video_code,
          score: candidate.editorialScore,
          reason: 'cover_aspect_not_16_9',
          coverDimensions: attemptResult.publishPayload.coverDimensions || null,
          coverAspectRatio: attemptResult.publishPayload.coverAspectRatio || null,
          coverCompositionReason: attemptResult.publishPayload.coverComposition &&
            attemptResult.publishPayload.coverComposition.reason || null
        });
        check.publishAttempt = 'skipped_before_submission_bad_cover_aspect';
        // No POST was sent. Keep the candidate eligible for future runs, but try the next ranked
        // source in this run so a bad thumbnail cannot waste the entire publishing slot.
        continue;
      }

      selected = candidate;
      result = attemptResult;
      break;
    }
    report.discovery.detailChecks = checked;
    report.discovery.coverGuardSkips = coverGuardSkips;
    report.discovery.coverPreparationSkips = coverPreparationSkips;
    if (!selected) {
      report.status = 'no_candidate_published_this_cycle';
      report.result = {
        status: 'no_candidate_published_this_cycle',
        reason: coverGuardSkips.length || coverPreparationSkips.length
          ? 'candidate_specific_cover_failures_exhausted_this_cycle'
          : 'no_candidate_passed_native_permission_and_metadata_gates',
        coverGuardSkips,
        coverPreparationSkips,
        retryOnNextScheduledRun: true
      };
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
    report.result = result;
    report.status = result.status;

    if (['submitted_pending_approval', 'submitted_unconfirmed', 'public_verified'].includes(result.status)) {
      state.posts.push({
        sourceCode: result.sourceCode || selected.video_code,
        sourceTitle: report.selected.title,
        repostTitle: result.repostMetadata && result.repostMetadata.title || null,
        repostDescription: result.repostMetadata && result.repostMetadata.description || null,
        captionPolicyVersion: 3,
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
  login,
  fetchFiloGlobalSearchPage,
  loadGlobalSearchCache,
  ageHours,
  feedCandidateEligible,
  searchCandidateEligible,
  cleanLegacyRepostTitle,
  cleanRepostCaptionTitle,
  cleanRepostDescription,
  policyTextRiskReason,
  imageDimensionsFromDataUrl,
  scoreFeedCandidate,
  createRepostMetadata,
  normalizeComparable,
  detailGate,
  isRecoverableCoverGuardBlock,
  isRecoverableCoverPreparationError,
  imageBufferFromDataUrl,
  trustedFiloMediaUrl,
  composeFiloCoverDataUrl,
  dailyCount
};