const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const NOW = new Date();
const STATE_PATH = path.join('state', 'platform-trends.json');
const OUT_PATH = path.join('out', 'platform-candidates.json');
const MD_PATH = path.join('out', 'platform-candidates.md');

const TELEGRAM_SOURCES = [
  { key: 'dmcam', url: 'https://t.me/s/dmcam', label: 'دوربین مخفی', kind: 'hidden-camera' },
  { key: 'doorbin_makhfy', url: 'https://t.me/s/doorbin_makhfy', label: 'دوربین مخفی ایرانی', kind: 'hidden-camera' },
  { key: 'khandbazar20', url: 'https://t.me/s/khandbazar20', label: 'خنده بازار', kind: 'persian-comedy' },
  { key: 'fun_land12', url: 'https://t.me/s/Fun_land12', label: 'لحظات شاد', kind: 'persian-comedy' }
];

const APARAT_SEARCHES = [
  { key: 'hidden-camera', query: 'دوربین مخفی' },
  { key: 'funny-clips', query: 'کلیپ خنده دار' },
  { key: 'funny-animals', query: 'حیوانات بامزه' },
  { key: 'dashcam', query: 'دوربین مداربسته تصادف' }
];

const YOUTUBE_CC_SEARCHES = [
  { key: 'fa-hidden-camera', query: 'دوربین مخفی' },
  { key: 'fa-funny-clips', query: 'کلیپ خنده دار' },
  { key: 'fa-funny-animals', query: 'حیوانات بامزه' },
  { key: 'fa-strange-moments', query: 'لحظه عجیب دوربین' },
  { key: 'visual-caught-camera', query: 'caught on camera funny moments' },
  { key: 'visual-dashcam', query: 'dashcam near miss caught on camera' },
  { key: 'visual-animals', query: 'funny animals without commentary' },
  { key: 'visual-satisfying', query: 'oddly satisfying no talking' }
];

function normalizeDigits(value) {
  return String(value || '').replace(/[۰-۹٠-٩]/g, d => {
    const fa = '۰۱۲۳۴۵۶۷۸۹';
    const ar = '٠١٢٣٤٥٦٧٨٩';
    if (fa.includes(d)) return String(fa.indexOf(d));
    if (ar.includes(d)) return String(ar.indexOf(d));
    return d;
  });
}

function norm(value) {
  return normalizeDigits(value).replace(/\s+/g, ' ').trim();
}

function parseCount(value, allowBare = false) {
  const text = norm(value).toLowerCase().replace(/,/g, '');
  const re = allowBare
    ? /(\d+(?:\.\d+)?)\s*(k|m|b|هزار|میلیون|میلیارد)?/i
    : /(\d+(?:\.\d+)?)\s*(k|m|b|هزار|میلیون|میلیارد)?\s*(?=بازدید|views?|view|مشاهده)/i;
  const match = text.match(re);
  if (!match) return null;
  let number = Number(match[1]);
  const unit = String(match[2] || '').toLowerCase();
  if (!Number.isFinite(number)) return null;
  if (unit === 'k' || unit === 'هزار') number *= 1_000;
  else if (unit === 'm' || unit === 'میلیون') number *= 1_000_000;
  else if (unit === 'b' || unit === 'میلیارد') number *= 1_000_000_000;
  return Math.round(number);
}

function ageHours(postedAt, text) {
  if (postedAt) {
    const parsed = Date.parse(postedAt);
    if (Number.isFinite(parsed)) return Math.max(1 / 60, (NOW.getTime() - parsed) / 3600000);
  }
  const t = norm(text).toLowerCase();
  const patterns = [
    [/(?:حدود\s*)?(\d+)\s*دقیقه\s*(?:پیش|قبل)/, 1 / 60],
    [/(\d+)\s*ساعت\s*(?:پیش|قبل)/, 1],
    [/(\d+)\s*روز\s*(?:پیش|قبل)/, 24],
    [/(\d+)\s*هفته\s*(?:پیش|قبل)/, 168],
    [/(\d+)\s*ماه\s*(?:پیش|قبل)/, 730],
    [/(\d+)\s*سال\s*(?:پیش|قبل)/, 8760],
    [/(\d+)\s*hours?\s*ago/i, 1],
    [/(\d+)\s*days?\s*ago/i, 24],
    [/(\d+)\s*weeks?\s*ago/i, 168]
  ];
  for (const [re, multiplier] of patterns) {
    const match = t.match(re);
    if (match) return Math.max(1 / 60, Number(match[1]) * multiplier);
  }
  if (t.includes('دیروز') || t.includes('yesterday')) return 24;
  if (t.includes('امروز') || t.includes('today')) return 1;
  return null;
}

