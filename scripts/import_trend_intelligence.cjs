'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { categoryFor } = require('./quality_rank.cjs');
const INPUT = path.join('state', 'trend-intelligence.json');
const OUTPUT = path.join('state', 'platform-trends.json');
const MAX_ITEMS = 500;
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function safeNumber(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
function groupFor(platform) { if (platform === 'youtube') return 'youtube_cc'; if (platform === 'aparat') return 'aparat'; return 'telegram'; }
function main() {
  const feed = readJson(INPUT, null);
  if (!feed || !Array.isArray(feed.items)) throw new Error('trend_intelligence_feed_missing_or_invalid');
  const existing = readJson(OUTPUT, {});
  const next = { schemaVersion: 2, updated_at: new Date().toISOString(), telegram: {}, aparat: {}, youtube_cc: {} };
  const previousById = new Map();
  for (const group of ['telegram', 'aparat', 'youtube_cc']) for (const [id,row] of Object.entries(existing[group] || {})) previousById.set(id,row);
  const ranked = [...feed.items].filter(x => x && x.id && x.url).slice(0, MAX_ITEMS);
  for (const item of ranked) {
    const id=String(item.id), group=groupFor(String(item.platform || '')), old=previousById.get(id)||{};
    const history=Array.isArray(item.views_history)?item.views_history:(Array.isArray(old.history)?old.history:[]);
    next[group][id]={
      title:String(item.title||old.title||'').slice(0,240), url:String(item.url),
      last_seen_at:String(item.metrics_observed_at||item.discovered_at||feed.updated_at||new Date().toISOString()),
      last_views:Math.max(safeNumber(item.views),safeNumber(item.telegram_repost_views),safeNumber(item.telegram_post_views)),
      history:history.map(row=>({at:String(row.observed_at||row.at||''),views:safeNumber(row.views)})).filter(row=>row.at&&row.views>0).slice(-8),
      source:String(item.source||''),platform:String(item.platform||''),
      velocity_per_hour:safeNumber(item.views_velocity_per_hour),velocity_kind:String(item.views_velocity_kind||'unknown'),
      acceleration_per_hour2:Number(item.views_acceleration_per_hour2||0)
    };
  }
  for (const group of ['telegram','aparat','youtube_cc']) {
    const entries=Object.entries(next[group]).sort((a,b)=>String(b[1].last_seen_at).localeCompare(String(a[1].last_seen_at))).slice(0,MAX_ITEMS);
    next[group]=Object.fromEntries(entries);
  }
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});
  fs.writeFileSync(OUTPUT,JSON.stringify(next,null,2)+'\n');
  const topics={};
  for(const item of ranked){const key=categoryFor(item.title||'');topics[key]=(topics[key]||0)+1;}
  console.log('TREND_INTELLIGENCE_IMPORTED',JSON.stringify({
    inputItems:feed.items.length,retained:['telegram','aparat','youtube_cc'].reduce((n,k)=>n+Object.keys(next[k]).length,0),
    measuredVelocity:ranked.filter(x=>x.views_velocity_kind==='observed').length,
    estimatedVelocity:ranked.filter(x=>x.views_velocity_kind==='estimated_from_lifetime_views').length,
    topicSignals:topics
  }));
}
main();
