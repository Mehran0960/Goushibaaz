'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VIDEO = path.join('work', 'shared-publish', 'video.mp4');
const MANIFEST = path.join('work', 'shared-publish', 'manifest.json');
const OUTPUT_DIR = path.join('work', 'jetra-publish');
const OUTPUT_VIDEO = path.join(OUTPUT_DIR, 'video.mp4');
const STATE = path.join('state', 'jetra-published.json');
const TOKEN = process.env.JETRA_BOT_TOKEN || '';
const CHAT_ID = String(process.env.JETRA_CHAT_ID || '').trim();
const ENABLED =
  /^true$/i.test(process.env.GOUSHIBAAZ_PUBLIC_PUBLISH_ENABLED || '') &&
  /^true$/i.test(process.env.GOUSHIBAAZ_FIRST_PUBLICATION_APPROVED || '');
const API_ROOT = 'https://jetra.ir/bot';
const MAX_VIDEO_BYTES = 25_000_000;
const COMPACT_VIDEO_BYTES = 24_000_000;

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

function parsePayload(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function messageId(result) {
  const message = result && (result.message || result);
  const value = message && (message.message_id || message.messageId || message.id);
  return value == null ? '' : String(value);
}

function apiUrl(method) {
  return API_ROOT + encodeURIComponent(TOKEN) + '/' + method;
}

async function callApi(method, body, options = {}) {
  if (!TOKEN) throw new Error('jetra_bot_token_missing');
  let response;
  try {
    response = await fetch(apiUrl(method), {
      method: options.method || (body ? 'POST' : 'GET'),
      headers: body && !(body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : undefined,
      body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined),
      signal: options.signal || AbortSignal.timeout(30000)
    });
  } catch {
    const failure = new Error(method + '_network_or_timeout_failure');
    failure.ambiguous = method === 'sendVideo';
    throw failure;
  }
  const raw = await response.text();
  const payload = parsePayload(raw);
  if (!response.ok) {
    const failure = new Error(method + '_http_' + response.status + '_' +
      clean(payload && (payload.description || payload.error_code) || 'request_failed'));
    failure.httpStatus = response.status;
    throw failure;
  }
  if (!payload || payload.ok !== true) {
    const failure = new Error(method + '_api_rejected_' +
      clean(payload && (payload.description || payload.error_code) || 'invalid_response'));
    failure.apiRejected = true;
    failure.retryable = /rate|flood|too many|temporar|busy/i.test(failure.message);
    throw failure;
  }
  return payload.result || {};
}

async function resolveChannel() {
  const me = await callApi('getMe');
  if (!me.id) throw new Error('jetra_getMe_missing_bot_id');

  const chat = await callApi('getChat', { chat_id: CHAT_ID });
  const type = String(chat.type || '').toLowerCase();
  if (!chat.id || !['channel', 'supergroup'].includes(type)) {
    throw new Error('jetra_destination_is_not_a_channel_or_supergroup');
  }

  const member = await callApi('getChatMember', {
    chat_id: chat.id,
    user_id: me.id
  });
  const status = String(member.status || '').toLowerCase();
  if (!['administrator', 'creator'].includes(status)) {
    throw new Error('jetra_bot_is_not_a_channel_admin');
  }
  if (member.can_post_messages === false) {
    throw new Error('jetra_bot_cannot_post_to_channel');
  }
  return { chatId: String(chat.id), botId: String(me.id), chatType: type };
}

function selectDeliveryVideo(originalBytes) {
  if (originalBytes.length <= MAX_VIDEO_BYTES) {
    return { filePath: VIDEO, bytes: originalBytes, compressed: false };
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const { convertToPortrait } = require('./media_format.cjs');
  convertToPortrait(VIDEO, OUTPUT_VIDEO, {
    width: 720,
    height: 1280,
    maxBytes: COMPACT_VIDEO_BYTES,
    crf: 29,
    preset: 'veryfast',
    maxrate: '850k',
    bufsize: '1700k',
    audioBitrate: '64k',
    timeoutMs: 240000
  });
  const bytes = fs.readFileSync(OUTPUT_VIDEO);
  if (bytes.length > MAX_VIDEO_BYTES) throw new Error('jetra_video_still_exceeds_25mb_after_compression');
  return { filePath: OUTPUT_VIDEO, bytes, compressed: true };
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
    console.log('JETRA_SHARED_SKIP', JSON.stringify({ manifestStatus: manifest.status || 'unknown' }));
    return;
  }

  if (!fs.existsSync(VIDEO)) throw new Error('shared_video_file_missing');
  const originalBytes = fs.readFileSync(VIDEO);
  if (originalBytes.length < 100_000 || originalBytes.length > 48_000_000) {
    throw new Error('shared_video_size_out_of_range');
  }
  const sourceSha256 = crypto.createHash('sha256').update(originalBytes).digest('hex');
  if (sourceSha256 !== manifest.sha256) throw new Error('shared_video_sha256_mismatch');
  if (!manifest.sourcePage || !manifest.caption || !manifest.licenseUrl) {
    throw new Error('shared_manifest_required_fields_missing');
  }

  const prior = state.posts.find(item =>
    item.sourcePage === manifest.sourcePage &&
    ['published', 'submitted_unconfirmed', 'send_started'].includes(item.status)
  );
  if (prior) {
    console.log('JETRA_DUPLICATE_SKIP', JSON.stringify({
      sourcePage: manifest.sourcePage,
      priorStatus: prior.status
    }));
    return;
  }

  const entry = {
    sourcePage: manifest.sourcePage,
    title: clean(manifest.title, 220),
    sourceSha256,
    license: manifest.license,
    licenseUrl: manifest.licenseUrl,
    preparedAt: manifest.preparedAt,
    status: 'prepared',
    attemptedAt: nowIso()
  };

  if (!ENABLED) {
    entry.status = 'dry_run_ready_no_post_sent';
    entry.deliveryBytes = originalBytes.length;
    entry.deliverySha256 = sourceSha256;
    entry.checkedAt = nowIso();
    state.posts.push(entry);
    state.lastOutcome = {
      status: entry.status,
      checkedAt: entry.checkedAt,
      sourcePage: entry.sourcePage,
      sourceSha256,
      publicPostSent: false
    };
    saveState(state);
    console.log('JETRA_DRY_RUN_READY', JSON.stringify({
      title: entry.title,
      bytes: originalBytes.length,
      sha256: sourceSha256,
      publicPostSent: false
    }));
    return;
  }

  if (!TOKEN || !CHAT_ID) throw new Error('jetra_bot_token_or_chat_id_missing');

  try {
    const destination = await resolveChannel();
    const delivery = selectDeliveryVideo(originalBytes);
    const deliverySha256 = crypto.createHash('sha256').update(delivery.bytes).digest('hex');

    const form = new FormData();
    form.append('chat_id', destination.chatId);
    form.append('caption', String(manifest.caption).slice(0, 1000));
    form.append('supports_streaming', 'true');
    form.append('video', new Blob([delivery.bytes], { type: 'video/mp4' }), 'goushibaaz-short.mp4');

    entry.status = 'send_started';
    entry.chatId = destination.chatId;
    entry.deliveryBytes = delivery.bytes.length;
    entry.deliverySha256 = deliverySha256;
    entry.compressedForDestination = delivery.compressed;
    state.posts.push(entry);
    state.lastOutcome = {
      status: 'send_started',
      checkedAt: entry.attemptedAt,
      sourcePage: entry.sourcePage
    };
    saveState(state);

    const result = await callApi('sendVideo', form, { signal: AbortSignal.timeout(240000) });
    const id = messageId(result);
    if (!id) {
      entry.status = 'submitted_unconfirmed';
      entry.failure = 'accepted_without_message_id';
      throw new Error('jetra_sendVideo_accepted_without_message_id');
    }

    entry.status = 'published';
    entry.messageId = id;
    entry.publishedAt = nowIso();
    state.lastOutcome = {
      status: 'published',
      checkedAt: entry.publishedAt,
      sourcePage: entry.sourcePage,
      messageId: id,
      sourceSha256,
      deliverySha256,
      compressedForDestination: delivery.compressed
    };
    saveState(state);
    console.log('JETRA_PUBLISHED', JSON.stringify({
      messageId: id,
      title: entry.title,
      deliveryBytes: delivery.bytes.length,
      compressedForDestination: delivery.compressed,
      sourceSha256,
      deliverySha256
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
  console.error('JETRA_PUBLISH_FAILED', clean(error && error.message || error));
  process.exitCode = 1;
});
