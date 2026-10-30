'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildOriginalPuzzleVideo } = require('./original_puzzle_video.cjs');
const bank = require('../content/original-puzzle-bank.json');

const puzzle = bank.puzzles[0];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goushibaaz-original-video-'));
try {
  const outputPath = path.join(dir, 'original.webm');
  const result = buildOriginalPuzzleVideo(puzzle, {
    outputPath,
    workDir: dir,
    espeakBin: process.env.ESPEAK_NG_BIN || 'espeak-ng',
    width: 720,
    height: 1280
  });
  assert.equal(result.width, 720);
  assert.equal(result.height, 1280);
  assert.ok(result.durationSeconds >= 8 && result.durationSeconds <= 180);
  assert.equal(result.audio, 'Persian eSpeak NG narration');
  assert.ok(result.sourceBytes > 50000);
  assert.ok(fs.existsSync(outputPath));
  console.log('ORIGINAL_PUZZLE_VIDEO_TESTS_PASSED', JSON.stringify(result));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
