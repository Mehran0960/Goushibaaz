'use strict';

const assert = require('node:assert/strict');
const {
  ageHours,
  shouldStartPublishingCycle,
  feedCandidateEligible,
  feedGateHintScore,
  isMetadataValidationRejectionReason,
  hasRetryableMetadataRejection,
  isSourceAlreadyAttempted,
  markMetadataPolicyRetry,
  summarizeFeedGateSignals,
  summarizeCandidateChecks,
  fitFiloTitleLength,
  cleanRepostCaptionTitle,
  cleanRepostDescription,
  policyTextRiskReason,
  imageDimensionsFromDataUrl,
  createRepostMetadata,
  normalizeComparable,
  detailGate,
  buildNativePublishGuardFailures,
  parseFiloPublishRequestBody,
  parseMultipartPublishBody,
  getPublishBodyParam,
  serializeFiloPublishRequestBody,
  setJsonPublishBodyField,
  safeApiDiagnosticValue,
  categoryApiErrorHint,
  detailFetchHttpDisposition,
  getCachedDetailAccessRejection,
  jalaliDateToGregorianTimestamp,
  editorialTitleQualityReason,
  buildUnconfirmedSubmissionResult,
  composeFiloCoverDataUrl,
  dailyCount,
  getPublicationOperationTimes,
  getPublicationPacingGate,
  cleanRepostCaptionTitle,
  cleanRepostDescription,
  editorialTitleQualityReason,
  buildCategoryPageRequestPayload,
  buildVideoTagFeedPath,
  normalizeVideoFeedItem,
  extractVideoTagFeeds,
  summarizeVideoTagPayload,
  candidateMetricValue,
  candidateMetricSnapshot,
  updateCandidateMomentum,
  classifyAudienceFit,
  durationPreferenceScore,
  summarizeTopicDemand,
  buildFreshPlatformTrendWeights,
  candidateExternalTopicKey,
  isAccountRepublishQuotaMessage,
  setAccountRepublishQuotaCooldown,
  getAccountRepublishQuotaCooldown,
  releaseOneLegacy403CacheForAccountQuotaProbe,
  rankCandidatesByMomentum,
  extractCategoryIds,
  summarizeCategoryCatalogPayload,
  rotatingDepthSelection,
  nextCategoryDepthPage,
  resolveDepthScanStartPage,
  getCachedCandidateRejection,
  candidateMetadataFingerprint,
  isTitleRewriteRejectionReason,
  cacheCandidateRejection,
  removeRepeatedTrailingPhrase,
  reliableFeedAgeBounds,
  analyzeCategoryFeedPage,
  categoryFeedBoundaryOrdered,
  shouldStopCategoryPagination,
  editorialTitleTokens,
  createDistinctRepostTitle,
  descriptionBasedTitleCandidate,
  topicDuplicateMatch,
  isCandidateLevelFiloRejection
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
const jalaliNow = Date.parse('2026-11-05T06:30:00.000Z');
assert.equal(ageHours({ create_date: '۱۴۰۵/۰۸/۱۴ ساعت ۰۹:۳۰' }, jalaliNow), 0.5,
  'Jalali timestamps must also drive candidate ranking and the 24-hour cutoff');
assert.equal(ageHours({ create_date: '۱۴۰۵/۰۸/۱۴' }, jalaliNow), 10,
  'date-only Jalali values use the conservative start of the Tehran day');
assert.equal(shouldStartPublishingCycle(null, Date.parse('2026-11-05T04:20:00.000Z')), true,
  'the first publishing cycle should start immediately');
assert.equal(shouldStartPublishingCycle('2026-11-05T04:17:00.000Z',
  Date.parse('2026-11-05T04:20:59.000Z')), false,
  'a second scheduler source must not start a duplicate cycle inside the four-minute cooldown');
assert.equal(shouldStartPublishingCycle('2026-11-05T04:17:00.000Z',
  Date.parse('2026-11-05T04:21:00.000Z')), true,
  'a new cycle becomes eligible as soon as the four-minute cooldown elapses');
assert.equal(feedCandidateEligible(valid, { posts: [] }), true);
assert.equal(feedCandidateEligible({ ...valid, video_code:'TinyTitle', title:'کم', description:'', sender_name:'' }, { posts:[] }), true,
  'a very short or missing source title must not block discovery; title fallback happens later');
assert.equal(feedCandidateEligible({ ...valid, can_republish: 0 }, { posts: [] }), true,
  'feed permission bits are advisory; final permission is checked against the detail endpoint');
assert.equal(feedCandidateEligible({ ...valid, is_publish_able: 0 }, { posts: [] }), true,
  'a stale feed publishable bit must not block the authoritative detail check');
assert.equal(feedCandidateEligible({ ...valid, only_in_filo: 1 }, { posts: [] }), true,
  'the authoritative detail gate owns only-in-Filo restrictions');
assert.equal(feedCandidateEligible({ ...valid, duration: 8 }, { posts: [] }), true,
  'compact duration is a hint and the detail duration gate remains authoritative');
assert.equal(feedCandidateEligible({ ...valid, duration: 9 }, { posts: [] }), true);
assert.equal(feedCandidateEligible({ ...valid, duration: 10 }, { posts: [] }), true);
assert.equal(feedCandidateEligible({ ...valid, duration: 240 }, { posts: [] }), true);

const metadataRejectedLedger = {posts:[{
  sourceCode:valid.video_code,
  status:'rejected_by_filo',
  reason:'توضیح بسیار کوتاه است!',
  responseDiagnostics:{uiErrors:['توضیح بسیار کوتاه است!']}
}]};
assert.equal(cleanRepostCaptionTitle('🎈🎈 یک اتفاق جالب!!! در بازی فوتبال 😂'), 'یک اتفاق جالب! در بازی فوتبال');
assert.equal(editorialTitleQualityReason('و نظر خود را بنویسید'), 'title_engagement_bait_without_subject');
const cleanedDescription = cleanRepostDescription(
  'این ویدئو درباره فوتبال است. لطفاً لایک کنید و نظر خود را بنویسید. این ویدئو درباره فوتبال است.',
  'فوتبال',
  'یک صحنه از مسابقه فوتبال'
);
assert.ok(!/لایک کنید|نظر خود را بنویسید/u.test(cleanedDescription),
  'engagement bait must not leak into the searchable description');
assert.ok(cleanedDescription.startsWith('این ویدئو درباره فوتبال است.'),
  'the first descriptive sentence must be retained');
assert.ok(cleanedDescription.length >= 30);
assert.equal(cleanedDescription.split('این ویدئو درباره فوتبال است').length - 1, 1,
  'duplicate description sentences must be removed');
assert.equal(createDistinctRepostTitle('و نظر خود را بنویسید', '', 'AbC1234'),
  'ویدئوی بازنشرشده AbC1234',
  'a generic engagement prompt must never become the repost title');
assert.equal(candidateExternalTopicKey({
  title:'ویدئوی کوتاه',
  feed_tag_label:'تولد'
}), 'heartwarming',
  'explicit celebration feeds should map into the shared heartwarming topic');
assert.equal(isMetadataValidationRejectionReason('توضیح بسیار کوتاه است!'),true);
assert.equal(hasRetryableMetadataRejection(metadataRejectedLedger,valid.video_code),true);
assert.equal(isSourceAlreadyAttempted(metadataRejectedLedger,valid.video_code),false,
  'a known Filo metadata rejection may be retried once after the metadata policy upgrade');
assert.equal(feedCandidateEligible(valid,metadataRejectedLedger),true);
assert.equal(markMetadataPolicyRetry(metadataRejectedLedger,valid.video_code,Date.parse('2026-11-06T00:00:00.000Z')),true);
assert.equal(hasRetryableMetadataRejection(metadataRejectedLedger,valid.video_code),false,
  'a metadata-policy retry must be consumed only once per policy version');
assert.equal(feedCandidateEligible(valid,metadataRejectedLedger),false,
  'the same rejected source must not cycle repeatedly after its single retry');
const legacyMetadataCache = {
  posts: metadataRejectedLedger.posts,
  candidateRejections: {
    [valid.video_code]: {
      reason:'filo_publish_not_accepted',
      fingerprint:'legacy-generic-fingerprint',
      retryAfterAt:'2026-11-06T06:00:00.000Z'
    }
  }
};
assert.equal(getCachedCandidateRejection(legacyMetadataCache,valid.video_code,valid,
  Date.parse('2026-11-06T00:30:00.000Z')),null,
  'a generic legacy API cache must not block the one-time retry when the ledger proves a specific metadata rejection');
assert.equal(legacyMetadataCache.candidateRejections[valid.video_code],undefined);
const nonMetadataRejectedLedger = {posts:[{sourceCode:valid.video_code,status:'rejected_by_filo',reason:'403 forbidden'}]};
assert.equal(feedCandidateEligible(valid,nonMetadataRejectedLedger),false,
  'permission/access failures must not be re-opened by a metadata-only retry');
const mixedRejectionLedger = {posts:[
  {sourceCode:valid.video_code,status:'rejected_by_filo',reason:'توضیح بسیار کوتاه است!',responseDiagnostics:{uiErrors:['توضیح بسیار کوتاه است!']}},
  {sourceCode:valid.video_code,status:'rejected_by_filo',reason:'creator_republish_permission_missing'}
]};
assert.equal(feedCandidateEligible(valid,mixedRejectionLedger),false,
  'any non-metadata rejection for the same source must block the metadata-only retry exception');
assert.equal(feedCandidateEligible(valid,{posts:[{sourceCode:valid.video_code,status:'public_verified'}]}),false,
  'a previously verified publication must never be submitted again');
assert.equal(feedCandidateEligible({ ...valid, title: 'خبر فوری جنگ و حمله نظامی' }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, title: 'پیغام توهین آمیز در پایان مسابقه' }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, title: 'سکانس سریال ایرانی' }, { posts: [] }), false);
assert.equal(feedCandidateEligible({ ...valid, title: 'تصاویر دوربین مداربسته بدون رضایت افراد' }, { posts: [] }), false);
assert.equal(policyTextRiskReason({ title: 'پیغام توهین آمیز به یک بازیکن' }), 'insult_or_defamation');
assert.equal(policyTextRiskReason({ title: 'شبیه ساز بمب اتم در تهران' }), 'weapons_or_explosives');
assert.equal(feedCandidateEligible({ ...valid, title: 'شبیه ساز بمب اتم در تهران' }, { posts: [] }), false);
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
assert.deepEqual(
  extractCategoryIds({
    c: [{ id: 6, name: 'طنز' }, { category_id: '42', title: 'تکنولوژی' }],
    cfs: { 7: { name: 'ورزش' } }
  }),
  [6, 7, 42],
  'the live Filo category catalogue should be read from both main and side category collections'
);
assert.deepEqual(extractCategoryIds({
  s:true,d:{c:[{id:8},{categoryId:'51'}],cfs:{9:{title:'ورزش'}}}
}),[8,9,51],'wrapped Filo response envelope must be supported');
assert.deepEqual(extractCategoryIds({
  data:{result:{categories:[{category_id:14}]}}
}),[14],'nested result/category collections must be supported');
assert.deepEqual(buildCategoryPageRequestPayload(2, 1365), {
  rowCount: 0, page: 2, needAllData: 0, windowWidth: 1365
}, 'category feed body must match the current Filo JSON request contract');
assert.deepEqual(buildCategoryPageRequestPayload('3', 0), {
  rowCount: 0, page: 3, needAllData: 0, windowWidth: 1365
}, 'invalid window width must safely use the same browser fallback');
assert.equal(buildVideoTagFeedPath('q-طنز'), '/api/v1/video/ai-tag/q-%D8%B7%D9%86%D8%B2');
assert.equal(buildVideoTagFeedPath('all'), '/api/v1/video/ai-tag/all');
assert.equal(buildVideoTagFeedPath('1058'), '/api/v1/video/ai-tag/1058',
  'authenticated Filo sessions expose numeric tag keys and route them directly');
