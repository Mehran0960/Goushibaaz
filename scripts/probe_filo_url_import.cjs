'use strict';

const fs = require('node:fs');
const { chromium } = require('playwright');

const BASE = 'https://ifilo.net';
const FIXTURE_URLS = [
  {
    name: 'foreign_github_raw',
    url: 'https://raw.githubusercontent.com/Mehran0960/Goushibaaz/test/filo-external-url-ingest-probe-20261114/test-fixtures/filo-url-import-test.mp4'
  },
  {
    name: 'iranian_imgurl_cdn',
    url: 'https://cdn.imgurl.ir/uploads/r074313_.mp4'
  }
];
const BLOCKED_URLS = [
  { name: 'youtube_blocklist', url: 'https://www.youtube.com/watch?v=filo-url-test' },
  { name: 'aparat_blocklist', url: 'https://www.aparat.com/v/filo-url-test' }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeError(error) {
  const code = error && error.cause && error.cause.code;
  if (code && /^[A-Z0-9_]+$/.test(String(code))) return String(code);
  return error && error.name ? String(error.name) : 'request_failed';
}

function parseJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function cleanMessage(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[A-Za-z0-9_-]{15,}/g, '[redacted]')
    .slice(0, 280);
}

async function probeSource(item) {
  const out = { name: item.name, host: new URL(item.url).host };

  try {
    const head = await fetch(item.url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
      headers: { 'User-Agent': 'Goushibaaz-Filo-URL-Probe/1.0' }
    });
    out.head = {
      status: head.status,
      finalHost: new URL(head.url).host,
      contentType: head.headers.get('content-type'),
      contentLength: head.headers.get('content-length'),
      acceptRanges: head.headers.get('accept-ranges')
    };
  } catch (error) {
    out.headError = safeError(error);
  }

  try {
    const response = await fetch(item.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
      headers: {
        'User-Agent': 'Goushibaaz-Filo-URL-Probe/1.0',
        Range: 'bytes=0-63'
      }
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    out.range = {
      status: response.status,
      finalHost: new URL(response.url).host,
      contentType: response.headers.get('content-type'),
      contentRange: response.headers.get('content-range'),
      contentLength: response.headers.get('content-length'),
      bytesReceived: bytes.length,
      first16Hex: Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join(''),
      mp4FtypAtOffset4: String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp'
    };
  } catch (error) {
    out.rangeError = safeError(error);
  }

  if (item.name === 'iranian_imgurl_cdn') {
    try {
      const httpUrl = item.url.replace(/^https:/i, 'http:');
      const http = await fetch(httpUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Goushibaaz-Filo-URL-Probe/1.0' }
      });
      out.httpFallback = {
        status: http.status,
        locationHost: http.headers.get('location') ? (() => { try { return new URL(http.headers.get('location')).host; } catch { return ''; } })() : '',
        contentType: http.headers.get('content-type'),
        contentLength: http.headers.get('content-length')
      };
    } catch (error) {
      out.httpFallbackError = safeError(error);
    }
  }

  return out;
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

