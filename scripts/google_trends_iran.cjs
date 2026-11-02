'use strict';

const RSS_URL = 'https://trends.google.com/trending/rss?geo=IR';
const STOP_WORDS = new Set([
  'این','آن','اینکه','از','با','برای','به','در','را','روی','و','یا','اما','اگر','هم',
  'یک','چند','چه','چرا','چی','چطور','امروز','دیروز','فردا','شد','شده','شود','است',
  'هست','بود','بودن','می','های','ها','ترین','the','and','for','with','from','into',
  'what','when','where','why','how','who','new','today','tomorrow','yesterday'
]);
const IRRELEVANT_TOPIC = /(?:آب.?و.?هوا|وضعیت هوا|پیش.?بینی هوا|دمای هوا|قیمت دلار|قیمت یورو|نرخ ارز|قیمت طلا|قیمت سکه|قیمت بیت.?کوین|قیمت دوج.?کوین|قیمت اتریوم|بورس|شاخص بورس|انتخابات|سیاست|سیاسی|جنگ|حمله نظامی|زلزله|سیل|آتش.?سوزی|اخبار فوری|breaking news|weather\\b|forecast|stock market|exchange rate|election|politic|war|earthquake|flood)/i;

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/\s+/g, ' ')
    .trim();
}

function readTag(xml, tagName) {
  const pattern = '<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tagName + '\\s*>';
  const match = String(xml || '').match(new RegExp(pattern, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('fa-IR')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u200c\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return normalizeText(value)
    .split(' ')
    .filter(token => token.length >= 2 && !STOP_WORDS.has(token));
}

function parseTraffic(value) {
  const text = String(value || '').replace(/,/g, '').trim().toUpperCase();
  const match = text.match(/(\d+(?:\.\d+)?)\s*([KMB])?/);
  if (!match) return 0;
  const scale = match[2] === 'B' ? 1e9 : match[2] === 'M' ? 1e6 : match[2] === 'K' ? 1e3 : 1;
  return Math.round(Number(match[1]) * scale);
}

function trafficMultiplier(traffic) {
  if (traffic >= 10_000_000) return 1.35;
  if (traffic >= 1_000_000) return 1.25;
  if (traffic >= 500_000) return 1.18;
  if (traffic >= 200_000) return 1.1;
  if (traffic >= 50_000) return 1.04;
  return 1;
}

function parseIranTrendsRss(xml, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxItems = Math.max(1, Math.min(100, Math.floor(Number(options.maxItems) || 40)));
  const maxAgeHours = Math.max(1, Math.min(168, Number(options.maxAgeHours) || 48));
  const rawItems = [...String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  const parsed = [];

  for (const [index, match] of rawItems.entries()) {
    const body = match[1];
    const title = readTag(body, 'title');
    if (!title || title.length < 2 || IRRELEVANT_TOPIC.test(title)) continue;

    const publishedAt = readTag(body, 'pubDate');
    const publishedMs = Date.parse(publishedAt);
    const ageHours = Number.isFinite(publishedMs)
      ? Math.max(0, (nowMs - publishedMs) / 3_600_000)
      : null;
    if (ageHours !== null && (ageHours > maxAgeHours || publishedMs > nowMs + 5 * 60_000)) continue;

    const trafficText = readTag(body, 'ht:approx_traffic');
    const traffic = parseTraffic(trafficText);
    const keywords = [...new Set(tokens(title))];
    if (!keywords.length) continue;

    parsed.push({
      id: String(publishedAt || 'undated') + ':' + index + ':' + normalizeText(title).slice(0, 80),
      title: title.slice(0, 180),
      keywords,
      traffic,
      trafficText,
      publishedAt: publishedAt || null,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      newsItems: [...body.matchAll(/<ht:news_item\b[^>]*>([\s\S]*?)<\/ht:news_item>/gi)]
        .slice(0, 3)
        .map(itemBody => ({
          title: readTag(itemBody[1], 'ht:news_item_title'),
          source: readTag(itemBody[1], 'ht:news_item_source')
        }))
        .filter(item => item.title)
    });
  }

  return parsed
    .sort((a, b) => b.traffic - a.traffic || (a.ageHours ?? 999) - (b.ageHours ?? 999))
    .slice(0, maxItems);
}

function scoreGoogleTrendRelevance(candidateText, trends = []) {
  const candidate = normalizeText(candidateText);
  if (!candidate) return { score: 0, match: null };
  const candidateTokens = new Set(tokens(candidate));
  let best = { score: 0, match: null };

  for (const trend of Array.isArray(trends) ? trends : []) {
    if (!trend || !trend.title || IRRELEVANT_TOPIC.test(trend.title)) continue;
    const trendTokens = [...new Set(Array.isArray(trend.keywords) ? trend.keywords : tokens(trend.title))];
    if (!trendTokens.length) continue;

    const overlap = trendTokens.filter(token => candidateTokens.has(token));
    if (!overlap.length) continue;

    const exactPhrase = trendTokens.length > 1 && candidate.includes(normalizeText(trend.title));
    let base;
    if (trendTokens.length === 1) {
      if (trendTokens[0].length < 4) continue;
      base = 4.2;
    } else if (overlap.length >= 2) {
      base = 6.5 + Math.min(2, (overlap.length / trendTokens.length) * 2);
    } else {
      base = 2.6 + Math.min(1.2, 1.2 / trendTokens.length);
    }
    if (exactPhrase) base += 1.5;

    const ageHours = Number.isFinite(trend.ageHours) ? trend.ageHours : 24;
    const freshness = Math.max(0.35, Math.min(1, 1 - ageHours / 72));
    const score = Math.min(12, Math.round(base * trafficMultiplier(Number(trend.traffic) || 0) * freshness * 10) / 10);
    if (score > best.score) {
      best = {
        score,
        match: {
          title: String(trend.title).slice(0, 180),
          overlap: overlap.slice(0, 6),
          traffic: Number(trend.traffic) || 0,
          publishedAt: trend.publishedAt || null
        }
      };
    }
  }

  return best;
}

async function fetchIranGoogleTrends(options = {}) {
  const timeoutMs = Math.max(1000, Math.min(20_000, Number(options.timeoutMs) || 8000));
  const maxItems = Math.max(1, Math.min(100, Math.floor(Number(options.maxItems) || 40)));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  if (typeof fetchImpl !== 'function') {
    return { ok: false, source: RSS_URL, fetchedAt: new Date(nowMs).toISOString(), items: [], error: 'fetch_unavailable' };
  }

  try {
    const response = await fetchImpl(RSS_URL, {
      method: 'GET',
      headers: {
        'accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        'user-agent': 'Mozilla/5.0 (compatible; GoushibaazTrendScout/1.0)'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response || !response.ok) {
      return {
        ok: false, source: RSS_URL, fetchedAt: new Date(nowMs).toISOString(),
        items: [], error: 'http_' + (response ? response.status : 'no_response')
      };
    }
    const xml = await response.text();
    const items = parseIranTrendsRss(xml, { nowMs, maxItems });
    return {
      ok: items.length > 0,
      source: RSS_URL,
      fetchedAt: new Date(nowMs).toISOString(),
      itemCount: items.length,
      items,
      error: items.length ? null : 'rss_empty_or_unparseable'
    };
  } catch (error) {
    return {
      ok: false,
      source: RSS_URL,
      fetchedAt: new Date(nowMs).toISOString(),
      items: [],
      error: String(error && error.name === 'TimeoutError' ? 'timeout' : error && error.message || error).slice(0, 180)
    };
  }
}

module.exports = {
  RSS_URL,
  normalizeText,
  tokens,
  parseTraffic,
  parseIranTrendsRss,
  scoreGoogleTrendRelevance,
  fetchIranGoogleTrends
};
