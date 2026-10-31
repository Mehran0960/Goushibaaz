'use strict';

const { scoreTrendTitleOverlap } = require('./trend_discovery.cjs');
const CONTENT_POLICY = require('../config/content-policy.json');
const AUDIENCE_WEIGHTS = CONTENT_POLICY.audience_priority_weights || {};

const CONTENT_EXCLUSIONS = [
  { key: 'institutional_or_current_affairs', pattern: /\bNASA\b|National Aeronautics and Space Administration|\bwar\b|\bexplosion\b|\bmissile\b|\bshooting\b|\bkilled\b|\binjured\b|\belection\b|\bpresident\b|politic|protest|government|sanction|geopolitical|russia|ukraine|israel|\bamerica\b|جنگ|انفجار|موشک|تیراندازی|کشته|مجروح|انتخابات|رئیس.?جمهور|سیاست|اعتراض|تحریم|درگیری|روسیه|اوکراین|اسرائیل|آمریکا/i },
  { key: 'sensitive_or_graphic_content', pattern: /gore|graphic violence|self.?harm|suicide|porn|explicit sexual|rape|blood|قتل|خون|قطع عضو|خودکشی|پورن|جنسی صریح|تجاوز جنسی/i },
  { key: 'promotional_content', pattern: /sponsored|affiliate|discount code|buy now|shop now|sign up now|link in bio|use my code|limited offer|promo code|visit our website|تبلیغات|اسپانسر|تخفیف|کد تخفیف|برای خرید|لینک خرید|ثبت.?نام کنید|لینک در بیو|فروش ویژه/i },
  { key: 'weapon_or_military_safety_review', pattern: /\bweapon\b|\bfirearm\b|\bgun\b|military training|سلاح|اسلحه|تفنگ|جنگ.?افزار|آموزش.?های.?نظامی/i }
];
const MULTI_CLIP_RISK = /\b(compilation|roundup|recap|best of|top\s*\d+|ranking|highlights|viral moments|top moments)\b|[0-9۰-۹]+\s*تا\s*(?:فان|کلیپ|اتفاق|لحظه|ویدیو|ویدئو)|(?:چندتا|چند)\s*(?:کلیپ|اتفاق|لحظه|ویدیو|ویدئو|فان)|گلچین|گزیده|مجموعه(?:ای)? از|تاپ\s*\d+|برترین لحظات|بهترین لحظات|گلچین لحظات/i;

