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
const petCandidate = { fileTitle: 'Unexpected cat jumpscare caught on camera', description: 'A cat suddenly leaps in front of a doorbell camera.', durationSeconds: 15, sourceAspectRatio: 0.56 };
const diverseCandidate = { fileTitle: 'Unexpected wood restoration before and after reveal', description: 'A damaged chair is transformed into a polished design.', durationSeconds: 18, sourceAspectRatio: 0.56 };
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
assert.equal(genericRanking.eligible, false, 'topic-only footage without a source-backed hook must not publish');
assert.ok(genericRanking.reasons.includes('no_verifiable_source_hook'), 'generated captions cannot manufacture source hooks');

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


const blandLandscapeRecipe = scoreCandidate({
  fileTitle: 'Redcurrant jam recipe 19',
  description: 'A person slowly stirs redcurrant jam in a saucepan.',
  durationSeconds: 35,
  sourceAspectRatio: 1.333,
  sourceWidth: 640,
  sourceHeight: 480
});
assert.equal(blandLandscapeRecipe.eligible, false, 'ordinary landscape recipe footage must not be forced into a vertical post');
assert.ok(blandLandscapeRecipe.reasons.includes('source_not_native_portrait'));

const vagueChallenge = scoreCandidate({
  fileTitle: 'Commons challenge',
  description: '',
  durationSeconds: 14,
  sourceAspectRatio: 0.5625
});
assert.equal(vagueChallenge.eligible, false, 'generic archive filenames must not pass as specific entertainment');

const nonHookRecipe = scoreCandidate({
  fileTitle: 'Redcurrant jam recipe',
  description: 'A recipe for making redcurrant jam at home.',
  durationSeconds: 34,
  sourceAspectRatio: 0.5625
});
assert.equal(nonHookRecipe.eligible, false, 'a topic label alone is not evidence of an engaging short-video hook');

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


const audienceComedy = {
  fileTitle: 'File:Persian hidden camera prank with a funny reaction.webm',
  description: 'A harmless single-event comedy clip with a clear payoff.',
  durationSeconds: 18,
  sourceAspectRatio: 0.5625,
  age_hours: 2,
  views_velocity_per_hour: 12000
};
const institutionalSpace = {
  fileTitle: 'NASA Mars rover footage',
  description: 'Space science and a long institutional research clip.',
  durationSeconds: 40,
  sourceAspectRatio: 1.777,
  age_hours: 2
};
assert.ok(scoreCandidate(audienceComedy).score > scoreCandidate(institutionalSpace).score,
  'Iranian-audience comedy should outrank generic institutional/science footage');

const trendLaneMatch = scoreCandidate({
  fileTitle: 'Unexpected athletic trick shot with a surprising payoff',
  description: 'One continuous sports skill clip.',
  durationSeconds: 16,
  sourceAspectRatio: 0.5625,
  trendSearchTitle: 'Unexpected athletic skill trick shot',
  trendSearchLane: 'skill_or_spectacle'
});
assert.equal(trendLaneMatch.topic, 'sports_skill',
  'a closely matched observed trend lane should guide the licensed clip topic');
const acceleratingTrendMatch = scoreCandidate({
  fileTitle: 'Unexpected athletic trick shot with a surprising payoff',
  description: 'One continuous sports skill clip.',
  durationSeconds: 16,
  sourceAspectRatio: 0.5625,
  trendSearchTitle: 'Unexpected athletic skill trick shot',
  trendSearchLane: 'skill_or_spectacle',
  trendSearchAcceleration: 12000
});
assert.ok(acceleratingTrendMatch.score > trendLaneMatch.score,
  'a licensed clip matching an accelerating observed trend should receive an additional ranking bonus');
assert.ok(acceleratingTrendMatch.reasons.some(reason => reason.startsWith('observed_trend_acceleration:')),
  'the acceleration bonus should be auditable');

assert.equal(scoreCandidate({
  fileTitle: 'Election campaign and political rally footage',
  description: 'A current affairs clip.',
  durationSeconds: 20
}).eligible, false, 'political/current-affairs footage must not pass the entertainment publisher');

assert.equal(scoreCandidate({
  fileTitle: 'A sponsored product discount code and buy now promotion',
  description: 'Use my code to shop now.',
  durationSeconds: 20
}).eligible, false, 'promotional content must not enter the audience channel');

const roundup = scoreCandidate({
  fileTitle: 'Compilation of the best funny moments',
  description: 'Top 10 viral moments roundup.',
  durationSeconds: 30
});
assert.equal(roundup.eligible, false, 'compilations and roundups must be rejected rather than merely down-ranked');
assert.ok(roundup.reasons.includes('multi_clip_roundup_not_allowed'));

const ranked = rankCandidates([weak, strong]);
assert.equal(ranked[0].fileTitle, strong.fileTitle);
assert.ok(ranked[0].editorialScore > 0);
assert.equal(ranked[0].editorialTopic, 'sports_skill');

console.log('QUALITY_RANK_TESTS_PASSED');
