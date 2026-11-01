const assert = require('node:assert/strict');
const { rightsStatus, candidateFrom } = require('./merge_short_candidates.cjs');

const unknown = rightsStatus({ license_status: 'unverified' }, new Map());
assert.equal(unknown.rights_decision, 'pending_rights_review');
assert.equal(unknown.republish_eligible, false);

const unknownCandidate = candidateFrom({
  title: 'نمونه ویدئوی سرگرم‌کننده',
  source_url: 'https://example.test/video/1',
  license_status: 'unverified'
}, 'test_source', new Map());
assert.ok(unknownCandidate, 'unknown-rights candidates stay in the discovery shortlist');
assert.equal(unknownCandidate.rights_decision, 'pending_rights_review');
assert.equal(unknownCandidate.republish_eligible, false);

const ccBySa = rightsStatus({
  license_status: 'cc_by_sa',
  rights_verified: true
}, new Map());
assert.equal(ccBySa.rights_decision, 'cleared');
assert.equal(ccBySa.republish_eligible, true);

const creatorPermission = rightsStatus({
  license_status: 'standard_or_other',
  explicit_permission_verified: true
}, new Map());
assert.equal(creatorPermission.rights_decision, 'cleared');

const restricted = rightsStatus({
  license_status: 'standard_or_other',
  license: 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0'
}, new Map());
assert.equal(restricted.rights_decision, 'restricted_license');
assert.equal(restricted.republish_eligible, false);

const explicitlyBlocked = rightsStatus({
  license_status: 'unverified',
  rights_verified: true,
  republication_prohibited: true
}, new Map());
assert.equal(explicitlyBlocked.rights_decision, 'blocked_explicit_restriction');
assert.equal(explicitlyBlocked.republish_eligible, false);

console.log('RIGHTS_POLICY_TESTS_OK', JSON.stringify({
  unknownRetainedButNotPublishable: true,
  ccBySaAcceptedWhenVerified: true,
  creatorPermissionAccepted: true,
  restrictedLicenseBlocked: true,
  explicitProhibitionBlocked: true
}));