// Editorial ranking only. A score never grants permission to republish a video.
const TOPICS = [
  { key: 'sports_skill', base: 23, patterns: [/football|soccer|basketball|skateboard|parkour|trick shot|freestyle|sports? skill|goal|dunk/i, /فوتبال|بسکتبال|والیبال|ورزش|گل زیبا|حرکت نمایشی|دریبل|اسکیت|مهارت عجیب/i] },
  { key: 'technology_demo', base: 24, patterns: [/technology demo|AI demo|robot demo|smart device|gadget demo|new technology|invention demo/i, /هوش مصنوعی|فناوری|تکنولوژی|ربات|گجت|دستگاه هوشمند|دموی فناوری|ابزار جدید/i] },
  { key: 'science_tech', base: 16, patterns: [/science experiment|experiment|optical illusion|brain teaser|puzzle|physics|astronomy|space footage|planetary science/i, /آزمایش علمی|علمی|خطای دید|معما|فیزیک|نجوم|کهکشان|سیاره|فضا|پدیده علمی/i] },
  { key: 'satisfying_craft', base: 24, patterns: [/oddly satisfying|satisfying|restoration|woodworking|pottery|craft|miniature|before and after|transformation/i, /رضایت بخش|رضایت‌بخش|ساختنی|کاردستی|نجاری|سفال|مرمت|بازسازی|قبل و بعد|تغییر شگفت انگیز/i] },
  { key: 'food_cooking', base: 21, patterns: [/cooking|recipe|food art|food hack|kitchen|baking|street food/i, /آشپزی|غذا|دستور پخت|خوراکی|شیرینی|نان پزی|نان‌پزی|آشپزخانه|غذای خیابانی|ترفند غذایی/i] },
  { key: 'pets_animals', base: 19, patterns: [/cats?|kittens?|felines?|dogs?|pupp(y|ies)|pets?|birds?|parrots?|squirrels?|monkeys?|rabbits?|animals?|wildlife|hamsters?/i, /گربه|سگ|توله|حیوان|جانور|پرنده|طوطی|میمون|خرگوش|سنجاب|حیات وحش|حیوان خانگی/i] },
  { key: 'performance_magic', base: 21, patterns: [/magic|illusion|dancing|dance|music performance|musician|singing|instrument|juggling/i, /شعبده|جادو|رقص|نوازندگی|موسیقی|خوانندگی|اجرای زنده|هنرنمایی|آکروبات/i] },
  { key: 'nature_wildlife', base: 17, patterns: [/nature|landscape|weather phenomenon|wildlife|ocean|volcano|waterfall|space footage/i, /طبیعت|حیات وحش|آبشار|اقیانوس|آسمان|پدیده جوی|شفق|آتشفشان|منظره|فضا/i] },
  { key: 'travel_culture', base: 16, patterns: [/travel|tourism|street life|local culture|traditional|architecture|iranian market/i, /سفر|گردشگری|فرهنگ|سنتی|بازار|خیابان|معماری|ایرانگردی|جاذبه دیدنی|زندگی روزمره/i] },
  { key: 'human_reaction', base: 23, patterns: [/human reaction|people react|street interview|relatable moment|caught on camera/i, /واکنش مردم|مصاحبه خیابانی|اتفاق روزمره|لحظه آشنا|عکس.?العمل/i] },
  { key: 'surprise_reveal', base: 24, patterns: [/unexpected|surprise|plot twist|reveal|mystery|wait until|final result|hidden result/i, /غیرمنتظره|غافلگیر|آخرش|نتیجه نهایی|راز|معما|ناگهان|باور نمی.?کنی/i] },
  { key: 'life_hacks', base: 22, patterns: [/life hack|useful tip|everyday hack|home hack|simple solution|how to/i, /ترفند کاربردی|ترفند روزمره|هک زندگی|راه حل ساده|نکته مفید|روش ساده/i] },
  { key: 'heartwarming', base: 22, patterns: [/heartwarming|wholesome|kindness|reunion|feel.?good|animal rescue|family moment/i, /مهربانی|کمک غیرمنتظره|دیدار دوباره|لحظه احساسی|نجات حیوان|خانواده/i] },
  { key: 'diy_creativity', base: 21, patterns: [/DIY|craft|woodworking|pottery|handmade|creative process|miniature build/i, /کاردستی|نجاری|سفالگری|ساخت دست.?ساز|خلاقانه|ساخت ماکت/i] },
  { key: 'home_cleaning', base: 20, patterns: [/cleaning|deep clean|home organization|declutter|organizing|tidying/i, /تمیزکاری|نظم.?دهی|مرتب.?سازی|پاکسازی|سازماندهی خانه/i] },
  { key: 'fashion_culture', base: 18, patterns: [/fashion show|runway|pageant|traditional dress|national costume/i, /فشن شو|مدلینگ|لباس سنتی|لباس ملی|مسابقه زیبایی/i] },
  { key: 'persian_comedy', base: 25, patterns: [/hidden camera|prank|comedy|comed(y|ic)|humou?r|funny|reaction|meme|sketch|fail|caught on camera|unexpected|surprise/i, /طنز|خنده|بامزه|سوتی|دوربین مخفی|دوبله|میم|چالش|واکنش|اتفاق غیرمنتظره|غافلگیر/i] },
];
const HOOKS = [
  /unexpected|surprise|caught on camera|reaction|fail|prank|challenge|before and after|transformation|trick shot|impossible|unbelievable|oddly satisfying|close call|plot twist|reveal|mystery|wait until|one take/i,
  /غیرمنتظره|غافلگیر|واکنش|سوتی|دوربین مخفی|چالش|قبل و بعد|تغییر شگفت|حرکت عجیب|باورنکردنی|نتیجه نهایی|آخرش|باور نمی کنی|باور نمی‌کنی|ناگهان|راز|معمای تصویری|خطای دید|مهارت خارق|یک ضرب|بدون برش/i,
];
const LOCAL = /فارسی|ایرانی|ایران|تهران|شیراز|اصفهان|تبریز|مشهد|کرج|اهواز|یزد|رشت|persian|farsi|iranian|tehran|shiraz|isfahan|tabriz|mashhad/i;
const OPEN_LOOP = /unexpected|surprise|mystery|reveal|plot twist|wait until|before and after|قبل و بعد|غافلگیر|غیرمنتظره|آخرش|راز|معما/i;
const PAYOFF = /final result|transformation|restoration|trick shot|impossible|reveal|result|payoff|نتیجه نهایی|تغییر|بازسازی|حرکت نمایشی|ترفند|آخر کار/i;

