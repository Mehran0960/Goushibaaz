'use strict';

const { buildTrendSearches } = require('./trend_discovery.cjs');
const { looksRelevant, persianTitle } = require('./editorial_content.cjs');

const API_ROOT = 'https://api.pexels.com/v1/videos';
const PEXELS_LICENSE_URL = 'https://www.pexels.com/license/';
const MIN_INTERVAL_MS = 15 * 60 * 1000;
const MIN_DURATION_SECONDS = 8;
const MAX_DURATION_SECONDS = 180;
const MAX_SOURCE_BYTES = 45_000_000;

function clean(value, max = 400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function videoTags(video) {
  const tags = Array.isArray(video && video.tags) ? video.tags : [];
  return tags.map(item => typeof item === 'string' ? item : item && (item.name || item.tag || item.title))
    .map(value => clean(value, 80))
    .filter(Boolean)
    .slice(0, 16);
}

function chooseVideoFile(video) {
  const files = Array.isArray(video && video.video_files) ? video.video_files : [];
  const eligible = files.filter(file =>
    file && typeof file.link === 'string' && /^https:\/\//i.test(file.link) &&
    String(file.file_type || '').toLowerCase().includes('mp4') &&
    Number(file.width) > 0 && Number(file.height) > 0
  );
  if (!eligible.length) return null;
  const bounded = eligible.filter(file => Math.max(Number(file.width), Number(file.height)) <= 1920);
  const pool = bounded.length ? bounded : eligible;
  return [...pool].sort((a, b) => {
    const targetPixels = 720 * 1280;
    const score = file => {
      const pixels = Number(file.width) * Number(file.height);
      const hdBonus = String(file.quality || '').toLowerCase() === 'hd' ? 0.25 : 0;
      return -Math.abs(Math.log(Math.max(1, pixels) / targetPixels)) + hdBonus;
    };
    return score(b) - score(a);
  })[0];
}

function videoToCandidate(video, options = {}) {
  if (!video || !Number.isFinite(Number(video.id))) return null;
  const sourcePage = String(video.url || '');
  if (!/^https:\/\/(?:www\.)?pexels\.com\/video\//i.test(sourcePage)) return null;

  const file = chooseVideoFile(video);
  if (!file) return null;
  const durationSeconds = Number(video.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS) return null;

  const tags = videoTags(video);
  if (!tags.length) return null;
  const tagText = tags.join(' ');
  if (!looksRelevant(tagText, tagText)) return null;

  const width = Number(video.width || file.width) || null;
  const height = Number(video.height || file.height) || null;
  const ratio = width && height ? width / height : null;
  const sourceVerticalScore = !ratio ? 1 : ratio >= 0.50 && ratio <= 0.64 ? 3 : ratio < 0.72 ? 1 : 0;
  const user = video.user || {};
  const lead = options.trendLead || null;
  const candidate = {
    sourceType: 'pexels',
    pexelsVideoId: String(video.id),
    sourcePage,
    fileUrl: file.link,
    mime: 'video/mp4',
    size: null,
    durationSeconds,
    fileTitle: tagText.slice(0, 240),
    description: ('Pexels stock video tags: ' + tagText).slice(0, 1200),
    author: clean(user.name || 'Pexels contributor', 120),
    authorUrl: clean(user.url || 'https://www.pexels.com', 400),
    licenseName: 'Pexels License',
    licenseUrl: PEXELS_LICENSE_URL,
    licenseType: 'Pexels License',
    sourceWidth: width,
    sourceHeight: height,
    sourceAspectRatio: ratio ? Math.round(ratio * 1000) / 1000 : null,
    sourceVerticalScore,
    contentLocaleScore: 0,
    discoveryQuery: options.mode === 'popular' ? 'pexels_popular' : 'pexels_trend_search',
    trendSearchTitle: lead && lead.trendTitle || undefined,
    trendSearchUrl: lead && lead.trendUrl || undefined,
    trendSearchVelocity: lead && lead.trendVelocity || undefined,
    trendSearchAcceleration: lead && lead.trendAcceleration || undefined,
    trendSearchLane: lead && lead.trendLane || undefined
  };
  candidate.title = persianTitle(candidate.fileTitle, candidate.description);
  if (!candidate.title) return null;
  candidate.descriptionText = [
    candidate.title,
    '',
    'این ویدئو با عنوان‌گذاری فارسی و تدوین عمودی به یک کلیپ اختصاصی گوشی‌باز تبدیل شده است.',
    'منبع ویدئو: Pexels',
    'تصویربردار: ' + candidate.author,
    'پروفایل تصویربردار: ' + candidate.authorUrl,
    'صفحه ویدئو: ' + candidate.sourcePage,
    'Pexels: https://www.pexels.com',
    'مجوز: Pexels License — ' + PEXELS_LICENSE_URL
  ].join('\n');
  return candidate;
}

async function discoverPexelsCandidates(options = {}) {
  const state = options.state && typeof options.state === 'object' ? options.state : {};
  const used = options.used instanceof Set ? options.used : new Set();
  const apiKey = String(options.apiKey || process.env.PEXELS_API_KEY || '').trim();
  if (!apiKey) {
    console.log('PEXELS_DISCOVERY_SKIPPED', JSON.stringify({ reason: 'PEXELS_API_KEY_not_configured' }));
    return [];
  }

  const now = Number(options.nowMs || Date.now());
  const lastChecked = Date.parse(state.pexelsLastCheckedAt || '');
  if (Number.isFinite(lastChecked) && now - lastChecked < MIN_INTERVAL_MS) {
    console.log('PEXELS_DISCOVERY_SKIPPED', JSON.stringify({ reason: '15_minute_cache_window', lastCheckedAt: state.pexelsLastCheckedAt }));
    return [];
  }
  state.pexelsLastCheckedAt = new Date(now).toISOString();

  const lead = buildTrendSearches(undefined, { nowMs: now, limit: 2 })[0] || null;
  const searchTerms = Array.isArray(lead && lead.searchTerms) ? lead.searchTerms : [];
  const query = searchTerms.slice(0, 6).join(' ').trim();
  const url = new URL(query ? API_ROOT + '/search' : API_ROOT + '/popular');
  if (query) url.searchParams.set('query', query.slice(0, 180));
  url.searchParams.set('per_page', '40');
  url.searchParams.set('min_duration', String(MIN_DURATION_SECONDS));
  url.searchParams.set('max_duration', String(MAX_DURATION_SECONDS));

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: apiKey,
        Accept: 'application/json',
        'User-Agent': 'GoushibaazPublisher/1.0 (licensed-short-video-discovery)'
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      state.pexelsLastCheckStatus = 'http_' + response.status;
      console.log('PEXELS_DISCOVERY_FAILED', JSON.stringify({ status: response.status, mode: query ? 'trend_search' : 'popular' }));
      return [];
    }

    const payload = await response.json();
    const videos = Array.isArray(payload.videos) ? payload.videos : [];
    const found = [];
    for (const video of videos) {
      const candidate = videoToCandidate(video, { trendLead: lead, mode: query ? 'search' : 'popular' });
      if (!candidate || used.has(candidate.sourcePage)) continue;
      found.push(candidate);
      if (found.length >= (Number(options.limit) || 25)) break;
    }

    state.pexelsLastCheckStatus = 'success';
    state.pexelsLastResultCount = videos.length;
    state.pexelsLastCandidateCount = found.length;
    console.log('PEXELS_SOURCE_COVERAGE', JSON.stringify({
      mode: query ? 'trend_search' : 'popular',
      query: query || null,
      observedTrendLead: lead && lead.trendTitle || null,
      apiVideos: videos.length,
      eligibleLicensedCandidates: found.length
    }));
    return found;
  } catch (error) {
    state.pexelsLastCheckStatus = 'request_failed';
    console.log('PEXELS_DISCOVERY_ERROR', JSON.stringify({
      errorKind: String(error && error.name || 'Error').slice(0, 50),
      reason: String(error && error.message || 'unknown').slice(0, 140)
    }));
    return [];
  }
}

module.exports = {
  PEXELS_LICENSE_URL,
  chooseVideoFile,
  videoToCandidate,
  discoverPexelsCandidates
};
