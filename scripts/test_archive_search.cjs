const assert = require('node:assert/strict');
const {
  LICENSE_QUERY_FILTERS,
  LICENSE_QUERY_EXCLUSIONS,
  buildInternetArchiveSearchQuery
} = require('./archive_search.cjs');

const query = buildInternetArchiveSearchQuery('cats playing');
assert.match(query, /^mediatype:movies AND /);
assert.match(query, / AND \(cats playing\)$/);
assert.equal(LICENSE_QUERY_FILTERS.length, 2);
assert.equal(LICENSE_QUERY_EXCLUSIONS.length, 2);
assert.ok(query.includes('licenseurl:http*zero*1.0*'));
assert.ok(query.includes('licenseurl:http*by*4.0*'));
assert.ok(query.includes('NOT licenseurl:http*nc*'));
assert.ok(query.includes('NOT licenseurl:http*nd*'));
assert.doesNotMatch(query, /licenses\/by\/4\.0|licenses\/by-sa\/4\.0/);
assert.throws(() => buildInternetArchiveSearchQuery(''), /archive_search_term_required/);

console.log('ARCHIVE_LICENSE_SEARCH_TESTS_OK', JSON.stringify({
  acceptedLicenseFamilies: ['CC0 1.0', 'CC BY 4.0', 'CC BY-SA 4.0'],
  excludedLicenseFamilies: ['NonCommercial', 'NoDerivatives'],
  usesInternetArchiveAbbreviationSyntax: true,
  preservesContentSearchTerm: true
}));