function cleanText(value) {
  return String(value || '')
    .replace(/[\u200c\u200d\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/ـ/g, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\w\u0600-\u06ff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('fa');
}

function candidateText(candidate) {
  const c = candidate || {};
  // Rank what the source actually contains, not our own generated Persian caption
  // or the search query that found it. Otherwise generic captions like
  // "a lovely/interesting moment" manufacture hook points for weak clips.
  const sourceTitle = c.fileTitle || c.sourceTitle || c.originalTitle || c.source_title ||
    c.title || c.caption || c.name;
  const sourceDescription = c.description || c.sourceDescription || c.source_description || '';
  return cleanText([sourceTitle, sourceDescription].filter(Boolean).join(' '));
}

function categoryFor(value) {
  if (value && typeof value === 'object') {
    const lane = String(value.content_lane || value.lane || value.editorialTopic || value.topic || '').toLowerCase();
    const laneMap = {
      comedy: 'persian_comedy',
      animals: 'pets_animals',
      surprise_or_reveal: 'surprise_reveal',
      transformation_or_satisfying: 'satisfying_craft',
      skill_or_spectacle: 'sports_skill',
      technology_demo: 'technology_demo',
      human_reaction_or_relatable: 'human_reaction',
      food_cooking: 'food_cooking',
      practical_tips_or_life_hacks: 'life_hacks',
      wholesome_or_heartwarming: 'heartwarming',
      sports_or_athletic_skill: 'sports_skill',
      nature_and_wildlife: 'nature_wildlife',
      science_curiosity: 'science_tech',
      diy_and_creativity: 'diy_creativity',
      home_organization_or_cleaning: 'home_cleaning',
      music_or_dance: 'performance_magic',
      fashion_or_cultural_showcase: 'fashion_culture',
      travel_and_places: 'travel_culture',
      puzzles_and_visual_illusions: 'science_tech',
      nostalgia_and_then_now: 'human_reaction',
      pets_animals: 'pets_animals',
      sports_skill: 'sports_skill',
      science_tech: 'science_tech',
      satisfying_craft: 'satisfying_craft',
      performance_magic: 'performance_magic',
      nature_wildlife: 'nature_wildlife',
      travel_culture: 'travel_culture',
      human_reaction: 'human_reaction',
      life_hacks: 'life_hacks',
      heartwarming: 'heartwarming',
      diy_creativity: 'diy_creativity',
      home_cleaning: 'home_cleaning',
      fashion_culture: 'fashion_culture'
    };
    if (laneMap[lane]) return laneMap[lane];
  }
  const text = typeof value === 'string' ? cleanText(value) : candidateText(value);
  let best = { key: 'general_entertainment', count: 0 };
  for (const topic of TOPICS) {
    const count = topic.patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
    if (count > best.count) best = { key: topic.key, count };
  }
  return best.key;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getDuration(candidate) {
  return safeNumber(candidate && (candidate.durationSeconds ?? candidate.duration_seconds ?? candidate.duration));
}

function getVerticalScore(candidate) {
  const c = candidate || {};
  const ratio = safeNumber(c.sourceAspectRatio ?? c.source_aspect_ratio) ??
    ((safeNumber(c.sourceWidth ?? c.source_width) > 0 && safeNumber(c.sourceHeight ?? c.source_height) > 0)
      ? safeNumber(c.sourceWidth ?? c.source_width) / safeNumber(c.sourceHeight ?? c.source_height) : null);
  if (ratio !== null) {
    if (ratio >= 0.48 && ratio <= 0.66) return 9;
    if (ratio >= 0.38 && ratio <= 0.75) return 5;
    if (ratio > 1.0) return -4;
    return 1;
  }
  const sourceScore = safeNumber(c.sourceVerticalScore ?? c.source_vertical_score);
  if (sourceScore !== null) return sourceScore >= 3 ? 8 : sourceScore >= 2 ? 5 : sourceScore <= 0 ? -2 : 2;
  return 1;
}

function ageHours(candidate, nowMs = Date.now()) {
  const c = candidate || {};
  const direct = safeNumber(c.age_hours ?? c.ageHours);
  if (direct !== null && direct >= 0) return direct;
  const date = c.discoveredAt || c.discovered_at || c.publishedAt || c.published_at || c.checkedAt || c.checked_at;
  if (!date) return null;
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) ? Math.max(0, (nowMs - timestamp) / 3600000) : null;
}

function scoreCandidate(candidate, options = {}) {
  const c = candidate || {};
  const text = candidateText(c);
  const trendMatchBonus = scoreTrendTitleOverlap(text, c.trendSearchTitle);
  const trendTopic = c.trendSearchLane ? categoryFor({ content_lane: c.trendSearchLane }) : 'general_entertainment';
  const detectedTopic = categoryFor(text);
  const topic = trendTopic !== 'general_entertainment' && trendMatchBonus >= 4 ? trendTopic : detectedTopic;
  const topicInfo = TOPICS.find(item => item.key === topic);
  const duration = getDuration(c);
  const reasons = [];
  const exclusion = CONTENT_EXCLUSIONS.find(item => item.pattern.test(text));
  if (exclusion) {
    return { eligible: false, score: -1000, topic, durationSeconds: duration, reasons: ['excluded:' + exclusion.key] };
  }
  if (duration !== null && duration < 8) {
    return { eligible: false, score: -1000, topic, durationSeconds: duration, reasons: ['duration_under_8_seconds'] };
  }
  const configuredBase = safeNumber(AUDIENCE_WEIGHTS[topic]);
  let score = configuredBase !== null ? configuredBase : (topicInfo ? topicInfo.base : 6);
  reasons.push('iranian_audience_topic:' + topic);

  const hookCount = HOOKS.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
  const hookScore = Math.min(16, hookCount * 8);
  score += hookScore;
  if (hookScore) reasons.push('strong_hook:' + hookScore);

  if (LOCAL.test(text)) {
    score += 7;
    reasons.push('persian_or_iran_signal');
  }

  const localeScore = safeNumber(c.contentLocaleScore ?? c.content_locality_score);
  if (localeScore !== null && localeScore > 0) {
    const bonus = Math.min(6, localeScore * 1.5);
    score += bonus;
    reasons.push('source_locale_priority:' + bonus);
  }

  const verticalScore = getVerticalScore(c);
  score += verticalScore;
  reasons.push('source_format:' + verticalScore);

  let durationScore = 0;
  if (duration === null) durationScore = 2;
  else if (duration >= 8 && duration <= 20) durationScore = 12;
  else if (duration <= 32) durationScore = 10;
  else if (duration <= 45) durationScore = 6;
  else if (duration <= 60) durationScore = 2;
  else durationScore = -Math.min(18, 4 + (duration - 60) * 0.25);
  score += durationScore;
  reasons.push('duration:' + durationScore);

  // A modest retention-arc bonus favors curiosity followed by a visible payoff.
  const hasOpenLoop = OPEN_LOOP.test(text);
  const hasPayoff = PAYOFF.test(text);
  let retentionScore = (hasOpenLoop ? 2 : 0) + (hasPayoff ? 2 : 0) + (hasOpenLoop && hasPayoff ? 2 : 0);
  if (duration !== null && duration > 60 && !hasOpenLoop) retentionScore -= 2;
  if (retentionScore) {
    score += retentionScore;
    reasons.push('retention_arc:' + retentionScore);
  }

  const age = ageHours(c);
  if (age !== null) {
    if (age <= 6) score += 5;
    else if (age <= 24) score += 3;
    else if (age > 72) score -= 8;
  }

  const velocity = safeNumber(c.views_velocity_per_hour ?? c.viewsVelocityPerHour ?? c.observed_views_per_hour ?? c.views_per_hour_proxy);
  if (velocity !== null && velocity > 0) {
    const velocityScore = Math.min(12, Math.log10(velocity + 1) * 3);
    score += velocityScore;
    reasons.push('observed_or_proxy_velocity:' + Math.round(velocityScore * 10) / 10);
  }
  const views = safeNumber(c.views ?? c.view_count);
  if (views !== null && views > 0) score += Math.min(4, Math.log10(views + 1) * 0.7);

  const trendWeights = options.trendWeights || {};
  const trendBonus = Math.min(10, Math.max(0, safeNumber(trendWeights[topic]) || 0));
  score += trendBonus;
  if (trendBonus) reasons.push('recent_topic_momentum:' + trendBonus);

  // A small title/description overlap bonus promotes licensed archive matches to
  // observed trends; it is a relevance hint, never proof that two clips are identical.
  if (trendMatchBonus > 0) {
    score += trendMatchBonus;
    reasons.push('observed_trend_title_overlap:' + trendMatchBonus);
    const acceleration = safeNumber(c.trendSearchAcceleration) || 0;
    if (acceleration > 0 && trendMatchBonus >= 4) {
      const accelerationBonus = Math.min(4, Math.log10(acceleration + 1) * 1.5);
      score += accelerationBonus;
      reasons.push('observed_trend_acceleration:' + Math.round(accelerationBonus * 10) / 10);
    }
  }
  if (MULTI_CLIP_RISK.test(text)) {
    score -= 20;
    reasons.push('multi_clip_roundup:-20');
  }
  if (c.trendSearchLocalPriority === true) {
    score += 3;
    reasons.push('persian_trend_search_priority:3');
  }

  const recentPosts = Array.isArray(options.recentPosts) ? options.recentPosts : [];
  const previousSameTopic = recentPosts.slice(-8).filter(post => {
    const status = String(post && post.status || '');
    if (['rejected_by_filo', 'ineligible_source', 'failed', 'upload_failed_retryable'].includes(status)) return false;
    return categoryFor(post) === topic;
  }).length;
  const diversityPenalty = Math.min(18, previousSameTopic * 5);
  score -= diversityPenalty;
  if (diversityPenalty) reasons.push('recent_topic_repeat:-' + diversityPenalty);

  return {
    eligible: true,
    score: Math.round(score * 10) / 10,
    topic,
    durationSeconds: duration,
    reasons
  };
}

function rankCandidates(candidates, options = {}) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => ({ candidate, ranking: scoreCandidate(candidate, options) }))
    .filter(item => item.ranking.eligible)
    .sort((a, b) => b.ranking.score - a.ranking.score)
    .map(({ candidate, ranking }) => ({
      ...candidate,
      editorialScore: ranking.score,
      editorialTopic: ranking.topic,
      editorialReasons: ranking.reasons
    }));
}

