'use strict';

const assert = require('node:assert/strict');
const {
  ageHours,
  feedCandidateEligible,
  searchCandidateEligible,
  cleanLegacyRepostTitle,
  cleanRepostCaptionTitle,
  cleanRepostDescription,
  policyTextRiskReason,
  imageDimensionsFromDataUrl,
  scoreFeedCandidate,
  createRepostMetadata,
  normalizeComparable,
  detailGate,
  dailyCount
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
assert.equal(feedCandidateEligible({ ...valid, title: 'پیغام توهین آمیز در پایان مسابقه' }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, title: 'سکانس سریال ایرانی' }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, title: 'تصاویر دوربین مداربسته بدون رضایت افراد' }, { posts: [] }), false);
assert.equal(policyTextRiskReason({ title: 'پیغام توهین آمیز به یک بازیکن' }), 'insult_or_defamation');
assert.equal(policyTextRiskReason({ description: 'دانلود و تماشای رایگان جدیدترین ویدیوها با کیفیت عالی در رسانه آی‌آرمووی.' }), 'external_video_service_advertising');
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
  cleanLegacyRepostTitle('روایتی از یک اتفاق غیرمنتظره', 'کلیپ خنده دار دزد حرفه ای'),
  'دزد حرفه ای',
  'legacy titles must be reduced to the actual title without editorial filler'
);
assert.equal(cleanRepostCaptionTitle('تصاویری دیدنی و خنده دار از سوژه هالووین'), 'سوژه هالووین');
assert.equal(
  cleanRepostCaptionTitle('مسخره کردن فرار از زندان پوکیدم از خنده عالی بود این حتما ببنید'),
  'مسخره کردن فرار از زندان'
);
assert.equal(
  cleanRepostCaptionTitle('چالش یحیی گل محمدی سرمربی پرسپولیس با رکورد دار روپایی'),
  'چالش یحیی گل محمدی با رکورد دار روپایی'
);
assert.equal(
  cleanRepostCaptionTitle('پیغام عجیب و توهین آمیز ساکت الهامی به یحیی گل محمدی در پایان مسابقه فولاد_ نساجی'),
  'پیغام ساکت الهامی به یحیی گل محمدی در پایان مسابقه فولاد_ نساجی'
);
assert.throws(() => cleanRepostCaptionTitle('عنوان کوتاه'), /no_clean_distinct_title_available_without_extra_words/);

const sourceDescription = 'در این ویدئو، هنگام برگزاری مولودی واکنش خانواده به تنها ماندن یکی از اعضا دیده می‌شود و رفتار او باعث خنده اطرافیان می‌شود.';
const rewritten = createRepostMetadata({
  ...valid,
  title: 'طنز خنده دار وقتی مامانت مولودی گرفته و تو تو اتاق تنها موندی',
  description: sourceDescription
}, 'AbC1234');
assert.notEqual(normalizeComparable(rewritten.title), normalizeComparable('طنز خنده دار وقتی مامانت مولودی گرفته و تو تو اتاق تنها موندی'));
assert.notEqual(normalizeComparable(rewritten.description), normalizeComparable(sourceDescription));
assert.ok(rewritten.title.length >= 8);
assert.doesNotMatch(rewritten.title, /ماجرای\s+بامزه/);
assert.doesNotMatch(rewritten.title, /لحظه‌ی\s+تماشایی/);
assert.doesNotMatch(rewritten.title, /روایت\s+تصویری|ماجرای\s+بامزه|روایتی\s+از/);
assert.doesNotMatch(rewritten.description, /روایت\s+تصویری|اجازه|https?:\/\//i);
assert.ok(rewritten.description.length >= 50);
assert.equal(normalizeComparable(rewritten.description).includes(normalizeComparable(rewritten.title)), false);
assert.throws(() => createRepostMetadata({ ...valid, description: 'توضیح کوتاه' }, 'AbC1235'), /repost_description_source_too_short/);
assert.throws(() => createRepostMetadata({ ...valid, title: 'پیغام توهین آمیز به یک بازیکن', description: sourceDescription }, 'AbC1236'), /filo_policy_text_risk:insult_or_defamation/);
assert.throws(() => createRepostMetadata({ ...valid, title: 'لینک https://example.com ویدئو', description: sourceDescription }, 'AbC1237'), /repost_source_title_contains_external_link/);

const high = scoreFeedCandidate(valid);
const low = scoreFeedCandidate({ ...valid, visit_count: 0, play_count: 0, share_count: 0, create_date: 'دیروز' });
assert.ok(high.score > low.score);
const trendBoosted = scoreFeedCandidate(valid, {}, [{
  title: 'مسابقه فوتبال', keywords: ['مسابقه', 'فوتبال'], traffic: 500000, ageHours: 0
}]);
assert.ok(trendBoosted.googleTrend.score > 0);
assert.ok(trendBoosted.score > high.score, 'a fresh, matching Iran trend should increase candidate relevance');

const pngHeader = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHeader, 0);
pngHeader.writeUInt32BE(1600, 16);
pngHeader.writeUInt32BE(900, 20);
assert.deepEqual(imageDimensionsFromDataUrl('data:image/png;base64,' + pngHeader.toString('base64')), { width: 1600, height: 900 });
pngHeader.writeUInt32BE(1200, 16);
pngHeader.writeUInt32BE(900, 20);
const nonWideCover = imageDimensionsFromDataUrl('data:image/png;base64,' + pngHeader.toString('base64'));
assert.equal(Math.abs(nonWideCover.width / nonWideCover.height - 16 / 9) <= 0.02, false);
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
assert.equal(dailyCount(state, Date.parse('2026-11-03T00:05:00.000Z')), 1,
  'the 24-hour window must include recent submissions across UTC midnight');
assert.equal(dailyCount(state, Date.parse('2026-11-03T00:10:00.000Z')), 1,
  'a submission exactly 24 hours old remains inside the rolling window');

console.log('FILO_NATIVE_REPUBLISH_TESTS_PASSED');
