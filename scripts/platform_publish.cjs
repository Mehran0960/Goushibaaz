'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VIDEO_PATH = path.join('work', 'shared-publish', 'video.mp4');
const MANIFEST_PATH = path.join('work', 'shared-publish', 'manifest.json');
const ENABLED = /^true$/i.test(process.env.GOUSHIBAAZ_PUBLIC_PUBLISH_ENABLED || '') &&
  /^true$/i.test(process.env.GOUSHIBAAZ_FIRST_PUBLICATION_APPROVED || '');

const CONFIG = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    apiRoot: 'https://api.telegram.org',
    statePath: path.join('state', 'telegram-published.json')
  },
  bale: {
    token: process.env.BALE_BOT_TOKEN || '',
    chatId: process.env.BALE_CHANNEL_ID || '',
    apiRoot: 'https://tapi.bale.ai',
    statePath: path.join('state', 'bale-published.json')
  }
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function clean(value, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').slice(0, max);
}
function resultMessageId(payload) {
  const result = payload && (payload.result || payload.data || payload);
  const message = result && (result.message || result);
  return message && (message.message_id || message.messageId || message.id);
}

async function publish(platform) {
  const config = CONFIG[platform];
  if (!config) throw new Error('unsupported_destination');
  const manifest = readJson(MANIFEST_PATH, null);
  if (!manifest || manifest.schemaVersion !== 1) throw new Error('shared_manifest_missing_or_invalid');
  if (manifest.status !== 'prepared') {
    console.log('DESTINATION_SKIP_NO_SHARED_CANDIDATE', JSON.stringify({ platform, status: manifest.status }));
    const state = readJson(config.statePath, { schemaVersion: 1, posts: [] });
    state.lastOutcome = { status: 'no_shared_candidate', checkedAt: new Date().toISOString(), manifestStatus: manifest.status };
    writeJson(config.statePath, state);
    return;
  }
  if (!fs.existsSync(VIDEO_PATH)) throw new Error('shared_video_file_missing');
  const video = fs.readFileSync(VIDEO_PATH);
  const sha256 = crypto.createHash('sha256').update(video).digest('hex');
  if (sha256 !== manifest.sha256) throw new Error('shared_video_sha256_mismatch');
  if (video.length < 100000 || video.length > 48_000_000) throw new Error('shared_video_size_out_of_range');
  if (!manifest.sourcePage || !manifest.caption || !manifest.licenseUrl) throw new Error('shared_manifest_required_fields_missing');

  const state = readJson(config.statePath, { schemaVersion: 1, posts: [] });
  if (!Array.isArray(state.posts)) state.posts = [];
  const prior = state.posts.find(item =>
    item.sourcePage === manifest.sourcePage &&
    ['published', 'submitted_unconfirmed', 'send_started'].includes(item.status)
  );
  if (prior) {
    console.log('DESTINATION_DUPLICATE_SKIP', JSON.stringify({ platform, sourcePage: manifest.sourcePage, status: prior.status }));
    return;
  }
  const entry = {
    sourcePage: manifest.sourcePage, title: clean(manifest.title, 240),
    sha256, license: manifest.license, licenseUrl: manifest.licenseUrl,
    preparedAt: manifest.preparedAt, status: 'prepared', attemptedAt: new Date().toISOString()
  };
  if (!ENABLED) {
    entry.status = 'dry_run_ready_no_post_sent';
    entry.checkedAt = new Date().toISOString();
    state.posts.push(entry);
    state.lastOutcome = { status: 'dry_run_ready_no_post_sent', checkedAt: entry.checkedAt, sourcePage: entry.sourcePage, sha256 };
    writeJson(config.statePath, state);
    console.log('DESTINATION_DRY_RUN_READY', JSON.stringify({
      platform, title: entry.title, bytes: video.length, sha256,
      publicPostSent: false, reason: 'both publication approval variables are required'
    }));
    return;
  }
  if (!config.token || !config.chatId) throw new Error(platform + '_credentials_or_channel_id_missing');

  // Persist before sending so an ambiguous timeout cannot cause an automatic duplicate.
  entry.status = 'send_started';
  state.posts.push(entry);
  state.lastOutcome = { status: 'send_started', checkedAt: entry.attemptedAt, sourcePage: entry.sourcePage };
  writeJson(config.statePath, state);

  const form = new FormData();
  form.append('chat_id', String(config.chatId));
  form.append('caption', String(manifest.caption).slice(0, 1000));
  form.append('supports_streaming', 'true');
  form.append('video', new Blob([video], { type: 'video/mp4' }), 'goushibaaz-short.mp4');
  let response, payload;
  try {
    response = await fetch(config.apiRoot + '/bot' + config.token + '/sendVideo', {
      method: 'POST', body: form, signal: AbortSignal.timeout(150000)
    });
    const raw = await response.text();
    try { payload = JSON.parse(raw); } catch { payload = {}; }
    if (response.status === 429) {
      entry.status = 'upload_failed_retryable';
      entry.failure = 'destination_rate_limited';
      throw new Error(platform + '_rate_limited');
    }
    if (!response.ok || payload.ok !== true) {
      entry.status = response.status >= 500 ? 'submitted_unconfirmed' : 'rejected';
      entry.failure = clean(payload.description || payload.error_code || ('http_' + response.status));
      throw new Error(platform + '_sendVideo_rejected_' + response.status);
    }
    const messageId = resultMessageId(payload);
    if (!messageId) {
      entry.status = 'submitted_unconfirmed';
      entry.failure = 'accepted_without_message_id';
      throw new Error(platform + '_accepted_without_message_id');
    }
    entry.status = 'published';
    entry.messageId = String(messageId);
    entry.publishedAt = new Date().toISOString();
    state.lastOutcome = {
      status: 'published', checkedAt: entry.publishedAt,
      sourcePage: entry.sourcePage, messageId: entry.messageId, sha256
    };
    writeJson(config.statePath, state);
    console.log('DESTINATION_PUBLISHED', JSON.stringify({
      platform, messageId: entry.messageId, title: entry.title, sha256
    }));
  } catch (error) {
    if (entry.status === 'send_started') {
      entry.status = 'submitted_unconfirmed';
      entry.failure = clean(error && error.message || error);
    }
    state.lastOutcome = {
      status: entry.status, checkedAt: new Date().toISOString(),
      sourcePage: entry.sourcePage, error: entry.failure || clean(error && error.message || error)
    };
    writeJson(config.statePath, state);
    throw error;
  }
}

module.exports = { publish };
