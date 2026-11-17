'use strict';

const assert = require('node:assert/strict');
const {
  inspectFiloUrlImportCandidate,
  isVerticalMediaForUrlImport
} = require('./filo_url_import.cjs');

const validCommons = {
  fileUrl: 'https://upload.wikimedia.org/wikipedia/commons/3/3a/sample.mp4',
  mime: 'video/mp4',
  size: 2_000_000
};
assert.equal(inspectFiloUrlImportCandidate(validCommons).eligible, true);

const validArchive = {
  fileUrl: 'https://ia800000.us.archive.org/23/items/sample/sample.webm',
  mime: 'video/webm',
  size: 3_000_000
};
assert.equal(inspectFiloUrlImportCandidate(validArchive).eligible, true);

const validPexels = {
  fileUrl: 'https://videos.pexels.com/video-files/12345/12345-hd_720_1280_30fps.mp4',
  mime: 'video/mp4',
  size: 8_000_000
};
assert.equal(inspectFiloUrlImportCandidate(validPexels).eligible, true);

for (const blocked of [
  'https://www.aparat.com/v/abcd123',
  'https://www.youtube.com/shorts/abcd123',
  'https://t.me/channel/123',
  'https://www.instagram.com/reel/abcd123',
  'https://telewebion.com/video/abcd',
  'https://hostdl.net/sample.mp4'
]) {
  assert.equal(inspectFiloUrlImportCandidate({
    fileUrl: blocked, mime: 'video/mp4', size: 2_000_000
  }).eligible, false, 'blocked social/platform URLs must not enter Filo URL import');
}

assert.equal(inspectFiloUrlImportCandidate({
  ...validCommons, fileUrl: 'http://upload.wikimedia.org/sample.mp4'
}).reason, 'https_required');
assert.equal(inspectFiloUrlImportCandidate({
  ...validCommons, fileUrl: 'https://example.com/sample.mp4'
}).reason, 'media_host_not_allowlisted');
assert.equal(inspectFiloUrlImportCandidate({
  ...validCommons, fileUrl: 'https://upload.wikimedia.org/sample.m3u8'
}).reason, 'unsupported_direct_video_extension');
assert.equal(inspectFiloUrlImportCandidate({
  ...validCommons, mime: 'video/webm'
}).reason, 'media_mime_extension_mismatch');
assert.equal(inspectFiloUrlImportCandidate({
  ...validCommons, size: 50_000_000
}).reason, 'media_size_out_of_range');

assert.equal(isVerticalMediaForUrlImport({
  width: 720, height: 1280, durationSeconds: 45
}), true);
assert.equal(isVerticalMediaForUrlImport({
  width: 1920, height: 1080, durationSeconds: 45
}), false);
assert.equal(isVerticalMediaForUrlImport({
  width: 720, height: 1280, durationSeconds: 181
}), false);
assert.equal(isVerticalMediaForUrlImport({
  width: 0, height: 1280, durationSeconds: 45
}), false);

console.log('FILO_URL_IMPORT_TESTS_OK');
