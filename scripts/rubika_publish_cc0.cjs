const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { rankCandidates, buildTrendWeights } = require('./quality_rank.cjs');

const TOKEN = process.env.RUBIKA_BOT_TOKEN || '';
// RUN_RUBIKA_REAL_PUBLISH_TEST validation: publish one verified-license silent vertical MP4, then persist its ID.
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const PREPARE_ONLY = /^(1|true|yes)$/i.test(process.env.PREPARE_ONLY || '');
const CHANNEL_HANDLE = '@didobyn';
const API_ROOT = 'https://botapi.rubika.ir/v3/';
const STATE_PATH = path.join('state', 'rubika-published.json');
const SHARED_STATE_PATH = path.join('state', 'shared-publications.json');
const SHARED_WORK_DIR = path.join(process.cwd(), 'work', 'shared-publish');
const SHARED_VIDEO_PATH = path.join(SHARED_WORK_DIR, 'video.mp4');
const SHARED_MANIFEST_PATH = path.join(SHARED_WORK_DIR, 'manifest.json');
const WORK_DIR = path.join(process.cwd(), 'work', 'rubika-publish');
const INPUT_FILE = path.join(WORK_DIR, 'source-video.webm');
const OUTPUT_FILE = path.join(WORK_DIR, 'didobyn-short.mp4');
const MAX_SOURCE_BYTES = 30_000_000;
const MAX_OUTPUT_BYTES = 48_000_000;
const CONTENT_POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'content-policy.json'), 'utf8'));
const TARGET_WIDTH = Number(CONTENT_POLICY.vertical_video.output_width) || 1080;
const TARGET_HEIGHT = Number(CONTENT_POLICY.vertical_video.output_height) || 1920;
const WORK_HEIGHT = 1080;
const WORK_WIDTH = Math.round(WORK_HEIGHT * TARGET_WIDTH / TARGET_HEIGHT);
const MIN_DURATION_SECONDS = 8;
const MAX_DURATION_SECONDS = 180;
const LICENSES = {
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  ccby: 'https://creativecommons.org/licenses/by/4.0/'
};
const SEARCHES = [
  // Preserve Iranian/Persian discovery, but allocate these slots to comedy, reactions,
  // challenges, sports and food rather than letting animal searches dominate.
  { key: 'iranian-hidden-camera', query: 'filetype:video Iran hidden camera funny', localPriority: true },
  { key: 'iranian-comedy', query: 'filetype:video طنز ایرانی دوربین مخفی', localPriority: true },
  { key: 'persian-reactions', query: 'filetype:video واکنش خنده دار ایرانی', localPriority: true },
  { key: 'iranian-street-comedy', query: 'filetype:video طنز خیابانی فارسی', localPriority: true },
  { key: 'persian-challenges', query: 'filetype:video چالش خنده دار فارسی', localPriority: true },
  { key: 'iranian-sports-skills', query: 'filetype:video Iran football skill trick shot', localPriority: true },
  { key: 'persian-food', query: 'filetype:video آشپزی خلاقانه ایرانی', localPriority: true },
  { key: 'persian-satisfying', query: 'filetype:video ساختنی رضایت بخش فارسی', localPriority: true },

  // Hook-first broad searches: search for a surprising payoff, skill or reveal
  // instead of relying chiefly on general animal footage.
  { key: 'caught-on-camera', query: 'filetype:video caught on camera unexpected funny' },
  { key: 'surprise-reveal', query: 'filetype:video unexpected reveal surprising reaction twist' },
  { key: 'amazing-one-take-skills', query: 'filetype:video incredible one take skill impossible trick shot' },
  { key: 'visual-puzzle', query: 'filetype:video optical illusion brain teaser puzzle reveal' },
  { key: 'clever-invention-lifehack', query: 'filetype:video clever invention life hack unusual mechanism' },
  { key: 'transformation-payoff', query: 'filetype:video before after transformation restoration satisfying' },
  { key: 'sports-skill', query: 'filetype:video sports skill trick shot fail' },
  { key: 'science-experiments', query: 'filetype:video fun science experiment optical illusion' },
  { key: 'funny-pets', query: 'filetype:video funny pets unexpected reaction' },
  { key: 'food-cooking', query: 'filetype:video cooking recipe food art' },
  { key: 'magic-performance', query: 'filetype:video magic trick juggling performance' },
  { key: 'wholesome-moments', query: 'filetype:video wholesome kindness unexpected reunion' },
  { key: 'nature-wonders', query: 'filetype:video nature wonders unusual animal behavior' },
  { key: 'travel-culture', query: 'filetype:video Iran travel culture street life' },
];

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const tidy = value => String(value || '').replace(/\s+/g, ' ').trim();
const htmlText = value => tidy(String(value || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#0*39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

function licenseProfile(name, url) {
  const n = String(name || '');
  const u = String(url || '').replace(/&amp;/g, '&');
  if (/\bCC0\b/i.test(n) &&
      /creativecommons\.org\/publicdomain\/zero\/1\.0(?:\/|$)/i.test(u)) {
    return { type: 'CC0 1.0', url: LICENSES.cc0 };
  }
  if (/\bCC BY 4\.0\b/i.test(n) &&
      /creativecommons\.org\/licenses\/by\/4\.0(?:\/|$)/i.test(u) &&
      !/creativecommons\.org\/licenses\/by-(?:nc|nd|sa)(?:-|\/)/i.test(u)) {
    return { type: 'CC BY 4.0', url: LICENSES.ccby };
  }
  return null;
}

function durationFromMetadata(info) {
  const entries = Array.isArray(info?.commonmetadata) ? info.commonmetadata : [];
  for (const entry of entries) {
    if (!/duration|length|runtime|run time/i.test(String(entry.name || ''))) continue;
    const value = String(entry.value || '');
    const iso = value.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/i);
    if (iso) return Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0);
    const clock = value.match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
    if (clock) return Number(clock[1] || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    const seconds = value.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)/i);
    if (seconds) return Number(seconds[1]);
  }
  return null;
}