assert.throws(() => buildVideoTagFeedPath('../upload'), /filo_tag_key_invalid/);
assert.deepEqual(extractVideoTagFeeds({
  tags: [{ all: 'همه' }, { 'q-طنز': 'طنز' }, { 'q-آشپزی': 'آشپزی' }]
}), [
  { key: 'all', label: 'همه' },
  { key: 'q-طنز', label: 'طنز' },
  { key: 'q-آشپزی', label: 'آشپزی' }
], 'tag feeds should follow Filo recommend-user-tags response');
assert.deepEqual(extractVideoTagFeeds({
  tags: [{ all: 'همه' }, { '1058': 'طنز' }, { '6': 'آشپزی' }]
}), [
  { key: 'all', label: 'همه' },
  { key: '1058', label: 'طنز' },
  { key: '6', label: 'آشپزی' }
], 'numeric topic keys used by authenticated Filo sessions must be discovered');
assert.deepEqual(extractVideoTagFeeds({
  data: { tags: [{ 'q-آموزش': 'آموزش' }] }
}), [{ key: 'q-آموزش', label: 'آموزش' }], 'wrapped tag payload should be supported');
const compactFeedItem = normalizeVideoFeedItem({
  v: 'AbC1234', t: 'یک کلیپ طنز', c: 6, du: 32, vc: 100, pd: 12,
  cd: '۲ ساعت پیش', hst: 1, co: 1, cr: 1, ac: 1
});
assert.deepEqual({
  video_code: compactFeedItem.video_code, title: compactFeedItem.title,
  category_id: compactFeedItem.category_id, duration: compactFeedItem.duration,
  visit_count: compactFeedItem.visit_count, play_count: compactFeedItem.play_count,
  create_date: compactFeedItem.create_date, has_audio: compactFeedItem.has_audio,
  can_republish: compactFeedItem.can_republish, can_make_money: compactFeedItem.can_make_money,
  active: compactFeedItem.active
}, {
  video_code: 'AbC1234', title: 'یک کلیپ طنز', category_id: 6, duration: 32,
  visit_count: 100, play_count: 12, create_date: '۲ ساعت پیش',
  has_audio: 1, can_republish: 1, can_make_money: 1, active: 1
}, 'compact Filo feed fields must be normalized before eligibility and momentum checks');
assert.equal(feedCandidateEligible({
  ...normalizeVideoFeedItem({v:'AbC1234',t:'یک چالش بامزه تازه و جذاب',c:6,du:28,vc:120,pd:10,cd:'۲ ساعت پیش',hst:1,co:1,cr:1,ac:1}),
  status_id:1
}, {posts:[]}), true, 'compact Filo records without an is_publish_able field pass discovery prefilter but still face detailGate');
assert.equal(feedCandidateEligible({
  ...normalizeVideoFeedItem({v:'AbC1234',t:'یک چالش بامزه تازه و جذاب',c:6,du:28,vc:120,pd:10,cd:'۲ ساعت پیش',hst:1,co:1,cr:1,ac:1}),
  is_publish_able:0,status_id:1
}, {posts:[]}), true, 'an explicit unpublishable feed flag is rechecked against authoritative details');
const feedSignals = summarizeFeedGateSignals([
  normalizeVideoFeedItem({v:'AbC1234',t:'ویدیوی تازه و مفید',du:28,vc:90,pd:5,hst:0,co:0,cr:1,ac:1}),
  normalizeVideoFeedItem({v:'ZzY9876',t:'ویدیوی تازه و مفید',du:240,vc:50,pd:0,hst:1,co:1,cr:1,ac:1}),
  normalizeVideoFeedItem({v:'QqW0001',t:'ویدئوی کوتاه',du:8}),
  normalizeVideoFeedItem({v:'Tiny001',t:'کم',du:12})
], {posts:[]});
assert.equal(feedSignals.totalItems, 4);
assert.equal(feedSignals.flags.can_republish.false, 1);
assert.equal(feedSignals.flags.has_audio.false, 1);
assert.equal(feedSignals.duration.belowMinimum, 1,
  'duration diagnostics must count only videos below the monetization minimum; long videos remain eligible for detail review');
assert.equal(feedSignals.hardPrefilter.sparseText, 1,
  'sparse title/description text should be reported diagnostically, not excluded');
assert.equal(feedSignals.hardPrefilter.passed, 4,
  'sparse but non-risky metadata must still pass the discovery prefilter');

assert.deepEqual(extractCategoryIds([{id:3},{id:4}]),[3,4],
  'direct category arrays must be supported');
