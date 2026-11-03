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
  isRecoverableCoverGuardBlock,
  isRecoverableCoverPreparationError,
  imageBufferFromDataUrl,
  encodedFormFieldLength,
  trustedFiloMediaUrl,
  buildNativePublishGuardFailures,
  safeApiDiagnosticValue,
  composeFiloCoverDataUrl,
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
assert.equal(isRecoverableCoverGuardBlock({
  status: 'blocked_before_filo_submission',
  publishPayload: { guardFailures: ['cover_aspect_not_16_9'], coverAspectOk: false }
}), true, 'a cover-only rejection must allow trying the next candidate');
assert.equal(isRecoverableCoverGuardBlock({
  status: 'blocked_before_filo_submission',
  publishPayload: { guardFailures: ['cover_frame_missing_or_invalid'], coverAspectOk: false }
}), true, 'a missing cover frame must skip only this candidate');
assert.equal(isRecoverableCoverGuardBlock({
  status: 'blocked_before_filo_submission',
  publishPayload: { guardFailures: ['cover_frame_missing_or_invalid', 'cover_aspect_not_16_9'], coverAspectOk: false }
}), true, 'combined cover-only failures must remain candidate-local');
assert.equal(isRecoverableCoverGuardBlock({
  status: 'blocked_before_filo_submission',
  publishPayload: { guardFailures: ['cover_aspect_not_16_9', 'monetization_permission_missing'], coverAspectOk: false }
}), false, 'never skip a candidate when any permission or policy guard also fails');
assert.equal(isRecoverableCoverGuardBlock({
  status: 'blocked_before_filo_submission',
  publishPayload: { guardFailures: ['monetization_permission_missing'], coverAspectOk: true }
}), false, 'permission failures must not be treated as thumbnail-only failures');
assert.equal(isRecoverableCoverGuardBlock({
  status: 'submitted_unconfirmed',
  publishPayload: { guardFailures: [], coverAspectOk: false }
}), false, 'submitted items must never be retried as an alternate candidate');
assert.equal(isRecoverableCoverPreparationError('filo_source_player_not_ready_for_cover'), true,
  'a source-specific cover failure must skip only that candidate');
assert.equal(isRecoverableCoverPreparationError('filo_cover_capture_control_unavailable'), true);
assert.equal(isRecoverableCoverPreparationError('filo_permission_gate_changed_before_submission:permission_missing'), false,
  'permission failures must never be treated as cover failures');
const decodedSample=imageBufferFromDataUrl('data:image/png;base64,'+pngHeader.toString('base64'));
assert.ok(decodedSample&&decodedSample.buffer.length===pngHeader.length,
  'data URL decoding must provide the image bytes for the thumbnail scorer');
assert.equal(trustedFiloMediaUrl('/media/source.mp4'),'https://ifilo.net/media/source.mp4',
  'relative source media URLs must resolve against Filo');
assert.equal(trustedFiloMediaUrl('https://cdn.ifilo.net/media/source.mp4'),'https://cdn.ifilo.net/media/source.mp4',
  'Filo-owned CDN media URLs must be accepted');
assert.equal(trustedFiloMediaUrl('http://ifilo.net/media/source.mp4'),null,
  'insecure source media URLs must be rejected');
assert.equal(trustedFiloMediaUrl('https://example.com/media/source.mp4'),null,
  'untrusted external media URLs must never be fetched by the thumbnail extractor');
const compactCoverDataUrl='data:image/png;base64,'+'a'.repeat(700000);
assert.ok(encodedFormFieldLength('selectedFrame',compactCoverDataUrl)<=800000,
  'compact fallback cover fits within the selectedFrame request budget');
const oversizedCoverDataUrl='data:image/png;base64,'+'a'.repeat(900000);
assert.ok(encodedFormFieldLength('selectedFrame',oversizedCoverDataUrl)>800000,
  'oversized fallback frame can be detected and omitted before sending the request');


const safePublishContext={
  sourceCode:'Source01',republishFrom:'Source01',videoCode:'NewVid01',
  isMadeByMe:'false',canRepublish:'true',canMakeMoney:'true',dontPublish:'0',metadataOk:true
};
assert.deepEqual(buildNativePublishGuardFailures(safePublishContext),[],
  'a valid source must pass native safety guards');
assert.deepEqual(buildNativePublishGuardFailures({...safePublishContext,metadataOk:false}),
  ['metadata_policy_guard_failed'],
  'metadata policy must remain a hard publishing guard');
assert.ok(buildNativePublishGuardFailures({...safePublishContext,canMakeMoney:'false'})
  .includes('monetization_permission_missing'),
  'missing monetization permission must remain a hard publishing guard');
assert.ok(buildNativePublishGuardFailures({...safePublishContext,canRepublish:'false'})
  .includes('native_republish_permission_missing'),
  'missing native repost permission must remain a hard publishing guard');
assert.deepEqual(buildNativePublishGuardFailures({
  ...safePublishContext,selectedFramePresent:false,coverAspectOk:false
}),[],
  'a missing cover and non-16:9 video frame must not block the publish request');
assert.equal(buildNativePublishGuardFailures(safePublishContext).some(reason=>/cover|frame|thumbnail/i.test(reason)),false,
  'cover selection and aspect ratio must never block the publish request');
assert.equal(safeApiDiagnosticValue({r:'خطا\nتکرار',items:[1,2,3]}).r,'خطا تکرار',
  'Filo diagnostics must sanitize multiline response fields');

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

async function testPortraitCoverComposition() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 600;
      const context = canvas.getContext('2d');
      context.fillStyle = '#244caa';
      context.fillRect(0, 0, 300, 600);
      context.fillStyle = '#f02020';
      context.fillRect(0, 0, 300, 28);
      context.fillStyle = '#20d060';
      context.fillRect(0, 572, 300, 28);
      return canvas.toDataURL('image/jpeg', 0.96);
    });
    const composed = await composeFiloCoverDataUrl(page, source);
    assert.equal(composed.ok, true, 'portrait cover must compose into a valid landscape image');
    assert.deepEqual(composed.sourceDimensions, { width: 300, height: 600 });
    assert.deepEqual(composed.dimensions, { width: 640, height: 360 });
    assert.ok(composed.encodedLength <= 800000,
      'the complete URL-encoded selectedFrame field must stay below Filo’s request limit');
    assert.equal(composed.strategy, 'blurred_background_full_frame_contain_compact_png_v1');
    assert.equal(composed.dataUrl.startsWith('data:image/png;base64,'), true,
      'the composed cover must retain Filo native PNG data URL format');

    const preserved = await page.evaluate(async dataUrl => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const top = context.getImageData(320, 5, 1, 1).data;
      const bottom = context.getImageData(320, 350, 1, 1).data;
      return { topRed: top[0], topGreen: top[1], bottomGreen: bottom[1], bottomRed: bottom[0] };
    }, composed.dataUrl);
    assert.ok(preserved.topRed > preserved.topGreen,
      'the top of a portrait frame must remain visible in the landscape cover');
    assert.ok(preserved.bottomGreen > preserved.bottomRed,
      'the bottom of a portrait frame must remain visible in the landscape cover');
  } finally {
    await browser.close();
  }
}

async function runAsyncTests() {
  await testPortraitCoverComposition();
  console.log('FILO_NATIVE_REPUBLISH_TESTS_PASSED');
}
runAsyncTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