function isExcludedEditorialContent(text) {
  // Locality alone is not an entertainment category: reject protests, politics, weapons and military footage.
  return /\b(protests?|protesters?|demonstrations?|riot|riots|war|missile|military|army|weapon|weapons|election|politics|political|parliament|government|police crackdown)\b|اعتراضات?|تظاهرات|اغتشاش|جنگ|موشک|پهپاد|بمب|نظامی|تسلیحات|سلاح|انتخابات|سیاست|سیاسی|مجلس|دولت|درگیری|سرکوب/.test(String(text || '').toLowerCase());
}

function looksRelevant(fileTitle, description) {
  const text = (fileTitle + ' ' + description).toLowerCase();
  if (isExcludedEditorialContent(text)) return false;
  // Diverse visual-entertainment categories: the ranking selects the strongest candidates later.
  return /\\b(cat|cats|kitten|dog|dogs|puppy|bird|birds|parrot|squirrel|monkey|rabbit|animal|pet|wildlife|funny|unexpected|surprise|caught on camera|playing|playful|fail|visual comedy|oddly satisfying|satisfying|hidden camera|prank|comedy|humou?r|reaction|football|soccer|basketball|skateboard|parkour|trick shot|science experiment|invention|optical illusion|puzzle|cooking|recipe|food art|woodworking|pottery|craft|restoration|dance|music performance|juggling|nature|waterfall|travel|culture|architecture)\\b|گربه|سگ|حیوان|پرنده|بامزه|طنز|خنده|دوربین مخفی|سوتی|پرنک|چالش|فوتبال|بسکتبال|ورزش|حرکت نمایشی|آزمایش علمی|اختراع|فناوری|خطای دید|معما|آشپزی|غذا|خوراکی|کاردستی|نجاری|سفال|رضایت.?بخش|بازسازی|رقص|نوازندگی|موسیقی|طبیعت|آبشار|سفر|گردشگری|فرهنگ|معماری/.test(text);
}