assert.deepEqual(extractCategoryIds({
  c: [{ i: 6, n: 'طنز' }, { i: 14, n: 'آموزش' }],
  cfs: [{ i: 29, n: 'آشپزی' }]
}), [6, 14, 29], 'compact catalogue entries may expose category IDs as i');
const compactShape = summarizeCategoryCatalogPayload({
  c: [{ i: 6, n: 'طنز' }], cfs: [{ i: 14, n: 'آموزش' }]
});
assert.deepEqual(compactShape.nested.c.itemKeys[0], ['i', 'n'],
  'catalogue diagnostics should expose item field names without raw values');
assert.deepEqual(rotatingDepthSelection([1,2,3,4,5],3,2),
  {categoryIds:[4,5],nextCursor:0});
assert.deepEqual(rotatingDepthSelection([1,2,3],2,12),
  {categoryIds:[3,1,2],nextCursor:2});
assert.equal(nextCategoryDepthPage(2),3);
assert.equal(resolveDepthScanStartPage(2,{lastPageNo:12}),13,
  'old state that wrapped at page twelve must resume at page thirteen');
assert.equal(resolveDepthScanStartPage(2,{lastPageNo:9}),2,
  'ordinary early pagination state must keep its current cursor');
assert.equal(resolveDepthScanStartPage(14,{lastPageNo:12}),2,
  'a non-contiguous stored cursor must restart safely');
assert.equal(nextCategoryDepthPage(12),13);
assert.equal(nextCategoryDepthPage(18),2, 'the expanded page ceiling still wraps only after page eighteen');
assert.deepEqual(
  Object.keys(summarizeCategoryCatalogPayload({s:true,d:{c:[],cfs:[]}}).nested),
  ['d']
);

const feedNow = Date.parse('2026-11-04T12:00:00.000Z');
const recentOrderedPage = analyzeCategoryFeedPage([
  { create_date: '۳ ساعت پیش' },
  { create_date: '۴ ساعت پیش' },
  { create_date: '۵ ساعت پیش' }
], feedNow);
assert.equal(recentOrderedPage.chronologyConsistent, true,
  'a newest-to-oldest feed page with reliable relative timestamps should be recognized');
assert.equal(recentOrderedPage.allItemsOlderThanLookback, false);

const oldOrderedPage = analyzeCategoryFeedPage([
  { create_date: '۲۵ ساعت پیش' },
  { create_date: '۲۶ ساعت پیش' },
  { create_date: '۲۷ ساعت پیش' }
], feedNow);
assert.equal(oldOrderedPage.chronologyConsistent, true);
assert.equal(oldOrderedPage.allItemsOlderThanLookback, true,
  'the 24-hour cutoff must account for relative-time rounding');

const reversedPage = analyzeCategoryFeedPage([
  { create_date: '۵ ساعت پیش' },
  { create_date: '۲ ساعت پیش' }
], feedNow);
assert.equal(reversedPage.chronologyConsistent, false,
  'a page with a material newest/oldest inversion must never authorize early pagination stop');

const ambiguousPage = analyzeCategoryFeedPage([
  { create_date: 'دیروز' },
  { create_date: '۲ روز پیش' }
], feedNow);
assert.equal(ambiguousPage.chronologyConsistent, false,
  'ambiguous relative labels must not be treated as proof of chronological ordering');

const jalaliTimestamp = jalaliDateToGregorianTimestamp('۱۴۰۵/۰۸/۱۴ ۰۹:۳۰');
assert.equal(new Date(jalaliTimestamp).toISOString(), '2026-11-05T06:00:00.000Z',
  'a Jalali datetime must be converted to its correct Gregorian UTC instant');
const jalaliAge = reliableFeedAgeBounds(
  { create_date: '۱۴۰۵/۰۸/۱۴ ساعت ۰۹:۳۰' },
  Date.parse('2026-11-05T06:30:00.000Z')
);
assert.equal(jalaliAge.centerHours, 0.5,
  'Filo Solar Hijri timestamps must use Tehran local time and preserve minute precision');
const jalaliDateOnlyAge = reliableFeedAgeBounds(
  { create_date: '۱۴۰۵/۰۸/۱۲' },
  Date.parse('2026-11-05T06:30:00.000Z')
);
assert.equal(jalaliDateOnlyAge.precisionHours, 24,
  'date-only Jalali values must retain conservative day-level uncertainty');
assert.ok(jalaliDateOnlyAge.lowerHours > 24,
  'a Jalali date safely older than the 24-hour lookback can establish the cutoff');
const yesterdayBounds = reliableFeedAgeBounds({ create_date: 'دیروز' }, feedNow);
assert.equal(yesterdayBounds.lowerHours, 24,
  'the label yesterday must retain the exact conservative lower boundary');
const jalaliOrderedPage = analyzeCategoryFeedPage([
  { create_date: '۱۴۰۵/۰۸/۱۲' },
  { create_date: '۱۴۰۵/۰۸/۱۱' }
], Date.parse('2026-11-05T06:30:00.000Z'));
assert.equal(jalaliOrderedPage.ageDataComplete, true);
assert.equal(jalaliOrderedPage.chronologyConsistent, true);
assert.equal(jalaliOrderedPage.allItemsOlderThanLookback, true,
  'consecutive Jalali date-only feed entries can safely prove a full page is older than 24 hours');
const previousPageLast = reliableFeedAgeBounds({ create_date: '۲۴ ساعت پیش' }, feedNow);
const nextPageFirst = reliableFeedAgeBounds({ create_date: '۲۵ ساعت پیش' }, feedNow);
const outOfOrderPageFirst = reliableFeedAgeBounds({ create_date: '۲۲ ساعت پیش' }, feedNow);
assert.equal(categoryFeedBoundaryOrdered(previousPageLast, nextPageFirst), true,
  'successive page boundaries should remain newest-to-oldest');
assert.equal(categoryFeedBoundaryOrdered(previousPageLast, outOfOrderPageFirst), false,
  'a newer item on a later page invalidates the pagination ordering assumption');
const sameDateBoundary = {
  centerHours: 48, lowerHours: 36, upperHours: 60, precisionHours: 24, chronologyReliable: true
};
const ambiguousDateBoundary = {
  centerHours: 48, lowerHours: 36, upperHours: 60, precisionHours: 24, chronologyReliable: true
};
const nextDayBoundary = {
  centerHours: 72, lowerHours: 60, upperHours: 84, precisionHours: 24, chronologyReliable: true
};
assert.equal(categoryFeedBoundaryOrdered(sameDateBoundary, ambiguousDateBoundary), false,
  'same-day date-only pagination boundaries cannot prove ordering within a day');
assert.equal(categoryFeedBoundaryOrdered(sameDateBoundary, nextDayBoundary), true,
  'non-overlapping consecutive date ranges can prove day-level pagination order');

assert.equal(shouldStopCategoryPagination({
  pageCount: 1, pageAnalysis: oldOrderedPage, chronologyVerified: true
}), false, 'the first page alone cannot establish cross-page ordering');
assert.equal(shouldStopCategoryPagination({
  pageCount: 2, pageAnalysis: oldOrderedPage, chronologyVerified: true
}), true, 'two consistent old pages can safely close the 24-hour window');
assert.equal(shouldStopCategoryPagination({
  pageCount: 3, pageAnalysis: oldOrderedPage, chronologyVerified: false
}), false, 'unverified category ordering must continue to the configured safety cap');

assert.ok(editorialTitleTokens('کلیپ طنز بهرام افشاری').includes('بهرام'));

assert.equal(editorialTitleQualityReason('من و رفیقام طنز دیلان برای کلیپ های بیشتر کانال مارا دنبال کنید'),
  'title_promotional_or_call_to_action',
  'the actual promotional title seen in the live ledger must be rejected');
assert.equal(editorialTitleQualityReason('خنده دار پارت ۱۹ طنز کمدی'),
  'title_generic_episode_label',
  'generic part-only comedy titles must be rejected');
assert.equal(editorialTitleQualityReason('روش پخت خورشت بامیه با مرغ'), null,
  'specific subject-driven cooking titles must remain eligible');

