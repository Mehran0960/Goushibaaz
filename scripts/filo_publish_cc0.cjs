const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { rankCandidates, buildTrendWeights } = require('./quality_rank.cjs');
const { buildTrendSearches, rotateSearchBatch } = require('./trend_discovery.cjs');
const { probeMedia, convertToPortrait } = require('./media_format.cjs');
const { looksRelevant, persianTitle } = require('./editorial_content.cjs');
const { appendFiloEndCard } = require('./filo_endcard.cjs');
const ACCOUNT = 'https://ifilo.net';
const CC0_LICENSE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';
const STATE_PATH = path.join('state', 'filo-published.json');
const VIDEO_DIR = path.join(process.cwd(), 'work', 'filo-publish');
const INPUT_FILE = path.join(VIDEO_DIR, 'source-video.webm');
const OUTPUT_FILE = path.join(VIDEO_DIR, 'filo-video-fa.mp4');
const COVER_FILE = path.join(VIDEO_DIR, 'filo-video-cover.jpg');
const MAX_SOURCE_BYTES = 45_000_000;
const CONTENT_POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'content-policy.json'), 'utf8'));
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const FILO_PROFILE = CONTENT_POLICY.platform_profiles && CONTENT_POLICY.platform_profiles.filo || {};
const TARGET_WIDTH = Number(FILO_PROFILE.output_width) || Number(CONTENT_POLICY.vertical_video.output_width) || 1080;
const TARGET_HEIGHT = Number(FILO_PROFILE.output_height) || Number(CONTENT_POLICY.vertical_video.output_height) || 1920;
const COVER_WIDTH = Number(FILO_PROFILE.cover_width) || 720;
const COVER_HEIGHT = Number(FILO_PROFILE.cover_height) || 1280;
const WORK_HEIGHT = 1080;
const WORK_WIDTH = Math.round(WORK_HEIGHT * TARGET_WIDTH / TARGET_HEIGHT);
// Fail closed on reuse rights: only explicit CC0 1.0 or CC BY 4.0 license metadata is accepted.
const MAX_DAILY_PUBLICATIONS = 288;
const MIN_PUBLICATION_GAP_MS = 5 * 60 * 1000;
const MIN_DURATION_SECONDS = 8;
const MAX_DURATION_SECONDS = 180;
const ACTIVE_SOURCE_STATUSES = new Set([
  'published', 'submitted_pending_approval', 'submit_started',
  'submitted_unconfirmed', 'submit_result_unconfirmed', 'upload_staged_unpublished', 'rejected_by_filo'
]);
const COMMONS_SEARCHES = [
  // Persian-first entertainment discovery mirrors the useful content lanes surfaced by TrendsUpLoader.
  { key: 'iranian-hidden-camera', query: 'filetype:video ایران دوربین مخفی', localPriority: true },
  { key: 'iranian-comedy', query: 'filetype:video طنز ایرانی خنده دار', localPriority: true },
  { key: 'persian-reactions', query: 'filetype:video واکنش خنده دار فارسی', localPriority: true },
  { key: 'iranian-street-comedy', query: 'filetype:video طنز خیابانی فارسی', localPriority: true },
  { key: 'persian-challenges', query: 'filetype:video چالش خنده دار فارسی', localPriority: true },
  { key: 'iranian-sports-skills', query: 'filetype:video مهارت ورزشی ایران فوتبال', localPriority: true },
  { key: 'persian-food', query: 'filetype:video آشپزی خلاقانه فارسی', localPriority: true },
  { key: 'persian-tech-lifehack', query: 'filetype:video ترفند کاربردی فناوری فارسی', localPriority: true },
  { key: 'visual-comedy', query: 'filetype:video visual comedy' },
  { key: 'unexpected-reactions', query: 'filetype:video unexpected reaction' },
  { key: 'caught-on-camera', query: 'filetype:video caught on camera funny' },
  { key: 'harmless-pranks', query: 'filetype:video harmless prank' },
  { key: 'street-moments', query: 'filetype:video funny street moments' },
  { key: 'sports-fails', query: 'filetype:video funny sports fail' },
  { key: 'technology-demos', query: 'filetype:video surprising technology demo' },
  { key: 'food-cooking', query: 'filetype:video food cooking unexpected' },

  ...[
    ['iranian-pet-moments', 'filetype:video Iran pet', true],
    ['persian-cat-video', 'filetype:video Persian cat', true],
    ['iranian-dog-video', 'filetype:video Iran dog', true],
    ['iranian-birds', 'filetype:video Iran birds', true],
    ['iranian-wildlife', 'filetype:video Iran wildlife', true],
    ['iranian-nature', 'filetype:video Iran nature', true],
    ['iranian-countryside', 'filetype:video Iran village', true],
    ['persian-culture', 'filetype:video Persian culture', true],
    ['iranian-travel', 'filetype:video Iran travel', true],
    ['tehran-street-life', 'filetype:video Tehran street', true],
    ['iranian-food', 'filetype:video Iranian food', true],
    ['iranian-crafts', 'filetype:video Iran crafts', true],
    ['iranian-farming', 'filetype:video Iran farming', true],
    ['iranian-family', 'filetype:video Iranian family', true],
    ['persian-comedy-visual', 'filetype:video Persian comedy', true],
    ['iranian-sports', 'filetype:video Iran sports', true],
    ['persian-garden', 'filetype:video Persian garden', true],
    ['iranian-markets', 'filetype:video Iran market', true],
    ['iranian-insects', 'filetype:video Iran insects', true],
    ['iranian-waterways', 'filetype:video Iran river', true],
    ['funny-puppies', 'filetype:video funny puppies'],
    ['playful-dogs', 'filetype:video playful dogs'],
    ['funny-kittens', 'filetype:video funny kittens'],
    ['cats-playing', 'filetype:video cats playing'],
    ['cats-camera', 'filetype:video cats caught camera'],
    ['dogs-camera', 'filetype:video dogs caught camera'],
    ['pets-unexpected', 'filetype:video unexpected pets'],
    ['funny-parrots', 'filetype:video funny parrots'],
    ['funny-birds', 'filetype:video funny birds'],
    ['squirrels-playing', 'filetype:video squirrels playing'],
    ['monkeys-playing', 'filetype:video monkeys playing'],
    ['rabbits-playing', 'filetype:video rabbits playing'],
    ['farm-animals', 'filetype:video funny farm animals'],
    ['wildlife-behavior', 'filetype:video unusual animal behavior'],
    ['animal-rescue', 'filetype:video animal rescue'],
    ['animal-friendship', 'filetype:video animal friendship'],
    ['funny-wildlife', 'filetype:video funny wildlife'],
    ['visual-comedy', 'filetype:video visual comedy'],
    ['slapstick', 'filetype:video slapstick comedy'],
    ['silent-comedy', 'filetype:video silent comedy'],
    ['unexpected-reactions', 'filetype:video unexpected reaction'],
    ['caught-on-camera', 'filetype:video caught on camera funny'],
    ['harmless-pranks', 'filetype:video harmless prank'],
    ['street-moments', 'filetype:video funny street moments'],
    ['oddly-satisfying', 'filetype:video oddly satisfying'],
    ['satisfying-process', 'filetype:video satisfying process'],
    ['creative-builds', 'filetype:video creative build process'],
    ['craft-process', 'filetype:video craft process'],
    ['woodworking', 'filetype:video woodworking process'],
    ['pottery-process', 'filetype:video pottery process'],
    ['cooking-process', 'filetype:video cooking process'],
    ['cooking-fails', 'filetype:video cooking fail'],
    ['food-art', 'filetype:video food art'],
    ['science-experiments', 'filetype:video fun science experiment'],
    ['optical-illusions', 'filetype:video optical illusion'],
    ['magic-tricks', 'filetype:video magic trick'],
    ['simple-inventions', 'filetype:video simple invention'],
    ['life-hacks', 'filetype:video practical life hack'],
    ['sports-fails', 'filetype:video funny sports fail'],
    ['football-skills', 'filetype:video football skills'],
    ['skateboard-fails', 'filetype:video skateboard fail'],
    ['cycling-moments', 'filetype:video funny cycling'],
    ['water-sports', 'filetype:video funny water sports'],
    ['nature-wonders', 'filetype:video nature wonders'],
    ['tiny-world', 'filetype:video macro nature insects'],
    ['weather-wonders', 'filetype:video unusual weather phenomenon'],
    ['machine-process', 'filetype:video satisfying machine process'],
    ['restoration', 'filetype:video satisfying restoration'],
    ['recycling-crafts', 'filetype:video creative recycling craft'],
    ['miniature-builds', 'filetype:video miniature building'],
    ['public-domain-animation', 'filetype:video public domain animation'],
    ['family-friendly-animation', 'filetype:video short animation'],
    ['daily-life-moments', 'filetype:video funny daily life'],
    ['pets-and-people', 'filetype:video pets people funny'],
    ['birds-feeding', 'filetype:video birds feeding'],
    ['farm-life', 'filetype:video funny farm life'],
    ['puppies-and-kittens', 'filetype:video puppies kittens'],
    ['visual-mishaps', 'filetype:video harmless funny mishap'],
    ['human-ingenuity', 'filetype:video human ingenuity invention']
  ].map(([key, query, localPriority = false]) => ({ key, query, localPriority }))

];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
const pathOnly = value => {
  try { return new URL(value).pathname; } catch { return ''; }
};
function comparableText(value) {
  return cleanText(String(value || '')
    .replace(/[\u200c\u200d\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/ـ/g, ' '))
    .toLocaleLowerCase('fa');
}
function titleMatchesContent(value, title) {
  const haystack = comparableText(value);
  const needle = comparableText(title);
  if (needle && haystack.includes(needle)) return true;
  const ignored = new Set(['لحظه', 'لحظه‌ای', 'دیدنی', 'تماشایی', 'دنیای', 'یک', 'از', 'که', 'برای', 'وقتی']);
  const tokens = needle.split(' ').filter(token => token.length > 2 && !ignored.has(token));
  return tokens.length > 0 && tokens.every(token => haystack.includes(token));
}

function plainMetadata(value) {
  return cleanText(String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

function commercialLicenseProfile(licenseName, licenseUrl) {
  const name = String(licenseName || '');
  const url = String(licenseUrl || '').replace(/&amp;/g, '&');
  if (/\bCC0\b/i.test(name) && /creativecommons\.org\/publicdomain\/zero\/1\.0(?:\/|$)/i.test(url)) {
    return { type: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  }
  // Commercial reuse allowed with attribution/change notice; exclude NC, ND, and SA variants.
  if (/\bCC BY 4\.0\b/i.test(name) &&
      /creativecommons\.org\/licenses\/by\/4\.0(?:\/|$)/i.test(url) &&
      !/creativecommons\.org\/licenses\/by-(?:nc|nd|sa)(?:-|\/)/i.test(url)) {
    return { type: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' };
  }
  return null;
}

function persianTopicLabel(candidate) {
  const text = [candidate.fileTitle, candidate.description].join(' ').toLowerCase();
  if (/\b(cat|cats|kitten|kittens|feline)\b|گربه/.test(text)) return 'گربه‌ها و رفتار حیوانات';
  if (/\b(dog|dogs|puppy|puppies)\b|سگ/.test(text)) return 'سگ‌ها و حیوانات خانگی';
  if (/\b(bird|birds|parrot|parrots|pigeon)\b|پرنده/.test(text)) return 'پرندگان و رفتار جالب آن‌ها';
  if (/\b(football|soccer|basketball|trick shot|parkour|freestyle|sports? skill|goal|dunk|skateboard)\b|فوتبال|بسکتبال|ورزش|حرکت نمایشی/.test(text)) return 'مهارت‌های ورزشی و حرکت‌های نمایشی';
  if (/\b(cooking|recipe|food art|food hack|kitchen|baking|street food)\b|آشپزی|غذا|خوراکی/.test(text)) return 'آشپزی و ایده‌های غذایی';
  if (/\b(woodworking|pottery|craft|restoration|miniature|transformation|satisfying)\b|کاردستی|نجاری|سفال|بازسازی|رضایت.?بخش/.test(text)) return 'ساختنی‌ها و فرایندهای جذاب';
  if (/\b(science experiment|invention|technology demo|optical illusion|brain teaser|puzzle)\b|آزمایش علمی|اختراع|فناوری|خطای دید|معما/.test(text)) return 'آزمایش‌های علمی، فناوری و خطای دید';
  if (/\b(magic|dance|music performance|musician|singing|instrument|juggling)\b|شعبده|رقص|نوازندگی|موسیقی|خوانندگی/.test(text)) return 'اجراهای هنری و مهارت‌های متفاوت';
  if (/\b(nature|landscape|weather phenomenon|ocean|volcano|waterfall|space footage)\b|طبیعت|آبشار|اقیانوس|پدیده جوی|آتشفشان|منظره|فضا/.test(text)) return 'طبیعت و پدیده‌های دیدنی';
  if (/\b(travel|tourism|street life|local culture|traditional|architecture)\b|سفر|گردشگری|فرهنگ|سنتی|معماری|ایرانگردی/.test(text)) return 'سفر، فرهنگ و معماری';
  if (/hidden camera|prank|comedy|humou?r|funny|reaction|meme|sketch|fail|surprise|unexpected|چالش|طنز|خنده|بامزه|سوتی|دوربین مخفی|واکنش/.test(text)) return 'طنز و لحظه‌های غیرمنتظره';
  return 'سرگرمی و اتفاق‌های دیدنی';
}

function descriptionForCandidate(candidate) {
  if (candidate.contentOrigin === 'original_goushibaaz') {
    const optionLine = candidate.options.map((value, i) => ['۱', '۲', '۳'][i] + ') ' + value).join(' | ');
    return [
      candidate.title + '؛ یک معمای هوش و چالش فکری کوتاه درباره ' + candidate.topic + '.',
      'قبل از دیدن پاسخ، سؤال را حل کن و جواب خودت را در دیدگاه‌ها بنویس.',
      'گزینه‌ها: ' + optionLine,
      '',
      'تولید اختصاصی گوشی‌باز؛ متن، روایت فارسی و تصویرسازی این ویدئو برای این کانال ساخته شده است.',
      '',
      'برای دیدن چالش‌های بعدی، گوشی‌باز را در فیلو دنبال کن.'
    ].join('\n');
  }

  const licenseType = candidate.licenseType || commercialLicenseProfile(candidate.licenseName, candidate.licenseUrl)?.type || 'CC0 1.0';
  const licenseUrl = candidate.licenseUrl || (licenseType === 'CC BY 4.0'
    ? 'https://creativecommons.org/licenses/by/4.0/'
    : CC0_LICENSE_URL);
  const title = candidate.title || persianTitle(candidate.fileTitle, candidate.description);
  const topic = persianTopicLabel(candidate);
  const changeNote = 'تغییرات انجام‌شده: قاب‌بندی عمودی ۹:۱۶ بدون برش تصویر اصلی، حفظ صدای موجود و افزودن کارت پایانی معرفی گوشی‌باز در فیلو.';
  return [
    title + '؛ یک کلیپ کوتاه درباره ' + topic + '.',
    'برای دیدن ویدئوهای بیشتر از این مجموعه، گوشی‌باز را در فیلو دنبال کنید.',
    '',
    'منبع: ' + candidate.fileTitle.replace(/^File:/i, ''),
    'پدیدآورنده: ' + (candidate.author || 'طبق اطلاعات صفحهٔ منبع'),
    'مجوز: ' + licenseType,
    ...(licenseType === 'CC BY 4.0' ? [changeNote] : []),
    candidate.sourcePage,
    licenseUrl
  ].join('\n');
}

function publicationCadenceDecision(state, now = new Date()) {
  const eligibleStatuses = new Set([
    'published', 'submitted_pending_approval', 'submit_started',
    'submitted_unconfirmed', 'submit_result_unconfirmed',
    'upload_staged_unpublished', 'rejected_by_filo'
  ]);
  const attempts = (state.posts || [])
    .filter(item => eligibleStatuses.has(item.status))
    .map(item => Date.parse(item.submittedAt || item.attemptedAt || item.publishedAt || item.checkedAt || ''))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  const today = now.toISOString().slice(0, 10);
  const todayCount = attempts.filter(ts => new Date(ts).toISOString().slice(0, 10) === today).length;
  if (todayCount >= MAX_DAILY_PUBLICATIONS) {
    return { allowed: false, status: 'daily_limit_reached', todayCount, maxDaily: MAX_DAILY_PUBLICATIONS };
  }
  if (attempts.length && now.getTime() - attempts[0] < MIN_PUBLICATION_GAP_MS) {
    return {
      allowed: false,
      status: 'publication_cooldown',
      todayCount,
      nextAllowedAt: new Date(attempts[0] + MIN_PUBLICATION_GAP_MS).toISOString()
    };
  }
  return { allowed: true, todayCount, maxDaily: MAX_DAILY_PUBLICATIONS };
}

function parsedDurationSeconds(info) {
  const items = Array.isArray(info && info.commonmetadata) ? info.commonmetadata : [];
  for (const item of items) {
    if (!/duration|length|runtime|run time/i.test(String(item.name || ''))) continue;
    const value = String(item.value || '');
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
  // Do not mistake Iranian/political event footage for entertainment just because a place name appears.
  return /\b(protests?|protesters?|demonstrations?|riot|riots|war|missile|military|army|weapon|weapons|election|politics|political|parliament|government|police crackdown)\b|اعتراضات?|تظاهرات|اغتشاش|جنگ|موشک|پهپاد|بمب|نظامی|تسلیحات|سلاح|انتخابات|سیاست|سیاسی|مجلس|دولت|درگیری|سرکوب/.test(String(text || '').toLowerCase());
}

function classifyCandidate(candidate) {
  return looksRelevant(candidate && candidate.fileTitle, candidate && candidate.description);
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

async function discoverCommercialCandidates(state) {
  const used = new Set((state.posts || [])
    .filter(item => ACTIVE_SOURCE_STATUSES.has(item.status) || item.status === 'ineligible_source')
    .map(item => item.sourcePage));
  // Each five-minute attempt rotates a small, balanced batch to avoid hammering public archives.
  // One additional query is built from an actually observed high-velocity entertainment trend.
  const trendSearches = buildTrendSearches();
  const localSearches = rotateSearchBatch(COMMONS_SEARCHES.filter(item => item.localPriority), 3);
  const broadSearches = rotateSearchBatch(COMMONS_SEARCHES.filter(item => !item.localPriority), 5);
  const searches = [...localSearches, ...broadSearches, ...trendSearches];
  console.log('FILO_ROTATING_DISCOVERY_BATCH', JSON.stringify({
    localCommonsQueries: localSearches.length,
    broadCommonsQueries: broadSearches.length,
    observedTrendTitleQueries: trendSearches.map(item => item.trendTitle)
  }));
  const found = new Map();

  async function scanCommonsSearch(search, retryAttempt = 0) {
    const api = new URL('https://commons.wikimedia.org/w/api.php');
    api.searchParams.set('action', 'query');
    api.searchParams.set('format', 'json');
    api.searchParams.set('generator', 'search');
    api.searchParams.set('gsrnamespace', '6');
    api.searchParams.set('gsrlimit', '50');
    api.searchParams.set('gsrsearch', search.query);
    api.searchParams.set('prop', 'imageinfo');
    api.searchParams.set('iiprop', 'url|mime|size|extmetadata|commonmetadata');
    const response = await fetch(api, {
      headers: { 'User-Agent': 'GoushibaazPublisher/1.1 (https://github.com/Mehran0960/Goushibaaz; CC0 and CC BY 4.0 verification)' },
      signal: AbortSignal.timeout(20000)
    });
    if (response.status === 429 && retryAttempt < 2) {
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      const delayMs = Math.max(2500, Math.min(30000, retryAfter > 0 ? retryAfter * 1000 : (retryAttempt + 1) * 5000));
      console.log('COMMONS_RATE_LIMIT_RETRY', JSON.stringify({ query: search.key, attempt: retryAttempt + 1, delayMs }));
      await sleep(delayMs);
      return scanCommonsSearch(search, retryAttempt + 1);
    }
    if (!response.ok) {
      console.log('COMMONS_SEARCH', JSON.stringify({ query: search.key, status: response.status }));
      return;
    }
    const payload = await response.json();
    const pages = Object.values(payload.query && payload.query.pages || {});
    console.log('COMMONS_SEARCH', JSON.stringify({ query: search.key, results: pages.length }));
    for (const page of pages) {
      const info = page.imageinfo && page.imageinfo[0];
      if (!info || !info.url || info.mime !== 'video/webm') continue;
      if (!Number.isFinite(info.size) || info.size < 200000 || info.size > MAX_SOURCE_BYTES) continue;
      const meta = info.extmetadata || {};
      const rawLicenseName = plainMetadata(meta.LicenseShortName && meta.LicenseShortName.value);
      const rawLicenseUrl = plainMetadata(meta.LicenseUrl && meta.LicenseUrl.value);
      const licenseProfile = commercialLicenseProfile(rawLicenseName, rawLicenseUrl);
      if (!licenseProfile) continue;
      const licenseName = licenseProfile.type;
      const licenseUrl = licenseProfile.url;
      const description = plainMetadata(meta.ImageDescription && meta.ImageDescription.value);
      const author = plainMetadata(meta.Artist && meta.Artist.value);
      const fileTitle = String(page.title || '');
      const editorialText = (fileTitle + ' ' + description).toLowerCase();
      if (isExcludedEditorialContent(editorialText)) continue;
      const sourcePage = info.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(fileTitle.replace(/ /g, '_')));
      if (used.has(sourcePage) || !classifyCandidate({ fileTitle, description })) continue;
      const duration = parsedDurationSeconds(info);
      if (duration !== null && (duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS)) continue;
      const candidate = {
        fileTitle, sourcePage, fileUrl: info.url, mime: info.mime, size: info.size,
        durationSeconds: duration, licenseName, licenseUrl, licenseType: licenseProfile.type,
        description, author,
        sourceWidth: Number(info.width) > 0 ? Number(info.width) : null,
        sourceHeight: Number(info.height) > 0 ? Number(info.height) : null,
        sourceAspectRatio: Number(info.width) > 0 && Number(info.height) > 0
          ? Math.round((Number(info.width) / Number(info.height)) * 1000) / 1000 : null,
        discoveryQuery: search.key,
        localPriorityQuery: Boolean(search.localPriority),
        trendSearchTitle: search.trendTitle || undefined,
        trendSearchUrl: search.trendUrl || undefined,
        trendSearchVelocity: search.trendVelocity || undefined,
        trendSearchLane: search.trendLane || undefined,
        trendSearchLocalPriority: Boolean(search.localPriority)
      };
      candidate.contentLocaleScore = Math.max(candidateContentPriority(candidate), search.localPriority ? 1 : 0);
      candidate.sourceVerticalScore = sourceVerticalScore(candidate.sourceWidth, candidate.sourceHeight);
      candidate.title = persianTitle(candidate.fileTitle, candidate.description);
      candidate.descriptionText = descriptionForCandidate(candidate);
      const previousCandidate = found.get(sourcePage);
      if (!previousCandidate || candidate.contentLocaleScore > previousCandidate.contentLocaleScore ||
          (candidate.contentLocaleScore === previousCandidate.contentLocaleScore && candidate.sourceVerticalScore > previousCandidate.sourceVerticalScore)) {
        found.set(sourcePage, candidate);
      }
    }
    await sleep(1000);
  }
  const searchQueue = [...searches];
  async function commonsWorker() {
    while (searchQueue.length) {
      const search = searchQueue.shift();
      if (!search) continue;
      try {
        await scanCommonsSearch(search);
      } catch (error) {
        console.log('COMMONS_SEARCH_ERROR', JSON.stringify({
          query: search.key,
          error: String(error && error.name || 'Error').slice(0, 40)
        }));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, searchQueue.length) }, () => commonsWorker()));
  const ranked = [...found.values()].sort((a, b) =>
    (b.contentLocaleScore - a.contentLocaleScore) ||
    (b.sourceVerticalScore - a.sourceVerticalScore) ||
    (Number(b.durationSeconds || 0) - Number(a.durationSeconds || 0))
  );
  console.log('FILO_CONTENT_PRIORITY', JSON.stringify({
    localPersianOrIranian: ranked.filter(item => item.contentLocaleScore >= 2).length,
    portraitSourceCandidates: ranked.filter(item => item.sourceVerticalScore >= 2).length,
    eligibleLicensedCandidates: ranked.length,
    targetAspectRatio: CONTENT_POLICY.vertical_video.aspect_ratio
  }));
  return ranked.slice(0, 80);
}


const ARCHIVE_SEARCH_TERMS = [
  { key: 'iran', term: 'Iran', localPriority: true },
  { key: 'persian', term: 'Persian', localPriority: true },
  { key: 'tehran', term: 'Tehran', localPriority: true },
  { key: 'iranian-animals', term: 'Iran animals', localPriority: true },
  { key: 'persian-cats', term: 'Persian cat', localPriority: true },
  { key: 'iranian-nature', term: 'Iran nature', localPriority: true },
  { key: 'iranian-life', term: 'Iran daily life', localPriority: true },
  { key: 'funny-animals', term: 'funny animals' },
  { key: 'cats', term: 'cats' },
  { key: 'dogs', term: 'dogs' },
  { key: 'pets', term: 'pets' },
  { key: 'birds', term: 'birds' },
  { key: 'wildlife', term: 'wildlife' },
  { key: 'comedy', term: 'visual comedy' },
  { key: 'silent-comedy', term: 'silent comedy' },
  { key: 'satisfying', term: 'satisfying' },
  { key: 'crafts', term: 'craft process' },
  { key: 'cooking', term: 'cooking' },
  { key: 'science', term: 'science experiment' },
  { key: 'street-moments', term: 'street moments' },
  { key: 'inventions', term: 'inventions' },
  { key: 'nature', term: 'nature' },
  { key: 'family-friendly', term: 'family friendly' },
  { key: 'sports-fun', term: 'funny sports' }
];
// License is verified against each archive item's actual metadata after discovery.
function internetArchiveLicense(rawUrl) {
  const url = String(rawUrl || '').toLowerCase().replace(/&amp;/g, '&').replace(/\/+$/, '');
  if (/creativecommons\.org\/publicdomain\/zero\/1\.0$/.test(url)) {
    return { type: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  }
  if (/creativecommons\.org\/licenses\/by\/4\.0$/.test(url) &&
      !/creativecommons\.org\/licenses\/by-(?:nc|nd|sa)(?:-|\/)/.test(url)) {
    return { type: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' };
  }
  return null;
}

async function discoverInternetArchiveCandidates(state) {
  const used = new Set((state.posts || [])
    .filter(item => ACTIVE_SOURCE_STATUSES.has(item.status) || item.status === 'ineligible_source')
    .map(item => item.sourcePage));
  // Rotate a bounded set of archive queries; metadata is still checked per item before download.
  const trendSearches = buildTrendSearches();
  const localSearches = rotateSearchBatch(ARCHIVE_SEARCH_TERMS.filter(term => term.localPriority), 2);
  const broadSearches = rotateSearchBatch(ARCHIVE_SEARCH_TERMS.filter(term => !term.localPriority), 2);
  const searches = [
    ...localSearches.map(term => ({ key: term.key, term })),
    ...broadSearches.map(term => ({ key: term.key, term })),
    ...trendSearches.map(item => ({ key: item.key, term: {
      term: item.searchTerms.join(' '), localPriority: item.localPriority,
      trendTitle: item.trendTitle, trendUrl: item.trendUrl, trendVelocity: item.trendVelocity
    }}))
  ];
  console.log('FILO_ARCHIVE_ROTATING_BATCH', JSON.stringify({
    localQueries: localSearches.length, broadQueries: broadSearches.length,
    observedTrendTitleQueries: trendSearches.map(item => item.trendTitle)
  }));
  const discovered = new Map();
  const queue = [...searches];

  async function searchWorker() {
    while (queue.length) {
      const search = queue.shift();
      if (!search) continue;
      const api = new URL('https://archive.org/advancedsearch.php');
      api.searchParams.set('q', 'mediatype:movies AND (' + search.term.term + ') ');
      api.searchParams.set('fl[]', 'identifier');
      api.searchParams.append('fl[]', 'title');
      api.searchParams.append('fl[]', 'creator');
      api.searchParams.append('fl[]', 'licenseurl');
      api.searchParams.append('fl[]', 'description');
      api.searchParams.set('rows', '25');
      api.searchParams.set('page', '1');
      api.searchParams.set('output', 'json');
      try {
        const response = await fetch(api, {
          headers: { 'User-Agent': 'GoushibaazPublisher/1.1 (https://github.com/Mehran0960/Goushibaaz; public metadata and reuse-license verification)' },
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) {
          console.log('ARCHIVE_SEARCH', JSON.stringify({ query: search.key, status: response.status }));
          continue;
        }
        const payload = await response.json();
        const docs = payload.response && Array.isArray(payload.response.docs) ? payload.response.docs : [];
        for (const doc of docs.slice(0, 12)) {
          if (!doc.identifier) continue;
          const previous = discovered.get(String(doc.identifier));
          const entry = { identifier: String(doc.identifier), search, indexed: doc };
          if (!previous || (search.term.localPriority && !previous.search.term.localPriority)) {
            discovered.set(entry.identifier, entry);
          }
        }
      } catch (error) {
        console.log('ARCHIVE_SEARCH_ERROR', JSON.stringify({
          query: search.key,
          error: String(error && error.name || 'Error').slice(0, 40)
        }));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => searchWorker()));

  const metadataQueue = [...discovered.values()]
    .sort((a, b) => Number(Boolean(b.search.term.localPriority)) - Number(Boolean(a.search.term.localPriority)))
    .slice(0, 120);
  const candidateQueue = [...metadataQueue];
  const found = [];
  let metadataErrors = 0;

  async function metadataWorker() {
    while (candidateQueue.length) {
      const entry = candidateQueue.shift();
      if (!entry) continue;
      try {
        const endpoint = 'https://archive.org/metadata/' + encodeURIComponent(entry.identifier);
        const response = await fetch(endpoint, {
          headers: { 'User-Agent': 'GoushibaazFiloPublisher/1.0 (public metadata and reuse-license verification)' },
          signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) { metadataErrors++; continue; }
        const body = await response.json();
        const meta = body.metadata || {};
        const licenseProfile = internetArchiveLicense(meta.licenseurl || entry.indexed.licenseurl);
        if (!licenseProfile) continue;
        const files = Array.isArray(body.files) ? body.files : [];
        const videoFiles = files.filter(file => {
          const name = String(file.name || '');
          const size = Number(file.size);
          return /\.webm$/i.test(name) && file.private !== 'true' &&
            Number.isFinite(size) && size >= 200000 && size <= MAX_SOURCE_BYTES;
        }).sort((a, b) => Number(a.size) - Number(b.size));
        for (const file of videoFiles.slice(0, 2)) {
          const sourcePage = 'https://archive.org/details/' + entry.identifier;
          if (used.has(sourcePage)) continue;
          const fileUrl = 'https://archive.org/download/' + encodeURIComponent(entry.identifier) + '/' +
            String(file.name).split('/').map(part => encodeURIComponent(part)).join('/');
          const title = plainMetadata(meta.title || entry.indexed.title || entry.identifier).slice(0, 180);
          const description = plainMetadata(meta.description || entry.indexed.description || '').slice(0, 1800);
          const author = plainMetadata(meta.creator || entry.indexed.creator || '').slice(0, 300);
          const editorial = { fileTitle: title, description, author };
          if (isExcludedEditorialContent(title + ' ' + description) || !classifyCandidate(editorial)) continue;
          const durationRaw = meta.runtime || meta.duration || meta.length || '';
          const durationSeconds = parsedDurationSeconds({ commonmetadata: [{ name: 'duration', value: durationRaw }] });
          if (durationSeconds !== null && (durationSeconds < 3 || durationSeconds > MAX_DURATION_SECONDS)) continue;
          const candidate = {
            fileTitle: title,
            sourcePage,
            fileUrl,
            mime: 'video/webm',
            size: Number(file.size),
            durationSeconds,
            licenseName: licenseProfile.type,
            licenseUrl: licenseProfile.url,
            licenseType: licenseProfile.type,
            description,
            author,
            sourceWidth: Number(file.width || meta.width) > 0 ? Number(file.width || meta.width) : null,
            sourceHeight: Number(file.height || meta.height) > 0 ? Number(file.height || meta.height) : null,
            sourceAspectRatio: Number(file.width || meta.width) > 0 && Number(file.height || meta.height) > 0
              ? Math.round((Number(file.width || meta.width) / Number(file.height || meta.height)) * 1000) / 1000 : null,
            discoveryQuery: entry.search.key,
            localPriorityQuery: Boolean(entry.search.term.localPriority),
            trendSearchTitle: entry.search.term.trendTitle || undefined,
            trendSearchUrl: entry.search.term.trendUrl || undefined,
            trendSearchVelocity: entry.search.term.trendVelocity || undefined,
            trendSearchLane: entry.search.term.trendLane || undefined,
            trendSearchLocalPriority: Boolean(entry.search.term.localPriority),
            archiveIdentifier: entry.identifier
          };
          candidate.contentLocaleScore = Math.max(candidateContentPriority(candidate), candidate.localPriorityQuery ? 1 : 0);
          candidate.sourceVerticalScore = sourceVerticalScore(candidate.sourceWidth, candidate.sourceHeight);
          candidate.title = persianTitle(candidate.fileTitle, candidate.description);
          candidate.descriptionText = descriptionForCandidate(candidate);
          found.push(candidate);
          break;
        }
      } catch (error) {
        metadataErrors++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, candidateQueue.length) }, () => metadataWorker()));
  const unique = new Map();
  for (const candidate of found) {
    if (!unique.has(candidate.sourcePage)) unique.set(candidate.sourcePage, candidate);
  }
  const ranked = [...unique.values()].sort((a, b) =>
    (b.contentLocaleScore - a.contentLocaleScore) ||
    (b.sourceVerticalScore - a.sourceVerticalScore) ||
    (Number(b.durationSeconds || 0) - Number(a.durationSeconds || 0))
  );
  console.log('INTERNET_ARCHIVE_SOURCE_COVERAGE', JSON.stringify({
    search_queries: searches.length,
    unique_items_discovered: discovered.size,
    items_checked_for_file_metadata: metadataQueue.length,
    eligible_webm_candidates: ranked.length,
    metadata_errors: metadataErrors
  }));
  return ranked.slice(0, 60);
}

async function downloadVerifiedCommercialVideo(candidate) {
  if (!candidate || !candidate.fileUrl || !candidate.sourcePage || !candidate.fileTitle) {
    throw new Error('commons_candidate_missing_required_fields');
  }
  const licenseProfile = commercialLicenseProfile(candidate.licenseName, candidate.licenseUrl);
  if (!licenseProfile || (candidate.licenseType && candidate.licenseType !== licenseProfile.type)) {
    throw new Error('commons_license_not_verified_for_commercial_reuse');
  }
  if (candidate.mime !== 'video/webm' || candidate.size > MAX_SOURCE_BYTES) {
    throw new Error('commons_video_type_or_size_not_allowed');
  }
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const fileResponse = await fetch(candidate.fileUrl, {
    headers: { 'User-Agent': 'GoushibaazPublisher/1.1 (https://github.com/Mehran0960/Goushibaaz; verified commercial-reuse license)' },
    signal: AbortSignal.timeout(45000)
  });
  if (!fileResponse.ok) throw new Error('commons_video_download_http_' + fileResponse.status);
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  if (bytes.length < 200000 || bytes.length > MAX_SOURCE_BYTES) throw new Error('commons_video_size_out_of_expected_range');
  if (!(bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) {
    throw new Error('commons_file_not_webm');
  }
  fs.writeFileSync(INPUT_FILE, bytes);
  const media = probeMedia(INPUT_FILE);
  if (!media.audio) throw new Error('source_audio_track_missing');
  if (!Number.isFinite(media.durationSeconds) ||
      media.durationSeconds < MIN_DURATION_SECONDS || media.durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error('source_duration_out_of_range_or_unavailable');
  }
  return {
    sourcePage: candidate.sourcePage, sourceTitle: candidate.fileTitle,
    directFilePath: pathOnly(candidate.fileUrl), licenseName: candidate.licenseName,
    licenseUrl: licenseProfile.url, licenseType: licenseProfile.type,
    author: String(candidate.author || 'Not identified on the source page').slice(0, 100),
    sourceBytes: bytes.length, sourceDescription: candidate.description.slice(0, 180),
    durationSeconds: Math.round(media.durationSeconds * 100) / 100,
    sourceAudio: media.audio,
    sourceWidth: media.width,
    sourceHeight: media.height
  };
}

function convertToPortraitMp4() {
  return convertToPortrait(INPUT_FILE, OUTPUT_FILE, {
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    crf: 25,
    maxrate: '1100k',
    bufsize: '2200k',
    audioBitrate: '96k',
    maxBytes: 80_000_000,
    timeoutMs: 180000
  });
}

function extractCoverFrame(seekSeconds = 1.0) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(Math.max(0.5, Number(seekSeconds) || 1.0)), '-i', OUTPUT_FILE,
    '-frames:v', '1',
    '-vf', `scale=${COVER_WIDTH}:${COVER_HEIGHT}:force_original_aspect_ratio=decrease,pad=${COVER_WIDTH}:${COVER_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-q:v', '2',
    COVER_FILE
  ], { stdio: 'pipe', timeout: 30000 });
  const bytes = fs.readFileSync(COVER_FILE);
  if (bytes.length < 10000 || bytes.length > 10000000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('cover_frame_generation_failed');
  }
  return { coverBytes: bytes.length, coverPath: COVER_FILE, width: COVER_WIDTH, height: COVER_HEIGHT };
}

async function visibleFirst(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function login(page) {
  if (!process.env.FILO_USER || !process.env.FILO_PASS) throw new Error('filo_credentials_missing');
  // Use the normal Filo home-to-login flow, then confirm authentication on the uploader itself.
  await page.goto(ACCOUNT + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(700);
  const signInHref = await page.locator('a[href]').evaluateAll(as => {
    const match = as.find(a => {
      let p = '';
      try { p = new URL(a.href).pathname; } catch {}
      const text = (a.innerText || a.getAttribute('aria-label') || '').trim();
      return p === '/login' || /ورود به فیلو|ورود به حساب|login/i.test(text);
    });
    return match ? match.href : '';
  }).catch(() => '');
  await page.goto(signInHref || ACCOUNT + '/login?m=3&r=%2Fupload', { waitUntil: 'domcontentloaded', timeout: 30000 });

  const password = page.locator('input[type="password"]').first();
  await password.waitFor({ state: 'visible', timeout: 15000 });
  const username = await visibleFirst(page, [
    'input[autocomplete="username"]',
    'input[placeholder="شماره موبایل یا ایمیل"]',
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
  const submit = await visibleFirst(page, [
    'button[type="submit"]',
    'input[type="submit"]'
  ]) || page.getByRole('button', { name: /^ورود$|^login$/i }).first();
  if (!(await submit.isVisible().catch(() => false))) throw new Error('filo_login_submit_not_found');

  const loginResponsePromise = page.waitForResponse(response => {
    try {
      const u = new URL(response.url());
      return u.hostname === 'ifilo.net' && u.pathname === '/api/v1/users/login' &&
        response.request().method() === 'POST';
    } catch { return false; }
  }, { timeout: 15000 }).catch(() => null);
  await submit.click();
  const loginResponse = await loginResponsePromise;
  const loginHttpStatus = loginResponse ? loginResponse.status() : null;
  let loginApiSignal = 'unavailable';
  if (loginResponse) {
    try {
      let data = await loginResponse.json();
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch {}
      }
      loginApiSignal = data && data.s ? 'success_flag_true' :
        data && data.r ? 'error_flag_present' :
        data && typeof data === 'object' ? 'response_without_success_flag' : 'non_json_response';
      if (data && data.r && /رمز|نامعتبر|اشتباه|موبایل|ایمیل|کاربر|ورود/i.test(String(data.r))) {
        // Do not echo server text, which might include account-identifying details.
        loginApiSignal = 'server_rejected_login';
      }
    } catch {}
  }

  await sleep(1600);
  const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 4500);
  if (/کد تایید|کد تأیید|رمز یکبار مصرف|captcha|verify you are human|تایید هویت/i.test(body)) {
    throw new Error('filo_login_challenge_required');
  }

  // The login route can keep the old form rendered during client-side transitions,
  // so the decisive test is whether the protected upload route remains accessible.
  await page.goto(ACCOUNT + '/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1400);
  if (pathOnly(page.url()) === '/login') {
    const failureHint = loginApiSignal === 'server_rejected_login' ? 'server_rejected_login' :
      loginHttpStatus ? 'login_http_' + loginHttpStatus : 'login_not_confirmed';
    throw new Error('filo_upload_redirected_to_login:' + failureHint);
  }
  // Filo mounts the actual file input only after its "from your device" mode is activated.
  // Checking #fileInput before this click falsely reports an upload-page failure.
  const deviceOption = page.getByText(/از دستگاه.{0,8}ت/).first();
  if (await deviceOption.isVisible().catch(() => false)) {
    await deviceOption.click().catch(() => {});
    await sleep(900);
  }
  const videoInput = page.locator('#fileInput').first();
  await videoInput.waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
  let videoInputCount = await videoInput.count().catch(() => 0);
  if (!videoInputCount) {
    // Handle harmless route transitions and late component mounts before declaring failure.
    await page.locator('input[type="file"][accept*="video"]').first()
      .waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    videoInputCount = await page.locator('input[type="file"][accept*="video"]').count().catch(() => 0);
  }
  if (!videoInputCount) {
    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 3000);
    const pageSignal = /اول باید به حساب کاربریت ورود کنی|ورود به فیلو|ورود به حساب/i.test(body)
      ? 'login_required_prompt'
      : /برای انتخاب ویدیو کلیک کن/.test(body) ? 'uploader_shell_without_file_input'
      : /از دستگاه/.test(body) ? 'device_choice_visible_but_input_not_mounted'
      : 'unexpected_page_content';
    throw new Error('filo_upload_page_missing_video_input:api_' + loginApiSignal +
      ':http_' + String(loginHttpStatus || 'none') + ':' + pageSignal);
  }
}
async function visibleFieldReport(page) {
  return page.locator('input, textarea, select, [contenteditable="true"], button, [role="button"], label').evaluateAll(nodes =>
    nodes.slice(0, 150).map(el => {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      const type = (el.getAttribute('type') || '').toLowerCase();
      const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ');
      return {
        tag: el.tagName.toLowerCase(),
        type,
        id: el.id || '',
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        label: text.slice(0, 90),
        visible,
        required: Boolean(el.required),
        accept: type === 'file' ? el.getAttribute('accept') || '' : ''
      };
    }).filter(x => x.visible || x.type === 'file')
  );
}

async function findField(page, kind) {
  const selectors = kind === 'title' ? [
    'input[name*="title" i]', 'input[id*="title" i]', 'input[placeholder*="عنوان"]',
    'input[aria-label*="عنوان"]', 'textarea[name*="title" i]',
    'input[placeholder*="نام ویدیو"]', 'input[placeholder*="نام ویدئو"]'
  ] : [
    'textarea[name*="description" i]', 'textarea[id*="description" i]',
    'textarea[placeholder*="توضیح"]', 'textarea[placeholder*="شرح"]',
    '[contenteditable="true"][aria-label*="توضیح"]', '[contenteditable="true"]'
  ];
  return visibleFirst(page, selectors);
}

async function findPublishButton(page) {
  const buttons = await page.locator('button, input[type="submit"], [role="button"]').evaluateAll(nodes => nodes
    .filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    })
    .map(el => ({
      text: String(el.getAttribute('aria-label') || el.innerText || el.getAttribute('value') || '').trim().replace(/\s+/g, ' ').slice(0, 90),
      disabled: Boolean(el.disabled),
      type: (el.getAttribute('type') || '').toLowerCase()
    })));
  function isPublishLabel(text) {
    return /بارگذاری ویدیو|آپلود ویدیو|انتشار|ارسال ویدیو|ثبت ویدیو|بارگذاری|آپلود|انتشار ویدیو/i.test(text) &&
      !/انتخاب فایل|انتخاب ویدیو|لغو|انصراف|بستن|بازگشت|ویرایش/i.test(text);
  }
  const target = buttons.find(x => isPublishLabel(x.text) && !x.disabled);
  if (!target) return null;
  const locators = [
    page.getByRole('button', { name: target.text, exact: true }).first(),
    page.locator('input[type="submit"]').filter({ hasText: target.text }).first()
  ];
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) return locator;
  }
  return null;
}

function cleanButtonText(el) {
  return String(el.getAttribute('aria-label') || el.innerText || el.getAttribute('value') || '').trim().replace(/\s+/g, ' ').slice(0, 90);
}

async function uploadCoverThumbnail(page, coverPath) {
  const tile = page.locator('#uploadVideoThumb').first();
  await tile.waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
  if (!(await tile.count().catch(() => 0))) throw new Error('filo_thumbnail_tile_not_found');

  const responsePromise = page.waitForResponse(response => {
    try {
      const url = new URL(response.url());
      return response.request().method() === 'POST' && /upload(?:VideoThumb|EditorImageVideo)/i.test(url.pathname);
    } catch { return false; }
  }, { timeout: 30000 }).catch(() => null);

  const inputSelectors = [
    '#uploadVideoThumb input[type="file"]',
    'input[type="file"]#dut',
    'input[type="file"][name="dut"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"][accept*=".jpg"]'
  ];
  let fileInput = null;
  for (const selector of inputSelectors) {
    const candidate = page.locator(selector).first();
    if (await candidate.count().catch(() => 0)) {
      fileInput = candidate;
      break;
    }
  }

  if (fileInput) {
    await fileInput.setInputFiles(coverPath);
  } else {
    const uploadButton = page.locator('#uploadVideoThumb button, #uploadVideoThumb a[title*="آپلود تصویر"], #uploadVideoThumb button[title*="تصویر"], a[title="آپلود تصویر"]').first();
    if (!(await uploadButton.isVisible().catch(() => false))) {
      const fields = await visibleFieldReport(page);
      throw new Error('filo_thumbnail_file_control_not_found:' +
        fields.filter(item => item.type === 'file').map(item => item.id + ':' + item.name + ':' + item.accept).join(',').slice(0, 120));
    }
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 7000 }).catch(() => null);
    await uploadButton.click();
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(coverPath);
    } else {
      const lateInput = page.locator('#uploadVideoThumb input[type="file"], input[type="file"][name="dut"], input[type="file"][accept*="image"]').first();
      if (!(await lateInput.count().catch(() => 0))) throw new Error('filo_thumbnail_filechooser_not_opened');
      await lateInput.setInputFiles(coverPath);
    }
  }

  const response = await responsePromise;
  if (!response) throw new Error('filo_thumbnail_upload_response_missing');
  const status = response.status();
  let apiSignal = 'unknown';
  let apiError = '';
  try {
    let data = await response.json();
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch {}
    }
    if (data && (data.s === true || data.s === 1 || data.s === '1')) apiSignal = 'success';
    else if (data && (data.s === false || data.s === 0 || data.s === '0')) apiSignal = 'rejected';
    if (data && data.r && apiSignal !== 'success') apiError = String(data.r).replace(/\s+/g, ' ').slice(0, 100);
  } catch {}

  if (status >= 400 || apiSignal === 'rejected' || apiError) {
    throw new Error('filo_thumbnail_upload_rejected:http_' + status + ':api_' + apiSignal +
      (apiError ? ':' + apiError : ''));
  }

  // Uploading a cover is not enough: Filo requires the uploaded thumbnail to be selected.
  const tileHeading = tile.locator('h3').first();
  if (await tileHeading.isVisible().catch(() => false)) {
    await tileHeading.click().catch(() => {});
  } else {
    await tile.click({ position: { x: 18, y: 18 } }).catch(() => {});
  }
  await sleep(700);
  const tileClass = await tile.getAttribute('class').catch(() => '');
  const tileSelected = /\bselected\b/.test(tileClass || '');
  if (!tileSelected) throw new Error('filo_cover_uploaded_but_not_selected');
  return { status, apiSignal, tileSelected: true, tileClass: String(tileClass || '').slice(0, 100) };
}

async function main() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  let state = { posts: [] };
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  if (!Array.isArray(state.posts)) state.posts = [];

  const cadence = publicationCadenceDecision(state);
  if (!cadence.allowed) {
    state.lastOutcome = { status: cadence.status, checkedAt: new Date().toISOString(), ...cadence };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    console.log('FILO_PUBLISH_RESULT', JSON.stringify({
      status: cadence.status,
      todayCount: cadence.todayCount,
      maxDaily: cadence.maxDaily,
      nextAllowedAt: cadence.nextAllowedAt || null,
      note: 'Filo permits at most 288 spaced attempts per UTC day; this is a ceiling, not a target. Only eligible verified-license media is submitted.'
    }));
    return;
  }

  const [commonsCandidates, archiveCandidates] = await Promise.all([
    discoverCommercialCandidates(state),
    discoverInternetArchiveCandidates(state)
  ]);
  const uniqueCandidates = new Map();
  for (const candidate of [...commonsCandidates, ...archiveCandidates]) {
    const old = uniqueCandidates.get(candidate.sourcePage);
    if (!old || (candidate.contentLocaleScore || 0) > (old.contentLocaleScore || 0)) {
      uniqueCandidates.set(candidate.sourcePage, candidate);
    }
  }
  let trendSnapshot = {};
  try {
    trendSnapshot = JSON.parse(fs.readFileSync(path.join('state', 'platform-trends.json'), 'utf8'));
  } catch {}
  const trendWeights = buildTrendWeights(trendSnapshot);
  const candidates = rankCandidates([...uniqueCandidates.values()], {
    trendWeights,
    recentPosts: state.posts || []
  });
  console.log('FILO_EDITORIAL_RANKING', JSON.stringify({
    trendWeights,
    topCandidates: candidates.slice(0, 8).map(item => ({
      title: item.title,
      sourceTitle: item.fileTitle,
      topic: item.editorialTopic,
      score: item.editorialScore,
      durationSeconds: item.durationSeconds,
      reasons: item.editorialReasons
    }))
  }));
  console.log('FILO_DISCOVERY_SOURCE_COVERAGE', JSON.stringify({
    wikimedia_commons_queries: COMMONS_SEARCHES.length,
    internet_archive_queries: ARCHIVE_SEARCH_TERMS.length,
    eligible_commons: commonsCandidates.length,
    eligible_internet_archive: archiveCandidates.length,
    unique_eligible_sources: candidates.length
  }));
  let candidate = null;
  let rights = null;
  let sourceDurationSeconds = null;
  const preparationErrors = [];
  for (const proposed of candidates.slice(0, 8)) {
    try {
      const proposedRights = await downloadVerifiedCommercialVideo(proposed);
      let duration = Number(proposedRights.durationSeconds);
      if (!Number.isFinite(duration) || duration <= 0) {
        const probe = execFileSync('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1', INPUT_FILE
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim();
        duration = Number(probe);
      }
      if (!Number.isFinite(duration) || duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
        state.posts.push({
          sourcePage: proposed.sourcePage, sourceTitle: proposed.fileTitle,
          status: 'ineligible_source', checkedAt: new Date().toISOString(),
          note: 'Source duration was unavailable or outside Filo short-video limits.'
        });
        preparationErrors.push({ source: proposed.sourcePage, reason: 'duration_not_eligible' });
        continue;
      }
      candidate = proposed;
      rights = proposedRights;
      sourceDurationSeconds = Math.round(duration * 100) / 100;
      break;
    } catch (error) {
      preparationErrors.push({
        source: proposed.sourcePage,
        reason: String(error && error.message || 'source_prepare_failed').slice(0, 120)
      });
    }
  }

  if (!candidate || !rights) {
    state.posts = state.posts.slice(-500);
    const status = candidates.length ? 'no_prepared_licensed_candidate' : 'no_eligible_licensed_candidate';
    state.lastOutcome = { status, checkedAt: new Date().toISOString() };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    const result = {
      status,
      candidateCount: candidates.length,
      preparationFailures: preparationErrors.slice(0, 8),
      note: 'No externally sourced video passed publication-rights, media and duration checks; nothing was published.'
    };
    console.log('FILO_PUBLISH_RESULT', JSON.stringify(result));
    return;
  }

  state.lastOutcome = { status: 'candidate_ready', checkedAt: new Date().toISOString(), sourcePage: candidate.sourcePage, contentOrigin: candidate.contentOrigin || 'licensed_external' };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  const COMMONS_PAGE = candidate.sourcePage;
  const SOURCE_TITLE = candidate.fileTitle;
  const PERSIAN_TITLE = candidate.title;
  const PERSIAN_DESCRIPTION = candidate.descriptionText;
  const converted = convertToPortraitMp4();
  const endCard = appendFiloEndCard(OUTPUT_FILE, OUTPUT_FILE + '.endcard.mp4', {
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    durationSeconds: Number(FILO_PROFILE.end_card_seconds) || 1.6
  });
  fs.renameSync(OUTPUT_FILE + '.endcard.mp4', OUTPUT_FILE);
  const finalMedia = probeMedia(OUTPUT_FILE);
  if (!finalMedia.audio) throw new Error('final_filo_video_audio_track_missing');
  const cover = extractCoverFrame(candidate.contentOrigin === 'original_goushibaaz' ? (candidate.coverSeekSeconds || 3) : 1);

  if (DRY_RUN) {
    console.log('FILO_PUBLISH_RESULT', JSON.stringify({
      status: 'dry_run_ready_no_post_sent',
      dryRun: true,
      title: PERSIAN_TITLE,
      sourcePage: COMMONS_PAGE,
      sourceTitle: SOURCE_TITLE,
      sourceType: candidate.contentOrigin || 'licensed_external',
      license: rights.licenseName,
      sourceBytes: rights.sourceBytes,
      sourceAspectRatio: candidate.sourceAspectRatio || null,
      targetAspectRatio: CONTENT_POLICY.vertical_video.aspect_ratio,
      targetWidth: TARGET_WIDTH,
      targetHeight: TARGET_HEIGHT,
      durationSeconds: sourceDurationSeconds,
      audioCodec: finalMedia.audio.codec,
      framingMode: 'fit_foreground_with_blurred_background',
      convertedBytes: converted.outputBytes,
      coverBytes: cover.coverBytes,
      endCard,
      finalVideoBytes: endCard.outputBytes,
      contentLocaleScore: candidate.contentLocaleScore || 0,
      sourceVerticalScore: candidate.sourceVerticalScore || 1,
      note: 'No login, upload or publication attempted.'
    }));
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'fa-IR',
    viewport: { width: 1365, height: 1000 },
    acceptDownloads: true
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const observedRequests = [];
  const observedResponses = [];
  page.on('request', req => {
    try {
      const u = new URL(req.url());
      const relevant = u.hostname === 'ifilo.net' ||
        /uploadFromFile|video\/publish|\/api\/v1\/upload/i.test(u.pathname);
      if (relevant && req.method() !== 'GET') {
        observedRequests.push({ host: u.hostname, method: req.method(), path: u.pathname, resourceType: req.resourceType() });
      }
    } catch {}
  });
  page.on('response', res => {
    try {
      const u = new URL(res.url());
      const relevant = u.hostname === 'ifilo.net' ||
        /uploadFromFile|video\/publish|\/api\/v1\/upload/i.test(u.pathname);
      if (relevant && res.request().method() !== 'GET') {
        observedResponses.push({ host: u.hostname, method: res.request().method(), path: u.pathname, status: res.status() });
      }
    } catch {}
  });

  let result;
  try {
    await login(page);
    // Snapshot existing uploads so a pre-existing video cannot be mistaken for the new publication.
    const existingVideoUrls = new Set();
    await page.goto(ACCOUNT + '/my/videos', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(1800);
    const existingLinks = await page.locator('a[href*="/v/"], a[href*="/video/"]').evaluateAll(as => as.map(a => a.href)).catch(() => []);
    for (const href of existingLinks) if (/^https?:\/\/(?:www\.)?ifilo\.net\/(?:v|video)\//i.test(href)) existingVideoUrls.add(href.split('?')[0]);
    await page.goto(ACCOUNT + '/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1000);
    const requestCountBeforeFile = observedRequests.length;

    // The file input is mounted lazily only after selecting the "from your device" method.
    // Click the option first, then wait for Filo's hidden file input to appear.
    const deviceOption = page.getByText(/از دستگاه.{0,8}ت/).first();
    if (await deviceOption.isVisible().catch(() => false)) {
      await deviceOption.click();
      await sleep(900);
    }
    const uploadFile = page.locator('#fileInput').first();
    const fallbackFile = page.locator('input[type="file"][accept*="video"]').first();
    let fileInput = await uploadFile.count().catch(() => 0) ? uploadFile : fallbackFile;
    if (!(await fileInput.count().catch(() => 0))) {
      await page.locator('input[type="file"]').first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
      fileInput = await uploadFile.count().catch(() => 0) ? uploadFile : fallbackFile;
    }
    if (!(await fileInput.count().catch(() => 0))) {
      const visibleFields = await visibleFieldReport(page);
      throw new Error('filo_video_file_input_not_found_after_device_choice:' +
        visibleFields.filter(x => x.type === 'file').length + '_file_inputs');
    }

    const visibleUploader = page.locator('#uploader').first();
    let chooser = null;
    if (await visibleUploader.isVisible().catch(() => false)) {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 4500 }).catch(() => null);
      await visibleUploader.click({ timeout: 8000 });
      chooser = await chooserPromise;
    }
    if (chooser) {
      await chooser.setFiles(OUTPUT_FILE);
    } else {
      // If the tile click only initializes the chunk uploader, assign the file now.
      await fileInput.setInputFiles(OUTPUT_FILE);
    }

    let fieldsAfterSelection = [];
    let titleField = null;
    let descriptionField = null;

    // Filo uploads in 1 MiB chunks and only then exposes its metadata form.
    for (let attempt = 0; attempt < 100; attempt++) {
      await sleep(1500);
      fieldsAfterSelection = await visibleFieldReport(page);
      titleField = await findField(page, 'title');
      descriptionField = await findField(page, 'description');
      if (titleField && await titleField.isVisible().catch(() => false)) break;
      const body = await page.locator('body').innerText().catch(() => '');
      if (/خطا در بارگذاری|فایل بیش از حد مجاز|فرمت فایل نامعتبر|آپلود ناموفق/i.test(body)) break;
    }
    const uploadResponseInfo = observedResponses.filter(x => /\/uploadFromFile$/i.test(x.path)).slice(-1)[0] || null;

    // Use a simple visible title/description input only when its labels identify the field.
    if (!titleField) {
      const candidate = fieldsAfterSelection.find(x => x.visible && ['text', ''].includes(x.type) &&
        /عنوان|title|نام ویدیو|نام ویدئو/i.test([x.id, x.name, x.placeholder, x.ariaLabel, x.label].join(' ')));
      if (candidate) titleField = page.locator(candidate.id ? '#' + candidate.id : candidate.name ? '[name="' + candidate.name.replace(/"/g, '\\"') + '"]' : 'input[type="text"]').first();
    }
    if (!descriptionField) {
      const candidate = fieldsAfterSelection.find(x => x.visible && ['textarea'].includes(x.tag) &&
        /توضیح|شرح|description/i.test([x.id, x.name, x.placeholder, x.ariaLabel, x.label].join(' ')));
      if (candidate) descriptionField = page.locator(candidate.id ? '#' + candidate.id : candidate.name ? '[name="' + candidate.name.replace(/"/g, '\\"') + '"]' : 'textarea').first();
    }

    if (!titleField || !(await titleField.isVisible().catch(() => false))) {
      const stageRequests = observedRequests.slice(requestCountBeforeFile);
      const actualUploadRequest = stageRequests.some(x => /uploadFromFile$/i.test(x.path));
      if (actualUploadRequest && uploadResponseInfo && uploadResponseInfo.status >= 200 && uploadResponseInfo.status < 300) {
        state.posts = [...(state.posts || []), {
          sourcePage: COMMONS_PAGE, title: PERSIAN_TITLE, status: 'upload_staged_unpublished',
          attemptedAt: new Date().toISOString(),
          note: 'Filo file transfer completed, but metadata/publish stage was not reached.'
        }].slice(-500);
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
      }
      result = {
        status: actualUploadRequest ? 'upload_transfer_observed_but_not_published' : 'not_published_upload_not_started',
        authenticated: true,
        uploadPage: pathOnly(page.url()),
        title: PERSIAN_TITLE,
        fileSelected: true,
        uploadRequestObserved: actualUploadRequest,
        uploadResponse: uploadResponseInfo,
        fields: fieldsAfterSelection,
        bodyText: (await page.locator('body').innerText().catch(() => '')).slice(0, 4000),
        requests: observedRequests.slice(-15),
        responses: observedResponses.slice(-15),
        reason: 'A clearly identified title field was not found; final publication button was not clicked.'
      };
      console.log('FILO_PUBLISH_RESULT', JSON.stringify(result));
      return;
    }

    await titleField.fill(PERSIAN_TITLE);
    if (descriptionField && await descriptionField.isVisible().catch(() => false)) {
      await descriptionField.fill(PERSIAN_DESCRIPTION);
    }

    const coverUpload = await uploadCoverThumbnail(page, COVER_FILE);
    const publishButton = await findPublishButton(page);
    if (!publishButton) {
      result = {
        status: 'not_published_submit_button_not_found',
        authenticated: true,
        uploadPage: pathOnly(page.url()),
        title: PERSIAN_TITLE,
        fileSelected: true,
        titleFilled: true,
        descriptionFilled: Boolean(descriptionField),
        fields: await visibleFieldReport(page),
        bodyText: (await page.locator('body').innerText().catch(() => '')).slice(0, 4000),
        buttons: await page.locator('button, [role="button"], input[type="submit"]').evaluateAll(nodes => nodes.map(el => String(el.getAttribute('aria-label') || el.innerText || el.getAttribute('value') || '').trim().replace(/\s+/g, ' ').slice(0, 90)).filter(Boolean).slice(0, 40)),
        requests: observedRequests.slice(-15),
        responses: observedResponses.slice(-15),
        reason: 'No unambiguous publish/upload button was found; no submit action was attempted.'
      };
      console.log('FILO_PUBLISH_RESULT', JSON.stringify(result));
      return;
    }

    const preSubmitEntry = {
      sourcePage: COMMONS_PAGE,
      author: rights.author,
      license: rights.licenseName,
      licenseUrl: rights.licenseUrl,
      title: PERSIAN_TITLE,
      status: 'submit_started',
      contentOrigin: candidate.contentOrigin || 'licensed_external',
      puzzleId: candidate.puzzleId || undefined,
      topic: candidate.topic || undefined,
      attemptedAt: new Date().toISOString()
    };
    state.posts = [...(state.posts || []), preSubmitEntry].slice(-500);
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');

    const publishResponsePromise = page.waitForResponse(response => {
      try {
        const u = new URL(response.url());
        return u.hostname === 'ifilo.net' && u.pathname === '/api/v1/video/publish' &&
          response.request().method() === 'POST';
      } catch { return false; }
    }, { timeout: 30000 }).catch(() => null);
    await publishButton.click();
    const publishResponse = await publishResponsePromise;
    const publishHttpStatus = publishResponse ? publishResponse.status() : null;
    let publishApiAccepted = false;
    let publishApiError = '';
    if (publishResponse) {
      let responseData = null;
      try { responseData = await publishResponse.json(); } catch {}
      if (typeof responseData === 'string') {
        try { responseData = JSON.parse(responseData); } catch {}
      }
      publishApiAccepted = Boolean(responseData && responseData.s);
      publishApiError = responseData && responseData.r
        ? String(responseData.r).replace(/\s+/g, ' ').slice(0, 140)
        : '';
    }
    await sleep(5000);

    let bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 6000);
    let postUrl = '';
    let targetCardText = '';
    if (/^https?:\/\/(?:www\.)?ifilo\.net\/(?:v|video)\//i.test(page.url()) &&
        !existingVideoUrls.has(page.url().split('?')[0])) {
      postUrl = page.url().split('?')[0];
    }
    if (!postUrl) {
      const firstPageLinks = await page.locator('a[href*="/v/"], a[href*="/video/"]').evaluateAll(as => as.map(a => ({
        href: a.href.split('?')[0],
        text: String(a.innerText || a.getAttribute('title') || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '),
        cardText: String((a.closest('article, li, [class*="item"], [class*="Item"], [class*="card"], [class*="Card"], [class*="video"], [class*="Video"]') || a.parentElement || a).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 300)
      }))).catch(() => []);
      const firstPageFresh = firstPageLinks.filter(x =>
        /^https?:\/\/(?:www\.)?ifilo\.net\/(?:v|video)\//i.test(x.href) &&
        !existingVideoUrls.has(x.href)
      );
      const firstPageTitleMatch = firstPageFresh.find(x => titleMatchesContent(x.text + ' ' + x.cardText, PERSIAN_TITLE));
      const firstPageCandidate = firstPageTitleMatch || (firstPageFresh.length === 1 ? firstPageFresh[0] : null);
      if (firstPageCandidate) {
        postUrl = firstPageCandidate.href;
        targetCardText = firstPageCandidate.cardText || firstPageCandidate.text || '';
      }
    }

    if (!postUrl) {
      await page.goto(ACCOUNT + '/my/videos', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(4000);
      const links = await page.locator('a[href*="/v/"], a[href*="/video/"]').evaluateAll(as => as.map(a => ({
        href: a.href.split('?')[0],
        text: String(a.innerText || a.getAttribute('title') || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '),
        cardText: String((a.closest('article, li, [class*="item"], [class*="Item"], [class*="card"], [class*="Card"], [class*="video"], [class*="Video"]') || a.parentElement || a).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 300)
      }))).catch(() => []);
      const freshLinks = links.filter(x =>
        /^https?:\/\/(?:www\.)?ifilo\.net\/(?:v|video)\//i.test(x.href) &&
        !existingVideoUrls.has(x.href.split('?')[0])
      );
      const match = freshLinks.find(x => titleMatchesContent(x.text + ' ' + x.cardText, PERSIAN_TITLE));
      const candidateLink = match || (freshLinks.length === 1 ? freshLinks[0] : null);
      if (candidateLink) {
        postUrl = candidateLink.href;
        targetCardText = candidateLink.cardText || candidateLink.text || '';
      }
      bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 6000);
    }

    if (postUrl) {
      const pendingStatusText = /در صف انتشار|در حال پردازش|در انتظار تایید|در انتظار تأیید|ارسال شده برای اصلاح|ارسال شده برای سانسور/i.test(targetCardText);
      const activeStatusText = /(?:^|\s)فعال(?:\s|$)/.test(targetCardText) && !pendingStatusText;
      const confirmedPublic = activeStatusText;
      const finalStatus = confirmedPublic ? 'published' : 'submitted_pending_approval';
      const now = new Date().toISOString();
      const entry = {
        sourcePage: COMMONS_PAGE,
        sourceTitle: SOURCE_TITLE,
        sourceType: candidate.contentOrigin || 'licensed_external',
        contentOrigin: candidate.contentOrigin || 'licensed_external',
        puzzleId: candidate.puzzleId || undefined,
        topic: candidate.topic || candidate.editorialTopic || undefined,
        author: rights.author,
        license: rights.licenseName,
        licenseUrl: rights.licenseUrl,
        title: PERSIAN_TITLE,
        postUrl,
        status: finalStatus,
        publishHttpStatus,
        publishApiAccepted,
        sourceBytes: rights.sourceBytes,
        durationSeconds: sourceDurationSeconds,
        submittedAt: now,
        publishedAt: confirmedPublic ? now : undefined,
        reviewStatusText: String(targetCardText || '').slice(0, 300)
      };
      state.posts = [...(state.posts || []).filter(x => !(x.sourcePage === COMMONS_PAGE && x.status === 'submit_started')), entry].slice(-500);
      state.lastOutcome = { status: finalStatus, checkedAt: now, sourcePage: COMMONS_PAGE, postUrl: postUrl || null };
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
      result = {
        status: finalStatus, title: PERSIAN_TITLE, postUrl, sourcePage: COMMONS_PAGE,
        sourceTitle: SOURCE_TITLE, license: rights.licenseName, sourceBytes: rights.sourceBytes,
        convertedBytes: converted.outputBytes, finalVideoBytes: endCard.outputBytes,
        coverBytes: cover.coverBytes, endCardSeconds: endCard.endCardSeconds, durationSeconds: sourceDurationSeconds,
        coverUpload, publishHttpStatus, publishApiAccepted,
        note: confirmedPublic ? 'Filo showed the new video as active.'
          : 'Filo accepted the submission, but its public/active status was not confirmed; review may still be pending.',
        requests: observedRequests.slice(-20), responses: observedResponses.slice(-20)
      };
    } else {
      // The /my/videos page contains unrelated phrases such as "ارسال شده برای سانسور";
      // generic text matching is not evidence that the publish request was accepted.
      const confirmedAcceptance = publishApiAccepted;
      const rejected = Boolean(publishResponse && !publishApiAccepted);
      const finalStatus = confirmedAcceptance
        ? 'submitted_pending_approval'
        : rejected ? 'rejected_by_filo' : 'submit_result_unconfirmed';
      const updated = {
        ...preSubmitEntry,
        status: finalStatus,
        attemptedAt: preSubmitEntry.attemptedAt,
        publishHttpStatus,
        publishApiAccepted,
        publishApiError: publishApiError || undefined
      };
      state.posts = [...(state.posts || []).filter(x => !(x.sourcePage === COMMONS_PAGE && x.status === 'submit_started')), updated].slice(-500);
      state.lastOutcome = { status: finalStatus, checkedAt: new Date().toISOString(), sourcePage: COMMONS_PAGE, postUrl: null };
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
      result = {
        status: finalStatus,
        title: PERSIAN_TITLE,
        currentPath: pathOnly(page.url()),
        sourcePage: COMMONS_PAGE,
        license: rights.licenseName,
        publishHttpStatus,
        publishApiAccepted,
        publishApiError: publishApiError || undefined,
        coverUpload,
        note: confirmedAcceptance
          ? 'Filo accepted the publish request, but a new public post URL was not confirmed; platform review may take up to 72 hours.'
          : rejected
            ? 'Filo rejected the publish request. No successful publication is claimed.'
            : 'The publish response was not conclusive; a new public post URL could not be confirmed.',
        sourceBytes: rights.sourceBytes,
        convertedBytes: converted.outputBytes,
        finalVideoBytes: endCard.outputBytes,
        coverBytes: cover.coverBytes,
        endCardSeconds: endCard.endCardSeconds,
        bodyText: bodyText.slice(0, 1200),
        requests: observedRequests.slice(-20),
        responses: observedResponses.slice(-20)
      };
    }
  } finally {
    await context.clearCookies().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log('FILO_PUBLISH_RESULT', JSON.stringify(result));
  if (!['published', 'submitted_pending_approval', 'skipped_duplicate', 'no_eligible_candidate', 'skipped_existing_unconfirmed_attempt'].includes(result.status)) process.exitCode = 2;
}

main().catch(error => {
  const errorKind = String(error && error.name || 'Error').slice(0, 60);
  let reason = String(error && error.message || 'unknown').slice(0, 180);
  for (const secret of [process.env.FILO_USER, process.env.FILO_PASS].filter(Boolean)) {
    reason = reason.split(secret).join('[redacted]');
  }
  try {
    let state = { posts: [] };
    try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
    if (!Array.isArray(state.posts)) state.posts = [];
    state.lastOutcome = {
      status: 'failed_retryable', checkedAt: new Date().toISOString(),
      errorKind, reason
    };
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (stateError) {
    console.error('FILO_FAILURE_STATE_WRITE_FAILED', String(stateError && stateError.message || stateError).slice(0, 160));
  }
  console.log('FILO_PUBLISH_RESULT', JSON.stringify({
    status: 'failed',
    errorKind: String(error && error.name || 'Error').slice(0, 60),
    reason: String(error && error.message || 'unknown').slice(0, 180),
    note: 'No successful publication was claimed.'
  }));
  process.exit(1);
});
