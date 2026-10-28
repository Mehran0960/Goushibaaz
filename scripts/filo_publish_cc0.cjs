const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ACCOUNT = 'https://ifilo.net';
const CC0_LICENSE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';
const STATE_PATH = path.join('state', 'filo-published.json');
const VIDEO_DIR = path.join(process.cwd(), 'work', 'filo-publish');
const INPUT_FILE = path.join(VIDEO_DIR, 'source-video.webm');
const OUTPUT_FILE = path.join(VIDEO_DIR, 'filo-video-fa.mp4');
const COVER_FILE = path.join(VIDEO_DIR, 'filo-video-cover.jpg');
const MAX_SOURCE_BYTES = 45_000_000;
// Fail closed on reuse rights: only explicitly documented, commercially reusable CC0 sources are considered.
const MAX_DURATION_SECONDS = 180;
const ACTIVE_SOURCE_STATUSES = new Set([
  'published', 'submitted_pending_approval', 'submit_started',
  'submitted_unconfirmed', 'submit_result_unconfirmed', 'upload_staged_unpublished', 'rejected_by_filo'
]);
const COMMONS_SEARCHES = [
  { key: 'cats', query: 'filetype:video cat' },
  { key: 'dogs', query: 'filetype:video dog' },
  { key: 'pets', query: 'filetype:video pet' },
  { key: 'birds', query: 'filetype:video bird' },
  { key: 'squirrels', query: 'filetype:video squirrel' },
  { key: 'monkeys', query: 'filetype:video monkey' },
  { key: 'animals', query: 'filetype:video animal' },
  { key: 'persian-cats', query: 'filetype:video گربه' },
  { key: 'persian-animals', query: 'filetype:video حیوانات بامزه' },
  { key: 'camera-moments', query: 'filetype:video caught camera animal' }
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

function titleForCandidate(candidate) {
  const text = (candidate.fileTitle + ' ' + candidate.description).toLowerCase();
  if (/\b(cat|cats|kitten|kittens|feline)\b|گربه/.test(text)) return 'لحظه‌ای غیرمنتظره از دنیای گربه‌ها 😹';
  if (/\b(dog|dogs|puppy|puppies)\b|سگ/.test(text)) return 'یک حرکت بامزه از دنیای سگ‌ها 🐶';
  if (/\b(bird|birds|parrot|parrots|pigeon)\b|پرنده/.test(text)) return 'لحظه‌ای تماشایی از دنیای پرندگان 🐦';
  if (/\b(mouse|mice|hamster|hamsters|gerbil|gerbils)\b/.test(text)) return 'لحظه‌های بامزه از دنیای موش‌های خانگی 🐭';
  if (/\b(squirrel|squirrels|monkey|monkeys|rabbit|rabbits)\b/.test(text)) return 'رفتار جالب یک حیوان در چند ثانیه 🐾';
  if (/\b(caught on camera|surprise|jumpscare|unexpected|funny|playful|playing|fail)\b/.test(text)) return 'یک لحظه غیرمنتظره که ارزش دیدن دارد 😮';
  return 'لحظه‌ای دیدنی از دنیای حیوانات 🐾';
}

function descriptionForCandidate(candidate) {
  const licenseType = candidate.licenseType || commercialLicenseProfile(candidate.licenseName, candidate.licenseUrl)?.type || 'CC0 1.0';
  const licenseUrl = candidate.licenseUrl || (licenseType === 'CC BY 4.0'
    ? 'https://creativecommons.org/licenses/by/4.0/'
    : CC0_LICENSE_URL);
  const changeNote = 'تغییرات: تبدیل به قالب عمودی ۹:۱۶، برش/مقیاس‌دهی تصویر و فشرده‌سازی برای انتشار.';
  return [
    'یک ویدئوی کوتاه و تصویری؛ بدون نیاز به زبان 🐾',
    '',
    'منبع: ' + candidate.fileTitle.replace(/^File:/i, ''),
    'پدیدآورنده: ' + (candidate.author || 'طبق اطلاعات صفحهٔ منبع'),
    'مجوز: ' + licenseType,
    ...(licenseType === 'CC BY 4.0' ? [changeNote] : []),
    candidate.sourcePage,
    licenseUrl,
    '',
    'اگر این کلیپ لبخندت را آورد، با دوستت هم به اشتراک بگذار.'
  ].join('\n');
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

function classifyCandidate(candidate) {
  const text = (candidate.fileTitle + ' ' + candidate.description).toLowerCase();
  if (/\b(cat|cats|kitten|kittens|feline|dog|dogs|puppy|puppies|pet|pets|bird|birds|parrot|pigeon|squirrel|monkey|rabbit|animal|wildlife)\b|گربه|سگ|حیوان|پرنده/.test(text)) {
    return true;
  }
  return /caught on camera|jumpscare|unexpected|surprise|funny|playful|playing|fail|visual comedy|oddly satisfying/.test(text);
}

async function discoverCommercialCandidates(state) {
  const used = new Set((state.posts || [])
    .filter(item => ACTIVE_SOURCE_STATUSES.has(item.status) || item.status === 'ineligible_source')
    .map(item => item.sourcePage));
  // Rotate by distinct sources already attempted/queued, not just approved posts;
  // moderation can take days, and pending items should still advance category variety.
  const rotationCount = used.size;
  const queryCount = 4;
  const searches = Array.from({ length: queryCount }, (_, offset) =>
    COMMONS_SEARCHES[(rotationCount * 2 + offset) % COMMONS_SEARCHES.length]);
  const found = new Map();

  for (const search of searches) {
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
      headers: { 'User-Agent': 'GoushibaazFiloPublisher/1.0 (CC0 and CC BY 4.0 verified reuse)' },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      console.log('COMMONS_SEARCH', JSON.stringify({ query: search.key, status: response.status }));
      continue;
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
      const sourcePage = info.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(fileTitle.replace(/ /g, '_')));
      if (used.has(sourcePage) || !classifyCandidate({ fileTitle, description })) continue;
      const duration = parsedDurationSeconds(info);
      if (duration !== null && (duration < 3 || duration > MAX_DURATION_SECONDS)) continue;
      const candidate = {
        fileTitle, sourcePage, fileUrl: info.url, mime: info.mime, size: info.size,
        durationSeconds: duration, licenseName, licenseUrl, licenseType: licenseProfile.type,
        description, author
      };
      candidate.title = titleForCandidate(candidate);
      candidate.descriptionText = descriptionForCandidate(candidate);
      found.set(sourcePage, candidate);
    }
    await sleep(250);
  }
  return [...found.values()].slice(0, 24);
}