assert.equal(
  createDistinctRepostTitle('طرز تهیه خورشت بامیه با مرغ'),
  'روش پخت خورشت بامیه با مرغ',
  'a safe recipe-title rewrite should preserve the facts while making the title distinct'
);
assert.equal(
  createDistinctRepostTitle('پاک کردن انار به سبک یزدی ها'),
  'روش یزدی ها برای پاک کردن انار',
  'a safe style-based title rewrite should keep the original claim and vary its wording'
);
assert.equal(
  createDistinctRepostTitle('کلیپ بلوچی آهنگ بلوچی ورنهایه'),
  'ترانه بلوچی «ورنهایه»',
  'a music clip title should become a concise title anchored to the source song'
);
assert.equal(
  createDistinctRepostTitle('۱۳ آبان ماهی عزیز تولدت مبارک'),
  'تبریک تولد به متولد ۱۳ آبان',
  'a date-specific birthday title should retain the date and greeting'
);
assert.equal(
  createDistinctRepostTitle('آهنگ افشین آذری و وفا شریفوا آخشاملار هوالار قارالان کیمی'),
  'همخوانی افشین آذری و وفا شریفوا با ترانه «آخشاملار هوالار قارالان کیمی»',
  'music title rewriting should preserve the named artists and song name'
);
assert.equal(
  createDistinctRepostTitle('دانلود آهنگ جدید دومان به نام من همانم'),
  'ترانه «من همانم» از دومان',
  'a download-style music title should become a clean title with artist and song'
);
assert.equal(
  createDistinctRepostTitle('طنر بازی کردن با غذا'),
  'بازی با غذا در قالب طنز',
  'a common typo in a comedy title should be corrected without inventing a subject'
);
assert.equal(
  createDistinctRepostTitle('طنز بهترین رفیق ها'),
  'بهترین رفیق‌ها در قاب طنز',
  'a specific comedy topic should be retained while removing generic lead-in'
);
assert.equal(
  createDistinctRepostTitle('طنز دیدار پاریس ژرمن و بارسلونا'),
  'شوخی با دیدار پاریس ژرمن و بارسلونا',
  'a humor-tagged sports title should retain both teams and the meeting context'
);
assert.equal(editorialTitleQualityReason('لایک فالو حمایت یادتون نره عزیزای دلم'),
  'title_promotional_or_call_to_action',
  'pure engagement prompts must never be used as video titles');
assert.equal(editorialTitleQualityReason('خنده دار پارت ۳۲ طنز کمدی'),
  'title_generic_episode_label',
  'a generic numbered clip title without a real subject must be rejected');
assert.equal(editorialTitleQualityReason('یک فیلم بسیار زیبا و رمانتیک که کار رو تموم میکنه'),
  'title_generic_praise_without_subject',
  'vague praise without an identifiable subject must be rejected');
assert.equal(editorialTitleQualityReason('شوخی با دیدار پاریس ژرمن و بارسلونا'), null,
  'grounded subject-specific titles remain eligible');
assert.equal(
  descriptionBasedTitleCandidate('لایک فالو حمایت یادتون نره عزیزای دلم. در این ویدئو، واکنش بامزه بهرام افشاری به اتفاق غیرمنتظره را ببینید.'),
  'واکنش بامزه بهرام افشاری به اتفاق غیرمنتظره را',
  'a CTA-only opening sentence must be skipped in favor of the first factual sentence'
);
assert.match(createDistinctRepostTitle('لایک فالو حمایت یادتون نره عزیزای دلم', '', 'Promo01'), /Promo01/,
  'a promotional-only title must fall back safely instead of rejecting an otherwise eligible video');
assert.match(createDistinctRepostTitle('خنده دار پارت ۳۲ 😂 طنز کمدی', '', 'Episode01'), /Episode01/,
  'generic episode labels must receive a neutral fallback rather than blocking an eligible video');
assert.doesNotMatch(cleanRepostDescription(
  'موضوع ویدئو: شوخی در خرید لباس. لایک فالو حمایت یادتون نره عزیزای دلم. برای کلیپ های بیشتر کانال ما را دنبال کنید.',
  'عنوان منبع',
  'شوخی در خرید لباس در فروشگاه'
), /لایک|فالو|حمایت|دنبال کنید|کلیپ های بیشتر/);

assert.doesNotThrow(() => createDistinctRepostTitle('کلیپ های طنز و خنده//بهرام افشاری', '', 'Channel01'),
  'a weak channel-style title must never become an eligibility rejection');
assert.equal(
  descriptionBasedTitleCandidate('در این ویدئو، واکنش بامزه بهرام افشاری به اتفاق غیرمنتظره را ببینید. برای ما لایک کنید.'),
  'واکنش بامزه بهرام افشاری به اتفاق غیرمنتظره را',
  'description fallback must strip the generic video lead-in and use the first factual sentence only'
);
assert.equal(
  createDistinctRepostTitle(
    'کلیپ های طنز و خنده//بهرام افشاری',
    'در این ویدئو، واکنش بامزه بهرام افشاری به اتفاق غیرمنتظره را ببینید.'
  ),
  'واکنش بامزه بهرام افشاری به اتفاق غیرمنتظره را',
  'a safe title can be derived from a factual source description when the title itself has no approved rewrite pattern'
);
assert.doesNotThrow(() => createDistinctRepostTitle(
  'کلیپ های طنز و خنده//بهرام افشاری',
  'کلیپ های طنز و خنده با بهرام افشاری',
  'Repeated01'
), 'when title and description provide no strong rewrite, use a safe fallback rather than rejecting the video');
assert.equal(removeRepeatedTrailingPhrase('لوبیا فرنگی پلو همراه مرغ لوبیا فرنگی'),
  'لوبیا فرنگی پلو همراه مرغ');
assert.equal(
  createDistinctRepostTitle('طرز تهیه لوبیا فرنگی پلو همراه مرغ لوبیا فرنگی'),
  'روش پخت لوبیا فرنگی پلو همراه مرغ',
  'repeated trailing phrase should be removed from final title'
);
const duplicateState = {
  posts: [{
    sourceCode: 'Bahram01',
    status: 'public_verified',
    repostTitle: 'لحظه طنز بهرام افشاری',
    submittedAt: '2026-11-04T12:00:00.000Z'
  }]
};
assert.equal(
  topicDuplicateMatch(duplicateState, 'ویدیوی تازه با حضور بهرام افشاری', Date.parse('2026-11-04T13:00:00.000Z')).duplicate,
  false,
  'sharing only a named person must not suppress a distinct video'
);
assert.equal(topicDuplicateMatch({
  posts:[{sourceCode:'SameEvent1',status:'public_verified',
    repostTitle:'درگیری لفظی بهرام افشاری در برنامه زنده تلویزیونی',
    submittedAt:'2026-11-04T12:00:00.000Z'}]
},'ماجرای درگیری لفظی بهرام افشاری در برنامه زنده تلویزیونی',
Date.parse('2026-11-04T13:00:00.000Z')).duplicate,true,
'a strongly overlapping story must still be suppressed within 48 hours');
assert.equal(topicDuplicateMatch({
  posts:[{sourceCode:'OldStory1',status:'public_verified',
    repostTitle:'روش پخت خورشت بامیه با مرغ',
    submittedAt:'2026-11-01T12:00:00.000Z'}]
},'روش پخت خورشت بامیه با مرغ',Date.parse('2026-11-04T13:00:00.000Z')).duplicate,false,
'a topic older than 48 hours must not remain a hard duplicate');
assert.equal(
  topicDuplicateMatch(duplicateState, 'روش پخت خورشت بامیه با مرغ', Date.parse('2026-11-04T13:00:00.000Z')).duplicate,
  false,
  'unrelated topics must not be suppressed'
);
assert.equal(
  isCandidateLevelFiloRejection({
    status: 'rejected_by_filo',
    httpStatus: 200,
    responseDiagnostics: { bodyKeys: ['r'], r: 'طول عنوان ویدیو بسیار کم است!' }
  }),
  true,
  'Filo can explicitly reject a post inside HTTP 200 and it must be classified as candidate-level'
);
assert.equal(
  isCandidateLevelFiloRejection({
    status: 'retryable_filo_failure',
    httpStatus: 429,
    responseDiagnostics: { bodyKeys: ['r'], r: 'rate limited' }
  }),
  false,
  'transient API failures must not be consumed as candidate-level rejections'
);
const rejectionCacheState={posts:[]};
const cacheVideo={title:'عنوان غیرقابل بازنویسی',description:'توضیح ثابت'};
cacheCandidateRejection(rejectionCacheState,'Cache01',cacheVideo,
  'title_without_safe_editorial_rewrite',Date.parse('2026-11-04T12:00:00.000Z'));
