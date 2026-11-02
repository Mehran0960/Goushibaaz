'use strict';

const assert = require('node:assert/strict');
const {
  ageHours,
  feedCandidateEligible,
  searchCandidateEligible,
  cleanLegacyRepostTitle,
  scoreFeedCandidate,
  createRepostMetadata,
  normalizeComparable,
  detailGate,
  dailyCount,
  lastSubmissionTime,
  millisecondsUntilNextPublication,
  waitForPublicationGap
} = require('./filo_native_republish.cjs');

const valid = {
  video_code: 'AbC1234',
  title: 'یک چالش بامزه و غیرمنتظره در مسابقه فوتبال',
  description: 'لحظه جالب و خنده دار مسابقه',
  category_id: 6,
  duration: 28,
  visit_count: 1200,
  play_count: 900,
  share_count: 20,
  create_date: '۲ ساعت پیش',
  can_republish: 1,
  is_publish_able: 1,
  active: 1,
  status_id: 1,
  file_deleted: 0,
  only_in_filo: 0,
  has_audio: 1,
  can_make_money: 1
};

assert.equal(ageHours({ create_date: '۲ ساعت پیش' }), 2);
assert.equal(feedCandidateEligible(valid, { posts: [] }), true);
assert.equal(searchCandidateEligible({ video_code: 'Trend01', title: 'لحظه دیدنی مسابقه فوتبال', duration: 28 }, { posts: [] }), true);
assert.equal(searchCandidateEligible({ video_code: 'Trend02', title: 'خبر فوری جنگ و حمله نظامی' }, { posts: [] }), false);
assert.equal(searchCandidateEligible({ video_code: 'Trend01', title: 'لحظه دیدنی مسابقه فوتبال' }, { posts: [{ sourceCode: 'Trend01', status: 'public_verified' }] }), false);
assert.equal(feedCandidateEligible({ ...valid, can_republish: 0 }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, is_publish_able: 0 }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, only_in_filo: 1 }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, duration: 8 }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, duration: 9 }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, duration: 10 }, { posts: [] }), true);
assert.equal(feedCandidateEligible({ ...valid, duration: 240 }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, title: 'خبر فوری جنگ و حمله نظامی' }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, title: 'رقص و حرکات موزون' }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, title: 'صحنه اعدام با سلاح' }, { posts: [] }), false);
assert.equal(feedCandidateEligible(valid, { posts: [{ sourceCode: 'AbC1234', status: 'submitted_pending_approval' }] }), false);
assert.equal(feedCandidateEligible(valid, { posts: [{ sourceCode: 'AbC1234', status: 'submitted_unconfirmed' }] }), false);
assert.equal(
  normalizeComparable('ماجرای بامزه‌ی «دستشویی رفتن آقایون»'),
  normalizeComparable('ماجرای بامزه ی «دستشویی رفتن آقایون»')
);
assert.equal(
  normalizeComparable('كلیپ خنده دار'),
  normalizeComparable('کلیپ خنده دار')
);
assert.equal(cleanLegacyRepostTitle('ماجرای بامزه‌ی «دستشویی رفتن آقایون»'), 'دستشویی رفتن آقایون');
assert.equal(cleanLegacyRepostTitle('عنوان بدون پیشوند'), 'عنوان بدون پیشوند');
assert.equal(
  cleanLegacyRepostTitle('ماجرای بامزه‌ی «دزد حرفه ای»', 'کلیپ خنده دار دزد حرفه ای'),
  'دزد حرفه ای؛ روایتی از یک اتفاق غیرمنتظره',
  'short legacy titles must be expanded so Filo does not reject the caption edit'
);

