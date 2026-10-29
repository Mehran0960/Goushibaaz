'use strict';

const assert = require('node:assert/strict');
const { categoryFor, scoreCandidate, rankCandidates, buildTrendWeights } = require('./quality_rank.cjs');

assert.equal(categoryFor('Persian hidden camera prank reaction'), 'persian_comedy');
assert.equal(categoryFor('football trick shot and basketball dunk'), 'sports_skill');
assert.equal(categoryFor('oddly satisfying restoration before and after'), 'satisfying_craft');
assert.equal(categoryFor('آشپزی و ترفندهای غذایی'), 'food_cooking');

const short = scoreCandidate({ fileTitle: 'funny cat', durationSeconds: 5 });
assert.equal(short.eligible, false, 'clips under 8 seconds must be excluded');

const strong = {
  fileTitle: 'Unexpected football trick shot',
  description: 'A surprising skill moment caught on camera',
  durationSeconds: 14,
  sourceAspectRatio: 0.5625,
  views: 120000,
  views_velocity_per_hour: 8000,
  age_hours: 2
};
const weak = {
  fileTitle: 'Animal video',
  description: 'A long general wildlife documentary clip',
  durationSeconds: 110,
  sourceAspectRatio: 1.777,
  views: 500
};
assert.ok(scoreCandidate(strong).score > scoreCandidate(weak).score,
  'fresh, vertical, hook-rich and fast-growing clips should outrank long generic landscape clips');

const recentPets = [
  { title: 'funny cat moment', status: 'published' },
  { title: 'cute dog playing', status: 'published' },
];
const petCandidate = { fileTitle: 'funny cats', description: 'unexpected cat reaction', durationSeconds: 15, sourceAspectRatio: 0.56 };
const diverseCandidate = { fileTitle: 'satisfying woodworking restoration', durationSeconds: 18, sourceAspectRatio: 0.56 };
assert.ok(
  scoreCandidate(diverseCandidate, { recentPosts: recentPets }).score >
  scoreCandidate(petCandidate, { recentPosts: recentPets }).score,
  'recent repetition should make a different eligible topic more competitive'
);

const now = Date.now();
const trends = buildTrendWeights({
  updated_at: new Date(now).toISOString(),
  telegram: {
    a: {
      title: 'آرایشگاه زنونه در برابر آرایشگاه مردونه طنز',
      last_seen_at: new Date(now).toISOString(),
      last_views: 10000,
      history: [
        { at: new Date(now - 5 * 3600000).toISOString(), views: 1000 },
        { at: new Date(now).toISOString(), views: 10000 },
      ],
    },
  },
}, now);
assert.ok(trends.persian_comedy > 0, 'fresh view growth should produce a topic trend hint');

const ranked = rankCandidates([weak, strong]);
assert.equal(ranked[0].fileTitle, strong.fileTitle);
assert.ok(ranked[0].editorialScore > 0);
assert.equal(ranked[0].editorialTopic, 'sports_skill');

console.log('QUALITY_RANK_TESTS_PASSED');