function classifyFormat(title, description = '') {
  const text = (String(title || '') + ' ' + String(description || '')).toLowerCase();
  const visual = /cctv|dashcam|دوربین مداربسته|دوربین ماشین|دوربین خودرو|تسلا|تصادف عجیب|لحظه برخورد|حیوانات بامزه|حیوان بامزه|گربه|سگ بامزه|oddly satisfying|without talking|no talking|wordless|nonverbal|visual comedy|instant karma|caught on camera|unexpected moments|funny animals|animal fails|optical illusion|magic trick/i;
  if (visual.test(text)) {
    return { fit: 'language_neutral_candidate', reason: 'Visual-first/camera/animal signal; speech and rights still require review' };
  }
  if (/[پچژگکی]/.test(text) || /طنز|خنده|دوربین مخفی|شکار لحظه|سوتی|کلیپ|چالش|فان|بامزه|غافلگیر|اتفاق عجیب|ویدیو/.test(text)) {
    return { fit: 'persian_priority', reason: 'Persian-script or Persian entertainment signal' };
  }
  return { fit: 'language_check_required', reason: 'No reliable language-neutral signal in public metadata' };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { updated_at: null, telegram: {}, aparat: {}, youtube_cc: {} };
  }
}

function scoreCandidate(item, oldMap) {
  const old = oldMap[item.id] || {};
  let delta = null;
  let rate = null;
  let elapsed = null;
  if (Number.isFinite(item.views) && Number.isFinite(old.last_views) && old.last_seen_at) {
    elapsed = Math.max(0, (NOW.getTime() - Date.parse(old.last_seen_at)) / 3600000);
    if (elapsed >= 1.5 && item.views >= old.last_views) {
      delta = item.views - old.last_views;
      rate = Math.round((delta / elapsed) * 10) / 10;
    }
  }
  const age = ageHours(item.posted_at, item.age_text);
  const fit = classifyFormat(item.title, item.description);
  item.age_hours = age === null ? null : Math.round(age * 100) / 100;
  item.views_per_hour_proxy = item.views !== null && age && age > 0
    ? Math.round(item.views / age * 10) / 10
    : null;
  item.observed_view_delta = delta;
  item.observed_views_per_hour = rate;
  item.format_fit = fit.fit;
  item.format_reason = fit.reason;
  item.license_status = 'not_verified; lead_only';
  return item;
}

function sortCandidates(items) {
  return items.sort((a, b) => {
    const as = a.observed_views_per_hour !== null && a.observed_views_per_hour >= 100;
    const bs = b.observed_views_per_hour !== null && b.observed_views_per_hour >= 100;
    if (as !== bs) return Number(bs) - Number(as);
    if (as && bs && a.observed_views_per_hour !== b.observed_views_per_hour) {
      return b.observed_views_per_hour - a.observed_views_per_hour;
    }
    const freshA = a.age_hours !== null && a.age_hours <= 48 ? 2 : a.age_hours !== null && a.age_hours <= 168 ? 1 : 0;
    const freshB = b.age_hours !== null && b.age_hours <= 48 ? 2 : b.age_hours !== null && b.age_hours <= 168 ? 1 : 0;
    if (freshA !== freshB) return freshB - freshA;
    const fitA = a.format_fit === 'persian_priority' ? 2 : a.format_fit === 'language_neutral_candidate' ? 1 : 0;
    const fitB = b.format_fit === 'persian_priority' ? 2 : b.format_fit === 'language_neutral_candidate' ? 1 : 0;
    if (fitA !== fitB) return fitB - fitA;
    return (b.views_per_hour_proxy || -1) - (a.views_per_hour_proxy || -1);
  });
}

