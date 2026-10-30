'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { appendFiloEndCard } = require('./filo_endcard.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goushibaaz-filo-endcard-'));
try {
  const input = path.join(dir, 'input.mp4');
  const output = path.join(dir, 'output.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x2A3342:s=720x1280:d=2:r=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    input
  ], { stdio: 'pipe', timeout: 30000 });

  const result = appendFiloEndCard(input, output, {
    width: 720,
    height: 1280,
    durationSeconds: 1.6
  });
  assert.equal(result.width, 720);
  assert.equal(result.height, 1280);
  assert.equal(result.endCardSeconds, 1.6);
  assert.ok(result.durationSeconds >= 3.48);
  assert.ok(result.outputBytes > 1000);
  assert.ok(fs.existsSync(output));
  console.log('FILO_END_CARD_TESTS_PASSED', JSON.stringify(result));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
