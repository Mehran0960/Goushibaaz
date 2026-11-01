const LICENSE_QUERY_FILTERS = Object.freeze([
  'licenseurl:http*zero*1.0*',
  'licenseurl:http*by*4.0*'
]);

const LICENSE_QUERY_EXCLUSIONS = Object.freeze([
  'NOT licenseurl:http*nc*',
  'NOT licenseurl:http*nd*'
]);

function buildInternetArchiveSearchQuery(searchTerm) {
  const term = String(searchTerm || '').trim();
  if (!term) throw new TypeError('archive_search_term_required');
  const accepted = '(' + LICENSE_QUERY_FILTERS.join(' OR ') + ')';
  const exclusions = LICENSE_QUERY_EXCLUSIONS.join(' AND ');
  return 'mediatype:movies AND ' + accepted + ' AND ' + exclusions + ' AND (' + term + ')';
}

module.exports = {
  LICENSE_QUERY_FILTERS,
  LICENSE_QUERY_EXCLUSIONS,
  buildInternetArchiveSearchQuery
};