function candidateContentPriority(candidate) {
  const text = [candidate.fileTitle, candidate.description, candidate.author].join(' ').toLowerCase();
  const persian = /[پچژگکی]/.test(text) || /persian|farsi|فارسی|زبان فارسی/.test(text);
  const iranian = /iran|iranian|tehran|shiraz|esfahan|isfahan|tabriz|mashhad|ایران|ایرانی|تهران|شیراز|اصفهان|تبریز|مشهد/.test(text);
  return iranian && persian ? 4 : persian ? 3 : iranian ? 2 : 0;
}

function sourceVerticalScore(width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (!(w > 0 && h > 0)) return 1;
  const ratio = w / h;
  if (ratio >= 0.50 && ratio <= 0.64) return 3;
  if (ratio < 0.50 && ratio > 0.40) return 2;
  if (ratio > 0.72) return 0;
  return 1;
}

function persianTitle(fileTitle, description) {
  const text = (fileTitle + ' ' + description).toLowerCase();
  if (/\\b(cat|cats|kitten)\\b|گربه/.test(text)) return 'یه لحظه بامزه از دنیای گربه‌ها 😹';
  if (/\\b(dog|dogs|puppy)\\b|سگ/.test(text)) return 'این حرکت سگ‌ها همیشه دیدنیه 🐶';
  if (/\\b(bird|birds|parrot)\\b|پرنده/.test(text)) return 'یه لحظه تماشایی از دنیای پرنده‌ها 🐦';
  if (/\\b(squirrel|monkey|rabbit)\\b/.test(text)) return 'رفتار جالبی که ارزش دیدن داره 🐾';
  if (/\\b(football|soccer|basketball|trick shot|parkour|freestyle|sports? skill|goal|dunk)\\b|فوتبال|بسکتبال|ورزش|دریبل|حرکت نمایشی/.test(text)) return 'یه مهارت ورزشی دیدنی 🏆';
  if (/\\b(science experiment|invention|technology demo|optical illusion|brain teaser|puzzle)\\b|آزمایش علمی|اختراع|فناوری|خطای دید|معما/.test(text)) return 'این آزمایش یا خطای دید رو ببین! 🧠';
  if (/\\b(oddly satisfying|satisfying|restoration|woodworking|pottery|craft|miniature|before and after|transformation)\\b|رضایت.?بخش|کاردستی|نجاری|سفال|مرمت|بازسازی|قبل و بعد/.test(text)) return 'یه تغییر یا ساختنی رضایت‌بخش ✨';
  if (/\\b(cooking|recipe|food art|food hack|kitchen|baking|street food)\\b|آشپزی|غذا|خوراکی|شیرینی|آشپزخانه/.test(text)) return 'یه ایده جالب از دنیای غذا 🍳';
  if (/\\b(magic|dancing|dance|music performance|musician|singing|instrument|juggling)\\b|شعبده|جادو|رقص|نوازندگی|موسیقی|خوانندگی|آکروبات/.test(text)) return 'یه اجرای دیدنی و متفاوت 🎭';
  if (/\\b(nature|landscape|weather phenomenon|ocean|volcano|waterfall|space footage)\\b|طبیعت|آبشار|اقیانوس|پدیده جوی|آتشفشان|منظره|فضا/.test(text)) return 'یه لحظه تماشایی از طبیعت 🌍';
  if (/\\b(travel|tourism|street life|local culture|traditional|architecture)\\b|سفر|گردشگری|فرهنگ|سنتی|معماری|ایرانگردی/.test(text)) return 'یه گوشه دیدنی از دنیا 🌎';
  if (/iranian|tehran|shiraz|ایران|ایرانی|تهران|شیراز|اصفهان/.test(text)) return 'یه لحظه دیدنی از ایران 🇮🇷';
  if (/persian|farsi|فارسی|طنز|خنده|دوربین مخفی|سوتی|پرنک|چالش|واکنش/.test(text)) return 'یه کلیپ فارسی که ارزش دیدن داره 😄';
  if (/\\b(caught on camera|unexpected|surprise|funny|fail)\\b/.test(text)) return 'این اتفاق غیرمنتظره رو از دست نده 😮';
  return 'یه کلیپ کوتاه و جالب 🎬';
}