assert.ok(getCachedCandidateRejection(rejectionCacheState,'Cache01',cacheVideo,
  Date.parse('2026-11-04T13:00:00.000Z')));
assert.equal(rejectionCacheState.candidateRejections.Cache01.titleRewritePolicyVersion, 6);
assert.equal(isTitleRewriteRejectionReason('title_without_safe_editorial_rewrite'), true);
assert.equal(isTitleRewriteRejectionReason('title_promotional_or_call_to_action'), true);
assert.equal(isTitleRewriteRejectionReason('title_generic_episode_label'), true);

assert.equal(isTitleRewriteRejectionReason('detail_gate:duration_out_of_short_form_range'), false);
const staleTitleCacheState = {candidateRejections:{Legacy:{...rejectionCacheState.candidateRejections.Cache01}}};
delete staleTitleCacheState.candidateRejections.Legacy.titleRewritePolicyVersion;
assert.equal(getCachedCandidateRejection(staleTitleCacheState, 'Legacy', cacheVideo,
  Date.parse('2026-11-04T13:00:00.000Z')), null,
  'a title rejection from an older rewrite policy must be retried immediately after the policy changes');
assert.equal(staleTitleCacheState.candidateRejections.Legacy, undefined);
assert.equal(detailFetchHttpDisposition(403), 'candidate_access_denied');
assert.equal(detailFetchHttpDisposition(401), 'session_expired');
assert.equal(detailFetchHttpDisposition(429), 'retryable');
assert.equal(detailFetchHttpDisposition(503), 'retryable');
assert.equal(detailFetchHttpDisposition(404), 'permanent');
assert.equal(categoryApiErrorHint({
  status: 403, contentType: 'application/json; charset=utf-8',
  body: JSON.stringify({ message: 'permission denied for this video' })
}), 'message:permission denied for this video',
'403 diagnostics should preserve a safe, useful API denial message');
assert.equal(categoryApiErrorHint({
  status: 403, contentType: 'application/json',
  body: JSON.stringify({ message: 'session token secret is invalid' })
}), 'body_keys:message',
'403 diagnostics must not expose authentication or session messages');
const forbiddenCacheState = {candidateRejections:{}};
cacheCandidateRejection(forbiddenCacheState,'Forbidden1',cacheVideo,
  'detail_fetch:forbidden_403',Date.parse('2026-11-05T10:00:00.000Z'),6*60*60*1000);
assert.ok(getCachedDetailAccessRejection(forbiddenCacheState,'Forbidden1',
  Date.parse('2026-11-05T11:00:00.000Z')),
  'a per-video 403 should be held in a six-hour candidate cooldown instead of retried every five minutes');
assert.equal(getCachedDetailAccessRejection(forbiddenCacheState,'Forbidden1',
  Date.parse('2026-11-05T16:00:00.000Z')), null,
  'the per-video 403 cooldown must expire so a later permission change can be rechecked');
const detailCacheState = {posts:[]};
cacheCandidateRejection(detailCacheState,'Detail01',cacheVideo,
  'detail_gate:duration_below_monetization_minimum',Date.parse('2026-11-04T12:00:00.000Z'));
assert.equal(detailCacheState.candidateRejections.Detail01.titleRewritePolicyVersion, null);
assert.ok(getCachedCandidateRejection(detailCacheState,'Detail01',cacheVideo,
  Date.parse('2026-11-04T13:00:00.000Z')),
  'below-minimum duration cooldowns must remain valid across title-only policy upgrades');
const oldLongDurationCache = {candidateRejections:{Long01:{
  fingerprint:candidateMetadataFingerprint(cacheVideo),
  reason:'detail_gate:duration_out_of_short_form_range',
  retryAfterAt:'2026-11-06T23:00:00.000Z'
}}};
assert.equal(getCachedCandidateRejection(oldLongDurationCache,'Long01',cacheVideo,
  Date.parse('2026-11-06T12:00:00.000Z')),null,
  'the obsolete local 180-second rejection must be invalidated immediately');
assert.equal(oldLongDurationCache.candidateRejections.Long01,undefined);
assert.equal(getCachedCandidateRejection(rejectionCacheState,'Cache01',
  {...cacheVideo,description:'توضیح تغییر کرده'},Date.parse('2026-11-04T13:00:00.000Z')),null,
  'changed source metadata must invalidate rejection cache immediately');
assert.equal(getCachedCandidateRejection(rejectionCacheState,'Cache01',cacheVideo,
  Date.parse('2026-11-04T19:00:01.000Z')),null,
  'static metadata rejection must be eligible for retry after six hours');

