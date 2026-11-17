'use strict';

const ALLOWED_URL_HOSTS = new Set([
  'upload.wikimedia.org',
  'archive.org',
  'videos.pexels.com'
]);
const BLOCKED_URL_MARKERS = [
  'upera.tv', 'aparat.com', 'telewebion.com', 'youtube.com',
  '://t.me', 'hostdl.net', 'instagram.com', 'ifilo.net'
];
const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);

/**
 * Validate a direct licensed-media file URL against Filo's current URL-import
 * form and this publisher's source-host allowlist. Rights still must be proven
 * separately by the caller; URL validity is not a reuse licence.
 */
function inspectFiloUrlImportCandidate(candidate = {}) {
  const raw = String(candidate.fileUrl || '').trim();
  if (!raw) return { eligible: false, reason: 'missing_direct_media_url' };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { eligible: false, reason: 'invalid_media_url' };
  }

  const normalized = parsed.href.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:') {
    return { eligible: false, reason: 'https_required' };
  }
  if (BLOCKED_URL_MARKERS.some(marker => normalized.includes(marker))) {
    return { eligible: false, reason: 'blocked_by_filo_url_import_policy' };
  }

  const hostAllowed = ALLOWED_URL_HOSTS.has(hostname) || hostname.endsWith('.archive.org');
  if (!hostAllowed) {
    return { eligible: false, reason: 'media_host_not_allowlisted' };
  }

  const extension = require('node:path').extname(parsed.pathname).toLowerCase();
  if (!ALLOWED_VIDEO_EXTENSIONS.has(extension)) {
    return { eligible: false, reason: 'unsupported_direct_video_extension' };
  }

  const mime = String(candidate.mime || '').toLowerCase();
  if ((extension === '.mp4' && mime !== 'video/mp4') ||
      (extension === '.webm' && mime !== 'video/webm')) {
    return { eligible: false, reason: 'media_mime_extension_mismatch' };
  }

  const size = Number(candidate.size);
  if (!Number.isFinite(size) || size < 200000 || size > 45_000_000) {
    return { eligible: false, reason: 'media_size_out_of_range' };
  }

  return {
    eligible: true,
    url: parsed.href,
    host: hostname,
    extension,
    mime,
    size
  };
}

function isVerticalMediaForUrlImport(media = {}) {
  const width = Number(media.width || media.sourceWidth);
  const height = Number(media.height || media.sourceHeight);
  const duration = Number(media.durationSeconds);
  if (!(width > 0 && height > 0 && duration >= 8 && duration <= 180)) return false;
  const ratio = width / height;
  return ratio >= 0.50 && ratio <= 0.64;
}

module.exports = {
  ALLOWED_URL_HOSTS,
  BLOCKED_URL_MARKERS,
  ALLOWED_VIDEO_EXTENSIONS,
  inspectFiloUrlImportCandidate,
  isVerticalMediaForUrlImport
};
