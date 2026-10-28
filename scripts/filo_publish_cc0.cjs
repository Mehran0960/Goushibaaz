const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ACCOUNT = 'https://ifilo.net';
const COMMONS_PAGE = 'https://commons.wikimedia.org/wiki/File:Cat_Jumpscare.webm';
const CC0_LICENSE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';
const SOURCE_TITLE = 'File:Cat_Jumpscare.webm';
const PERSIAN_TITLE = 'وقتی گربه یهو میاد جلوی دوربین 😂';
const PERSIAN_DESCRIPTION = [
  'یک لحظهٔ کوتاه و غافلگیرکننده؛ بدون نیاز به زبان 😹',
  '',
  'منبع: Cat Jumpscare — اثر Panini! در Wikimedia Commons',
  'مجوز: CC0 1.0 (دامنهٔ عمومی)',
  COMMONS_PAGE,
  CC0_LICENSE_URL
].join('\n');

const STATE_PATH = path.join('state', 'filo-published.json');
const VIDEO_DIR = path.join(process.cwd(), 'work', 'filo-publish');
const INPUT_FILE = path.join(VIDEO_DIR, 'Cat_Jumpscare.webm');
const OUTPUT_FILE = path.join(VIDEO_DIR, 'cat-jumpscare-fa.mp4');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();
const pathOnly = value => {
  try { return new URL(value).pathname; } catch { return ''; }
};

