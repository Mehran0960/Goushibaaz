'use strict';

const assert = require('node:assert/strict');
const {
  ageHours,
  feedCandidateEligible,
  cleanRepostCaptionTitle,
  cleanRepostDescription,
  policyTextRiskReason,
  imageDimensionsFromDataUrl,
  createRepostMetadata,
  normalizeComparable,
  detailGate,
  buildNativePublishGuardFailures,
  safeApiDiagnosticValue,
  buildUnconfirmedSubmissionResult,
  composeFiloCoverDataUrl,
  dailyCount,
  updateCandidateMomentum,
  rankCandidatesByMomentum
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
assert.equal(cleanRepostCaptionTitle('دزد حرفه ای؛ روایتی از یک اتفاق غیرمنتظره'), 'دزد حرفه ای',
  'generic editorial suffixes must not survive in a concise title');
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
assert.equal(cleanRepostCaptionTitle('بدل بهنام بانی در قوچان'), 'بدل بهنام بانی در قوچان',
  'a usable source title must not be truncated to force an artificial rewrite');
assert.equal(cleanRepostCaptionTitle('مردی که روغن گریس میخورد!'), 'مردی که روغن گریس میخورد',
  'an already meaningful title must retain its full meaning');
assert.equal(cleanRepostCaptionTitle('اگه گفتی این بی مزه ها چرا انقدر موقع پخت ماکارونی میخندن'),
  'چرا این‌قدر موقع پخت ماکارونی می‌خندند؟',
  'clickbait phrasing must become a clear, factual question without the insulting lead-in');
assert.equal(
  cleanRepostCaptionTitle(
    'ریمیک جدید گاد آف وار ۲ برای کنسول PS5',
    'ریمیکی جذاب از یکی از طرفداران گاد آف وار برای شما عزیزان.'
  ),
  'ریمیک طرفداری از گاد آف وار ۲ برای PS5',
  'fan-made attribution is allowed only when supported by the source description'
);
assert.throws(() => cleanRepostCaptionTitle('عنوان'), /no_clean_distinct_title_available_without_extra_words/);

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
const unicodePromo = cleanRepostDescription(
  'مادر و فرزند در حال آماده کردن سالاد ماکارونی هستند و مراحل را کنار هم انجام می‌دهند. 𝗝𝗈𝗂𝗇︎𝗨𝗌 𝗘𝗑︎𝖼︎𝗂𝗍𝖾𝖽 👾 𝗖𝗅︎𝖎𝖈𝖐↝',
  'عنوان منبع متفاوت و طولانی',
  'ویدئوی ماکارونی'
);
assert.match(unicodePromo, /سالاد ماکارونی/);
assert.doesNotMatch(unicodePromo, /join\s*us|excited|click/i,
  'Unicode-styled English promotions must be normalized and stripped');
const shortButUseful = cleanRepostDescription(
  'بچه و مامانش سالاد ماکارونی درست میکنن 😂🤣 𝗝𝗈𝗂𝗇︎𝗨𝗌 𝗘𝗑︎𝖼︎𝗂𝗍𝖾𝖽 𝗖𝗅︎𝗂𝖼𝗄',
  'عنوان منبع متفاوت و طولانی',
  'ویدئوی ماکارونی'
);
assert.ok(shortButUseful.length >= 35 && shortButUseful.length < 50,
  'a concise, factual description remains usable after promo and emoji cleanup');
const promoCleaned = cleanRepostDescription(
  'ریمیکی جذاب از یکی از طرفداران گاد آف وار برای شما عزیزان. همراه ما باشید و لذت ببرید. 🔥',
  'ریمیک جدید گاد آف وار ۲ برای کنسول PS5',
  'ریمیک طرفداری از گاد آف وار ۲ برای PS5'
);
assert.match(promoCleaned, /طرفداران گاد آف وار/);
assert.doesNotMatch(promoCleaned, /برای شما عزیزان|همراه ما|لذت ببرید|🔥/,
  'generic audience address, engagement prompts, and decorative emoji must be removed');
const alreadyCleanMetadata = createRepostMetadata({
  ...valid,
  title: 'مردی که روغن گریس میخورد!',
  description: 'در این ویدئو، مردی در حال خوردن روغن گریس را نشان می‌دهد و واکنش اطرافیان دیده می‌شود. این رفتار غیرمعمول توجه افراد حاضر را جلب می‌کند.'
}, 'AbC1238');
assert.equal(alreadyCleanMetadata.title, 'مردی که روغن گریس میخورد',
  'an already-clean title is valid metadata when its description is independently substantive');
assert.notEqual(normalizeComparable(alreadyCleanMetadata.description), normalizeComparable('در این ویدئو، مردی در حال خوردن روغن گریس را نشان می‌دهد و واکنش اطرافیان دیده می‌شود. این رفتار غیرمعمول توجه افراد حاضر را جلب می‌کند.'));
assert.throws(() => createRepostMetadata({ ...valid, description: 'توضیح کوتاه' }, 'AbC1235'), /repost_description_source_too_short/);
assert.throws(() => createRepostMetadata({ ...valid, title: 'پیغام توهین آمیز به یک بازیکن', description: sourceDescription }, 'AbC1236'), /filo_policy_text_risk:insult_or_defamation/);
assert.throws(() => createRepostMetadata({ ...valid, title: 'لینک https://example.com ویدئو', description: sourceDescription }, 'AbC1237'), /repost_source_title_contains_external_link/);

const pngHeader = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHeader, 0);
pngHeader.writeUInt32BE(1600, 16);
pngHeader.writeUInt32BE(900, 20);
assert.deepEqual(imageDimensionsFromDataUrl('data:image/png;base64,' + pngHeader.toString('base64')), { width: 1600, height: 900 });
pngHeader.writeUInt32BE(1200, 16);
pngHeader.writeUInt32BE(900, 20);
const nonWideCover = imageDimensionsFromDataUrl('data:image/png;base64,' + pngHeader.toString('base64'));
assert.equal(Math.abs(nonWideCover.width / nonWideCover.height - 16 / 9) <= 0.02, false);
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