function captionFor(candidate) {
  const lines = [
    candidate.title,
    '',
    'منبع: ' + candidate.fileTitle.replace(/^File:/i, ''),
    'پدیدآورنده: ' + (candidate.author || 'طبق اطلاعات صفحه منبع'),
    'مجوز: ' + candidate.license.type,
    'تغییرات: تبدیل خروجی به قالب عمودی ۹:۱۶ و حذف صدا برای سازگاری بارگذاری روبیکا.',
    candidate.sourcePage,
    candidate.license.url
  ];
  return lines.join('\n').slice(0, 1800);
}

async function rubika(method, body = {}) {
  const response = await fetch(API_ROOT + encodeURIComponent(TOKEN) + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(method + ': non_json_response_http_' + response.status); }
  if (!response.ok || data.status !== 'OK') {
    const reason = String(data.description || data.error || data.status || 'request_failed').replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(method + ': http_' + response.status + '_' + reason);
  }
  return data.data || data;
}

async function resolveChannel() {
  const result = await rubika('getChat', { chat_id: CHANNEL_HANDLE });
  const chat = result.chat || result.channel || result;
  const chatId = chat.chat_id || chat.id || chat.guid;
  const username = String(chat.username || chat.user_name || '').replace(/^@/, '').toLowerCase();
  const title = tidy(chat.title || chat.name || '');
  if (!chatId || (username !== 'didobyn' && title.replace(/\s/g, '') !== 'دیدوبین')) {
    throw new Error('rubika_channel_identity_check_failed');
  }
  return { chatId, title: title || 'دیدوبین', username: username || 'didobyn', type: chat.type || chat.chat_type || null };
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (state && Array.isArray(state.posts)) return state;
  } catch {}
  return { schemaVersion: 1, posts: [] };
}

function loadSharedState() {
  try {
    const state = JSON.parse(fs.readFileSync(SHARED_STATE_PATH, 'utf8'));
    if (state && Array.isArray(state.posts)) return state;
  } catch {}
  return { schemaVersion: 1, posts: [] };
}