async function downloadVerifiedCc0Source(candidate) {
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
    headers: { 'User-Agent': 'GoushibaazFiloPublisher/1.0 (verified commercial-reuse license)' },
    signal: AbortSignal.timeout(45000)
  });
  if (!fileResponse.ok) throw new Error('commons_video_download_http_' + fileResponse.status);
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  if (bytes.length < 200000 || bytes.length > MAX_SOURCE_BYTES) throw new Error('commons_video_size_out_of_expected_range');
  if (!(bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) {
    throw new Error('commons_file_not_webm');
  }
  fs.writeFileSync(INPUT_FILE, bytes);
  return {
    sourcePage: candidate.sourcePage, sourceTitle: candidate.fileTitle,
    directFilePath: pathOnly(candidate.fileUrl), licenseName: candidate.licenseName,
    licenseUrl: licenseProfile.url, licenseType: licenseProfile.type,
    author: String(candidate.author || 'Not identified on the source page').slice(0, 100),
    sourceBytes: bytes.length, sourceDescription: candidate.description.slice(0, 180),
    durationSeconds: candidate.durationSeconds
  };
}

function convertToPortraitMp4() {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', INPUT_FILE,
    '-vf', 'scale=608:1080:force_original_aspect_ratio=increase,crop=608:1080,scale=1080:1920',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-movflags', '+faststart',
    OUTPUT_FILE
  ], { stdio: 'pipe', timeout: 120000 });
  const stat = fs.statSync(OUTPUT_FILE);
  if (stat.size < 100000 || stat.size > 80000000) throw new Error('converted_video_size_out_of_range');
  return { outputBytes: stat.size, outputPath: OUTPUT_FILE };
}

function extractCoverFrame() {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '00:00:01.0', '-i', OUTPUT_FILE,
    '-frames:v', '1',
    '-vf', 'scale=576:1024:force_original_aspect_ratio=decrease,pad=576:1024:(ow-iw)/2:(oh-ih)/2,setsar=1',
    '-q:v', '2',
    COVER_FILE
  ], { stdio: 'pipe', timeout: 30000 });
  const bytes = fs.readFileSync(COVER_FILE);
  if (bytes.length < 10000 || bytes.length > 10000000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('cover_frame_generation_failed');
  }
  return { coverBytes: bytes.length, coverPath: COVER_FILE, width: 576, height: 1024 };
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

  const candidates = await discoverCommercialCandidates(state);
  if (!candidates.length) {
    const result = {
      status: 'no_eligible_candidate',
      searchedQueries: 4,
      note: 'No new short WebM candidate with an explicitly verified CC0 license was found. Nothing was published.'
    };
    console.log('FILO_PUBLISH_RESULT', JSON.stringify(result));
    return;
  }

  let candidate = null;
  let rights = null;
  let sourceDurationSeconds = null;
  const preparationErrors = [];
  for (const proposed of candidates.slice(0, 8)) {
    try {
      const proposedRights = await downloadVerifiedCc0Source(proposed);
      let duration = Number(proposedRights.durationSeconds);
      if (!Number.isFinite(duration) || duration <= 0) {
        const probe = execFileSync('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1', INPUT_FILE
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim();
        duration = Number(probe);
      }
      if (!Number.isFinite(duration) || duration < 3 || duration > MAX_DURATION_SECONDS) {
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
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    const result = {
      status: 'no_eligible_candidate',
      candidateCount: candidates.length,
      preparationFailures: preparationErrors.slice(0, 8),
      note: 'No new CC0 video passed download and duration checks; nothing was published.'
    };
    console.log('FILO_PUBLISH_RESULT', JSON.stringify(result));
    return;
  }

  const COMMONS_PAGE = candidate.sourcePage;
  const SOURCE_TITLE = candidate.fileTitle;
  const PERSIAN_TITLE = candidate.title;
  const PERSIAN_DESCRIPTION = candidate.descriptionText;
  const converted = convertToPortraitMp4();
  const cover = extractCoverFrame();

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
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
      result = {
        status: finalStatus, title: PERSIAN_TITLE, postUrl, sourcePage: COMMONS_PAGE,
        sourceTitle: SOURCE_TITLE, license: rights.licenseName, sourceBytes: rights.sourceBytes,
        convertedBytes: converted.outputBytes, coverBytes: cover.coverBytes, durationSeconds: sourceDurationSeconds,
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
        coverBytes: cover.coverBytes,
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
  console.log('FILO_PUBLISH_RESULT', JSON.stringify({
    status: 'failed',
    errorKind: String(error && error.name || 'Error').slice(0, 60),
    reason: String(error && error.message || 'unknown').slice(0, 180),
    note: 'No successful publication was claimed.'
  }));
  process.exit(1);
});
