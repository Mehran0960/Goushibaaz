'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { probeMedia, buildPortraitFilter, convertToPortrait } = require('./media_format.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goushibaaz-media-format-'));
try {
  const input = path.join(dir, 'source-landscape.mp4');
  const output = path.join(dir, 'vertical-full-frame.mp4');
  // A landscape source with a visible edge marker and a real audio tone.
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
    '-vf', 'drawbox=x=0:y=0:w=18:h=180:color=red:t=fill',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-shortest', input
  ], { stdio: 'pipe', timeout: 30000 });

  const source = probeMedia(input);
  assert.equal(source.width, 320);
  assert.equal(source.height, 180);
  assert.ok(source.audio, 'source audio must be detected');

  const filter = buildPortraitFilter(180, 320);
  assert.match(filter, /\[fgsrc\]scale=180:320:force_original_aspect_ratio=decrease\[fg\]/,
    'the foreground must fit within the portrait canvas instead of being cropped');
  assert.match(filter, /boxblur=/, 'a blurred background should fill the unused canvas area');

  const result = convertToPortrait(input, output, {
    width: 180,
    height: 320,
    maxBytes: 10_000_000,
    crf: 28,
    maxrate: '500k',
    bufsize: '1000k',
    timeoutMs: 60000
  });
  assert.equal(result.width, 180);
  assert.equal(result.height, 320);
  assert.equal(result.audioCodec, 'aac');
  assert.ok(result.durationSeconds >= 4.8);
  assert.ok(result.outputBytes > 1000);

  const noAudio = path.join(dir, 'silent-source.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2:r=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', noAudio
  ], { stdio: 'pipe', timeout: 30000 });
  assert.throws(() => convertToPortrait(noAudio, path.join(dir, 'should-not-exist.mp4'), {
    width: 180, height: 320
  }), /source_audio_track_missing/, 'silent source media must fail closed');

  console.log('MEDIA_FORMAT_TESTS_PASSED', JSON.stringify(result));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