const unconfirmed=buildUnconfirmedSubmissionResult({
 sourceCode:'Source01',newVideoCode:'NewVid01',publishPayload:{sourceCode:'Source01',newVideoCode:'NewVid01'},
 repostTitle:'عنوان تازه',repostDescription:'توضیح کامل برای ثبت وضعیت ارسال نامشخص'
});
assert.equal(unconfirmed.status,'submitted_unconfirmed');
assert.equal(unconfirmed.sourceCode,'Source01');
assert.equal(unconfirmed.newVideoCode,'NewVid01',
 'unconfirmed submissions must retain the generated video code for later public reconciliation');
assert.equal(unconfirmed.repostMetadata.title,'عنوان تازه',
 'unconfirmed submissions must retain the expected title for later public verification');


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

const momentumState = { posts: [] };
const momentumStart = Date.parse('2026-11-04T00:00:00.000Z');
const baseline = [
  { video_code: 'Slow01', title: 'ویدئوی تازه اول', create_date: '۲ ساعت پیش', visit_count: 100, plays: 10 },
  { video_code: 'Fast01', title: 'ویدئوی تازه دوم', create_date: '۲ ساعت پیش', visit_count: 100, plays: 10 },
  { video_code: 'Old001', title: 'ویدئوی قدیمی', create_date: 'دیروز', visit_count: 100, plays: 10 }
];
assert.deepEqual(rankCandidatesByMomentum(baseline, momentumState, momentumStart), [],
  'first sighting is only a baseline and must not be mistaken for growth');

const secondScan = [
  { ...baseline[0], visit_count: 200, plays: 20 },
  { ...baseline[1], visit_count: 200, plays: 20 },
  { ...baseline[2], visit_count: 400, plays: 30 }
];
const secondRank = rankCandidatesByMomentum(secondScan, momentumState, momentumStart + 10 * 60 * 1000);
assert.equal(secondRank.length, 2, 'videos older than 24 hours are excluded');
assert.equal(secondRank[0].item.video_code, 'Slow01');
assert.equal(secondRank[0].momentum.viewsPerMinute, 10);

const thirdScan = [
  { ...baseline[0], visit_count: 500, plays: 50 },
  { ...baseline[1], visit_count: 300, plays: 30 },
  { ...baseline[2], visit_count: 900, plays: 60 }
];
const thirdRank = rankCandidatesByMomentum(thirdScan, momentumState, momentumStart + 20 * 60 * 1000);
assert.equal(thirdRank[0].item.video_code, 'Slow01',
  'the video with the highest measured views per minute must rank first');
assert.equal(thirdRank[0].momentum.viewsPerMinute, 30);
assert.equal(thirdRank[0].momentum.accelerationPerMinute, 20);
assert.equal(thirdRank[1].momentum.viewsPerMinute, 10);

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