async function downloadVerifiedCc0Source() {
  const api = new URL('https://commons.wikimedia.org/w/api.php');
  api.searchParams.set('action', 'query');
  api.searchParams.set('titles', SOURCE_TITLE);
  api.searchParams.set('prop', 'imageinfo');
  api.searchParams.set('iiprop', 'url|mime|size|extmetadata');
  api.searchParams.set('format', 'json');

  const metadataResponse = await fetch(api, {
    headers: { 'User-Agent': 'GoushibaazFiloPublisher/1.0 (public metadata; source CC0)' },
    signal: AbortSignal.timeout(20000)
  });
  if (!metadataResponse.ok) throw new Error('commons_metadata_http_' + metadataResponse.status);
  const json = await metadataResponse.json();
  const page = Object.values(json.query && json.query.pages || {})[0];
  const info = page && page.imageinfo && page.imageinfo[0];
  if (!info || !info.url) throw new Error('commons_source_file_missing');

  const metadata = info.extmetadata || {};
  const licenseName = cleanText(metadata.LicenseShortName && metadata.LicenseShortName.value);
  const licenseUrl = cleanText(metadata.LicenseUrl && metadata.LicenseUrl.value);
  const description = cleanText(metadata.ImageDescription && metadata.ImageDescription.value);
  const authorHtml = metadata.Artist && metadata.Artist.value || '';
  const author = cleanText(authorHtml.replace(/<[^>]*>/g, ''));
  const explicitlyCc0 = /CC0/i.test(licenseName) || /publicdomain\/zero\/1\.0/i.test(licenseUrl);
  if (!explicitlyCc0) throw new Error('commons_license_not_verified_as_cc0');

  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const fileResponse = await fetch(info.url, {
    headers: { 'User-Agent': 'GoushibaazFiloPublisher/1.0 (CC0 video reuse)' },
    signal: AbortSignal.timeout(45000)
  });
  if (!fileResponse.ok) throw new Error('commons_video_download_http_' + fileResponse.status);
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  if (bytes.length < 200000 || bytes.length > 80000000) throw new Error('commons_video_size_out_of_expected_range');
  if (!(bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) {
    throw new Error('commons_file_not_webm');
  }
  fs.writeFileSync(INPUT_FILE, bytes);
  return {
    sourcePage: COMMONS_PAGE,
    directFilePath: pathOnly(info.url),
    licenseName,
    licenseUrl,
    author: author.slice(0, 100),
    sourceBytes: bytes.length,
    sourceDescription: description.slice(0, 180)
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

async function visibleFirst(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function login(page) {
  if (!process.env.FILO_USER || !process.env.FILO_PASS) throw new Error('filo_credentials_missing');
  await page.goto(ACCOUNT + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const password = page.locator('input[type="password"]').first();
  await password.waitFor({ state: 'visible', timeout: 15000 });

  const username = await visibleFirst(page, [
    'input[autocomplete="username"]',
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
  ]) || page.getByRole('button', { name: /ورود|login/i }).first();

  if (!(await submit.isVisible().catch(() => false))) throw new Error('filo_login_submit_not_found');
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
    submit.click()
  ]);
  await sleep(4000);

  const challengeText = (await page.locator('body').innerText().catch(() => '')).slice(0, 5000);
  if (/کد تایید|کد تأیید|رمز یکبار مصرف|captcha|verify you are human/i.test(challengeText)) {
    throw new Error('filo_login_challenge_required');
  }
  const stillPassword = await password.isVisible().catch(() => false);
  if (stillPassword && /ورود به حساب|رمز عبور/.test(challengeText)) throw new Error('filo_login_failed');
  await page.goto(ACCOUNT + '/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1600);
  if (pathOnly(page.url()) === '/login') throw new Error('filo_upload_redirected_to_login');
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
      text: cleanButtonText(el),
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

async function main() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  let state = { posts: [] };
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  if ((state.posts || []).some(x => x.sourcePage === COMMONS_PAGE && x.status === 'published')) {
    console.log('FILO_PUBLISH_RESULT', JSON.stringify({ status: 'skipped_duplicate', source: COMMONS_PAGE }));
    return;
  }

  const rights = await downloadVerifiedCc0Source();
  const converted = convertToPortraitMp4();

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
    const u = new URL(req.url());
    if (u.hostname === 'ifilo.net' && req.method() !== 'GET') {
      observedRequests.push({ method: req.method(), path: u.pathname, resourceType: req.resourceType() });
    }
  });
  page.on('response', res => {
    const u = new URL(res.url());
    if (u.hostname === 'ifilo.net' && res.request().method() !== 'GET') {
      observedResponses.push({ method: res.request().method(), path: u.pathname, status: res.status() });
    }
  });

  let result;
  try {
    await login(page);
    const uploadFile = page.locator('#fileInput').first();
    const fallbackFile = page.locator('input[type="file"][accept*="video"]').first();
    let fileInput = await uploadFile.count().catch(() => 0) ? uploadFile : fallbackFile;
    if (!(await fileInput.count().catch(() => 0))) throw new Error('filo_video_file_input_not_found');

    await fileInput.setInputFiles(OUTPUT_FILE);
    await sleep(2500);

    const fieldsAfterSelection = await visibleFieldReport(page);
    let titleField = await findField(page, 'title');
    let descriptionField = await findField(page, 'description');

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
      result = {
        status: 'not_published_form_needs_mapping',
        authenticated: true,
        uploadPage: pathOnly(page.url()),
        title: PERSIAN_TITLE,
        fileSelected: true,
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

    const beforeText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1000);
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
        buttons: await page.locator('button, [role="button"], input[type="submit"]').evaluateAll(nodes => nodes.map(cleanButtonText).filter(Boolean).slice(0, 40)),
        requests: observedRequests.slice(-15),
        responses: observedResponses.slice(-15),
        reason: 'No unambiguous publish/upload button was found; no submit action was attempted.'
      };
      console.log('FILO_PUBLISH_RESULT', JSON.stringify(result));
      return;
    }

    await publishButton.click();
    await sleep(10000);

    let bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 6000);
    let postUrl = await page.locator('a[href*="/v/"], a[href*="/video/"]').evaluateAll(as => as.map(a => a.href).find(h => /^https?:\/\/(?:www\.)?ifilo\.net\/(?:v|video)\//i.test(h)) || '').catch(() => '');

    if (!postUrl) {
      await page.goto(ACCOUNT + '/my/videos', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(4000);
      const links = await page.locator('a[href*="/v/"], a[href*="/video/"]').evaluateAll(as => as.map(a => ({
        href: a.href,
        text: (a.innerText || a.getAttribute('title') || '').trim().replace(/\s+/g,' ')
      }))).catch(() => []);
      const match = links.find(x => cleanText(x.text).includes('گربه') || x.href.includes('/v/'));
      if (match) postUrl = match.href;
      bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 6000);
    }

    if (postUrl) {
      const entry = {
        sourcePage: COMMONS_PAGE,
        author: rights.author,
        license: rights.licenseName,
        licenseUrl: rights.licenseUrl,
        title: PERSIAN_TITLE,
        postUrl,
        status: 'published',
        publishedAt: new Date().toISOString()
      };
      state.posts = [...(state.posts || []), entry].slice(-500);
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
      result = { status: 'published', title: PERSIAN_TITLE, postUrl, sourcePage: COMMONS_PAGE, license: rights.licenseName, sourceBytes: rights.sourceBytes, convertedBytes: converted.outputBytes, requests: observedRequests.slice(-15), responses: observedResponses.slice(-15) };
    } else {
      result = {
        status: /با موفقیت|موفقیت آمیز|بارگذاری شد|ارسال شد|منتشر شد/i.test(bodyText) ? 'submitted_no_public_url_found' : 'submit_result_unconfirmed',
        title: PERSIAN_TITLE,
        currentPath: pathOnly(page.url()),
        sourcePage: COMMONS_PAGE,
        license: rights.licenseName,
        sourceBytes: rights.sourceBytes,
        convertedBytes: converted.outputBytes,
        bodyText,
        requests: observedRequests.slice(-20),
        responses: observedResponses.slice(-20)
      };
    }
  } finally {
    await context.clearCookies().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log('FILO_PUBLISH_RESULT', JSON.stringify(result));
  if (!['published', 'skipped_duplicate'].includes(result.status)) process.exitCode = 2;
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
