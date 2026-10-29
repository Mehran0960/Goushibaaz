const fs = require('node:fs');
const path = require('node:path');

const POLICY_PATH = path.join('config', 'content-policy.json');
const POLICY = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
const OUT_JSON = path.join('out', 'shorts-priority.json');
const OUT_MD = path.join('out', 'shorts-priority.md');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function persianSignal(text) {
  return /[پچژگکی]/.test(text) || /فارسی|طنز|خنده|دوربین مخفی|سوتی|کلیپ|چالش|بامزه/.test(text);
}
function iranSignal(text) {
  return /ایران|ایرانی|تهران|شیراز|اصفهان|تبریز|مشهد|کرج|اهواز|رشت|کرمانشاه|\biran(?:ian)?\b|\btehran\b|\bshiraz\b|\bisfahan\b/i.test(text);
}
function aspectData(item) {
  const width = Number(item.video_width || item.width || item.sourceWidth || 0);
  const height = Number(item.video_height || item.height || item.sourceHeight || 0);
  if (width > 0 && height > 0) {
    const ratio = width / height;
    if (ratio >= 0.50 && ratio <= 0.64) return { ratio: Math.round(ratio * 1000) / 1000, score: 3, fit: 'portrait_9_16_candidate', evidence: 'reported_dimensions' };
    if (ratio < 0.50 && ratio > 0.40) return { ratio: Math.round(ratio * 1000) / 1000, score: 2, fit: 'portrait_other_ratio', evidence: 'reported_dimensions' };
    return { ratio: Math.round(ratio * 1000) / 1000, score: 0, fit: 'landscape_or_square', evidence: 'reported_dimensions' };
  }
  const shortHint = item.is_short === true || /shorts_vertical_candidate/.test(String(item.vertical_fit || '')) ||
    /MediaFarsi Shorts list/i.test(String(item.vertical_evidence || ''));
  return shortHint
    ? { ratio: null, score: 2, fit: 'shorts_vertical_candidate', evidence: String(item.vertical_evidence || 'short-form source listing; exact ratio not confirmed') }
    : { ratio: null, score: 1, fit: 'unknown', evidence: 'dimensions unavailable' };
}
function rightsStatus(item, licenseLookup) {
  const id = item.video_id || (String(item.source_url || item.youtube_url || '').match(/(?:v=|shorts\/)([A-Za-z0-9_-]{11})/) || [])[1];
  const license = id ? licenseLookup.get(id) : null;
  const status = license?.license_status || item.license_status || 'unverified';
  const label = license?.license || item.license || '';
  const verifiedByOwner = Boolean(item.owner_permission_verified || item.explicit_permission_verified);
  const eligibleStatus = ['public_domain_or_cc0', 'cc_by'].includes(status);
  // YouTube/API labels are signals only: component ownership and source terms still need clearance.
  const publishEligible = verifiedByOwner || Boolean(item.rights_verified && eligibleStatus);
  return {
    license_label: label || null,
    license_status: status,
    permission_verified: verifiedByOwner || Boolean(item.rights_verified),
    republish_eligible: publishEligible
  };
}
function candidateFrom(item, origin, licenseLookup) {
  const title = clean(item.title || item.name || item.sourceTitle);
  const sourceUrl = clean(item.source_url || item.youtube_url || item.url || item.href);
  if (!title || !sourceUrl) return null;
  const meta = [title, item.description, item.source_channel, item.channel, item.uploader].filter(Boolean).join(' ');
  const isPersian = item.language_priority === 'persian' || item.source_language_priority === 'persian' || persianSignal(meta);
  const isIran = iranSignal(meta);
  const vertical = aspectData(item);
  const localScore = isIran && isPersian ? 4 : (isPersian ? 3 : (isIran ? 2 : Number(item.local_content_score || item.content_locality_score || 0)));
  const observed = Number.isFinite(Number(item.observed_views_per_hour)) ? Number(item.observed_views_per_hour) : null;
  const proxy = Number.isFinite(Number(item.views_per_hour_proxy)) ? Number(item.views_per_hour_proxy) : null;
  const age = Number.isFinite(Number(item.age_hours)) ? Number(item.age_hours) : null;
  const rights = rightsStatus(item, licenseLookup);
  const tags = [];
  if (isIran) tags.push('Iran-related metadata signal');
  if (isPersian) tags.push('Persian-language/source signal');
  if (vertical.score >= 2) tags.push('portrait/Shorts candidate');
  if (observed !== null && observed > 0) tags.push('measured growth available');
  return {
    id: item.id || item.video_id || sourceUrl,
    title,
    source_platform: item.source_platform || (origin === 'mediafarsi_shorts' ? 'youtube_shorts' : origin),
    source_channel: item.source_channel || item.channel || null,
    source_url: sourceUrl,
    discovery_origin: origin,
    content_language: isPersian ? 'persian_signal' : 'unconfirmed',
    content_locality: isIran ? 'iran_metadata_signal' : 'unconfirmed',
    local_content_score: localScore,
    vertical_fit: vertical.fit,
    vertical_score: vertical.score,
    source_aspect_ratio: vertical.ratio,
    vertical_evidence: vertical.evidence,
    target_aspect_ratio: POLICY.vertical_video.aspect_ratio,
    views: item.views ?? item.view_count ?? null,
    age_hours: age,
    observed_views_per_hour: observed,
    views_per_hour_proxy: proxy,
    format_fit: item.format_fit || null,
    license: rights.license_label,
    license_status: rights.license_status,
    permission_verified: rights.permission_verified,
    republish_eligible: rights.republish_eligible,
    priority_reasons: tags
  };
}
function score(item) {
  const observed = item.observed_views_per_hour;
  const velocitySignal = observed !== null && observed >= 100 ? 1 : 0;
  const measured = velocitySignal ? observed : -1;
  const age = item.age_hours;
  const freshness = age === null ? 0 : age <= 48 ? 2 : age <= 168 ? 1 : 0;
  return [
    item.local_content_score || 0,
    item.vertical_score || 0,
    velocitySignal,
    measured,
    freshness,
    item.views_per_hour_proxy ?? -1,
    Number(item.views) || -1
  ];
}
function compare(a,b) {
  const x = score(a), y = score(b);
  for (let i = 0; i < Math.max(x.length,y.length); i++) {
    if ((y[i] ?? -1) !== (x[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1);
  }
  return a.title.localeCompare(b.title, 'fa');
}

function main() {
  fs.mkdirSync('out', { recursive: true });
  const mediaFarsi = readJson('out/candidates.json') || { candidates: [] };
  const platform = readJson('out/platform-candidates.json') || { candidates: [] };
  const licenseReport = readJson('out/license-check.json') || { results: [] };
  const licenses = new Map((licenseReport.results || []).filter(x => x.video_id).map(x => [x.video_id, x]));
  const unique = new Map();
  const inputs = [
    ...(mediaFarsi.candidates || []).map(x => ({ item: x, origin: 'mediafarsi_shorts' })),
    ...(platform.candidates || []).map(x => ({ item: x, origin: 'public_platform_scout' }))
  ];
  for (const entry of inputs) {
    const item = candidateFrom(entry.item, entry.origin, licenses);
    if (!item) continue;
    const old = unique.get(item.source_url);
    if (!old || compare(item, old) < 0) unique.set(item.source_url, item);
  }
  const candidates = [...unique.values()].sort(compare).slice(0, 200);
  const report = {
    generated_at: new Date().toISOString(),
    content_policy: {
      primary_language: POLICY.content_focus.primary_language,
      primary_market: POLICY.content_focus.primary_market,
      target_aspect_ratio: POLICY.vertical_video.aspect_ratio,
      ranking_order: POLICY.ranking_order,
      rights_gate: POLICY.rights_gate
    },
    candidate_count: candidates.length,
    note: 'This is the shared discovery shortlist for all destination adapters. Public video links, Persian language, Shorts pages, and a Creative Commons search filter are discovery signals only. Do not download or publish a lead unless republication rights are independently verified. Final exports must be 1080x1920 (9:16).',
    summary: {
      persian_signals: candidates.filter(x => x.content_language === 'persian_signal').length,
      iran_metadata_signals: candidates.filter(x => x.content_locality === 'iran_metadata_signal').length,
      portrait_or_shorts_candidates: candidates.filter(x => x.vertical_score >= 2).length,
      rights_verified_for_republication: candidates.filter(x => x.republish_eligible).length,
      discovery_only: candidates.filter(x => !x.republish_eligible).length
    },
    candidates
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8');
  const lines = [
    '# Shared Persian/Iran-first vertical video shortlist',
    '',
    'Generated: ' + report.generated_at,
    '',
    '**No media is downloaded or published by this merge step.**',
    'Ranking: Persian/Iran-related signal → portrait/Shorts evidence → observed growth → freshness.',
    'Target output: 1080×1920 (9:16). Exact source ratio is only confirmed when source dimensions are available.',
    'Public availability or a search-filter/license label alone does not grant republishing permission.',
    '',
    'Candidates: ' + report.summary.persian_signals + ' Persian signals · ' + report.summary.iran_metadata_signals + ' Iran-related metadata signals · ' + report.summary.portrait_or_shorts_candidates + ' portrait/Shorts candidates · ' + report.summary.rights_verified_for_republication + ' rights-cleared',
    '',
    '| Rank | Candidate | Source | Content signal | Vertical evidence | Growth/h | Rights status |',
    '|---:|---|---|---|---|---:|---|'
  ];
  for (const [index, item] of candidates.slice(0, 80).entries()) {
    const title = item.title.replace(/[|\n]/g, ' ').slice(0, 120);
    const growth = item.observed_views_per_hour === null ? '—' : item.observed_views_per_hour;
    const contentSignal = item.content_locality === 'iran_metadata_signal' ? 'Iran signal' : item.content_language === 'persian_signal' ? 'Persian signal' : 'unconfirmed';
    lines.push('| ' + (index + 1) + ' | [' + title + '](' + item.source_url + ') | ' + item.source_platform + '/' + (item.source_channel || 'unknown') + ' | ' + contentSignal + ' | ' + item.vertical_fit + ' | ' + growth + ' | ' + item.license_status + (item.republish_eligible ? ' (cleared)' : ' (discovery only)') + ' |');
  }
  fs.writeFileSync(OUT_MD, lines.join('\n') + '\n', 'utf8');
  console.log('SHORTS_PRIORITY_SUMMARY', JSON.stringify(report.summary));
  for (const item of candidates.slice(0, 15)) {
    console.log('SHORTS_PRIORITY_LEAD', JSON.stringify({
      title: item.title, source_url: item.source_url, source_platform: item.source_platform,
      local_content_score: item.local_content_score, vertical_fit: item.vertical_fit,
      observed_views_per_hour: item.observed_views_per_hour, license_status: item.license_status,
      republish_eligible: item.republish_eligible
    }));
  }
}
main();
