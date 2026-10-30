'use strict';

const assert = require('node:assert/strict');
const { categoryFor, scoreCandidate, rankCandidates, buildTrendWeights } = require('./quality_rank.cjs');

assert.equal(categoryFor('Persian hidden camera prank reaction'), 'persian_comedy');
assert.equal(categoryFor('football trick shot and basketball dunk'), 'sports_skill');
assert.equal(categoryFor('oddly satisfying restoration before and after'), 'satisfying_craft');
assert.equal(categoryFor('آشپزی و ترفندهای غذایی'), 'food_cooking');
assert.equal(categoryFor('unexpected final reveal and plot twist'), 'surprise_reveal');
assert.equal(categoryFor('ترفند کاربردی و راه حل ساده خانه'), 'life_hacks');
assert.equal(categoryFor({ content_lane: 'human_reaction_or_relatable', title: 'لحظه جالب' }), 'human_reaction');

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
assert.ok(scoreCandidate(strong).reasons.some(reason => reason.startsWith('retention_arc:')),
  'curiosity plus payoff signals should improve watch-time retention potential');
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

// Generated Persian captions must not manufacture "strong hook" points.
const genericCaption = {
  fileTitle: 'File:Cute Bird Drinking Water from Bottle Cap.webm',
  description: 'A bird drinks water from a bottle cap offered by a woman.',
  title: 'یه لحظه تماشایی از دنیای پرنده‌ها 🐦',
  durationSeconds: 12,
  sourceAspectRatio: 0.5625
};
const genericRanking = scoreCandidate(genericCaption);
assert.equal(genericRanking.topic, 'pets_animals');
assert.equal(
  genericRanking.reasons.some(reason => reason.startsWith('strong_hook:')),
  false,
  'generic generated captions such as "تماشایی" must not count as source-content hooks'
);

const sourceHook = {
  fileTitle: 'File:Unexpected cat reaction caught on camera.webm',
  description: 'An unexpected reaction when a toy suddenly appears.',
  title: 'یه لحظه بامزه از دنیای گربه‌ها 😹',
  durationSeconds: 12,
  sourceAspectRatio: 0.5625
};
assert.ok(
  scoreCandidate(sourceHook).reasons.some(reason => reason.startsWith('strong_hook:')),
  'specific source-title/description hook signals should still be rewarded'
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