const cleanedTitle = cleanRepostCaptionTitle('کلیپ خنده‌دار از مسابقه فوتبال 😂 #فوتبال');
assert.ok(cleanedTitle.includes('مسابقه فوتبال'));
assert.doesNotMatch(cleanedTitle, /https?:\/\/|#/);
const shortDescription = cleanRepostDescription('واکنش کوتاه خانواده در لحظه رسیدن مهمان.', 'عنوان منبع', cleanedTitle);
assert.equal(shortDescription, 'واکنش کوتاه خانواده در لحظه رسیدن مهمان.',
  'a factual source description above the safe minimum remains unchanged');
const missingDescriptionFallback = cleanRepostDescription('', 'عنوان منبع', cleanedTitle);
assert.ok(missingDescriptionFallback.includes('این ویدئو دربارهٔ'));
assert.ok(missingDescriptionFallback.includes(cleanedTitle));
assert.ok(missingDescriptionFallback.length >= 30,
  'missing descriptions receive a neutral source-title-based description rather than filler');

const sourceDescription = 'در این ویدئو، هنگام برگزاری مولودی واکنش خانواده به تنها ماندن یکی از اعضا دیده می‌شود و رفتار او باعث خنده اطرافیان می‌شود.';
const shortMetadata = createRepostMetadata({
  ...valid,
  title: 'طرز تهیه خورشت بامیه با مرغ',
  description: 'واکنش کوتاه خانواده'
}, 'AbC1234');
assert.equal(shortMetadata.title, 'روش پخت خورشت بامیه با مرغ');
assert.match(shortMetadata.description, /این ویدئو دربارهٔ/);
assert.match(shortMetadata.description, /واکنش کوتاه خانواده/);
assert.ok(shortMetadata.description.length >= 30,
  'short captions must be expanded only with a neutral sentence grounded in the source title');
assert.ok(shortMetadata.title.length >= 5 && shortMetadata.title.length <= 180,
  'generated titles must satisfy only the payload safety bounds; the 20–96 character editorial target is not an eligibility gate');
const shortTitle = createDistinctRepostTitle('طرز تهیه چای', '');
assert.ok(shortTitle.length >= 20 && shortTitle.length <= 96,
  'short but meaningful source titles should be expanded without inventing new facts');
const fittedLongTitle = fitFiloTitleLength('ترانهٔ بسیار زیبا و شنیدنی از خوانندهٔ محبوب و پرطرفدار برای یک شب بارانی در شهر و کوچه‌های قدیمی با صدای گرم و دلنشین');
assert.ok(fittedLongTitle.length <= 96 && fittedLongTitle.length >= 20,
  'long titles must be safely trimmed below Filo’s 100-character rejection boundary');
assert.equal(editorialTitleQualityReason('ترفند آشپزی'), null,
  'two informative terms are sufficient when the resulting title remains meaningful and within Filo limits');
assert.throws(() => createRepostMetadata({
  ...valid,
  title: 'پیغام توهین آمیز به یک بازیکن',
  description: 'متن کوتاه'
}, 'AbC1236'), /filo_policy_text_risk:insult_or_defamation/);
const linkedTitleMetadata = createRepostMetadata({
  ...valid,
  title: 'لینک https://example.com ویدئو',
  description: 'توضیح کوتاه'
}, 'AbC1237');
assert.doesNotMatch(linkedTitleMetadata.title, /https?:\/\//i,
  'external links in source titles should be stripped rather than causing a title-only rejection');

const promoCleaned = cleanRepostDescription(
  'ریمیکی جذاب از یکی از طرفداران گاد آف وار برای شما عزیزان. همراه ما باشید و لذت ببرید. 🔥',
  'ریمیک جدید گاد آف وار ۲ برای کنسول PS5',
  'ریمیک طرفداری از گاد آف وار ۲ برای PS5'
);
assert.match(promoCleaned, /طرفداران گاد آف وار/);
assert.doesNotMatch(promoCleaned, /برای شما عزیزان|همراه ما|لذت ببرید|🔥/);

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
const urlEncodedPublishBody = parseFiloPublishRequestBody(
  'republishFrom=Source01&videoCode=NewVid01&canRepublish=true&canMakeMoney=true&isMadeByMe=false&dontPublish=0&title=New+title',
  'application/x-www-form-urlencoded; charset=UTF-8'
);
assert.equal(urlEncodedPublishBody.format, 'urlencoded');
assert.equal(getPublishBodyParam(urlEncodedPublishBody.params, 'republish_from'), 'Source01');
assert.equal(getPublishBodyParam(urlEncodedPublishBody.params, 'video_code'), 'NewVid01');
assert.equal(serializeFiloPublishRequestBody(urlEncodedPublishBody),
  'republishFrom=Source01&videoCode=NewVid01&canRepublish=true&canMakeMoney=true&isMadeByMe=false&dontPublish=0&title=New+title');

const jsonPublishBody = parseFiloPublishRequestBody(
  JSON.stringify({ data: { republishFrom: 'Source02', videoCode: 'NewVid02', canRepublish: true, canMakeMoney: true } }),
  'application/json'
);
assert.equal(jsonPublishBody.format, 'json');
assert.equal(getPublishBodyParam(jsonPublishBody.params, 'republish_from'), 'Source02');
assert.equal(getPublishBodyParam(jsonPublishBody.params, 'video_code'), 'NewVid02');
setJsonPublishBodyField(jsonPublishBody.json, 'selectedFrame', 'data:image/png;base64,AAAA');
assert.equal(JSON.parse(serializeFiloPublishRequestBody(jsonPublishBody)).data.selectedFrame,
  'data:image/png;base64,AAAA');

const multipartBoundary = '----FiloBoundary123';
const multipartBody = [
  '--' + multipartBoundary,
  'Content-Disposition: form-data; name="republishFrom"',
  '',
  'Source03',
  '--' + multipartBoundary,
  'Content-Disposition: form-data; name="videoCode"',
  '',
  'NewVid03',
  '--' + multipartBoundary,
  'Content-Disposition: form-data; name="canRepublish"',
  '',
  'true',
  '--' + multipartBoundary,
  'Content-Disposition: form-data; name="canMakeMoney"',
  '',
  'true',
  '--' + multipartBoundary + '--',
  ''
].join('\r\n');
const multipartPublishBody = parseFiloPublishRequestBody(
  multipartBody, 'multipart/form-data; boundary=' + multipartBoundary
);
assert.equal(multipartPublishBody.format, 'multipart');
assert.equal(getPublishBodyParam(multipartPublishBody.params, 'republish_from'), 'Source03');
assert.equal(getPublishBodyParam(multipartPublishBody.params, 'video_code'), 'NewVid03');
assert.deepEqual([...parseMultipartPublishBody(multipartBody, multipartBoundary).keys()],
  ['republishFrom', 'videoCode', 'canRepublish', 'canMakeMoney']);

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
assert.equal(detailGate({ is_republish: 1 }, { ...valid, duration: 9 }).eligible, false,
  'videos under ten seconds remain ineligible for monetization');
assert.equal(detailGate({ is_republish: 1 }, { ...valid, duration: 181 }).eligible, true,
  'videos longer than 180 seconds must pass the local duration gate when all authoritative Filo flags pass');
assert.equal(detailGate({ is_republish: 1 }, { ...valid, duration: 900 }).eligible, true,
  'there is no local upper-duration cap for authorized, monetizable source videos');
assert.equal(feedGateHintScore({ ...valid, duration: 240 }), feedGateHintScore({ ...valid, duration: 30 }),
  'long videos must not receive a lower feed hint score solely because of duration');

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
  { video_code: 'Comedy01', title: 'طنز خنده دار تازه', create_date: '۲ ساعت پیش', visit_count: 100, plays: 10 },
  { video_code: 'Tutorial1', title: 'ترفند کاربردی تازه', create_date: '۲ ساعت پیش', visit_count: 100, plays: 10 },
  { video_code: 'Old001', title: 'ویدئوی قدیمی', create_date: 'دیروز', visit_count: 100, plays: 10 },
  { video_code: 'ViewsOnly', title: 'ویدئوی بدون شمارنده پخش', create_date: '۲ ساعت پیش', visit_count: 100 }
];
const firstRank = rankCandidatesByMomentum(baseline, momentumState, momentumStart);
assert.equal(firstRank.length, 3,
  'a first sighting must use safe cumulative-count fallback instead of stalling the publishing cycle');
assert.equal(firstRank[0].rankingMetric, 'cumulative_plays');
assert.equal(firstRank[0].selectionMode, 'cumulative_play_fallback');
assert.equal(firstRank.every(entry => !entry.hasMeasuredGrowth), true);

const secondScan = [
  { ...baseline[0], visit_count: 200, plays: 30 },
  { ...baseline[1], visit_count: 250, plays: 20 },
  { ...baseline[2], visit_count: 400, plays: 30 },
  { ...baseline[3], visit_count: 250 }
];
const secondRank = rankCandidatesByMomentum(secondScan, momentumState, momentumStart + 10 * 60 * 1000);
assert.equal(secondRank.length, 3, 'older videos are excluded but views-only fallback remains available');
assert.equal(secondRank[0].item.video_code, 'Comedy01',
  'measured plays growth must outrank higher views growth');
assert.equal(secondRank[0].momentum.playsPerMinute, 2);
assert.equal(secondRank[0].momentum.viewsPerMinute, 10);
assert.equal(secondRank[0].rankingMetric, 'plays');
assert.equal(secondRank[1].item.video_code, 'Tutorial1');
assert.equal(secondRank[1].momentum.playsPerMinute, 1);
assert.equal(secondRank[2].item.video_code, 'ViewsOnly');
assert.equal(secondRank[2].rankingMetric, 'views',
  'a candidate with no play counter may fall back to measured view growth');

const hintPriorityState = {posts:[]};
const hintPriorityStart = Date.parse('2026-11-04T01:00:00.000Z');
const hintBaseline = [
  {video_code:'FastGrowth',title:'رشد سریع بازدید یک ویدئو',create_date:'۲ ساعت پیش',visit_count:100,plays:10,can_republish:0,has_audio:0,can_make_money:0,duration:30},
  {video_code:'SlowGrowth',title:'ویدئوی محبوب با رشد آرام',create_date:'۲ ساعت پیش',visit_count:100,plays:10,can_republish:1,has_audio:1,can_make_money:1,duration:30}
];
rankCandidatesByMomentum(hintBaseline,hintPriorityState,hintPriorityStart);
const hintSecondScan = [
  {...hintBaseline[0],visit_count:700,plays:210},
  {...hintBaseline[1],visit_count:150,plays:20}
];
const hintRank = rankCandidatesByMomentum(hintSecondScan,hintPriorityState,hintPriorityStart+5*60*1000);
assert.equal(hintRank[0].item.video_code,'FastGrowth',
  'measured play momentum must outrank a slower candidate with more favorable feed hints');

const thirdScan = [
  { ...baseline[0], visit_count: 500, plays: 50 },
  { ...baseline[1], visit_count: 300, plays: 30 },
  { ...baseline[2], visit_count: 900, plays: 60 },
  { ...baseline[3], visit_count: 500 }
];
const thirdRank = rankCandidatesByMomentum(thirdScan, momentumState, momentumStart + 20 * 60 * 1000);
assert.equal(thirdRank[0].item.video_code, 'Comedy01');
assert.equal(thirdRank[0].momentum.playsPerMinute, 2);
assert.equal(thirdRank[0].momentum.playsAccelerationPerMinute, 0);
assert.equal(thirdRank[0].momentum.viewsPerMinute, 30);
assert.equal(thirdRank[2].item.video_code, 'ViewsOnly');

assert.equal(candidateMetricSnapshot({ plays: 0 }, ['play_count', 'plays']).available, true,
  'an explicit zero is a real counter value, not a missing field');
assert.equal(candidateMetricSnapshot({}, ['play_count', 'plays']).available, false,
  'missing play metrics must remain distinguishable from a zero counter');