function persistSharedState(state) {
  fs.mkdirSync(path.dirname(SHARED_STATE_PATH), { recursive: true });
  state.posts = (state.posts || []).slice(-600);
  fs.writeFileSync(SHARED_STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function writeSharedManifest(manifest) {
  fs.mkdirSync(SHARED_WORK_DIR, { recursive: true });
  fs.writeFileSync(SHARED_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function discoverCandidates(state) {
  const shared = loadSharedState();
  const used = new Set([
    ...(state.posts || []),
    ...(shared.posts || [])
  ].filter(item => ['published', 'submitted_unconfirmed', 'prepared'].includes(item.status))
    .map(item => item.sourcePage));
  const hits = new Map();
  // Search all Persian/Iranian targets first, then fallback to broadly useful licensed clips.
  const orderedSearches = [
    ...SEARCHES.filter(item => item.localPriority).slice(0, 8),
    ...SEARCHES.filter(item => !item.localPriority).slice(0, 14)
  ];
  for (const search of orderedSearches) {
    const url = new URL('https://commons.wikimedia.org/w/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('format', 'json');
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrnamespace', '6');
    url.searchParams.set('gsrlimit', '50');
    url.searchParams.set('gsrsearch', search.query);
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|mime|size|extmetadata|commonmetadata');
    let response = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(url, {
        headers: { 'User-Agent': 'GoushibaazRubikaPublisher/1.0 (verified commercial reuse)' },
        signal: AbortSignal.timeout(25000)
      });
      if (response.status !== 429 && response.status < 500) break;
      if (attempt >= 2) break;
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      const delayMs = Math.max(3000, Math.min(20000, retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 5000));
      console.warn('COMMONS_RATE_LIMIT_RETRY', JSON.stringify({ category: search.key, status: response.status, attempt: attempt + 1, delayMs }));
      await pause(delayMs);
    }
    if (!response || !response.ok) {
      console.log('COMMONS_SEARCH', JSON.stringify({ category: search.key, httpStatus: response && response.status }));
      continue;
    }
    const payload = await response.json();
    const pages = Object.values(payload.query?.pages || {});
    console.log('COMMONS_SEARCH', JSON.stringify({ category: search.key, results: pages.length }));
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info?.url || info.mime !== 'video/webm') continue;
      if (!Number.isFinite(info.size) || info.size < 200_000 || info.size > MAX_SOURCE_BYTES) continue;
      const meta = info.extmetadata || {};
      const license = licenseProfile(
        htmlText(meta.LicenseShortName?.value),
        htmlText(meta.LicenseUrl?.value)
      );
      if (!license) continue;
      const description = htmlText(meta.ImageDescription?.value);
      const fileTitle = String(page.title || '');
      const editorialText = (fileTitle + ' ' + description).toLowerCase();
      if (isExcludedEditorialContent(editorialText) || !looksRelevant(fileTitle, description)) continue;
      const sourcePage = info.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(fileTitle.replace(/ /g, '_')));
      if (used.has(sourcePage)) continue;
      const durationSeconds = durationFromMetadata(info);
      if (durationSeconds !== null &&
          (durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS)) continue;
      const candidate = {
        fileTitle,
        sourcePage,
        fileUrl: info.url,
        size: info.size,
        durationSeconds,
        license,
        author: htmlText(meta.Artist?.value),
        description,
        sourceWidth: Number(info.width) > 0 ? Number(info.width) : null,
        sourceHeight: Number(info.height) > 0 ? Number(info.height) : null,
        sourceAspectRatio: Number(info.width) > 0 && Number(info.height) > 0
          ? Math.round((Number(info.width) / Number(info.height)) * 1000) / 1000 : null,
        discoveryQuery: search.key,
        localPriorityQuery: Boolean(search.localPriority)
      };
      candidate.contentLocaleScore = Math.max(candidateContentPriority(candidate), search.localPriority ? 1 : 0);
      candidate.sourceVerticalScore = sourceVerticalScore(candidate.sourceWidth, candidate.sourceHeight);
      candidate.title = persianTitle(fileTitle, description);
      const previousCandidate = hits.get(sourcePage);
      if (!previousCandidate || candidate.contentLocaleScore > previousCandidate.contentLocaleScore ||
          (candidate.contentLocaleScore === previousCandidate.contentLocaleScore && candidate.sourceVerticalScore > previousCandidate.sourceVerticalScore)) {
        hits.set(sourcePage, candidate);
      }
    }
    await pause(1000);
  }
  let trendSnapshot = {};
  try {
    trendSnapshot = JSON.parse(fs.readFileSync(path.join('state', 'platform-trends.json'), 'utf8'));
  } catch {}
  const trendWeights = buildTrendWeights(trendSnapshot);
  const ranked = rankCandidates([...hits.values()], {
    trendWeights,
    recentPosts: state.posts || []
  });
  console.log('RUBIKA_CONTENT_PRIORITY', JSON.stringify({
    localPersianOrIranian: ranked.filter(item => item.contentLocaleScore >= 2).length,
    portraitSourceCandidates: ranked.filter(item => item.sourceVerticalScore >= 2).length,
    eligibleLicensedCandidates: ranked.length,
    targetAspectRatio: CONTENT_POLICY.vertical_video.aspect_ratio,
    trendWeights,
    topCandidates: ranked.slice(0, 8).map(item => ({
      title: item.title,
      sourceTitle: item.fileTitle,
      topic: item.editorialTopic,
      score: item.editorialScore,
      durationSeconds: item.durationSeconds,
      reasons: item.editorialReasons
    }))
  }));
  return ranked;
}

async function downloadSource(candidate) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const response = await fetch(candidate.fileUrl, {
    headers: { 'User-Agent': 'GoushibaazRubikaPublisher/1.0 (verified commercial reuse)' },
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error('commons_download_http_' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 200_000 || bytes.length > MAX_SOURCE_BYTES) throw new Error('source_size_out_of_range');
  if (!(bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) {
    throw new Error('source_file_is_not_webm');
  }
  fs.writeFileSync(INPUT_FILE, bytes);
  const probe = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    INPUT_FILE
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim();
  const durationSeconds = Number(probe);
  if (!Number.isFinite(durationSeconds) || durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error('source_duration_out_of_range_or_unavailable');
  }
  return { bytes: bytes.length, durationSeconds: Math.round(durationSeconds * 100) / 100 };
}

function convertPortrait() {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', INPUT_FILE,
    '-vf', `scale=${WORK_WIDTH}:${WORK_HEIGHT}:force_original_aspect_ratio=increase,crop=${WORK_WIDTH}:${WORK_HEIGHT},scale=${TARGET_WIDTH}:${TARGET_HEIGHT},setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    // Rubika's Bot API upload endpoint times out on MP4s with an audio stream in our tests.
    // Until that endpoint works with audio, deliver supported silent MP4 video instead.
    '-an',
    '-maxrate', '1400k', '-bufsize', '2800k',
    '-movflags', '+faststart',
    OUTPUT_FILE
  ], { stdio: 'pipe', timeout: 180000 });
  const stat = fs.statSync(OUTPUT_FILE);
  if (stat.size < 100_000 || stat.size > MAX_OUTPUT_BYTES) throw new Error('converted_mp4_size_out_of_range');
  const header = Buffer.alloc(12);
  const fd = fs.openSync(OUTPUT_FILE, 'r');
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('converted_file_is_not_mp4');
  return { bytes: stat.size };
}

async function uploadVideo(filePath) {
  const file = fs.readFileSync(filePath);
  console.log('RUBIKA_VIDEO_UPLOAD_STARTED', JSON.stringify({ bytes: file.length, type: 'silent_mp4' }));
  let lastError;
  // A timed-out upload never reaches sendFile, so retrying with a fresh upload URL cannot create a duplicate public post.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const request = await rubika('requestSendFile', { type: 'Video' });
      const uploadUrl = request.upload_url || request.data?.upload_url;
      if (typeof uploadUrl !== 'string' || !/^https:\/\//i.test(uploadUrl)) {
        throw new Error('requestSendFile_missing_upload_url');
      }
      const endpoint = new URL(uploadUrl);
      console.log('RUBIKA_VIDEO_UPLOAD_ENDPOINT', JSON.stringify({ hostname: endpoint.hostname, attempt }));
      const form = new FormData();
      form.append('file', new Blob([file], { type: 'video/mp4' }), 'didobyn-short.mp4');
      const response = await fetch(uploadUrl, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(180000)
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 120) }; }
      if (!response.ok) throw new Error('rubika_file_upload_http_' + response.status);
      const fileId = data.data?.file_id || data.file_id || data.data?.file?.file_id;
      if (!fileId) {
        const reason = String(data.description || data.error || data.status || 'file_id_missing').slice(0, 120);
        throw new Error('rubika_file_upload_failed_' + reason);
      }
      console.log('RUBIKA_VIDEO_FILE_UPLOADED', JSON.stringify({ bytes: file.length, attempt }));
      return fileId;
    } catch (error) {
      lastError = error;
      console.warn('RUBIKA_VIDEO_UPLOAD_ATTEMPT_FAILED', JSON.stringify({
        attempt,
        reason: String(error && error.message || error).replace(/\\s+/g, ' ').slice(0, 150)
      }));
      if (attempt >= 2) break;
      await pause(5000);
    }
  }
  throw lastError || new Error('rubika_video_upload_failed');
}

function persistState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  state.posts = state.posts.slice(-600);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function main() {
  let channel = null;
  if (!PREPARE_ONLY) {
    if (!TOKEN) throw new Error('missing_RUBIKA_BOT_TOKEN');
    const me = await rubika('getMe');
    const bot = me.bot || me.data?.bot || me.data || {};
    console.log('RUBIKA_BOT_AUTHENTICATED', JSON.stringify({
      botId: bot.bot_id || bot.id || null,
      botUsername: bot.username || bot.name || null
    }));
    channel = await resolveChannel();
    console.log('RUBIKA_CHANNEL_CONFIRMED', JSON.stringify({
      chatId: channel.chatId, title: channel.title, username: channel.username, type: channel.type
    }));
  } else {
    console.log('SHARED_PREPARATION_MODE: destination API checks skipped; licensed media selection only.');
  }

  const state = loadState();
  let normalizedLegacyUpload = false;
  for (const item of state.posts) {
    if (item.status === 'send_started' && !item.messageId) {
      item.status = 'upload_failed_retryable';
      item.note = 'Previous attempt timed out during media upload before sendFile was called.';
      item.normalizedAt = new Date().toISOString();
      normalizedLegacyUpload = true;
    }
  }
  if (normalizedLegacyUpload && !PREPARE_ONLY) persistState(state);

  const candidates = await discoverCandidates(state);
  if (!candidates.length) {
    const checkedAt = new Date().toISOString();
    state.lastOutcome = { status: 'no_eligible_candidate', checkedAt };
    if (!PREPARE_ONLY) persistState(state);
    if (PREPARE_ONLY) {
      writeSharedManifest({ schemaVersion: 1, status: 'no_eligible_candidate', checkedAt });
      const shared = loadSharedState();
      shared.lastOutcome = { status: 'no_eligible_candidate', checkedAt };
      persistSharedState(shared);
    }
    console.log('RUBIKA_PUBLISH_RESULT', JSON.stringify({ status: 'no_eligible_candidate', dryRun: DRY_RUN, prepareOnly: PREPARE_ONLY }));
    return;
  }

  let candidate = null;
  let sourceInfo = null;
  const failures = [];
  for (const proposed of candidates.slice(0, 8)) {
    try {
      sourceInfo = await downloadSource(proposed);
      candidate = proposed;
      break;
    } catch (error) {
      failures.push({ source: proposed.sourcePage, reason: String(error.message || error).slice(0, 120) });
    }
  }
  if (!candidate) {
    const checkedAt = new Date().toISOString();
    state.lastOutcome = { status: 'no_eligible_candidate', checkedAt };
    if (!PREPARE_ONLY) persistState(state);
    if (PREPARE_ONLY) {
      writeSharedManifest({ schemaVersion: 1, status: 'no_eligible_candidate', checkedAt, preparationFailures: failures });
      const shared = loadSharedState();
      shared.lastOutcome = { status: 'no_eligible_candidate', checkedAt };
      persistSharedState(shared);
    }
    console.log('RUBIKA_PUBLISH_RESULT', JSON.stringify({
      status: 'no_eligible_candidate', dryRun: DRY_RUN, prepareOnly: PREPARE_ONLY, candidatesChecked: Math.min(candidates.length, 8),
      preparationFailures: failures
    }));
    return;
  }

  state.lastOutcome = { status: 'candidate_ready', checkedAt: new Date().toISOString(), sourcePage: candidate.sourcePage };
  if (!PREPARE_ONLY) persistState(state);
  const converted = convertPortrait();
  const resultSummary = {
    title: candidate.title,
    sourcePage: candidate.sourcePage,
    sourceTitle: candidate.fileTitle,
    license: candidate.license.type,
    sourceBytes: sourceInfo.bytes,
    outputBytes: converted.bytes,
    sourceWidth: candidate.sourceWidth || null,
    sourceHeight: candidate.sourceHeight || null,
    sourceAspectRatio: candidate.sourceAspectRatio || null,
    targetAspectRatio: CONTENT_POLICY.vertical_video.aspect_ratio,
    contentLocaleScore: candidate.contentLocaleScore || 0,
    sourceVerticalScore: candidate.sourceVerticalScore || 1,
    durationSeconds: sourceInfo.durationSeconds
  };
  if (PREPARE_ONLY) {
    if (!DRY_RUN) throw new Error('PREPARE_ONLY_requires_DRY_RUN');
    fs.mkdirSync(SHARED_WORK_DIR, { recursive: true });
    fs.copyFileSync(OUTPUT_FILE, SHARED_VIDEO_PATH);
    const videoBytes = fs.readFileSync(SHARED_VIDEO_PATH);
    const sha256 = crypto.createHash('sha256').update(videoBytes).digest('hex');
    const checkedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1, status: 'prepared', preparedAt: checkedAt,
      ...resultSummary, sha256, fileName: 'video.mp4',
      caption: captionFor(candidate).slice(0, 1000),
      sourcePage: candidate.sourcePage, licenseUrl: candidate.license.url,
      author: candidate.author || ''
    };
    writeSharedManifest(manifest);
    const shared = loadSharedState();
    shared.posts.push({
      sourcePage: candidate.sourcePage, title: candidate.title,
      sourceTitle: candidate.fileTitle, license: candidate.license.type,
      licenseUrl: candidate.license.url, sha256, preparedAt: checkedAt,
      status: 'prepared', destinations: {}
    });
    shared.lastOutcome = { status: 'shared_candidate_prepared', checkedAt, sourcePage: candidate.sourcePage, sha256 };
    persistSharedState(shared);
    state.lastOutcome = { status: 'shared_candidate_prepared', checkedAt, sourcePage: candidate.sourcePage, sha256 };
    persistState(state);
    console.log('SHARED_CANDIDATE_PREPARED', JSON.stringify({
      title: manifest.title, sourcePage: manifest.sourcePage,
      license: manifest.license, durationSeconds: manifest.durationSeconds,
      bytes: videoBytes.length, sha256
    }));
    return;
  }
  if (DRY_RUN) {
    state.lastOutcome = { status: 'dry_run_ready_no_post_sent', checkedAt: new Date().toISOString(), sourcePage: candidate.sourcePage };
    persistState(state);
    console.log('RUBIKA_PUBLISH_RESULT', JSON.stringify({
      status: 'dry_run_ready_no_post_sent', dryRun: true, ...resultSummary
    }));
    return;
  }

  // Track upload and message-sending separately so upload failures can be retried without risking duplicate posts.
  const entry = {
    ...resultSummary,
    status: 'upload_started',
    attemptedAt: new Date().toISOString()
  };
  state.posts.push(entry);
  persistState(state);

  let fileId;
  try {
    fileId = await uploadVideo(OUTPUT_FILE);
  } catch (error) {
    entry.status = 'upload_failed_retryable';
    entry.uploadFailure = String(error && error.message || error).replace(/\s+/g, ' ').slice(0, 180);
    entry.failedAt = new Date().toISOString();
    state.lastOutcome = { status: 'upload_failed_retryable', checkedAt: entry.failedAt, sourcePage: entry.sourcePage };
    persistState(state);
    throw error;
  }

  // Once sendFile begins, keep the source in the dedupe set until the result is known.
  entry.status = 'submitted_unconfirmed';
  entry.uploadedAt = new Date().toISOString();
  persistState(state);

  const sent = await rubika('sendFile', {
    chat_id: channel.chatId,
    file_id: fileId,
    text: captionFor(candidate)
  });
  const message = sent.message || sent.data?.message || sent.data || sent;
  const messageId = message.message_id || message.id;
  if (!messageId) {
    entry.sendFailure = 'sendFile_accepted_without_message_id';
    persistState(state);
    throw new Error('sendFile_accepted_without_message_id');
  }
  entry.status = 'published';
  entry.messageId = String(messageId);
  entry.publishedAt = new Date().toISOString();
  state.lastOutcome = { status: 'published', checkedAt: entry.publishedAt, sourcePage: entry.sourcePage, messageId: entry.messageId };
  persistState(state);
  console.log('RUBIKA_PUBLISH_RESULT', JSON.stringify({
    status: entry.status, messageId: entry.messageId, title: entry.title,
    sourcePage: entry.sourcePage, license: entry.license, durationSeconds: entry.durationSeconds
  }));
}

main().catch(error => {
  console.error('RUBIKA_PUBLISH_FAILED', String(error && error.message || error).replace(/\s+/g, ' ').slice(0, 220));
  process.exitCode = 1;
});