const rewritten = createRepostMetadata({ ...valid, title: 'طنز خنده دار وقتی مامانت مولودی گرفته و تو تو اتاق تنها موندی', description: 'توضیحات اصلی با متن بلند و تکراری' }, 'AbC1234');
assert.notEqual(normalizeComparable(rewritten.title), normalizeComparable('طنز خنده دار وقتی مامانت مولودی گرفته و تو تو اتاق تنها موندی'));
assert.notEqual(normalizeComparable(rewritten.description), normalizeComparable('توضیحات اصلی با متن بلند و تکراری'));
assert.ok(rewritten.title.length >= 8);
assert.doesNotMatch(rewritten.title, /ماجرای\s+بامزه/);
assert.doesNotMatch(rewritten.title, /لحظه‌ی\s+تماشایی/);
assert.ok(rewritten.description.length >= 50);
assert.match(rewritten.description, /اجازه/);
assert.doesNotMatch(rewritten.description, /https?:\/\//i);

const high = scoreFeedCandidate(valid);
const low = scoreFeedCandidate({ ...valid, visit_count: 0, play_count: 0, share_count: 0, create_date: 'دیروز' });
assert.ok(high.score > low.score);
const trendBoosted = scoreFeedCandidate(valid, {}, [{
  title: 'مسابقه فوتبال', keywords: ['مسابقه', 'فوتبال'], traffic: 500000, ageHours: 0
}]);
assert.ok(trendBoosted.googleTrend.score > 0);
assert.ok(trendBoosted.score > high.score, 'a fresh, matching Iran trend should increase candidate relevance');
assert.equal(detailGate({}, { ...valid }).eligible, false, 'global search must never bypass the native Filo permission gate');

assert.deepEqual(detailGate({ is_republish: 1, stop_upload: 0 }, {
  can_republish: 1, active: 1, status_id: 1, file_deleted: 0,
  only_in_filo: 0, has_audio: 1, can_make_money: 1, duration: 32
}), { eligible: true, reason: 'filo_native_republish_permitted' });

assert.equal(detailGate({ is_republish: 1 }, { ...valid, can_republish: 0, duration: 32 }).eligible, false);
assert.equal(detailGate({ is_republish: 0 }, { ...valid, duration: 32 }).eligible, false);
assert.equal(detailGate({ is_republish: 1, stop_upload: 1 }, { ...valid, duration: 32 }).eligible, false);
assert.equal(detailGate({ is_republish: 1 }, { ...valid, only_in_filo: 1, duration: 32 }).eligible, false);
assert.equal(detailGate({ is_republish: 1 }, { ...valid, duration: 9 }).eligible, false);

const state = {
  posts: [
    { sourceCode: 'old', status: 'public_verified', submittedAt: '2026-11-02T00:00:00.000Z' },
    { sourceCode: 'pending', status: 'submitted_pending_approval', submittedAt: '2026-11-02T00:10:00.000Z' },
    { sourceCode: 'rejected', status: 'rejected_by_filo', attemptedAt: '2026-11-02T00:20:00.000Z' }
  ]
};
assert.equal(dailyCount(state, Date.parse('2026-11-02T12:00:00.000Z')), 2);
assert.equal(lastSubmissionTime(state), Date.parse('2026-11-02T00:10:00.000Z'));
assert.equal(millisecondsUntilNextPublication(state, Date.parse('2026-11-02T00:14:59.000Z')), 1000);
assert.equal(millisecondsUntilNextPublication(state, Date.parse('2026-11-02T00:15:00.000Z')), 0);
(async () => {
  let fakeNow = Date.parse('2026-11-02T00:14:00.000Z');
  const waitReport = {};
  const waitCalls = [];
  await waitForPublicationGap(state, waitReport, {
    now: () => fakeNow,
    sleep: async ms => {
      waitCalls.push(ms);
      fakeNow += ms;
    }
  });
  assert.equal(waitCalls.length, 1);
  assert.equal(waitCalls[0], 60750);
  assert.equal(millisecondsUntilNextPublication(state, fakeNow), 0);
  assert.equal(waitReport.status, 'waiting_for_minimum_publication_gap');
  assert.equal(waitReport.minimumGapWaitedMs, 60750);

  console.log('FILO_NATIVE_REPUBLISH_TESTS_PASSED');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
