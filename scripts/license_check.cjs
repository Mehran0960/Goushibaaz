const fs = require('fs');
const { chromium } = require('playwright');

const BASE_REPORT = 'out/candidates.json';
const PLATFORM_REPORT = 'out/platform-candidates.json';
const OUTPUT = 'out/license-check.json';
const ALLOWED_METADATA = new Set(['cc_by', 'cc_by_sa', 'public_domain_or_cc0']);

function classifyLicense(value) {
  const v = String(value || '').toLowerCase();
  if (!v) return 'license_not_exposed';
  if (v.includes('public domain') || v === 'cc0' || v === 'cc-zero') return 'public_domain_or_cc0';
  if (v.includes('creative commons') && v.includes('sharealike')) return 'cc_by_sa';
  if (v.includes('creative commons') && (v.includes('attribution') || v.includes('cc by'))) return 'cc_by';
  if (v.includes('cc by-sa')) return 'cc_by_sa';
  if (v.includes('cc by')) return 'cc_by';
  return 'standard_or_other';
}

function videoId(item) {
  if (item.video_id && /^[A-Za-z0-9_-]{11}$/.test(item.video_id)) return item.video_id;
  try {
    const u = new URL(item.youtube_url || item.source_url);
    return u.searchParams.get('v') || ((u.pathname.match(/\/shorts\/([A-Za-z0-9_-]{11})/) || [])[1]) || null;
  } catch {
    return null;
  }
}

function loadCandidates() {
  if (!fs.existsSync(BASE_REPORT)) throw new Error('candidate report missing');
  const base = JSON.parse(fs.readFileSync(BASE_REPORT, 'utf8'));
  const platform = fs.existsSync(PLATFORM_REPORT)
    ? JSON.parse(fs.readFileSync(PLATFORM_REPORT, 'utf8'))
    : { candidates: [] };
  const ccCandidates = (platform.candidates || [])
    .filter(x => x.source_platform === 'youtube_cc' && (x.source_url || x.youtube_url))
    .map(x => ({ ...x, youtube_url: x.source_url || x.youtube_url, cc_search_filter: true }));
  const trendCandidates = (base.candidates || []).filter(x =>
    x.youtube_url && ['persian_priority', 'language_neutral_candidate'].includes(x.format_fit)
  );
  const unique = new Map();
  for (const item of [...ccCandidates, ...trendCandidates]) {
    const id = videoId(item);
    if (id && !unique.has(id)) unique.set(id, { ...item, video_id: id });
  }
  return [...unique.values()].slice(0, 30);
}

async function apiLicenseLookup(ids) {
  const result = new Map();
  if (!process.env.YOUTUBE_API_KEY || !ids.length) return result;
  for (let offset = 0; offset < ids.length; offset += 50) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'status,snippet,statistics');
    url.searchParams.set('id', ids.slice(offset, offset + 50).join(','));
    url.searchParams.set('key', process.env.YOUTUBE_API_KEY);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) continue;
      const body = await response.json();
      for (const video of body.items || []) {
        result.set(video.id, {
          license: video.status && video.status.license || '',
          title: video.snippet && video.snippet.title || '',
          channel: video.snippet && video.snippet.channelTitle || '',
          viewCount: Number(video.statistics && video.statistics.viewCount || 0) || null
        });
      }
    } catch {
      // Do not print API URLs, tokens, or key values. Browser metadata is the fallback.
    }
  }
  return result;
}

