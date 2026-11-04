'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HOUR = 60 * 60 * 1000;
const PLATFORMS = {
  telegram: {
    tokenEnv: 'TELEGRAM_BOT_TOKEN',
    chatEnv: 'TELEGRAM_CHAT_ID',
    defaultChatId: '@didobyn',
    apiRoot: 'https://api.telegram.org',
    stateFile: 'state/telegram-published.json',
    deleteAfterMs: 46 * HOUR,
    apiWindowMs: 48 * HOUR,
    kind: 'bot-api'
  },
  bale: {
    tokenEnv: 'BALE_BOT_TOKEN',
    chatEnv: 'BALE_CHANNEL_ID',
    defaultChatId: '@didobyn',
    apiRoot: 'https://tapi.bale.ai',
    stateFile: 'state/bale-published.json',
    deleteAfterMs: 46 * HOUR,
    apiWindowMs: 48 * HOUR,
    kind: 'bot-api'
  },
  rubika: {
    tokenEnv: 'RUBIKA_BOT_TOKEN',
    chatEnv: 'RUBIKA_CHAT_ID',
    defaultChatId: '@didobyn',
    apiRoot: 'https://botapi.rubika.ir/v3',
    stateFile: 'state/rubika-published.json',
    deleteAfterMs: 48 * HOUR,
    apiWindowMs: null,
    kind: 'rubika'
  },
  eitaa: {
    tokenEnv: 'EITAAYAR_API_TOKEN',
    chatEnv: 'EITAAYAR_CHAT_ID',
    defaultChatId: '',
    apiRoot: 'https://eitaayar.ir/api',
    stateFile: 'state/eitaa-published.json',
    deleteAfterMs: 46 * HOUR,
    apiWindowMs: 48 * HOUR,
    kind: 'eitaayar'
  },
  jetra: {
    tokenEnv: 'JETRA_BOT_TOKEN',
    chatEnv: 'JETRA_CHAT_ID',
    defaultChatId: '@didobyn',
    apiRoot: 'https://jetra.ir/bot',
    stateFile: 'state/jetra-published.json',
    deleteAfterMs: 46 * HOUR,
    apiWindowMs: 48 * HOUR,
    kind: 'jetra'
  }
};

function safeText(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').slice(0, max);
}

function readState(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (value && Array.isArray(value.posts)) return value;
  } catch {}
  return { schemaVersion: 1, posts: [] };
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function parsePayload(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

async function requestDelete(platform, config, token, chatId, messageId, fetchImpl) {
  let url;
  if (config.kind === 'rubika' || config.kind === 'eitaayar') {
    url = config.apiRoot + '/' + encodeURIComponent(token) + '/deleteMessage';
  } else if (config.kind === 'jetra') {
    url = config.apiRoot + encodeURIComponent(token) + '/deleteMessage';
  } else {
    url = config.apiRoot + '/bot' + encodeURIComponent(token) + '/deleteMessage';
  }

  const params = { chat_id: chatId, message_id: String(messageId) };
  const formBody = config.kind === 'eitaayar' ? new URLSearchParams(params) : null;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: formBody ? undefined : { 'content-type': 'application/json' },
      body: formBody || JSON.stringify(params),
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    const failure = new Error('delete_network_or_timeout_failure');
    failure.retryable = true;
    throw failure;
  }

  const raw = await response.text();
  const payload = parsePayload(raw);
  if (!response.ok) {
    const failure = new Error('delete_http_' + response.status + '_' +
      safeText(payload && (payload.description || payload.error || payload.status) || 'request_failed'));
    failure.httpStatus = response.status;
    failure.retryable = response.status === 429 || response.status >= 500;
    throw failure;
  }

  if (platform === 'rubika') {
    if (payload && (payload.status === 'OK' || payload.ok === true)) return true;
    const failure = new Error('rubika_delete_api_rejected_' +
      safeText(payload && (payload.description || payload.error || payload.status) || 'invalid_response'));
    failure.retryable = /rate|flood|too many|temporar|busy/i.test(failure.message);
    throw failure;
  }

  if (payload && payload.ok === true && payload.result !== false) return true;
  const failure = new Error(platform + '_delete_api_rejected_' +
    safeText(payload && (payload.description || payload.error_code) || 'invalid_response'));
  failure.httpStatus = payload && Number(payload.error_code) || undefined;
  failure.retryable = failure.httpStatus === 429 ||
    /rate|flood|too many|temporar|busy/i.test(failure.message);
  throw failure;
}

async function resolveRubikaChatId(config, token, fetchImpl) {
  const url = config.apiRoot + '/' + encodeURIComponent(token) + '/getChat';
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: config.defaultChatId }),
    signal: AbortSignal.timeout(20000)
  });
  const payload = parsePayload(await response.text());
  if (!response.ok || !payload || payload.status !== 'OK') {
    throw new Error('rubika_getChat_failed');
  }
  const data = payload.data || payload;
  const chat = data.chat || data.channel || data;
  const id = chat.chat_id || chat.id || chat.guid;
  const username = String(chat.username || chat.user_name || '').replace(/^@/, '').toLowerCase();
  const title = String(chat.title || chat.name || '').replace(/\s/g, '');
  if (!id || (username !== 'didobyn' && title !== 'دیدوبین')) {
    throw new Error('rubika_channel_identity_check_failed');
  }
  return String(id);
}

