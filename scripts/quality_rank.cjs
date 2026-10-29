'use strict';

// Editorial ranking only. A score never grants permission to republish a video.
const TOPICS = [
  { key: 'sports_skill', base: 23, patterns: [/football|soccer|basketball|skateboard|parkour|trick shot|freestyle|sports? skill|goal|dunk/i, /فوتبال|بسکتبال|والیبال|ورزش|گل زیبا|حرکت نمایشی|دریبل|اسکیت|مهارت عجیب/i] },
  { key: 'science_tech', base: 22, patterns: [/science experiment|experiment|invention|technology demo|optical illusion|magic trick|brain teaser|puzzle/i, /آزمایش علمی|علمی|اختراع|فناوری|ترفند تکنولوژی|خطای دید|معما|حقه|تجربه جالب/i] },
  { key: 'satisfying_craft', base: 24, patterns: [/oddly satisfying|satisfying|restoration|woodworking|pottery|craft|miniature|before and after|transformation/i, /رضایت بخش|رضایت‌بخش|ساختنی|کاردستی|نجاری|سفال|مرمت|بازسازی|قبل و بعد|تغییر شگفت انگیز/i] },
  { key: 'food_cooking', base: 21, patterns: [/cooking|recipe|food art|food hack|kitchen|baking|street food/i, /آشپزی|غذا|دستور پخت|خوراکی|شیرینی|نان پزی|نان‌پزی|آشپزخانه|غذای خیابانی|ترفند غذایی/i] },
  { key: 'pets_animals', base: 19, patterns: [/cats?|kittens?|felines?|dogs?|pupp(y|ies)|pets?|birds?|parrots?|squirrels?|monkeys?|rabbits?|animals?|wildlife|hamsters?/i, /گربه|سگ|توله|حیوان|جانور|پرنده|طوطی|میمون|خرگوش|سنجاب|حیات وحش|حیوان خانگی/i] },
  { key: 'performance_magic', base: 21, patterns: [/magic|illusion|dancing|dance|music performance|musician|singing|instrument|juggling/i, /شعبده|جادو|رقص|نوازندگی|موسیقی|خوانندگی|اجرای زنده|هنرنمایی|آکروبات/i] },
  { key: 'nature_wildlife', base: 17, patterns: [/nature|landscape|weather phenomenon|wildlife|ocean|volcano|waterfall|space footage/i, /طبیعت|حیات وحش|آبشار|اقیانوس|آسمان|پدیده جوی|شفق|آتشفشان|منظره|فضا/i] },
  { key: 'travel_culture', base: 16, patterns: [/travel|tourism|street life|local culture|traditional|architecture|iranian market/i, /سفر|گردشگری|فرهنگ|سنتی|بازار|خیابان|معماری|ایرانگردی|جاذبه دیدنی|زندگی روزمره/i] },
  { key: 'persian_comedy', base: 25, patterns: [/hidden camera|prank|comedy|comed(y|ic)|humou?r|funny|reaction|meme|sketch|fail|caught on camera|unexpected|surprise/i, /طنز|خنده|بامزه|سوتی|دوربین مخفی|دوبله|میم|چالش|واکنش|اتفاق غیرمنتظره|غافلگیر/i] },
];
const HOOKS = [
  /unexpected|surprise|caught on camera|reaction|fail|prank|challenge|before and after|transformation|trick shot|impossible|unbelievable|oddly satisfying|close call|plot twist/i,
  /غیرمنتظره|غافلگیر|واکنش|سوتی|دوربین مخفی|چالش|قبل و بعد|تغییر|حرکت عجیب|باورنکردنی|دیدنی|رضایت بخش|رضایت‌بخش|آخرش|باور نمی کنی|باور نمی‌کنی/i,
];
const LOCAL = /فارسی|ایرانی|ایران|تهران|شیراز|اصفهان|تبریز|مشهد|کرج|اهواز|یزد|رشت|persian|farsi|iranian|tehran|shiraz|isfahan|tabriz|mashhad/i;

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
  return cleanText([
    c.fileTitle, c.sourceTitle, c.description, c.sourceDescription,
    c.title, c.caption, c.name, c.discoveryQuery, c.query
  ].filter(Boolean).join(' '));
}

function categoryFor(value) {
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
  const topic = categoryFor(text);
  const topicInfo = TOPICS.find(item => item.key === topic);
  const duration = getDuration(c);
  const reasons = [];
  if (duration !== null && duration < 8) {
    return { eligible: false, score: -1000, topic, durationSeconds: duration, reasons: ['duration_under_8_seconds'] };
  }
  let score = topicInfo ? topicInfo.base : 8;
  reasons.push('topic:' + topic);

  const hookCount = HOOKS.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
  const hookScore = Math.min(16, hookCount * 8);
  score += hookScore;
  if (hookScore) reasons.push('strong_hook:' + hookScore);

  if (LOCAL.test(text)) {
    score += 7;
    reasons.push('persian_or_iran_signal');
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
      const topic = categoryFor(item.title || '');
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
