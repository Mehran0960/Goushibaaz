'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VIDEO = path.join('work', 'shared-publish', 'video.mp4');
const MANIFEST = path.join('work', 'shared-publish', 'manifest.json');
const STATE = path.join('state', 'eitaa-published.json');
const TOKEN = process.env.EITAAYAR_API_TOKEN || '';
const CHAT_ID = String(process.env.EITAAYAR_CHAT_ID || '').trim().replace(/^@/, '');
const ENABLED =
  /^true$/i.test(process.env.GOUSHIBAAZ_PUBLIC_PUBLISH_ENABLED || '') &&
  /^true$/i.test(process.env.GOUSHIBAAZ_FIRST_PUBLICATION_APPROVED || '');
const API_ROOT = 'https://eitaayar.ir/api/';
const MAX_VIDEO_BYTES = 48_000_000;

const clean = value => String(value || '').replace(/\s+/g, ' ').slice(0, 260);
const nowIso = () => new Date().toISOString();

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (Array.isArray(value.posts)) return value;
  } catch {}
  return { schemaVersion: 1, posts: [] };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  state.posts = state.posts.slice(-600);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function parseMessageId(result) {
  const value = result && (result.message_id || result.messageId || result.id);
  return value == null ? '' : String(value);
}

function parsePayload(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

async function callApi(method, options = {}) {
  if (!TOKEN) throw new Error('eitaayar_api_token_missing');
  const url = API_ROOT + encodeURIComponent(TOKEN) + '/' + method;
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(150000)
    });
  } catch (error) {
    const failure = new Error(method + '_network_or_timeout_failure');
    failure.ambiguous = method === 'sendFile';
    throw failure;
  }
  const raw = await response.text();
  const payload = parsePayload(raw);
  if (!response.ok) {
    const failure = new Error(method + '_http_' + response.status + '_' +
      clean(payload && (payload.description || payload.error) || 'request_failed'));
    failure.httpStatus = response.status;
    throw failure;
  }
  if (!payload || payload.ok !== true) {
    const failure = new Error(method + '_api_rejected_' +
      clean(payload && (payload.description || payload.error || payload.result) || 'invalid_response'));
    failure.apiRejected = true;
    failure.retryable = /rate|flood|too many|temporar|busy/i.test(failure.message);
    throw failure;
  }
  return payload.result || {};
}

async function main() {
  const state = readState();
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch { throw new Error('shared_manifest_missing_or_invalid'); }

  if (manifest.schemaVersion !== 1) throw new Error('shared_manifest_schema_invalid');
  if (manifest.status !== 'prepared') {
    state.lastOutcome = {
      status: 'no_shared_candidate',
      checkedAt: nowIso(),
      manifestStatus: manifest.status || 'unknown'
    };
    saveState(state);
    console.log('EITAA_SHARED_SKIP', JSON.stringify({ manifestStatus: manifest.status || 'unknown' }));
    return;
  }

  if (!fs.existsSync(VIDEO)) throw new Error('shared_video_file_missing');
  const bytes = fs.readFileSync(VIDEO);
  if (bytes.length < 100_000 || bytes.length > MAX_VIDEO_BYTES) {
    throw new Error('shared_video_size_out_of_range');
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== manifest.sha256) throw new Error('shared_video_sha256_mismatch');
  if (!manifest.sourcePage || !manifest.caption || !manifest.licenseUrl) {
    throw new Error('shared_manifest_required_fields_missing');
  }

  const prior = state.posts.find(item =>
    item.sourcePage === manifest.sourcePage &&
    ['published', 'submitted_unconfirmed', 'send_started'].includes(item.status)
  );
  if (prior) {
    console.log('EITAA_DUPLICATE_SKIP', JSON.stringify({
      sourcePage: manifest.sourcePage,
      priorStatus: prior.status
    }));
    return;
  }

  const entry = {
    sourcePage: manifest.sourcePage,
    title: clean(manifest.title, 220),
    sha256,
    license: manifest.license,
    licenseUrl: manifest.licenseUrl,
    preparedAt: manifest.preparedAt,
    status: 'prepared',
    attemptedAt: nowIso()
  };

  if (!ENABLED) {
    entry.status = 'dry_run_ready_no_post_sent';
    entry.checkedAt = nowIso();
    state.posts.push(entry);
    state.lastOutcome = {
      status: entry.status,
      checkedAt: entry.checkedAt,
      sourcePage: entry.sourcePage,
      sha256
    };
    saveState(state);
    console.log('EITAA_DRY_RUN_READY', JSON.stringify({
      title: entry.title,
      bytes: bytes.length,
      sha256,
      publicPostSent: false
    }));
    return;
  }

  if (!TOKEN || !CHAT_ID) throw new Error('eitaayar_token_or_chat_id_missing');

  try {
    const bot = await callApi('getMe', { method: 'GET', signal: AbortSignal.timeout(25000) });
    if (bot.is_bot !== true) throw new Error('eitaayar_getMe_did_not_confirm_bot_account');

    // EitaaYar's documented media method is sendFile (not Telegram's sendVideo).
    // Its documented channel parameter is id_chat; public usernames are sent without @.
    const form = new FormData();
    form.append('id_chat', CHAT_ID);
    form.append('caption', String(manifest.caption).slice(0, 1000));
    form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'goushibaaz-short.mp4');

    entry.status = 'send_started';
    entry.chatId = CHAT_ID;
    entry.botUsername = clean(bot.username, 80);
    state.posts.push(entry);
    state.lastOutcome = {
      status: 'send_started',
      checkedAt: entry.attemptedAt,
      sourcePage: entry.sourcePage
    };
    saveState(state);

    const result = await callApi('sendFile', { method: 'POST', body: form });
    const messageId = parseMessageId(result);
    if (!messageId) {
      entry.status = 'submitted_unconfirmed';
      entry.failure = 'accepted_without_message_id';
      throw new Error('eitaayar_sendFile_accepted_without_message_id');
    }

    entry.status = 'published';
    entry.messageId = messageId;
    entry.publishedAt = nowIso();
    state.lastOutcome = {
      status: 'published',
      checkedAt: entry.publishedAt,
      sourcePage: entry.sourcePage,
      messageId,
      sha256
    };
    saveState(state);
    console.log('EITAA_PUBLISHED', JSON.stringify({
      messageId,
      title: entry.title,
      sha256,
      chatId: CHAT_ID
    }));
  } catch (error) {
    if (entry.status === 'send_started') {
      if (error.ambiguous || (error.httpStatus >= 500)) {
        entry.status = 'submitted_unconfirmed';
      } else if (error.httpStatus === 429 || error.retryable) {
        entry.status = 'upload_failed_retryable';
      } else if (error.apiRejected || (error.httpStatus >= 400 && error.httpStatus < 500)) {
        entry.status = 'rejected';
      } else {
        entry.status = 'submitted_unconfirmed';
      }
    } else {
      entry.status = 'failed_retryable';
    }
    entry.failure = clean(error && error.message || error);
    entry.failedAt = nowIso();
    if (!state.posts.some(item => item === entry)) state.posts.push(entry);
    state.lastOutcome = {
      status: entry.status,
      checkedAt: entry.failedAt,
      sourcePage: entry.sourcePage,
      error: entry.failure
    };
    saveState(state);
    throw error;
  }
}

main().catch(error => {
  console.error('EITAA_PUBLISH_FAILED', clean(error && error.message || error));
  process.exitCode = 1;
});
