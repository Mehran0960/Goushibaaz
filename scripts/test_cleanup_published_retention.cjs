'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCleanup } = require('./cleanup_published_retention.cjs');

async function main() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goushibaaz-retention-'));
  const nowMs = Date.parse('2026-11-04T12:00:00.000Z');
  const writeFixture = (file, posts) => {
    const target = path.join(rootDir, 'state', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, posts }, null, 2));
  };
  const post = (messageId, hoursOld) => ({
    status: 'published',
    messageId,
    publishedAt: new Date(nowMs - hoursOld * 3600000).toISOString()
  });

  writeFixture('telegram-published.json', [post('tg-recent-expired', 47), post('tg-too-old', 49)]);
  writeFixture('bale-published.json', [post('bale-recent', 20)]);
  writeFixture('rubika-published.json', [post('rubika-old', 60)]);
  writeFixture('eitaa-published.json', [post('eitaa-47h', 47)]);
  writeFixture('jetra-published.json', [post('jetra-47h', 47)]);

  const calls = [];
  const mockFetch = async (url, init) => {
    const body = init.body instanceof URLSearchParams
      ? Object.fromEntries(init.body.entries())
      : JSON.parse(init.body);
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      text: async () => url.includes('botapi.rubika.ir')
        ? JSON.stringify({ status: 'OK', data: true })
        : JSON.stringify({ ok: true, result: true })
    };
  };

  const report = await runCleanup({
    rootDir,
    nowMs,
    fetchImpl: mockFetch,
    env: {
      TELEGRAM_BOT_TOKEN: 'test-telegram',
      BALE_BOT_TOKEN: 'test-bale',
      RUBIKA_BOT_TOKEN: 'test-rubika',
      RUBIKA_CHAT_ID: 'rubika-chat',
      EITAAYAR_API_TOKEN: 'test-eitaa',
      EITAAYAR_CHAT_ID: 'eitaa-chat',
      JETRA_BOT_TOKEN: 'test-jetra',
      JETRA_CHAT_ID: 'jetra-chat',
      TELEGRAM_CHAT_ID: '@didobyn',
      BALE_CHANNEL_ID: '@didobyn'
    }
  });

  assert.equal(calls.length, 4, 'Telegram, Eitaa, and Jetra at 47h plus Rubika at 60h should be deleted');
  assert.ok(calls.some(call => call.url === 'https://api.telegram.org/bottest-telegram/deleteMessage'));
  assert.ok(calls.some(call => call.url === 'https://botapi.rubika.ir/v3/test-rubika/deleteMessage'));
  assert.ok(calls.some(call => call.url === 'https://eitaayar.ir/api/test-eitaa/deleteMessage'));
  assert.ok(calls.some(call => call.url === 'https://jetra.ir/bottest-jetra/deleteMessage'));
  assert.ok(calls.every(call => call.body.chat_id && call.body.message_id));
  assert.equal(report.platforms.telegram.deleted, 1);
  assert.equal(report.platforms.telegram.outsideApiWindow, 1);
  assert.equal(report.platforms.bale.deleted, 0);
  assert.equal(report.platforms.rubika.deleted, 1);
  assert.equal(report.platforms.eitaa.deleted, 1);
  assert.equal(report.platforms.jetra.deleted, 1);

  const telegram = JSON.parse(fs.readFileSync(path.join(rootDir, 'state', 'telegram-published.json'), 'utf8'));
  const bale = JSON.parse(fs.readFileSync(path.join(rootDir, 'state', 'bale-published.json'), 'utf8'));
  const rubika = JSON.parse(fs.readFileSync(path.join(rootDir, 'state', 'rubika-published.json'), 'utf8'));
  const eitaa = JSON.parse(fs.readFileSync(path.join(rootDir, 'state', 'eitaa-published.json'), 'utf8'));
  const jetra = JSON.parse(fs.readFileSync(path.join(rootDir, 'state', 'jetra-published.json'), 'utf8'));
  assert.equal(telegram.posts[0].retentionStatus, 'deleted');
  assert.equal(telegram.posts[1].retentionStatus, 'outside_api_window');
  assert.equal(bale.posts[0].retentionStatus, undefined);
  assert.equal(rubika.posts[0].retentionStatus, 'deleted');
  assert.equal(eitaa.posts[0].retentionStatus, 'deleted');
  assert.equal(jetra.posts[0].retentionStatus, 'deleted');

  console.log('GOUSHIBAAZ_RETENTION_TESTS_PASSED');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
