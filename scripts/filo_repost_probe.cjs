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

  // The SSR form can be replaced during client hydration. Wait for the app to settle
  // before entering credentials so Vue hydration cannot erase them mid-fill.
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(2500);
  await password.waitFor({ state: 'visible', timeout: 10000 });

  const usernameSelectors = [
    'input[autocomplete="username"]', 'input[type="tel"]',
    'input[name*="phone" i]', 'input[name*="mobile" i]',
    'input[placeholder*="شماره"]', 'input[placeholder*="موبایل"]',
    'input[placeholder*="ایمیل"]', 'input[type="email"]',
    'input[name*="user" i]', 'input[name*="email" i]', 'input[type="text"]'
  ];
  const username = await visibleFirst(page, usernameSelectors);
  if (!username) throw new Error('filo_username_field_not_found');

  const inputDiagnostics = {
    usernameSecretLength: String(process.env.FILO_USER || '').length,
    passwordSecretLength: String(process.env.FILO_PASS || '').length,
    waitedForHydration: true
  };
  await username.fill(process.env.FILO_USER);
  inputDiagnostics.usernameAfterFill = (await username.inputValue().catch(() => '')).length;
  await password.fill(process.env.FILO_PASS);
  inputDiagnostics.usernameAfterPasswordFill = (await username.inputValue().catch(() => '')).length;
  inputDiagnostics.passwordAfterFill = (await password.inputValue().catch(() => '')).length;
  await sleep(700);
  inputDiagnostics.usernameAfterHydrationSettle = (await username.inputValue().catch(() => '')).length;
  inputDiagnostics.passwordAfterHydrationSettle = (await password.inputValue().catch(() => '')).length;
  await username.press('Tab').catch(() => {});
  await password.press('Tab').catch(() => {});

  const submit = await visibleFirst(page, ['button[type="submit"]', 'input[type="submit"]']);
  if (!submit) throw new Error('filo_login_submit_not_found');
  let submitEnabled = await submit.isEnabled().catch(() => false);
  if (!submitEnabled) {
    await sleep(80);
    inputDiagnostics.usernameAfterShortWait = (await username.inputValue().catch(() => '')).length;
    inputDiagnostics.passwordAfterShortWait = (await password.inputValue().catch(() => '')).length;
    submitEnabled = await submit.isEnabled().catch(() => false);
  }
  if (!submitEnabled) {
    await sleep(150);
    inputDiagnostics.usernameAfterRetryWait = (await username.inputValue().catch(() => '')).length;
    inputDiagnostics.passwordAfterRetryWait = (await password.inputValue().catch(() => '')).length;
    submitEnabled = await submit.isEnabled().catch(() => false);
  }
  if (!submitEnabled) {
    const diagnostics = await page.evaluate(() => {
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const inputs = [...document.querySelectorAll('input')].filter(isVisible).slice(0, 20).map(el => ({
        type: String(el.type || '').toLowerCase(),
        id: el.id || '',
        name: el.name || '',
        placeholder: el.getAttribute('placeholder') || '',
        required: Boolean(el.required),
        minLength: el.minLength,
        maxLength: el.maxLength,
        valueLength: String(el.value || '').length,
        valid: el.checkValidity(),
        validationMessage: String(el.validationMessage || '').slice(0, 100),
        className: String(el.className || '').slice(0, 100)
      }));
      const form = document.querySelector('input[type="password"]')?.form ||
        document.querySelector('button[type="submit"]')?.form || null;
      const button = document.querySelector('button[type="submit"], input[type="submit"]');
      return {
        inputs,
        formPresent: Boolean(form),
        formValid: form ? form.checkValidity() : null,
        submitDisabled: button ? Boolean(button.disabled) : null,
        submitClassName: button ? String(button.className || '').slice(0, 120) : '',
        visibleText: String(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 900)
      };
    }).catch(() => ({}));
    throw new Error('filo_login_submit_stayed_disabled:' + JSON.stringify({inputDiagnostics, diagnostics}).slice(0, 1500));
  }

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
    const allInputs = [...document.querySelectorAll('input')].slice(0, 80).map(el => ({
      type: String(el.type || '').toLowerCase(),
      id: el.id || '',
      name: el.name || '',
      placeholder: el.getAttribute('placeholder') || '',
      required: Boolean(el.required),
      visible: visible(el),
      disabled: Boolean(el.disabled),
      checked: typeof el.checked === 'boolean' ? Boolean(el.checked) : null,
      accept: el.getAttribute('accept') || '',
      labelText: el.labels ? [...el.labels].map(label => String(label.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120)) : [],
      parentText: el.type === 'checkbox' ? String(el.parentElement && el.parentElement.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 180) : ''
    }));
    const scriptPaths = [...document.querySelectorAll('script[src]')].map(el => {
      try { return new URL(el.src, location.href).pathname; } catch { return ''; }
    }).filter(Boolean).slice(0, 80);
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
      allInputs,
      scriptPaths,
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
    allInputs: data.allInputs,
    scriptPaths: data.scriptPaths,
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

    const apiTraffic = [];
    page.on('request', request => {
      try {
        const u = new URL(request.url());
        if (u.hostname === 'ifilo.net' && (u.pathname.startsWith('/api/') || u.pathname.includes('republish'))) {
          apiTraffic.push({ kind: 'request', method: request.method(), path: u.pathname, resourceType: request.resourceType() });
        }
      } catch {}
    });
    let repostSourceData = null;
    page.on('response', async response => {
      try {
        const u = new URL(response.url());
        if (u.hostname === 'ifilo.net' && (u.pathname.startsWith('/api/') || u.pathname.includes('republish'))) {
          apiTraffic.push({ kind: 'response', method: response.request().method(), path: u.pathname, status: response.status() });
          if (u.pathname.startsWith('/api/v1/republish/')) {
            const body = await response.json().catch(() => null);
            if (body && typeof body === 'object') {
              const root = body.data && typeof body.data === 'object' ? body.data :
                body.r && typeof body.r === 'object' ? body.r : body;
              const safe = {};
              for (const key of ['status','status_code','title','description','videoTitle','videoDescription','videoId','video_code','id','server_id','category_id','views','view_count','visit_count','play_count','share_count','duration','width','height','has_audio','can_make_money','allow_public_display','can_republish','is_publish_able','active','status_id','republish_from','file_deleted','only_in_filo','chosen','category','categoryName','playlistId','createdAt','thumbnail','image','sourceUrl','url']) {
                if (Object.prototype.hasOwnProperty.call(root, key) && (root[key] === null || ['string','number','boolean'].includes(typeof root[key]))) {
                  safe[key] = typeof root[key] === 'string' ? root[key].slice(0, 300) : root[key];
                }
              }
              safe.rootKeys = Object.keys(root).slice(0, 100);
              if (root.all_categories && typeof root.all_categories === 'object' && !Array.isArray(root.all_categories)) {
                safe.all_categories = Object.entries(root.all_categories).slice(0, 80).map(([id, item]) => {
                  if (item && typeof item === 'object') {
                    const fields = {};
                    for (const key of ['id','code','name','title','description','slug','url','parent_id','parentId','type']) {
                      if (Object.prototype.hasOwnProperty.call(item, key) && (item[key] === null || ['string','number','boolean'].includes(typeof item[key]))) {
                        fields[key] = typeof item[key] === 'string' ? item[key].slice(0, 180) : item[key];
                      }
                    }
                    return { id, keys: Object.keys(item).slice(0, 40), fields };
                  }
                  return { id, value: typeof item === 'string' ? item.slice(0, 180) : item };
                });
              }
              for (const key of ['republish_video','republish_video_category','republish_video_code','server_id','upload_domain','file_domain','unix_time','accept_rule','is_republish','limited_minutes','important_messages']) {
                const value = root[key];
                if (Array.isArray(value)) {
                  safe[key] = {
                    type: 'array',
                    length: value.length,
                    sample: value.slice(0, 20).map(item => {
                      if (item && typeof item === 'object') {
                        const out = {};
                        for (const k of ['id','code','name','title','description','label','url','category','type']) {
                          if (Object.prototype.hasOwnProperty.call(item, k) && (item[k] === null || ['string','number','boolean'].includes(typeof item[k]))) {
                            out[k] = typeof item[k] === 'string' ? item[k].slice(0, 180) : item[k];
                          }
                        }
                        return { keys: Object.keys(item).slice(0, 30), fields: out };
                      }
                      return typeof item === 'string' ? item.slice(0, 180) : item;
                    })
                  };
                } else if (value && typeof value === 'object') {
                  const out = {};
                  for (const k of ['id','code','name','title','description','label','url','category','type','views','duration','video_code','user_id','server_id','category_id','visit_count','play_count']) {
                    if (Object.prototype.hasOwnProperty.call(value, k) && (value[k] === null || ['string','number','boolean'].includes(typeof value[k]))) {
                      out[k] = typeof value[k] === 'string' ? value[k].slice(0, 180) : value[k];
                    }
                  }
                  safe[key] = { keys: Object.keys(value).slice(0, 40), fields: out };
                } else if (value !== undefined) {
                  safe[key] = typeof value === 'string' ? value.slice(0, 300) : value;
                }
              }
              for (const childKey of ['video','user','author','owner','item']) {
                const child = root[childKey];
                if (child && typeof child === 'object' && !Array.isArray(child)) {
                  safe[childKey + 'Keys'] = Object.keys(child).slice(0, 60);
                  const childSafe = {};
                  for (const key of ['title','description','name','views','viewCount','duration','thumbnail','url','createdAt']) {
                    if (Object.prototype.hasOwnProperty.call(child, key) && (child[key] === null || ['string','number','boolean'].includes(typeof child[key]))) {
                      childSafe[key] = typeof child[key] === 'string' ? child[key].slice(0, 300) : child[key];
                    }
                  }
                  if (Object.keys(childSafe).length) safe[childKey] = childSafe;
                }
              }
              repostSourceData = safe;
            }
          }
        }
      } catch {}
    });
    report.login = await login(page);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => {});
    await page.waitForTimeout(3200);
    if (safeUrlPath(page.url()) === '/login') throw new Error('repost_form_redirected_to_login');
    report.form = await inspectForm(page);
    report.apiTraffic = apiTraffic.slice(-80);
    report.repostSourceData = repostSourceData;
    report.categoryDiscoveryProbe = await (async () => {
      const requests = [];
      const responses = [];
      const candidateItems = [];
      const categoryPage = BASE + '/video/category/11';
      page.on('request', request => {
        try {
          const u = new URL(request.url());
          if (u.hostname === 'ifilo.net' && u.pathname.startsWith('/api/v1/video/category/')) {
            const raw = request.postData() || '';
            requests.push({
              path: u.pathname,
              method: request.method(),
              postData: raw.slice(0, 900)
            });
          }
        } catch {}
      });
      page.on('response', async response => {
        try {
          const u = new URL(response.url());
          if (u.hostname === 'ifilo.net' && u.pathname.startsWith('/api/v1/video/category/')) {
            const body = await response.json().catch(() => null);
            if (body && typeof body === 'object') {
              const arr = Array.isArray(body.l) ? body.l :
                Array.isArray(body.items) ? body.items :
                Array.isArray(body.v) ? body.v : [];
              const pick = item => {
                if (!item || typeof item !== 'object') return item;
                const safe = {};
                for (const key of ['id','i','video_code','videoCode','code','title','visit_count','play_count','views','duration','create_date','create_time','active_datetime','category_id','is_republish','can_make_money','can_republish','is_publish_able','active','status_id','republish_from','has_audio','file_deleted','allow_public_display','only_in_filo','chosen']) {
                  if (Object.prototype.hasOwnProperty.call(item, key) &&
                      (item[key] === null || ['string','number','boolean'].includes(typeof item[key]))) {
                    safe[key] = typeof item[key] === 'string' ? item[key].slice(0, 260) : item[key];
                  }
                }
                safe.keys = Object.keys(item).slice(0, 90);
                return safe;
              };
              for (const item of arr) {
                const rawCode = item && (item.video_code || item.videoCode || item.code);
                if (typeof rawCode === 'string' && /^[A-Za-z0-9_-]{5,40}$/.test(rawCode)) {
                  const safe = pick(item);
                  candidateItems.push(safe);
                }
              }
              responses.push({
                path: u.pathname,
                status: response.status(),
                rootKeys: Object.keys(body).slice(0, 80),
                pageTitle: body.pageTitle || body.page_title || body.t || '',
                itemCount: arr.length,
                items: arr.slice(0, 12).map(pick),
                paging: {
                  p: body.p ?? body.page ?? null,
                  next: body.next ?? null,
                  total: body.total ?? body.count ?? null
                }
              });
            } else {
              responses.push({ path: u.pathname, status: response.status(), json: false });
            }
          }
        } catch {}
      });
      await page.goto(categoryPage, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1600);
      const firstPageVideoLinks = await page.locator('a[href*="/v/"]').evaluateAll(nodes => nodes.slice(0, 40).map(a => ({
        path: (() => { try { return new URL(a.href).pathname; } catch { return ''; } })(),
        title: String(a.innerText || a.getAttribute('title') || a.querySelector('img')?.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ').slice(0, 180),
        cardText: String((a.closest('article,li,[class*="video-item"],[class*="videoItem"],[class*="item"],[class*="card"],[class*="Card"]') || a.parentElement || a).innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 260)
      })));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2200);
      const moreButton = page.locator('button.more-btn, button:has-text("بیشتر")').first();
      if (await moreButton.isVisible().catch(() => false)) {
        await moreButton.click().catch(() => {});
        await page.waitForTimeout(2200);
      }
      const codeSet = new Set(candidateItems.map(item => item.video_code).filter(Boolean));
      for (const item of firstPageVideoLinks) {
        const match = String(item.path || '').match(/^\\/v\\/([A-Za-z0-9_-]+)$/);
        if (match) codeSet.add(match[1]);
      }
      const candidateCodes = [...codeSet].slice(0, 18);
      const candidateChecks = await page.evaluate(async codes => {
        const results = [];
        for (const code of codes) {
          try {
            const response = await fetch('/api/v1/republish/' + encodeURIComponent(code), {
              credentials: 'include',
              headers: { Accept: 'application/json' }
            });
            const payload = await response.json().catch(() => null);
            const root = payload && typeof payload === 'object'
              ? (payload.data && typeof payload.data === 'object' ? payload.data :
                 payload.r && typeof payload.r === 'object' ? payload.r : payload)
              : null;
            const video = root && root.republish_video && typeof root.republish_video === 'object'
              ? root.republish_video : null;
            const safeValue = (obj, keys) => {
              if (!obj) return {};
              const out = {};
              for (const key of keys) {
                const value = obj[key];
                if (value === null || ['string','number','boolean'].includes(typeof value)) {
                  if (value !== undefined) out[key] = typeof value === 'string' ? value.slice(0, 260) : value;
                }
              }
              return out;
            };
            results.push({
              code, httpStatus: response.status(),
              successFlag: payload && typeof payload === 'object' ? Boolean(payload.s) : null,
              errorPresent: Boolean(payload && typeof payload === 'object' && payload.r),
              source: video ? safeValue(video, [
                'id','video_code','title','duration','visit_count','play_count','category_id',
                'server_id','status_id','active','can_republish','is_publish_able',
                'allow_public_display','can_make_money','has_audio','file_deleted',
                'only_in_filo','chosen','republish_from','create_date','create_time'
              ]) : null,
              rootFlags: root ? safeValue(root, [
                'is_republish','republish_video_code','republish_video_category',
                'server_id','limited_minutes','stop_upload','stop_upload_message',
                'accept_rule','block_made_by_me'
              ]) : null,
              rootKeys: root && typeof root === 'object' ? Object.keys(root).slice(0, 60) : []
            });
          } catch (error) {
            results.push({ code, errorKind: String(error && error.name || 'Error').slice(0, 60) });
          }
        }
        return results;
      }, candidateCodes);
      return {
        pagePath: safeUrlPath(page.url()),
        requests: requests.slice(-10),
        responses: responses.slice(-10),
        firstPageVideoLinks: firstPageVideoLinks.slice(0, 20),
        candidateItems: candidateItems.slice(0, 24),
        candidateCodes,
        candidateChecks,
        pageTitle: await page.title().catch(() => '')
      };
    })();
    report.publicBundleInspection = await (async () => {
      const bundlePath = (report.form.scriptPaths || []).find(item => item.startsWith('/assets/index-') && item.endsWith('.js'));
      if (!bundlePath) return { status: 'main_bundle_not_found' };
      try {
        const response = await fetch(new URL(bundlePath, BASE).href, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) return { status: 'bundle_http_' + response.status };
        const source = await response.text();
        const terms = ['/api/v1/republish', '/api/v1/video/publish', 'dontPublish', 'acceptRules', 'canMakeMoney', 'hasComment', 'republish', 'uploadView', 'uploadRepublishView'];
        const snippets = [];
        for (const term of terms) {
          let from = 0;
          for (let hit = 0; hit < 3; hit++) {
            const at = source.indexOf(term, from);
            if (at < 0) break;
            snippets.push({
              term,
              context: source.slice(Math.max(0, at - 260), Math.min(source.length, at + term.length + 360)).replace(/\\s+/g, ' ').slice(0, 700)
            });
            from = at + term.length;
          }
        }
        const uploadComponentAt = source.indexOf('uploadRepublishView');
        const uploadComponentContext = uploadComponentAt >= 0
          ? source.slice(Math.max(0, uploadComponentAt - 1800), Math.min(source.length, uploadComponentAt + 900)).replace(/\\s+/g, ' ').slice(0, 2600)
          : '';
        return { status: 'ok', bundlePath, bytes: source.length, snippets, uploadComponentContext };
      } catch (error) {
        return { status: 'bundle_fetch_failed', errorKind: String(error && error.name || 'Error').slice(0, 60) };
      }
    })();
    report.login.headerShowsSignedIn = await page.locator('a').evaluateAll(links =>
      links.some(a => /خروج|logout|sign.?out/i.test((a.innerText || '') + ' ' + (a.getAttribute('href') || '')))
    ).catch(() => false);

    const titleText = (report.form.headings || []).join(' ');
    report.sourceLooksLikeMusic = /پیانو|آهنگ|موسیقی|خواننده|شادمهر|ابی/i.test(titleText);
    report.status = report.form.titlePrefilled && report.form.descriptionPrefilled
      ? 'authenticated_repost_form_inspected_prefilled'
      : 'authenticated_repost_form_inspected';
    report.note = 'Inspection-only run. No form field was changed and no repost or publication control was clicked.';
  } catch (error) {
    report.status = 'probe_failed';
    report.error = String(error && error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 1600);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('FILO_REPOST_PROBE ' + JSON.stringify(report));
  }
  if (report.status === 'probe_failed') process.exitCode = 1;
})();
