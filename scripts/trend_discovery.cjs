'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SLOT_MS = 5 * 60 * 1000;
const SAFE_LANES = new Set([
  'comedy', 'animals', 'surprise_or_reveal', 'transformation_or_satisfying',
  'skill_or_spectacle', 'technology_demo', 'human_reaction_or_relatable',
  'food_cooking', 'practical_tips_or_life_hacks', 'wholesome_or_heartwarming',
  'sports_or_athletic_skill', 'nature_and_wildlife', 'science_curiosity',
  'diy_and_creativity', 'home_organization_or_cleaning', 'music_or_dance',
  'fashion_or_cultural_showcase', 'travel_and_places',
  'pets_animals', 'sports_skill', 'science_tech', 'satisfying_craft',
  'performance_magic', 'nature_wildlife', 'travel_culture', 'human_reaction',
  'life_hacks', 'heartwarming', 'diy_creativity', 'home_cleaning',
  'fashion_culture', 'persian_comedy'
]);
const STOP_WORDS = new Set([
  'the','and','this','that','when','where','what','which','who','with','from','into',
  'about','how','why','are','was','were','his','her','their','they','them','he','she',
  'for','but','not','just','all','has','have','had','will','never','before','after',
  'like','looks','look','you','your','one','two','three','video','short','shorts',
  'viral','watch','while','then','than','very','more','most','some','only','new',
  'این','اون','آن','وقتی','همین','همه','برای','تا','از','با','به','یک','یکی','که',
  'را','در','روی','اینکه','چون','اما','اگر','هم','و','یا','شد','شده','شود','هست',
  'است','بود','بودن','دارند','دارد','کرد','کرده','کنید','کنه','میشه','میشود',
  'میاد','میاره','باید','خیلی','چطور','چرا','چی','چه','کدام','چند','پس','مثل',
  'بدون','بعد','قبل','هر','همین','اونها','ایشون','خودش','خود','شما','من','ما'
]);
const UNSAFE_TITLE = /porn|nsfw|sexual|sexually|gore|graphic violence|suicide|self.?harm|terror|war footage|election|politic|politics|جنگ|سیاست|سیاسی|انتخابات|ترور|قتل|خودکشی|جنسی|پورن|خشونت شدید/i;

function tokens(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[\w\u0600-\u06ff_]+/g, ' ')
    .replace(/#[\w\u0600-\u06ff_]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLocaleLowerCase('fa')
    .split(/\s+/)
    .filter(word => word.length >= 2 && !STOP_WORDS.has(word));
}

function rotateSearchBatch(items, batchSize, nowMs = Date.now()) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const size = Math.max(1, Math.floor(Number(batchSize) || 1));
  if (items.length <= size) return [...items];
  const batchCount = Math.ceil(items.length / size);
  const batchIndex = Math.floor(nowMs / SLOT_MS) % batchCount;
  const start = batchIndex * size;
  return items.slice(start, start + size);
}

function readTrendSnapshot(filePath = path.join('state', 'platform-trends.json')) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function buildTrendSearches(snapshot = readTrendSnapshot(), options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const limit = Math.max(0, Math.min(2, Math.floor(Number(options.limit ?? 1))));
  if (!limit || !snapshot || typeof snapshot !== 'object') return [];
  const leads = [];
  for (const group of ['telegram', 'aparat', 'youtube_cc']) {
    const entries = snapshot[group];
    if (!entries || typeof entries !== 'object') continue;
    for (const [id, item] of Object.entries(entries)) {
      if (!item || typeof item !== 'object' || item.velocity_kind !== 'observed') continue;
      const lane = String(item.lane || '').trim().toLowerCase();
      if (!SAFE_LANES.has(lane)) continue;
      if (UNSAFE_TITLE.test(String(item.title || ''))) continue;
      const seenAt = Date.parse(item.last_seen_at || item.updated_at || '');
      if (!Number.isFinite(seenAt) || seenAt > nowMs + 5 * 60000 || nowMs - seenAt > 36 * 3600000) continue;
      const velocity = Number(item.velocity_per_hour);
      if (!Number.isFinite(velocity) || velocity <= 0) continue;
      const searchTerms = [...new Set(tokens(item.title))].slice(0, 6);
      if (searchTerms.length < 2) continue;
      const ageHours = Math.max(0, (nowMs - seenAt) / 3600000);
      const priority = Math.log10(velocity + 1) * 2 + Math.max(0, 1 - ageHours / 36);
      leads.push({
        id: String(id),
        group,
        lane,
        title: String(item.title || '').slice(0, 240),
        url: String(item.url || ''),
        velocity,
        seenAt,
        ageHours,
        priority,
        searchTerms
      });
    }
  }
  leads.sort((a, b) => b.priority - a.priority || b.velocity - a.velocity || b.seenAt - a.seenAt);
  const pool = leads.slice(0, Math.min(12, leads.length));
  if (!pool.length) return [];
  const slot = Math.floor(nowMs / SLOT_MS);
  const selected = [];
  for (let index = 0; index < Math.min(limit, pool.length); index++) {
    const lead = pool[(slot + index) % pool.length];
    const localPriority = /[پچژگکی]/.test(lead.title) || /iran|persian|farsi/i.test(lead.title);
    selected.push({
      key: 'trend-' + lead.group + '-' + lead.id.slice(0, 10),
      query: 'filetype:video ' + lead.searchTerms.join(' '),
      searchTerms: lead.searchTerms,
      localPriority,
      trendTitle: lead.title,
      trendUrl: lead.url,
      trendVelocity: lead.velocity,
      trendLane: lead.lane
    });
  }
  return selected;
}

function scoreTrendTitleOverlap(candidateText, trendTitle) {
  const candidateTokens = new Set(tokens(candidateText));
  const trendTokens = new Set(tokens(trendTitle));
  if (candidateTokens.size === 0 || trendTokens.size < 2) return 0;
  let overlap = 0;
  for (const token of trendTokens) if (candidateTokens.has(token)) overlap++;
  if (overlap < 2) return 0;
  const coverage = overlap / Math.min(6, trendTokens.size);
  return Math.max(0, Math.min(8, Math.round(coverage * 8)));
}

module.exports = {
  SLOT_MS,
  SAFE_LANES,
  tokens,
  rotateSearchBatch,
  readTrendSnapshot,
  buildTrendSearches,
  scoreTrendTitleOverlap
};
