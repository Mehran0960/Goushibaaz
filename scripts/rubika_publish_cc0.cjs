const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TOKEN = process.env.RUBIKA_BOT_TOKEN || '';
// One-time live-channel validation is controlled only by the workflow environment; the scheduled workflow publishes normally.
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const CHANNEL_HANDLE = '@didobyn';
const API_ROOT = 'https://botapi.rubika.ir/v3/';
const STATE_PATH = path.join('state', 'rubika-published.json');
const WORK_DIR = path.join(process.cwd(), 'work', 'rubika-publish');
const INPUT_FILE = path.join(WORK_DIR, 'source-video.webm');
const OUTPUT_FILE = path.join(WORK_DIR, 'didobyn-short.mp4');
const MAX_SOURCE_BYTES = 30_000_000;
const MAX_OUTPUT_BYTES = 48_000_000;
const MIN_DURATION_SECONDS = 3;
const MAX_DURATION_SECONDS = 180;
const LICENSES = {
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  ccby: 'https://creativecommons.org/licenses/by/4.0/'
};
const SEARCHES = [
  { key: 'cats', query: 'filetype:video cat' },
  { key: 'dogs', query: 'filetype:video dog' },
  { key: 'birds', query: 'filetype:video bird' },
  { key: 'funny-animals', query: 'filetype:video funny animal' },
  { key: 'persian-cats', query: 'filetype:video گربه' },
  { key: 'camera-moments', query: 'filetype:video caught on camera animal' }
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

function looksRelevant(fileTitle, description) {
  return /\b(cat|cats|kitten|dog|dogs|puppy|bird|birds|parrot|squirrel|monkey|rabbit|animal|pet|wildlife|funny|unexpected|surprise|caught on camera|playing|fail)\b|گربه|سگ|حیوان|پرنده|بامزه/i
    .test(fileTitle + ' ' + description);
}

function persianTitle(fileTitle, description) {
  const text = (fileTitle + ' ' + description).toLowerCase();
  if (/\b(cat|cats|kitten)\b|گربه/.test(text)) return 'یه لحظه بامزه از دنیای گربه‌ها 😹';
  if (/\b(dog|dogs|puppy)\b|سگ/.test(text)) return 'این حرکت سگ‌ها همیشه دیدنیه 🐶';
  if (/\b(bird|birds|parrot)\b|پرنده/.test(text)) return 'یه لحظه تماشایی از دنیای پرنده‌ها 🐦';
  if (/\b(squirrel|monkey|rabbit)\b/.test(text)) return 'رفتار جالبی که ارزش دیدن داره 🐾';
  if (/\b(caught on camera|unexpected|surprise|funny|fail)\b/.test(text)) return 'این اتفاق غیرمنتظره رو از دست نده 😮';
  return 'یه لحظه دیدنی از دنیای حیوانات 🐾';
}

function captionFor(candidate) {
  const lines = [
    candidate.title,
    '',
    'منبع: ' + candidate.fileTitle.replace(/^File:/i, ''),
    'پدیدآورنده: ' + (candidate.author || 'طبق اطلاعات صفحه منبع'),
    'مجوز: ' + candidate.license.type,
    ...(candidate.license.type === 'CC BY 4.0'
      ? ['تغییرات: برش و تبدیل ویدئو به قالب عمودی ۹:۱۶.']
      : []),
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

async function discoverCandidates(state) {
  const used = new Set((state.posts || [])
    .filter(item => ['published', 'send_started', 'submitted_unconfirmed'].includes(item.status))
    .map(item => item.sourcePage));
  const hits = new Map();
  for (let i = 0; i < 4; i++) {
    const search = SEARCHES[(used.size + i) % SEARCHES.length];
    const url = new URL('https://commons.wikimedia.org/w/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('format', 'json');
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrnamespace', '6');
    url.searchParams.set('gsrlimit', '50');
    url.searchParams.set('gsrsearch', search.query);
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|mime|size|extmetadata|commonmetadata');
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GoushibaazRubikaPublisher/1.0 (verified commercial reuse)' },
      signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) {
      console.log('COMMONS_SEARCH', JSON.stringify({ category: search.key, httpStatus: response.status }));
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
      if (!looksRelevant(fileTitle, description)) continue;
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
        description
      };
      candidate.title = persianTitle(fileTitle, description);
      hits.set(sourcePage, candidate);
    }
    await pause(250);
  }
  return [...hits.values()];
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
    '-vf', 'scale=608:1080:force_original_aspect_ratio=increase,crop=608:1080,scale=1080:1920,setsar=1',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
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
  const request = await rubika('requestSendFile', { type: 'Video' });
  const uploadUrl = request.upload_url || request.data?.upload_url;
  if (typeof uploadUrl !== 'string' || !/^https:\/\//i.test(uploadUrl)) {
    throw new Error('requestSendFile_missing_upload_url');
  }
  const file = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([file], { type: 'video/mp4' }), 'didobyn-short.mp4');
  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(90000)
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
  return fileId;
}

function persistState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  state.posts = state.posts.slice(-600);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function main() {
  if (!TOKEN) throw new Error('missing_RUBIKA_BOT_TOKEN');
  const me = await rubika('getMe');
  const bot = me.bot || me.data?.bot || me.data || {};
  console.log('RUBIKA_BOT_AUTHENTICATED', JSON.stringify({
    botId: bot.bot_id || bot.id || null,
    botUsername: bot.username || bot.name || null
  }));
  const channel = await resolveChannel();
  console.log('RUBIKA_CHANNEL_CONFIRMED', JSON.stringify({
    chatId: channel.chatId, title: channel.title, username: channel.username, type: channel.type
  }));

  const state = loadState();
  const candidates = await discoverCandidates(state);
  if (!candidates.length) {
    console.log('RUBIKA_PUBLISH_RESULT', JSON.stringify({ status: 'no_eligible_candidate', dryRun: DRY_RUN }));
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
    console.log('RUBIKA_PUBLISH_RESULT', JSON.stringify({
      status: 'no_eligible_candidate', dryRun: DRY_RUN, candidatesChecked: Math.min(candidates.length, 8),
      preparationFailures: failures
    }));
    return;
  }

  const converted = convertPortrait();
  const resultSummary = {
    title: candidate.title,
    sourcePage: candidate.sourcePage,
    sourceTitle: candidate.fileTitle,
    license: candidate.license.type,
    sourceBytes: sourceInfo.bytes,
    outputBytes: converted.bytes,
    durationSeconds: sourceInfo.durationSeconds
  };
  if (DRY_RUN) {
    console.log('RUBIKA_PUBLISH_RESULT', JSON.stringify({
      status: 'dry_run_ready_no_post_sent', dryRun: true, ...resultSummary
    }));
    return;
  }

  // Record the attempt before posting. A later workflow failure should not silently republish this source.
  const entry = {
    ...resultSummary,
    status: 'send_started',
    attemptedAt: new Date().toISOString()
  };
  state.posts.push(entry);
  persistState(state);

  const fileId = await uploadVideo(OUTPUT_FILE);
  const sent = await rubika('sendFile', {
    chat_id: channel.chatId,
    file_id: fileId,
    text: captionFor(candidate)
  });
  const message = sent.message || sent.data?.message || sent.data || sent;
  const messageId = message.message_id || message.id;
  if (!messageId) throw new Error('sendFile_accepted_without_message_id');
  entry.status = 'published';
  entry.messageId = String(messageId);
  entry.publishedAt = new Date().toISOString();
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
