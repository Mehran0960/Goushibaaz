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

  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () => url.includes('/deleteMessage')
        ? (url.includes('botapi.rubika.ir')
            ? JSON.stringify({ status: 'OK', data: true })
            : JSON.stringify({ ok: true, result: true }))
        : JSON.stringify({ status: 'OK', data: { chat: { chat_id: 'rubika-chat', username: 'didobyn' } } })
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
      TELEGRAM_CHAT_ID: '@didobyn',
      BALE_CHANNEL_ID: '@didobyn'
    }
  });

  assert.equal(calls.length, 2, 'only Telegram at 47h and Rubika at 60h should be deleted');
  assert.equal(report.platforms.telegram.deleted, 1);
  assert.equal(report.platforms.telegram.outsideApiWindow, 1);
  assert.equal(report.platforms.bale.deleted, 0);
  assert.equal(report.platforms.rubika.deleted, 1);

  const telegram = JSON.parse(fs.readFileSync(path.join(rootDir, 'state', 'telegram-published.json'), 'utf8'));
  const bale = JSON.parse(fs.readFileSync(path.join(rootDir, 'state', 'bale-published.json'), 'utf8'));
  const rubika = JSON.parse(fs.readFileSync(path.join(rootDir, 'state', 'rubika-published.json'), 'utf8'));
  assert.equal(telegram.posts[0].retentionStatus, 'deleted');
  assert.equal(telegram.posts[1].retentionStatus, 'outside_api_window');
  assert.equal(bale.posts[0].retentionStatus, undefined);
  assert.equal(rubika.posts[0].retentionStatus, 'deleted');

  console.log('GOUSHIBAAZ_RETENTION_TESTS_PASSED');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
