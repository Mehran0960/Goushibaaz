const LICENSE_QUERY_FILTERS = Object.freeze([
  'licenseurl:http*publicdomain/zero/1.0*',
  'licenseurl:http*licenses/by/4.0*',
  'licenseurl:http*licenses/by-sa/4.0*'
]);

function buildInternetArchiveSearchQuery(searchTerm) {
  const term = String(searchTerm || '').trim();
  if (!term) throw new TypeError('archive_search_term_required');
  const licenseFilter = '(' + LICENSE_QUERY_FILTERS.join(' OR ') + ')';
  return 'mediatype:movies AND ' + licenseFilter + ' AND (' + term + ')';
}

module.exports = { LICENSE_QUERY_FILTERS, buildInternetArchiveSearchQuery };