function buildTrendWeights(snapshot, nowMs = Date.now()) {
  const totals = Object.create(null);
  if (!snapshot || typeof snapshot !== 'object') return totals;
  for (const group of ['telegram', 'aparat', 'youtube_cc']) {
    const collection = snapshot[group];
    if (!collection || typeof collection !== 'object') continue;
    for (const item of Object.values(collection)) {
      if (!item || typeof item !== 'object') continue;
      const seenAt = Date.parse(item.last_seen_at || item.updated_at || '');
      if (!Number.isFinite(seenAt) || nowMs - seenAt > 48 * 3600000 || seenAt > nowMs + 5 * 60000) continue;
      const topic = categoryFor(item);
      if (topic === 'general_entertainment') continue;
      const history = Array.isArray(item.history) ? item.history : [];
      let growthWeight = 0;
      if (history.length >= 2) {
        const first = history[0], last = history[history.length - 1];
        const firstAt = Date.parse(first.at || ''), lastAt = Date.parse(last.at || '');
        const firstViews = safeNumber(first.views), lastViews = safeNumber(last.views);
        if (Number.isFinite(firstAt) && Number.isFinite(lastAt) && lastAt > firstAt &&
            firstViews !== null && lastViews !== null && lastViews >= firstViews) {
          const rate = (lastViews - firstViews) / Math.max((lastAt - firstAt) / 3600000, 0.25);
          growthWeight = Math.min(6, Math.log10(rate + 1) * 1.8);
        }
      }
      const views = safeNumber(item.last_views) || 0;
      const viewWeight = Math.min(3, Math.log10(views + 1) * 0.45);
      const recency = Math.max(0.25, 1 - Math.max(0, nowMs - seenAt) / (48 * 3600000));
      totals[topic] = (totals[topic] || 0) + (growthWeight + viewWeight + 0.5) * recency;
    }
  }
  const max = Math.max(0, ...Object.values(totals));
  for (const key of Object.keys(totals)) totals[key] = Math.round(Math.min(10, (totals[key] / Math.max(1, max)) * 10) * 10) / 10;
  return totals;
}

module.exports = { categoryFor, scoreCandidate, rankCandidates, buildTrendWeights };