async function scrapeTelegram(browser, source) {
  const page = await browser.newPage({ locale: 'fa-IR' });
  page.setDefaultTimeout(9000);
  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('.tgme_widget_message_wrap', { timeout: 9000 }).catch(() => {});
    await page.waitForTimeout(400);
    const messages = await page.evaluate(() => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('.tgme_widget_message_wrap')].map(wrap => {
        const message = wrap.querySelector('.tgme_widget_message');
        if (!message) return null;
        const dataPost = message.getAttribute('data-post') || '';
        const dateAnchor = message.querySelector('a.tgme_widget_message_date');
        const postUrl = dateAnchor ? dateAnchor.href.split('?')[0] : (dataPost ? 'https://t.me/' + dataPost : '');
        const textNode = message.querySelector('.tgme_widget_message_text');
        const description = clean(textNode ? textNode.innerText : '');
        const videoNode = message.querySelector('video, .tgme_widget_message_video, .tgme_widget_message_video_wrap, .tgme_widget_message_roundvideo');
        if (!videoNode) return null;
        const viewsNode = message.querySelector('.tgme_widget_message_views');
        const timeNode = message.querySelector('time[datetime]');
        const title = description.split(/\n/).map(clean).find(x => x && !/^@\w+/.test(x)) || '';
        return {
          postUrl,
          postId: dataPost || postUrl,
          title: title.slice(0, 180),
          description: description.slice(0, 500),
          viewsText: clean(viewsNode ? viewsNode.innerText : ''),
          postedAt: timeNode ? timeNode.getAttribute('datetime') : null,
          durationText: clean((message.querySelector('.tgme_widget_message_video_duration') || {}).innerText || '')
        };
      }).filter(x => x && x.postUrl && x.title);
    });
    return {
      status: 'ok',
      source: source.key,
      label: source.label,
      url: source.url,
      candidates: messages.map(m => ({
        id: 'telegram:' + m.postId,
        source_platform: 'telegram',
        source_channel: source.key,
        source_page: source.url,
        source_url: m.postUrl,
        title: m.title,
        description: m.description,
        views: parseCount(m.viewsText, true),
        views_text: m.viewsText,
        posted_at: m.postedAt,
        age_text: '',
        duration_text: m.durationText,
        media_type: 'video',
        license_status: 'not_verified; lead_only'
      }))
    };
  } catch (e) {
    return { status: 'error', source: source.key, url: source.url, error_kind: String(e && e.name || 'Error').slice(0, 60), candidates: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeAparat(browser, search) {
  const page = await browser.newPage({ locale: 'fa-IR' });
  page.setDefaultTimeout(9000);
  const url = 'https://www.aparat.com/result/' + encodeURIComponent(search.query);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
    await page.waitForSelector('a[href*="/v/"]', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);
    const cards = await page.evaluate(() => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const anchors = [...document.querySelectorAll('a[href*="/v/"]')];
      const seen = new Set();
      const output = [];
      for (const a of anchors) {
        let url;
        try { url = new URL(a.getAttribute('href'), location.origin); } catch { continue; }
        if (!/^\/v\/[a-z0-9]+/i.test(url.pathname)) continue;
        url.search = '';
        const canonical = url.href;
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const card = a.closest('article, li, [class*="video"], [class*="Video"], [data-testid*="video"]') || a.parentElement?.parentElement || a;
        const cardText = clean(card.innerText || a.innerText || '');
        const image = a.querySelector('img') || card.querySelector('img');
        const title = clean(a.getAttribute('title') || a.getAttribute('aria-label') || (image && image.alt) || a.innerText || '');
        if (!title || title.length < 3) continue;
        const timeNode = card.querySelector('time[datetime]');
        const viewMatch = cardText.match(/[\d۰-۹٠-٩,.]+\s*(?:k|m|هزار|میلیون|میلیارد)?\s*(?:بازدید|views?|مشاهده)/i);
        const ageMatch = cardText.match(/(?:\d+|[۰-۹٠-٩]+)\s*(?:دقیقه|ساعت|روز|هفته|ماه)\s*(?:پیش|قبل)/);
        output.push({
          url: canonical,
          title: title.slice(0, 180),
          cardText: cardText.slice(0, 500),
          viewsText: viewMatch ? viewMatch[0] : '',
          ageText: ageMatch ? ageMatch[0] : '',
          postedAt: timeNode ? timeNode.getAttribute('datetime') : null,
          thumbnail: image ? (image.getAttribute('src') || image.getAttribute('data-src') || '') : ''
        });
        if (output.length >= 60) break;
      }
      return { title: document.title, url: location.href, cards: output };
    });
    return {
      status: cards.cards.length ? 'ok' : 'no_cards',
      source: 'aparat:' + search.key,
      label: 'آپارات · ' + search.query,
      url,
      http_status: response && response.status() || null,
      candidates: cards.cards.map(item => ({
        id: 'aparat:' + item.url.split('/v/')[1],
        source_platform: 'aparat',
        source_channel: search.key,
        source_page: url,
        source_url: item.url,
        title: item.title,
        description: item.cardText,
        views: parseCount(item.viewsText, false),
        views_text: item.viewsText,
        posted_at: item.postedAt,
        age_text: item.ageText,
        thumbnail: item.thumbnail,
        media_type: 'video',
        license_status: 'not_verified; lead_only'
      })),
      page_title: cards.title
    };
  } catch (e) {
    return { status: 'error', source: 'aparat:' + search.key, label: search.query, url, error_kind: String(e && e.name || 'Error').slice(0, 60), candidates: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeYouTubeCreativeCommons(browser, search) {
  const page = await browser.newPage({ locale: 'fa-IR' });
  page.setDefaultTimeout(9000);
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', search.query);
  // YouTube's public search filter for Creative Commons. This is only a signal to review,
  // not proof that every component of a video is cleared for commercial reuse.
  url.searchParams.set('sp', 'EgIwAQ==');
  try {
    const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
    await page.waitForSelector('ytd-video-renderer, ytd-rich-item-renderer', { timeout: 9000 }).catch(() => {});
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const nodes = [...document.querySelectorAll('ytd-video-renderer, ytd-rich-item-renderer')];
      const seen = new Set();
      const candidates = [];
      for (const node of nodes) {
        const anchor = node.querySelector('a#video-title[href], a#video-title-link[href], a[href*="/watch?v="], a[href*="/shorts/"]');
        if (!anchor) continue;
        let href;
        try { href = new URL(anchor.getAttribute('href'), location.origin); } catch { continue; }
        const id = href.searchParams.get('v') || ((href.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/) || [])[1]);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const title = clean(anchor.getAttribute('title') || anchor.getAttribute('aria-label') || anchor.innerText);
        if (!title) continue;
        const text = clean(node.innerText || '');
        const channelAnchor = node.querySelector('#channel-name a, ytd-channel-name a, a.yt-simple-endpoint[href*="/@"]');
        const metadata = [...node.querySelectorAll('#metadata-line span, ytd-video-meta-block span')].map(el => clean(el.innerText)).filter(Boolean);
        const durationNode = node.querySelector('ytd-thumbnail-overlay-time-status-renderer, .ytd-thumbnail-overlay-time-status-renderer');
        const durationText = clean(durationNode ? durationNode.innerText : '');
        const descriptionNode = node.querySelector('#description-text, .metadata-snippet-text, yt-formatted-string#description-text');
        const a = new URL('https://www.youtube.com/watch');
        a.searchParams.set('v', id);
        candidates.push({
          video_id: id,
          title: title.slice(0, 180),
          url: a.toString(),
          channel: clean(channelAnchor ? channelAnchor.innerText : ''),
          card_text: text.slice(0, 700),
          description: clean(descriptionNode ? descriptionNode.innerText : '').slice(0, 400),
          metadata,
          duration_text: durationText,
          is_short: href.pathname.startsWith('/shorts/'),
        });
        if (candidates.length >= 30) break;
      }
      return { pageTitle: document.title, candidates };
    });
    return {
      status: result.candidates.length ? 'ok' : 'no_cards',
      source: 'youtube_cc:' + search.key,
      label: search.query,
      url: url.toString(),
      http_status: response && response.status() || null,
      candidates: result.candidates.map(item => ({
        id: 'youtube_cc:' + item.video_id,
        video_id: item.video_id,
        source_platform: 'youtube_cc',
        source_channel: search.key,
        source_page: url.toString(),
        source_url: item.url,
        title: item.title,
        description: item.description,
        views: parseCount(item.card_text, false),
        views_text: item.metadata.join(' · '),
        posted_at: null,
        age_text: item.metadata.find(x => /ago|پیش|قبل|day|hour|week|month/i.test(x)) || '',
        duration_text: item.duration_text,
        is_short: item.is_short,
        media_type: 'video',
        cc_search_filter: true,
        license_status: 'cc_search_filter_signal_only'
      }))
    };
  } catch (e) {
    return { status: 'error', source: 'youtube_cc:' + search.key, label: search.query, url: url.toString(), error_kind: String(e && e.name || 'Error').slice(0, 60), candidates: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  fs.mkdirSync('out', { recursive: true });
  fs.mkdirSync('state', { recursive: true });
  const state = loadState();
  state.telegram ||= {};
  state.aparat ||= {};
  state.youtube_cc ||= {};

  const browser = await chromium.launch({ headless: true });
  const pages = await Promise.all([
    ...TELEGRAM_SOURCES.map(source => scrapeTelegram(browser, source)),
    ...APARAT_SEARCHES.map(search => scrapeAparat(browser, search)),
    ...YOUTUBE_CC_SEARCHES.map(search => scrapeYouTubeCreativeCommons(browser, search))
  ]);
  await browser.close();

  const all = [];
  const sourceResults = [];
  const errors = [];
  for (const page of pages) {
    sourceResults.push({
      source: page.source, status: page.status, url: page.url,
      count: (page.candidates || []).length, http_status: page.http_status,
      error_kind: page.error_kind || null
    });
    if (page.status !== 'ok') {
      if (page.status === 'error' || page.status === 'no_cards') errors.push({
        source: page.source, error: page.error_kind || 'No public video cards detected'
      });
    }
    for (const item of (page.candidates || [])) {
      if (!item.title || !item.source_url) continue;
      const oldMap = item.source_platform === 'telegram' ? state.telegram : item.source_platform === 'youtube_cc' ? state.youtube_cc : state.aparat;
      const scored = scoreCandidate(item, oldMap);
      const age = scored.age_hours;
      if (age !== null && age > 720) continue;
      if (/جنگ|سیاست|سیاسی|انتخابات|قومیت|نژاد|خامنه|ترور|اعدام|قتل|اسلحه|سلاح|اختلاس|فساد|انقلاب/.test(scored.title)) continue;
      all.push(scored);
      const previous = oldMap[item.id] || {};
      const history = Array.isArray(previous.history) ? previous.history : [];
      if (Number.isFinite(item.views)) {
        history.push({ at: NOW.toISOString(), views: item.views });
        const newBaseline = scored.observed_views_per_hour !== null || !Number.isFinite(previous.last_views);
        oldMap[item.id] = {
          first_seen_at: previous.first_seen_at || NOW.toISOString(),
          last_seen_at: newBaseline ? NOW.toISOString() : (previous.last_seen_at || NOW.toISOString()),
          last_views: newBaseline ? item.views : previous.last_views,
          title: scored.title,
          source_url: item.source_url,
          history: history.slice(-8)
        };
      } else if (!previous.first_seen_at) {
        oldMap[item.id] = { first_seen_at: NOW.toISOString(), last_seen_at: NOW.toISOString(), title: scored.title, source_url: item.source_url, history: [] };
      }
    }
  }

  const telegram = sortCandidates(all.filter(x => x.source_platform === 'telegram')).slice(0, 80);
  const aparat = sortCandidates(all.filter(x => x.source_platform === 'aparat')).slice(0, 80);
  const youtubeCc = sortCandidates(all.filter(x => x.source_platform === 'youtube_cc')).slice(0, 100);
  state.updated_at = NOW.toISOString();
  for (const name of ['telegram', 'aparat', 'youtube_cc']) {
    const entries = Object.entries(state[name] || {}).sort((a,b) => (b[1].last_seen_at || '').localeCompare(a[1].last_seen_at || ''));
    state[name] = Object.fromEntries(entries.slice(0, 1500));
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');

  const report = {
    generated_at: NOW.toISOString(),
    note: 'Public Telegram and Aparat metadata only. No media downloaded or uploaded. Public availability and view counts do not grant redistribution rights.',
    source_results: sourceResults,
    source_errors: errors,
    telegram_count: telegram.length,
    aparat_count: aparat.length,
    youtube_cc_count: youtubeCc.length,
    candidates: [...telegram, ...aparat, ...youtubeCc]
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), 'utf8');

  const lines = [
    '# Additional public video leads', '',
    'Generated: ' + NOW.toISOString(), '',
    '**No media was downloaded or uploaded.** All rights remain unverified.', '',
    '## Source coverage', '',
    '| Platform/source | Status | Video leads |', '|---|---|---:|'
  ];
  for (const source of sourceResults) {
    lines.push('| ' + source.source + ' | ' + source.status + (source.http_status ? ' (HTTP ' + source.http_status + ')' : '') + (source.error_kind ? ' — ' + source.error_kind : '') + ' | ' + source.count + ' |');
  }
  for (const [title, list] of [['Telegram', telegram], ['Aparat', aparat], ['YouTube Creative Commons search-filter leads', youtubeCc]]) {
    lines.push('', '## ' + title, '', '| Rank | Title | Views | Age (h) | Observed growth/h | Format | Source |', '|---:|---|---:|---:|---:|---|---|');
    for (const [index, item] of list.slice(0, 40).entries()) {
      const views = Number.isFinite(item.views) ? item.views.toLocaleString('en-US') : '—';
      const age = item.age_hours === null ? '—' : item.age_hours;
      const growth = item.observed_views_per_hour === null ? '—' : item.observed_views_per_hour;
      const label = String(item.title || '').replace(/[|\n]/g, ' ').slice(0, 130);
      lines.push('| ' + (index + 1) + ' | [' + label + '](' + item.source_url + ') | ' + views + ' | ' + age + ' | ' + growth + ' | ' + item.format_fit + ' | ' + item.source_channel + ' |');
    }
  }
  fs.writeFileSync(MD_PATH, lines.join('\n') + '\n', 'utf8');

  console.log('PLATFORM_SOURCE_RESULTS', JSON.stringify(sourceResults));
  console.log('PLATFORM_CANDIDATE_SUMMARY', JSON.stringify({
    telegram: telegram.length,
    aparat: aparat.length,
    youtube_cc: youtubeCc.length,
    cc_search_filter_signals: youtubeCc.length,
    source_errors: errors.length,
    language_neutral: all.filter(x => x.format_fit === 'language_neutral_candidate').length,
    persian_priority: all.filter(x => x.format_fit === 'persian_priority').length
  }));
  for (const item of sortCandidates(all).slice(0, 20)) {
    console.log('PLATFORM_LEAD', JSON.stringify({
      title: item.title, source_platform: item.source_platform, source_url: item.source_url,
      views: item.views, age_hours: item.age_hours, observed_views_per_hour: item.observed_views_per_hour,
      views_per_hour_proxy: item.views_per_hour_proxy, format_fit: item.format_fit,
      license_status: item.license_status
    }));
  }
}

main().catch(error => {
  console.error('PLATFORM_SCOUT_FAILED', String(error && error.name || 'Error').slice(0, 60));
  process.exit(1);
});