const checkSummary = summarizeCandidateChecks([
  {code:'A',gate:'creator_republish_permission_missing'},
  {code:'B',gate:'metadata_not_compliant',metadataError:'title_too_long'},
  {code:'C',gate:'republish_detail_fetch_failed',detailFetchError:'republish_detail_forbidden_403'}
]);
assert.equal(checkSummary.total,3);
assert.equal(checkSummary.reasonCounts.creator_republish_permission_missing,1);
assert.equal(checkSummary.reasonCounts.title_too_long,1);
assert.equal(checkSummary.detailFetchErrors.republish_detail_forbidden_403,1);
assert.equal(checkSummary.metadataFailures,1);

assert.equal(classifyAudienceFit({ title: 'طنز و خنده در یک موقعیت عجیب' }).label, 'comedy_entertainment');
assert.equal(classifyAudienceFit({ title: 'ترفند کاربردی برای تعمیر شیر آب' }).label, 'practical_tutorial');
assert.equal(classifyAudienceFit({ title: 'واکنش یک بازیگر معروف در برنامه زنده' }).label, 'celebrity_pop_culture');
assert.equal(classifyAudienceFit({ title: 'منظره‌ای از جنگل در شمال' }).score, 2);

assert.equal(classifyAudienceFit({ title: 'یک ویدئوی معمولی' }).score, 1);

assert.ok(durationPreferenceScore({ duration: 20 }) > durationPreferenceScore({ duration: 240 }),
  'short videos receive a soft preference over longer videos');
assert.ok(durationPreferenceScore({ duration: 240 }) > durationPreferenceScore({ duration: 1200 }),
  'very long videos are down-ranked softly, not rejected');
assert.equal(durationPreferenceScore({ duration: 1200 }) > 0, true,
  'there must be no local maximum-duration rejection');
assert.equal(durationPreferenceScore({}) , 50,
  'missing duration metadata must remain neutral rather than inventing a penalty');

const quotaMessage = 'سقف بازنشر شما تموم شده؛ ساعاتی بعد برای بازنشر مراجعه کن';
assert.equal(isAccountRepublishQuotaMessage(quotaMessage), true,
  'Filo account repost quota errors must be identified as a global account gate');
assert.equal(isAccountRepublishQuotaMessage('republish limit reached; try again later'), true,
  'English quota responses must also be recognized');
assert.equal(isAccountRepublishQuotaMessage('permission denied for this single video'), false,
  'ordinary candidate-specific 403 responses must not pause the whole account');

const quotaState = {};
const quotaStart = Date.parse('2026-11-06T09:00:00.000Z');
const quotaCooldown = setAccountRepublishQuotaCooldown(quotaState, quotaStart);
assert.equal(quotaCooldown.retryAfterAt, '2026-11-06T11:00:00.000Z');
assert.ok(getAccountRepublishQuotaCooldown(quotaState, quotaStart + 60 * 60 * 1000),
  'account cooldown must suppress repeated detail requests during the cooldown window');
assert.equal(getAccountRepublishQuotaCooldown(quotaState, quotaStart + 2 * 60 * 60 * 1000), null,
  'account cooldown must expire and allow a fresh authoritative recheck');

assert.equal(quotaState.accountRepublishQuotaCooldown, undefined);

const legacyQuotaState = {
  candidateRejections: {
    BestCode1: { reason: 'detail_fetch:forbidden_403', retryAfterAt: '2026-11-06T15:00:00.000Z' },
    NextCode2: { reason: 'detail_fetch:forbidden_403', retryAfterAt: '2026-11-06T15:00:00.000Z' }
  }
};
const legacyProbe = releaseOneLegacy403CacheForAccountQuotaProbe(legacyQuotaState, [
  { item: { video_code: 'BestCode1' } },
  { item: { video_code: 'NextCode2' } }
], quotaStart);
assert.equal(legacyProbe, 'BestCode1',
  'one top-ranked legacy 403 cache entry must be released to obtain an authoritative account-level quota response');
assert.equal(legacyQuotaState.candidateRejections.BestCode1, undefined);
assert.ok(legacyQuotaState.candidateRejections.NextCode2,
  'the migration must not clear the remaining per-video rejection cache');
assert.equal(legacyQuotaState.accountQuota403ProbeCode, 'BestCode1');
assert.equal(releaseOneLegacy403CacheForAccountQuotaProbe(legacyQuotaState, [
  { item: { video_code: 'NextCode2' } }
], quotaStart), null,
  'the legacy quota probe migration must run only once');

const activeQuotaState = {
  accountRepublishQuotaCooldown: {
    retryAfterAt: '2026-11-06T11:00:00.000Z'
  },
  candidateRejections: {
    BestCode1: { reason: 'detail_fetch:forbidden_403', retryAfterAt: '2026-11-06T15:00:00.000Z' }
  }
};
assert.equal(releaseOneLegacy403CacheForAccountQuotaProbe(activeQuotaState, [
  { item: { video_code: 'BestCode1' } }
], quotaStart), null,
  'the migration must not probe while the account-level cooldown is active');
assert.equal(activeQuotaState.candidateRejections.BestCode1.reason, 'detail_fetch:forbidden_403');


const topicState = { posts: [] };
const topicStart = Date.parse('2026-11-06T00:00:00.000Z');
const topicBaseline = [
  { video_code:'HotA01', title:'موضوع داغ اول', feed_tag:'q-hot-topic', feed_tag_label:'موضوع داغ', create_date:'۱ ساعت پیش', duration:25, visit_count:100, plays:10 },
  { video_code:'HotB01', title:'موضوع داغ دوم', feed_tag:'q-hot-topic', feed_tag_label:'موضوع داغ', create_date:'۱ ساعت پیش', duration:45, visit_count:100, plays:10 },
  { video_code:'ColdA01', title:'موضوع مستقل', feed_tag:'q-cold-topic', feed_tag_label:'موضوع مستقل', create_date:'۱ ساعت پیش', duration:25, visit_count:100, plays:10 }
];
rankCandidatesByMomentum(topicBaseline, topicState, topicStart);
const topicSecondScan = [
  { ...topicBaseline[0], visit_count:120, plays:20 },
  { ...topicBaseline[1], visit_count:115, plays:15 },
  { ...topicBaseline[2], visit_count:120, plays:20 }
];
const topicRank = rankCandidatesByMomentum(topicSecondScan, topicState, topicStart + 5 * 60 * 1000);
assert.equal(topicRank[0].item.video_code, 'HotA01',
  'a corroborated topic cohort may lift a slightly slower candidate above a similarly paced isolated candidate');
assert.ok(topicRank[0].topicDemandScore > topicRank[2].topicDemandScore,
  'topic demand must be derived from multiple candidates showing measured growth');
assert.ok(topicRank[0].rankingScore > 0);
assert.ok(topicRank[0].durationPreferenceScore > topicRank[1].durationPreferenceScore,
  'duration preference must be present as a separate soft ranking feature');
const nonGrowingTopicDemand = summarizeTopicDemand([
  { topicKey:'broad-no-growth', hasPositivePlayGrowth:false, hasPositiveViewGrowth:false, momentum:{} },
  { topicKey:'broad-no-growth', hasPositivePlayGrowth:false, hasPositiveViewGrowth:false, momentum:{} },
  { topicKey:'broad-no-growth', hasPositivePlayGrowth:false, hasPositiveViewGrowth:false, momentum:{} }
]);
assert.equal(nonGrowingTopicDemand['broad-no-growth'].demandScore, 0,
  'a broad feed with no measured growth must not be presented as a hot topic');
const singleGrowingTopicDemand = summarizeTopicDemand([
  { topicKey:'weak-growth', hasPositivePlayGrowth:true, hasPositiveViewGrowth:false,
    momentum:{playsPerMinute:3,playsAccelerationPerMinute:1} },
  { topicKey:'weak-growth', hasPositivePlayGrowth:false, hasPositiveViewGrowth:false, momentum:{} }
]);
assert.equal(singleGrowingTopicDemand['weak-growth'].demandScore, 0,
  'topic-level demand needs at least two distinct growing candidates');
const corroboratedTopicDemand = summarizeTopicDemand([
  { topicKey:'corroborated', hasPositivePlayGrowth:true, hasPositiveViewGrowth:false,
    momentum:{playsPerMinute:3,playsAccelerationPerMinute:1} },
  { topicKey:'corroborated', hasPositivePlayGrowth:false, hasPositiveViewGrowth:true,
    momentum:{viewsPerMinute:5,viewsAccelerationPerMinute:2} }
]);
assert.ok(corroboratedTopicDemand.corroborated.demandScore > 0,
  'two independently growing videos can establish in-Filo topic demand');
