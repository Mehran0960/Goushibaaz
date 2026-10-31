'use strict';

const assert = require('node:assert/strict');
const { PEXELS_LICENSE_URL, chooseVideoFile, videoToCandidate, discoverPexelsCandidates } = require('./pexels_source.cjs');

const fixture = {
  id: 12345,
  url: 'https://www.pexels.com/video/a-cat-playing-with-a-ball-12345/',
  width: 720,
  height: 1280,
  duration: 18,
  tags: ['cat', 'playing', 'pet', 'funny'],
  user: { name: 'Example Creator', url: 'https://www.pexels.com/@example' },
  video_files: [
    { quality: 'hd', file_type: 'video/mp4', width: 720, height: 1280, link: 'https://videos.pexels.com/video-files/example-hd.mp4' },
    { quality: 'sd', file_type: 'video/mp4', width: 360, height: 640, link: 'https://videos.pexels.com/video-files/example-sd.mp4' }
  ]
};

assert.equal(chooseVideoFile(fixture).width, 720);
const candidate = videoToCandidate(fixture, { mode: 'search' });
assert.ok(candidate);
assert.equal(candidate.sourceType, 'pexels');
assert.equal(candidate.licenseName, 'Pexels License');
assert.equal(candidate.licenseUrl, PEXELS_LICENSE_URL);
assert.equal(candidate.sourcePage, fixture.url);
assert.equal(candidate.author, 'Example Creator');
assert.match(candidate.descriptionText, /Pexels License/);
assert.equal(videoToCandidate({ ...fixture, duration: 3 }), null);
assert.equal(videoToCandidate({ ...fixture, url: 'https://example.com/video/123' }), null);
assert.equal(videoToCandidate({ ...fixture, video_files: [] }), null);
assert.equal(videoToCandidate({ ...fixture, tags: [] }), null);

(async () => {
  const state = {};
  const skipped = await discoverPexelsCandidates({ state, apiKey: '' });
  assert.deepEqual(skipped, [], 'Pexels must be optional when no API key is configured');
  assert.equal(state.pexelsLastCheckedAt, undefined, 'missing key must not consume an API slot');
  console.log('PEXELS_SOURCE_TESTS_PASSED');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