async function inspect(browser, item, apiLicenses) {
  const id = item.video_id || videoId(item);
  if (!id) return {
    title: item.title || '',
    url: item.youtube_url || item.source_url || '',
    format_fit: item.format_fit || 'unknown',
    cc_search_filter: Boolean(item.cc_search_filter),
    license_status: 'bad_video_id'
  };

  const watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(id);
  let pageData = {};
  let httpStatus = null;
  let challenge = false;
  const page = await browser.newPage({ locale: 'fa-IR' });
  page.setDefaultNavigationTimeout(20000);
  try {
    const response = await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    httpStatus = response && response.status() || null;
    await page.waitForTimeout(900);
    pageData = await page.evaluate(() => {
      const p = window.ytInitialPlayerResponse || null;
      const d = p && p.videoDetails || {};
      const m = p && p.microformat && p.microformat.playerMicroformatRenderer || {};
      const status = p && p.playabilityStatus && p.playabilityStatus.status || '';
      const title = d.title || document.title || '';
      const text = document.body.innerText.slice(0, 5000);
      return {
        title: title.slice(0, 160),
        channel: (d.author || m.ownerChannelName || '').slice(0, 100),
        viewCount: Number(d.viewCount || 0) || null,
        durationSeconds: Number(d.lengthSeconds || 0) || null,
        license: String(m.license || d.license || '').slice(0, 140),
        playabilityStatus: status,
        challenge: /unusual traffic|not a robot|captcha|sign in to confirm/i.test(text)
      };
    }).catch(() => ({}));
    challenge = Boolean(pageData.challenge);
  } catch {
    pageData = {};
  } finally {
    await page.close().catch(() => {});
  }

  const api = apiLicenses.get(id) || null;
  const apiLicense = api && api.license === 'creativeCommon'
    ? 'Creative Commons Attribution'
    : api && api.license === 'youtube' ? 'YouTube Standard License' : '';
  const licenseValue = apiLicense || pageData.license || '';
  const licenseStatus = challenge && !apiLicense ? 'metadata_blocked_by_challenge' : classifyLicense(licenseValue);

  return {
    video_id: id,
    title: (api && api.title) || pageData.title || item.title || '',
    url: watchUrl,
    source_channel: (api && api.channel) || pageData.channel || item.source_channel || '',
    view_count: (api && api.viewCount) || pageData.viewCount || item.views || null,
    duration_seconds: pageData.durationSeconds || null,
    license: licenseValue,
    license_source: api ? 'YouTube Data API status.license' : 'public watch-page metadata',
    cc_search_filter: Boolean(item.cc_search_filter),
    playability_status: pageData.playabilityStatus || '',
    http_status: httpStatus,
    format_fit: item.format_fit || 'unknown',
    license_status: licenseStatus,
    note: 'A declared license is only an initial signal; verify the uploader controls every component and that the intended commercial reuse is allowed.'
  };
}

async function main() {
  fs.mkdirSync('out', { recursive: true });
  const candidates = loadCandidates();
  const apiLicenses = await apiLicenseLookup(candidates.map(x => x.video_id).filter(Boolean));
  const browser = await chromium.launch({ headless: true });
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const item = candidates[cursor++];
      try {
        results.push(await inspect(browser, item, apiLicenses));
      } catch (error) {
        results.push({
          video_id: item.video_id,
          title: item.title,
          url: item.youtube_url || item.source_url,
          format_fit: item.format_fit,
          cc_search_filter: Boolean(item.cc_search_filter),
          license_status: 'metadata_unavailable',
          error_kind: String(error && error.name || 'Error').slice(0, 40)
        });
      }
    }
  });
  await Promise.all(workers);
  await browser.close();

  results.sort((a, b) =>
    Number(!ALLOWED_METADATA.has(a.license_status)) - Number(!ALLOWED_METADATA.has(b.license_status)) ||
    Number(a.format_fit !== 'persian_priority') - Number(b.format_fit !== 'persian_priority') ||
    (b.view_count || 0) - (a.view_count || 0)
  );
  const eligible = results.filter(x => ALLOWED_METADATA.has(x.license_status));
  const report = {
    generated_at: new Date().toISOString(),
    checked_count: results.length,
    cc_search_filter_candidates_checked: results.filter(x => x.cc_search_filter).length,
    official_api_license_metadata_available: results.filter(x => x.license_source === 'YouTube Data API status.license').length,
    cc_or_public_domain_metadata_count: eligible.length,
    note: 'Metadata-only. No media was downloaded or uploaded. A license label is not proof of rights to every element or permission under third-party platform terms.',
    results
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2), 'utf8');
  console.log('LICENSE_SCAN_SUMMARY', JSON.stringify({
    checked: results.length,
    cc_search_filter_candidates_checked: report.cc_search_filter_candidates_checked,
    official_api_license_metadata_available: report.official_api_license_metadata_available,
    cc_or_public_domain_metadata: eligible.length,
    statuses: Object.fromEntries([...new Set(results.map(x => x.license_status))].map(k => [k, results.filter(x => x.license_status === k).length]))
  }));
  console.log('LICENSE_SCAN_TOP_RESULTS');
  for (const x of results.slice(0, 12)) {
    console.log('LICENSE_LEAD', JSON.stringify({
      title: x.title, url: x.url, source_channel: x.source_channel, view_count: x.view_count,
      license: x.license, license_status: x.license_status, license_source: x.license_source,
      cc_search_filter: x.cc_search_filter, format_fit: x.format_fit, http_status: x.http_status
    }));
  }
}

main().catch(error => {
  console.error('LICENSE_SCAN_FAILED', String(error && error.name || 'Error').slice(0, 40));
  process.exit(1);
});