assert.equal(topicRank.some(entry => entry.item.video_code === 'HotB01'), true,
  'longer eligible content remains in the ranking rather than being hard-rejected');
const trendSignalNow = Date.parse('2026-11-06T12:00:00.000Z');
const trendSignalSnapshot = {
  schemaVersion: 3,
  updated_at: new Date(trendSignalNow).toISOString(),
  telegram: {
    comedyTelegram: {
      lane: 'comedy',
      last_seen_at: new Date(trendSignalNow).toISOString(),
      last_views: 1100,
      history: [
        { at: new Date(trendSignalNow - 60 * 60 * 1000).toISOString(), views: 100 },
        { at: new Date(trendSignalNow).toISOString(), views: 1100 }
      ]
    }
  },
  youtube_cc: {
    comedyYoutube: {
      lane: 'comedy',
      last_seen_at: new Date(trendSignalNow).toISOString(),
      last_views: 2200,
      history: [
        { at: new Date(trendSignalNow - 60 * 60 * 1000).toISOString(), views: 200 },
        { at: new Date(trendSignalNow).toISOString(), views: 2200 }
      ]
    }
  }
};
const freshTrendWeights = buildFreshPlatformTrendWeights(trendSignalSnapshot, trendSignalNow);
assert.equal(freshTrendWeights.persian_comedy, 10,
  'fresh cross-platform trend state must be converted through the shared topic taxonomy');
const staleTrendWeights = buildFreshPlatformTrendWeights({
  ...trendSignalSnapshot,
  updated_at: new Date(trendSignalNow - 49 * 60 * 60 * 1000).toISOString()
}, trendSignalNow);
assert.deepEqual(staleTrendWeights, {},
  'stale platform trend snapshots must not influence Filo candidate ranking');
assert.deepEqual(buildFreshPlatformTrendWeights(null, trendSignalNow), {},
  'a missing trend snapshot must safely disable only the external topic bonus');
assert.deepEqual(buildFreshPlatformTrendWeights([], trendSignalNow), {},
  'a malformed trend snapshot must safely disable only the external topic bonus');
assert.deepEqual(buildFreshPlatformTrendWeights({
  ...trendSignalSnapshot,
  updated_at: new Date(trendSignalNow + 6 * 60 * 1000).toISOString()
}, trendSignalNow), {},
  'a future-dated trend snapshot beyond clock tolerance must be ignored');
assert.equal(candidateExternalTopicKey({ title: 'دموی فناوری و ربات هوشمند' }), 'technology_demo');
assert.equal(candidateExternalTopicKey({ title: 'طنز ویدئوی بامزه و خنده دار' }), 'persian_comedy');
assert.equal(candidateExternalTopicKey({
  title: 'کلیپ بلوچی آهنگ بلوچی دوردو',
  feed_tag_label: 'آهنگ'
}), 'performance_magic',
  'Filo music feed labels must map into the shared music/dance topic instead of generic entertainment');
assert.equal(candidateExternalTopicKey({
  title: 'ویدئوی کوتاه',
  feed_tag_label: 'هوش مصنوعی'
}), 'technology_demo',
  'Filo AI labels must map into the shared technology topic when the title itself is generic');

const crossPlatformState = { posts: [] };
const crossPlatformBaseline = [
  { video_code:'ComedyT1', title:'طنز ویدئوی بامزه و خنده دار', create_date:'۱ ساعت پیش', duration:30, visit_count:100, plays:10 },
  { video_code:'TechT01', title:'دموی فناوری و ربات هوشمند', create_date:'۱ ساعت پیش', duration:30, visit_count:100, plays:10 }
];
rankCandidatesByMomentum(crossPlatformBaseline, crossPlatformState, trendSignalNow);
const crossPlatformSecondScan = crossPlatformBaseline.map(item => ({ ...item, visit_count:120, plays:20 }));
const crossPlatformRank = rankCandidatesByMomentum(
  crossPlatformSecondScan,
  crossPlatformState,
  trendSignalNow + 5 * 60 * 1000,
  { persian_comedy: 0, technology_demo: 10 }
);
assert.equal(crossPlatformRank[0].item.video_code, 'TechT01',
  'a currently trending topic across platforms must lift an otherwise equally growing Filo candidate');
assert.equal(crossPlatformRank[0].externalTopicKey, 'technology_demo');
assert.equal(crossPlatformRank[0].externalTopicTrendScore, 100);
assert.equal(crossPlatformRank[1].externalTopicTrendScore, 0);
assert.ok(crossPlatformRank[0].rankingScore > crossPlatformRank[1].rankingScore);

const durationTieState = { posts: [] };
const durationTieBaseline = [
  { video_code:'Short01', title:'ویدئوی سرگرم کننده', feed_tag:'q-same-topic', create_date:'۱ ساعت پیش', duration:20, visit_count:100, plays:10 },
  { video_code:'Longer1', title:'ویدئوی سرگرم کننده', feed_tag:'q-same-topic', create_date:'۱ ساعت پیش', duration:240, visit_count:100, plays:10 }
];
rankCandidatesByMomentum(durationTieBaseline, durationTieState, trendSignalNow);
const durationTieRank = rankCandidatesByMomentum(
  durationTieBaseline.map(item => ({ ...item, visit_count:120, plays:20 })),
  durationTieState,
  trendSignalNow + 5 * 60 * 1000
);
assert.equal(durationTieRank[0].item.video_code, 'Short01',
  'short-form preference must decide an otherwise identical candidate comparison');
assert.equal(durationTieRank.some(entry => entry.item.video_code === 'Longer1'), true,
  'the soft duration preference must not remove eligible long videos');

const pacingNow = Date.parse('2026-11-06T12:00:00.000Z');
const oneRecentPublication = { posts: [
  { status:'public_verified', submittedAt:new Date(pacingNow - 10*60*1000).toISOString() }
] };
const blockedByGap = getPublicationPacingGate(oneRecentPublication, pacingNow);
assert.equal(blockedByGap.blocked, true);
assert.deepEqual(blockedByGap.reasons, ['minimum_gap_between_republish_operations']);
assert.equal(blockedByGap.nextEligibleAt, new Date(pacingNow + 10*60*1000).toISOString());
assert.equal(getPublicationPacingGate(oneRecentPublication, pacingNow + 10*60*1000).blocked, false,
  'the next repost becomes eligible at the 20-minute minimum gap');

const rollingHourState = { posts: [
  { status:'public_verified', submittedAt:new Date(pacingNow - 50*60*1000).toISOString() },
  { status:'public_verified', submittedAt:new Date(pacingNow - 30*60*1000).toISOString() },
  { status:'rejected_by_filo', attemptedAt:new Date(pacingNow - 10*60*1000).toISOString() }
] };
const blockedByHour = getPublicationPacingGate(rollingHourState, pacingNow);
assert.equal(blockedByHour.blocked, true,
  'rejected upload attempts count toward the rolling-hour safety budget');
assert.ok(blockedByHour.reasons.includes('rolling_hour_operation_cap'));
assert.equal(blockedByHour.rollingHourOperations, 3);
assert.equal(blockedByHour.nextEligibleAt, new Date(pacingNow + 10*60*1000).toISOString(),
  'the next slot opens when the oldest operation leaves the rolling hour');

const dailyPacingState = { posts: Array.from({length:36},(_,index)=>({
  status:'public_verified',
  submittedAt:new Date(pacingNow - (23*60+index)*60*1000).toISOString()
})) };
const blockedByDay = getPublicationPacingGate(dailyPacingState, pacingNow);
assert.equal(blockedByDay.blocked, true);
assert.ok(blockedByDay.reasons.includes('rolling_24h_operation_cap'));
assert.equal(dailyCount(dailyPacingState,pacingNow),36);

const quotaBackoffState = {};
const quotaFirst = setAccountRepublishQuotaCooldown(quotaBackoffState,pacingNow);
assert.equal(quotaFirst.cooldownMs,2*60*60*1000);
const quotaSecond = setAccountRepublishQuotaCooldown(quotaBackoffState,pacingNow+60*60*1000);
assert.equal(quotaSecond.cooldownMs,4*60*60*1000,
  'a repeated account quota response within 24h must increase the cooldown');
assert.equal(quotaSecond.occurrenceCountIn24h,2);

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
