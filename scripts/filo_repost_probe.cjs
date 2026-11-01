const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = 'https://ifilo.net';
const DEFAULT_FORM = 'https://ifilo.net/republish/iFEOV7G';
const TARGET_URL = String(process.env.FILO_REPOST_FORM_URL || DEFAULT_FORM).trim();
const OUT = path.join('out', 'filo-repost-probe.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeUrlPath(value) {
  try {
    const u = new URL(value);
    if (u.hostname !== 'ifilo.net' && u.hostname !== 'www.ifilo.net') return 'external_url_blocked';
    return u.pathname;
  } catch {
    return 'invalid_url';
  }
}

async function visibleFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function login(page) {
  if (!process.env.FILO_USER || !process.env.FILO_PASS) throw new Error('filo_credentials_missing');
  await page.goto(BASE + '/login?m=3&r=%2Fupload', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const password = page.locator('input[type="password"]').first();
  await password.waitFor({ state: 'visible', timeout: 15000 });

  const usernameSelectors = [
    'input[autocomplete="username"]', 'input[type="tel"]',
    'input[name*="phone" i]', 'input[name*="mobile" i]',
    'input[placeholder*="شماره"]', 'input[placeholder*="موبایل"]',
    'input[placeholder*="ایمیل"]', 'input[type="email"]',
    'input[name*="user" i]', 'input[name*="email" i]', 'input[type="text"]'
  ];
  const username = await visibleFirst(page, usernameSelectors);
  if (!username) throw new Error('filo_username_field_not_found');

  await username.fill(process.env.FILO_USER);
  await password.fill(process.env.FILO_PASS);
  const submit = await visibleFirst(page, ['button[type="submit"]', 'input[type="submit"]']);
  if (!submit) throw new Error('filo_login_submit_not_found');

  const responsePromise = page.waitForResponse(response => {
    try {
      const u = new URL(response.url());
      return u.hostname === 'ifilo.net' && u.pathname === '/api/v1/users/login' &&
        response.request().method() === 'POST';
    } catch { return false; }
  }, { timeout: 15000 }).catch(() => null);

  await submit.click();
  const loginResponse = await responsePromise;
  let apiOk = false;
  if (loginResponse) {
    try {
      let data = await loginResponse.json();
      if (typeof data === 'string') data = JSON.parse(data);
      apiOk = Boolean(data && data.s);
    } catch {}
  }
  await sleep(1800);
  const body = await page.locator('body').innerText().catch(() => '');
  if (/کد تایید|کد تأیید|رمز یکبار مصرف|captcha|verify you are human|تایید هویت/i.test(body)) {
    throw new Error('filo_login_challenge_required');
  }

  await page.goto(BASE + '/upload', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(1000);
  if (safeUrlPath(page.url()) === '/login') throw new Error(apiOk ? 'filo_login_not_confirmed' : 'filo_login_failed');
  return { apiOk, authenticatedRoute: safeUrlPath(page.url()) };
}

async function inspectForm(page) {
  const data = await page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const text = el => String(
      el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('name') || el.innerText || el.getAttribute('value') || ''
    ).trim().replace(/\s+/g, ' ').slice(0, 100);
    const controls = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"], button, [role="button"], label')]
      .filter(visible).slice(0, 180).map(el => {
        const tag = el.tagName.toLowerCase();
        const type = String(el.getAttribute('type') || '').toLowerCase();
        const value = tag === 'select'
          ? (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent : '')
          : (tag === 'input' || tag === 'textarea' ? el.value : (el.isContentEditable ? el.innerText : ''));
        const options = tag === 'select'
          ? [...el.options].slice(0, 80).map(option => ({
              text: String(option.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
              selected: Boolean(option.selected),
              valuePresent: Boolean(option.value)
            }))
          : [];
        return {
          tag, type, id: el.id || '', name: el.getAttribute('name') || '',
          label: text(el), visible: visible(el), required: Boolean(el.required),
          disabled: Boolean(el.disabled), valuePresent: Boolean(String(value || '').trim()),
          valueLength: String(value || '').length, optionCount: options.length, options
        };
      });
    const headings = [...document.querySelectorAll('h1,h2,h3')]
      .filter(visible).map(el => String(el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160)).slice(0, 12);
    const buttons = [...document.querySelectorAll('button, input[type="submit"], [role="button"], a')]
      .filter(visible).map(el => ({
        label: text(el),
        tag: el.tagName.toLowerCase(),
        type: String(el.getAttribute('type') || '').toLowerCase(),
        disabled: Boolean(el.disabled),
        hrefPath: (() => { try { return new URL(el.href, location.href).pathname; } catch { return ''; } })()
      })).filter(x => x.label || /publish|submit|republish|انتشار|بازنشر|فعلا|فعلاً|ذخیره|پیش.?نویس/i.test(x.hrefPath)).slice(0, 80);
    const forms = [...document.querySelectorAll('form')].slice(0, 10).map(form => ({
      actionPath: (() => { try { return new URL(form.action, location.href).pathname; } catch { return ''; } })(),
      method: String(form.method || 'get').toLowerCase(),
      controlCount: form.querySelectorAll('input,textarea,select,button').length
    }));
    return {
      title: document.title.slice(0, 160),
      headings,
      controls,
      buttons,
      forms,
      bodyIncludesDraftChoice: /فعلاً ویدیو منتشر نشه|فعلا ویدیو منتشر نشه|ذخیره پیش.?نویس/i.test(document.body.innerText),
      bodyIncludesPublishText: /انتشار ویدیو|انتشار ویدئو/i.test(document.body.innerText),
      bodyHasLoginPrompt: /اول باید به حساب کاربریت ورود کنی|ورود به فیلو|ورود به حساب/i.test(document.body.innerText)
    };
  });

  const fields = data.controls.filter(x =>
    /عنوان|title|توضیح|شرح|description|دسته|category|tag|زیرنویس|subtitle|تصویر|cover|thumbnail/i.test(
      [x.id, x.name, x.label].join(' ')
    ));
  const titleField = fields.find(x => /title|عنوان/i.test([x.id, x.name, x.label].join(' ')));
  const descriptionField = fields.find(x => /description|توضیح|شرح/i.test([x.id, x.name, x.label].join(' ')));
  const categories = fields.filter(x => /category|دسته/i.test([x.id, x.name, x.label].join(' ')));

  return {
    pagePath: safeUrlPath(page.url()),
    pageTitle: data.title,
    headings: data.headings,
    fields,
    titlePrefilled: Boolean(titleField && titleField.valuePresent),
    descriptionPrefilled: Boolean(descriptionField && descriptionField.valuePresent),
    categoryControlCount: categories.length,
    categoryOptionCount: categories.reduce((sum, x) => sum + (x.optionCount || 0), 0),
    nativeSelects: data.controls.filter(x => x.tag === 'select'),
    buttons: data.buttons,
    forms: data.forms,
    hasDraftChoice: data.bodyIncludesDraftChoice,
    hasPublishControl: data.bodyIncludesPublishText,
    loginPrompt: data.bodyHasLoginPrompt
  };
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const report = {
    status: 'started',
    targetPath: safeUrlPath(TARGET_URL),
    createdAt: new Date().toISOString(),
    publicationAttempted: false,
    repostSubmitted: false
  };
  let browser;
  try {
    if (!/^https:\/\/(?:www\.)?ifilo\.net\/republish\/[A-Za-z0-9_-]+(?:[?#].*)?$/i.test(TARGET_URL)) {
      throw new Error('target_must_be_a_filo_republish_form_url');
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'fa-IR',
      viewport: { width: 1365, height: 1000 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129 Safari/537.36'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);

    report.login = await login(page);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    if (safeUrlPath(page.url()) === '/login') throw new Error('repost_form_redirected_to_login');
    report.form = await inspectForm(page);

    const titleText = (report.form.headings || []).join(' ');
    report.sourceLooksLikeMusic = /پیانو|آهنگ|موسیقی|خواننده|شادمهر|ابی/i.test(titleText);
    report.status = report.form.titlePrefilled && report.form.descriptionPrefilled
      ? 'authenticated_repost_form_inspected_prefilled'
      : 'authenticated_repost_form_inspected';
    report.note = 'Inspection-only run. No form field was changed and no repost or publication control was clicked.';
  } catch (error) {
    report.status = 'probe_failed';
    report.error = String(error && error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 220);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('FILO_REPOST_PROBE ' + JSON.stringify(report));
  }
  if (report.status === 'probe_failed') process.exitCode = 1;
})();