async function confirmLogin(page, report) {
  const loginResponsePromise = page.waitForResponse(response => {
    try {
      const url = new URL(response.url());
      return url.hostname === 'ifilo.net' &&
        url.pathname === '/api/v1/users/login' &&
        response.request().method() === 'POST';
    } catch { return false; }
  }, { timeout: 15000 }).catch(() => null);

  const loginPageResponse = await page.goto(BASE + '/login?m=3&r=%2Fupload', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  report.pageHttpStatus = loginPageResponse ? loginPageResponse.status() : null;

  const password = page.locator('input[type="password"]').first();
  await password.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(1200);

  const selectors = [
    'input[autocomplete="username"]',
    'input[type="tel"]',
    'input[name*="phone" i]',
    'input[name*="mobile" i]',
    'input[placeholder*="شماره"]',
    'input[placeholder*="موبایل"]',
    'input[placeholder*="ایمیل"]',
    'input[type="email"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[type="text"]'
  ];

  let username = null;
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    if (await visible(candidate)) {
      username = candidate;
      break;
    }
  }
  if (!username) throw new Error('filo_username_field_not_found');

  await username.fill(process.env.FILO_USER);
  await password.fill(process.env.FILO_PASS);
  await password.press('Tab').catch(() => {});

  let submit = null;
  for (const selector of ['button[type="submit"]', 'input[type="submit"]']) {
    const candidate = page.locator(selector).first();
    if (await visible(candidate) && await candidate.isEnabled().catch(() => false)) {
      submit = candidate;
      break;
    }
  }
  if (!submit) throw new Error('filo_login_submit_not_ready');

  await submit.click();
  const loginResponse = await loginResponsePromise;
  let loginKeys = [];
  let explicitRejection = false;
  let loginStatus = null;
  let loginStatusField = null;
  let loginStatusCode = null;
  let loginMessage = '';
  if (loginResponse) {
    loginStatus = loginResponse.status();
    const body = await loginResponse.text().catch(() => '');
    const parsed = parseJson(body);
    loginKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 12) : [];
    loginStatusField = parsed && typeof parsed.status === 'string' ? parsed.status.slice(0, 40) : parsed && typeof parsed.status === 'boolean' ? parsed.status : null;
    loginStatusCode = parsed && (typeof parsed.status_code === 'number' || typeof parsed.status_code === 'string') ? String(parsed.status_code).slice(0, 40) : null;
    loginMessage = cleanMessage(parsed && parsed.message || '');
    explicitRejection = Boolean(parsed && typeof parsed === 'object' &&
      (parsed.success === false || parsed.status === false || parsed.error || parsed.errors || (typeof parsed.status === 'string' && !/^(success|ok)$/i.test(parsed.status))));
  }

  report.apiHttpStatus = loginStatus;
  report.apiResponseKeys = loginKeys;
  report.apiStatusField = loginStatusField;
  report.apiStatusCode = loginStatusCode;
  report.apiMessage = loginMessage;
  report.explicitApiRejection = explicitRejection;

  await sleep(1500);
  const uploadResponse = await page.goto(BASE + '/upload', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  report.uploadRouteHttpStatus = uploadResponse ? uploadResponse.status() : null;
  await sleep(1800);

  const pageEvidence = await page.evaluate(() => {
    const text = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200);
    const path = location.pathname;
    const storageKeys = [];
    try { for (let i = 0; i < localStorage.length; i++) storageKeys.push(localStorage.key(i)); } catch {}
    try { for (let i = 0; i < sessionStorage.length; i++) storageKeys.push(sessionStorage.key(i)); } catch {}
    const authStorageKeyPresent = storageKeys.some(key => /(token|auth|session|user)/i.test(String(key || '')));
    const hasLogout = Array.from(document.querySelectorAll('a')).some(a =>
      /خروج|logout|sign.?out/i.test((a.innerText || '') + ' ' + (a.getAttribute('href') || ''))
    );
    const hasPassword = Array.from(document.querySelectorAll('input[type="password"]'))
      .some(input => input.offsetParent !== null);
    const hasFile = Boolean(document.querySelector('input[type="file"]'));
    const hasUploadForm = Boolean(document.querySelector('form[action*="upload" i], [data-upload-form], .upload-form'));
    const loginPrompt = /ورود به حساب|وارد حساب شوید|لطفا وارد شوید|رمز عبور|sign in to|please log in|login required/i.test(text);
    const accessDenied = /دسترسی غیرمجاز|access denied|forbidden/i.test((document.title || '') + ' ' + text);
    return {
      path,
      hasLogout,
      hasPassword,
      hasFile,
      hasUploadForm,
      loginPrompt,
      accessDenied,
      authStorageKeyPresent,
      storageKeyNames: storageKeys.map(key => String(key || '').slice(0, 80)).slice(0, 30),
      title: String(document.title || '').slice(0, 100)
    };
  });

  report.pageEvidence = pageEvidence;
  const cookies = await page.context().cookies(BASE);
  const hasSessionCookie = cookies.some(cookie => /(session|auth|token|user|sid|jwt)/i.test(cookie.name));
  const routeOk = /^\/upload(?:\/|$)/i.test(pageEvidence.path) &&
    !pageEvidence.hasPassword && !pageEvidence.loginPrompt && !pageEvidence.accessDenied;
  const confirmed = !explicitRejection && (pageEvidence.hasLogout ||
    (routeOk && (hasSessionCookie || pageEvidence.authStorageKeyPresent || pageEvidence.hasFile || pageEvidence.hasUploadForm)));
  report.hasSessionCookie = hasSessionCookie;
  report.outcome = confirmed ? 'authenticated' : 'login_not_confirmed';
  return confirmed;
}

