const assert = require('node:assert/strict');
const {
  LICENSE_QUERY_FILTERS,
  buildInternetArchiveSearchQuery
} = require('./archive_search.cjs');

const query = buildInternetArchiveSearchQuery('cats playing');
assert.match(query, /^mediatype:movies AND /);
assert.match(query, / AND \(cats playing\)$/);
assert.equal(LICENSE_QUERY_FILTERS.length, 3);
assert.ok(query.includes('licenseurl:http*publicdomain/zero/1.0*'));
assert.ok(query.includes('licenseurl:http*licenses/by/4.0*'));
assert.ok(query.includes('licenseurl:http*licenses/by-sa/4.0*'));
assert.doesNotMatch(query, /by-nc|by-nd/i);
assert.throws(() => buildInternetArchiveSearchQuery(''), /archive_search_term_required/);

console.log('ARCHIVE_LICENSE_SEARCH_TESTS_OK', JSON.stringify({
  acceptedLicenseFamilies: ['CC0', 'CC BY 4.0', 'CC BY-SA 4.0'],
  excludesNonCommercialAndNoDerivatives: true,
  preservesContentSearchTerm: true
}));