async function runCleanup(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const fetchImpl = options.fetchImpl || fetch;
  const env = options.env || process.env;
  const rootDir = options.rootDir || process.cwd();
  const dryRun = options.dryRun === true;
  const selected = options.platforms || Object.keys(PLATFORMS);
  const report = { dryRun, checkedAt: new Date(nowMs).toISOString(), platforms: {} };

  for (const platform of selected) {
    const config = PLATFORMS[platform];
    if (!config) continue;
    const token = String(env[config.tokenEnv] || '').trim();
    const statePath = path.join(rootDir, config.stateFile);
    const result = {
      status: 'skipped',
      reason: '',
      checked: 0,
      deleted: 0,
      outsideApiWindow: 0,
      failed: 0
    };
    report.platforms[platform] = result;

    if (!token) {
      result.reason = 'token_not_configured';
      continue;
    }

    const state = readState(statePath);
    let changed = false;
    let chatIdFallback = String(env[config.chatEnv] || '').trim();
    if (platform !== 'rubika' && !chatIdFallback) chatIdFallback = config.defaultChatId;

    if (platform === 'rubika' && !chatIdFallback) {
      try {
        chatIdFallback = await resolveRubikaChatId(config, token, fetchImpl);
      } catch (error) {
        result.status = 'failed';
        result.reason = safeText(error.message);
        continue;
      }
    }

    for (const post of state.posts) {
      if (!post || post.status !== 'published' || post.retentionStatus === 'deleted' ||
          post.retentionStatus === 'outside_api_window' ||
          post.retentionStatus === 'delete_failed_permanent') continue;

      const publishedAt = Date.parse(post.publishedAt || '');
      if (!Number.isFinite(publishedAt) || publishedAt > nowMs) continue;

      const ageMs = nowMs - publishedAt;
      if (ageMs < config.deleteAfterMs) continue;
      result.checked++;

      if (config.apiWindowMs && ageMs >= config.apiWindowMs) {
        if (!dryRun) {
          post.retentionStatus = 'outside_api_window';
          post.retentionFailure = 'platform_bot_api_cannot_delete_messages_at_or_after_48_hours';
          post.retentionCheckedAt = new Date(nowMs).toISOString();
          changed = true;
        }
        result.outsideApiWindow++;
        continue;
      }

      const messageId = String(post.messageId || '').trim();
      const chatId = String(post.chatId || post.channelId || chatIdFallback).trim();
      if (!messageId || !chatId) {
        if (!dryRun) {
          post.retentionStatus = 'delete_failed_permanent';
          post.retentionFailure = !messageId ? 'published_message_id_missing' : 'destination_chat_id_missing';
          post.retentionCheckedAt = new Date(nowMs).toISOString();
          changed = true;
        }
        result.failed++;
        continue;
      }

      if (dryRun) {
        result.reason = 'dry_run_no_api_calls';
        continue;
      }

      post.deleteAttempts = Number(post.deleteAttempts || 0) + 1;
      post.lastDeleteAttemptAt = new Date(nowMs).toISOString();
      changed = true;
      try {
        await requestDelete(platform, config, token, chatId, messageId, fetchImpl);
        post.retentionStatus = 'deleted';
        post.deletedAt = new Date(nowMs).toISOString();
        post.retentionFailure = null;
        result.deleted++;
      } catch (error) {
        post.retentionFailure = safeText(error && error.message || error);
        post.retentionCheckedAt = new Date(nowMs).toISOString();
        if (error && error.retryable && post.deleteAttempts < 12) {
          post.retentionStatus = 'delete_pending_retry';
        } else {
          post.retentionStatus = 'delete_failed_permanent';
        }
        result.failed++;
      }
    }

    if (changed) {
      state.lastRetentionRun = {
        checkedAt: new Date(nowMs).toISOString(),
        deleted: result.deleted,
        outsideApiWindow: result.outsideApiWindow,
        failed: result.failed
      };
      writeState(statePath, state);
    }
    result.status = result.failed ? 'completed_with_errors' : 'completed';
    if (!result.reason) result.reason = changed ? 'state_updated' : 'nothing_due';
  }

  return report;
}

if (require.main === module) {
  runCleanup().then(report => {
    console.log('GOUSHIBAAZ_RETENTION_REPORT ' + JSON.stringify(report));
  }).catch(error => {
    console.error('GOUSHIBAAZ_RETENTION_FAILED ' + safeText(error && error.message || error));
    process.exitCode = 1;
  });
}

module.exports = { runCleanup, PLATFORMS };