async function selectExternalUrlTab(page) {
  const tab = page.getByText('از سایت‌های دیگه', { exact: true }).first();
  if (await visible(tab)) await tab.click();
  await page.waitForTimeout(500);
  return page.locator('input[name="tVideoUrl"]').first();
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    sourceProbe: [],
    login: { outcome: 'not_attempted' },
    uploadConfig: { loaded: false },
    frontendBlocklist: [],
    imports: [],
    publishEndpointCalled: false,
    note: 'Import-only diagnostics. The workflow never calls /api/v1/video/publish and never creates a public Filo post.'
  };

  for (const source of FIXTURE_URLS) report.sourceProbe.push(await probeSource(source));

  if (!process.env.FILO_USER || !process.env.FILO_PASS) {
    report.login.outcome = 'missing_github_secrets';
    return report;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'fa-IR',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129 Safari/537.36'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);

  const uploadRequests = [];
  const uploadResponses = [];
  const publishRequests = [];
  const failedUploadRequests = [];
  let uploadConfig = null;

  page.on('request', request => {
    try {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/uploadFromUrl')) {
        uploadRequests.push({ host: url.host, path: url.pathname, method: request.method() });
      }
      if (url.pathname === '/api/v1/video/publish') {
        publishRequests.push({ host: url.host, path: url.pathname, method: request.method() });
      }
    } catch {}
  });

  page.on('requestfailed', request => {
    try {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/uploadFromUrl')) {
        failedUploadRequests.push({
          host: url.host,
          path: url.pathname,
          method: request.method(),
          failure: cleanMessage(request.failure()?.errorText || 'request_failed')
        });
      }
    } catch {}
  });

  page.on('response', async response => {
    try {
      const url = new URL(response.url());
      if (url.hostname === 'ifilo.net' && url.pathname === '/api/v1/upload') {
        const parsed = parseJson(await response.text().catch(() => ''));
        const data = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : null;
        if (data) {
          uploadConfig = {
            isIran: Boolean(data.is_iran ?? data.isIran),
            limitedMinutes: Boolean(data.limited_minutes ?? data.limitedMinutes),
            stopUpload: Boolean(data.stop_upload ?? data.stopUpload),
            uploadDomainPresent: Boolean(data.upload_domain ?? data.uploadDomain),
            fileDomainPresent: Boolean(data.file_domain ?? data.fileDomain),
            acceptRulePresent: data.accept_rule !== undefined || data.acceptRule !== undefined
          };
        }
      }

      if (url.pathname.endsWith('/uploadFromUrl')) {
        const parsed = parseJson(await response.text().catch(() => ''));
        const data = parsed && parsed.d && typeof parsed.d === 'object' ? parsed.d : {};
        uploadResponses.push({
          host: url.host,
          path: url.pathname,
          status: response.status(),
          contentType: response.headers()['content-type'] || '',
          responseKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 12) : [],
          chunkPending: Boolean(parsed && parsed.d === 1),
          importSuccessFlag: Boolean(parsed && parsed.s),
          metadataPresent: Boolean(data.c || data.ufr || data.i),
          width: Number(data.w) || null,
          height: Number(data.he) || null,
          durationSeconds: Number(data.d) || null,
          framesCount: Array.isArray(data.i) ? data.i.length : null
        });
      }
    } catch {}
  });

  try {
    const loggedIn = await confirmLogin(page, report.login);
    if (!loggedIn) {
      report.uploadConfig = uploadConfig || { loaded: false };
      return report;
    }

    await page.waitForTimeout(1000);
    report.uploadConfig = uploadConfig || { loaded: false };

    for (const item of BLOCKED_URLS) {
      await page.goto(BASE + '/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1200);
      const field = await selectExternalUrlTab(page);
      const before = uploadRequests.length;
      const test = { name: item.name, fieldFound: await visible(field) };
      if (test.fieldFound) {
        await field.fill(item.url);
        await page.locator('#startUrlUpload').click();
        await page.waitForTimeout(600);
        const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
        test.blockedMessageShown = text.includes('امکان بارگذاری ویدیو از این سایت وجود نداره');
        test.message = cleanMessage(text.match(/امکان بارگذاری[^.]*|لطفا نشانی[^.]*/)?.[0] || '');
        test.uploadRequestsSent = uploadRequests.length - before;
      }
      report.frontendBlocklist.push(test);
    }

    for (const item of FIXTURE_URLS) {
      await page.goto(BASE + '/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1200);
      const beforeRequests = uploadRequests.length;
      const beforeResponses = uploadResponses.length;
      const field = await selectExternalUrlTab(page);
      const test = { name: item.name, host: new URL(item.url).host, inputFound: await visible(field) };

      if (test.inputFound) {
        await field.fill(item.url);
        await page.locator('#startUrlUpload').click();

        const start = Date.now();
        while (Date.now() - start < 90000) {
          const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
          const titleField = page.locator('input[name="title"]').first();
          const descriptionField = page.locator('textarea').first();
          const titleVisible = await visible(titleField);
          const descriptionVisible = await visible(descriptionField);
          const tempSourceVisible = await page.locator('video[src*="/temp/"], video source[src*="/temp/"]').count().catch(() => 0) > 0;
          const failed = /سرور آدرس وارد شده از کیفیت مناسبی برخوردار نمی باشد|بارگذاری ناموفق بود|فایل موردنظر معتبر نیست|امکان بارگذاری ویدیو از این سایت وجود نداره/.test(body);
          const responseFinished = uploadResponses.length > beforeResponses;
          const requestFailed = failedUploadRequests.length > 0 && failedUploadRequests.some(item => item.host === test.host);
          if (failed || titleVisible || descriptionVisible || tempSourceVisible || responseFinished || requestFailed) break;
          await page.waitForTimeout(1000);
        }

        const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
        test.uploadRequests = uploadRequests.length - beforeRequests;
        test.uploadResponses = uploadResponses.slice(beforeResponses);
        test.failedUploadRequests = failedUploadRequests.filter(item => item.host === test.host);
        test.publishFormReached = await visible(page.locator('input[name="title"]').first());
        test.descriptionFieldVisible = await visible(page.locator('textarea').first());
        test.tempSourceVisible = (await page.locator('video[src*="/temp/"], video source[src*="/temp/"]').count().catch(() => 0)) > 0;
        test.videoSources = await page.locator('video, video source').evaluateAll(nodes => nodes.map(node => {
          const value = node.currentSrc || node.src || node.getAttribute('src') || '';
          try { const url = new URL(value); return { host: url.host, path: url.pathname }; } catch { return { host: '', path: '' }; }
        }).filter(item => item.path).slice(0, 5)).catch(() => []);
        test.errorMessage = cleanMessage(body.match(/سرور آدرس وارد شده[^.]*|بارگذاری ناموفق بود[^.]*|فایل موردنظر معتبر نیست[^.]*|امکان بارگذاری ویدیو[^.]*/)?.[0] || '');
        test.imported = test.publishFormReached || test.descriptionFieldVisible || test.tempSourceVisible ||
          test.uploadResponses.some(result => result.importSuccessFlag || result.metadataPresent);
        test.outcome = test.imported ? 'temporary_import_confirmed' :
          test.failedUploadRequests.length ? 'upload_request_failed' :
          test.uploadResponses.length ? 'upload_response_without_import_metadata' :
          test.uploadRequests ? 'request_sent_no_response_or_preview' : 'no_upload_request';
      }

      report.imports.push(test);
    }
  } catch (error) {
    report.error = String(error && error.message || error).slice(0, 360);
  } finally {
    report.publishEndpointCalled = publishRequests.length > 0;
    report.publishRequestCount = publishRequests.length;
    report.uploadRequests = uploadRequests;
    report.failedUploadRequests = failedUploadRequests;
    await context.clearCookies().catch(() => {});
    await browser.close().catch(() => {});
  }

  return report;
}

main()
  .then(report => {
    const json = JSON.stringify(report, null, 2);
    console.log('FILO_URL_IMPORT_PROBE ' + JSON.stringify(report));
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Filo URL import probe (no publication)\n\n' + json + '\n');
    if (report.publishEndpointCalled) {
      console.error('Safety assertion failed: Filo publish endpoint was called.');
      process.exitCode = 2;
    }
  })
  .catch(error => {
    console.error('probe_fatal:' + (error && error.name || 'unknown'));
    process.exitCode = 1;
  });
