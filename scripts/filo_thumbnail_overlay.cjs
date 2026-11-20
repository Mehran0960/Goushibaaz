'use strict';

function normalizeHeadline(value) {
  return String(value || '')
    .replace(/[\u200c\u200d\u200e\u200f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

async function applyFiloEditorialThumbnailOverlay(page, sourceDataUrl, title, {
  outputMimeType = null,
  quality = 0.92
} = {}) {
  const headline = normalizeHeadline(title);
  if (!headline) return { ok: false, reason: 'thumbnail_headline_missing' };
  if (!page || typeof page.evaluate !== 'function') {
    return { ok: false, reason: 'thumbnail_page_evaluate_unavailable' };
  }
  if (!/^data:image\/(?:png|jpe?g);base64,/i.test(String(sourceDataUrl || ''))) {
    return { ok: false, reason: 'thumbnail_source_data_url_invalid' };
  }

  try {
    const result = await page.evaluate(async ({ source, headline, outputMimeType, quality }) => {
      const image = new Image();
      image.src = source;
      try { await image.decode(); } catch { return null; }
      if (!image.naturalWidth || !image.naturalHeight) return null;

      const width = image.naturalWidth;
      const height = image.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(image, 0, 0, width, height);

      const scale = Math.min(width / 640, height / 360);
      const margin = Math.max(14, Math.round(22 * scale));
      const bandTop = Math.round(height * 0.62);
      const gradient = context.createLinearGradient(0, bandTop, 0, height);
      gradient.addColorStop(0, 'rgba(7, 13, 22, 0)');
      gradient.addColorStop(0.24, 'rgba(7, 13, 22, 0.76)');
      gradient.addColorStop(1, 'rgba(7, 13, 22, 0.94)');
      context.fillStyle = gradient;
      context.fillRect(0, bandTop, width, height - bandTop);

      const accentWidth = Math.max(4, Math.round(6 * scale));
      context.fillStyle = '#26c6b5';
      context.fillRect(width - margin, bandTop + Math.round(18 * scale), accentWidth, Math.round(height * 0.24));

      context.save();
      context.direction = 'rtl';
      context.textAlign = 'right';
      context.textBaseline = 'middle';
      const x = width - margin - accentWidth - Math.round(12 * scale);
      const maxTextWidth = width * 0.86;
      let fontSize = Math.max(17, Math.round(height * 0.09));
      context.font = '700 ' + fontSize + 'px "Noto Sans Arabic", "Noto Naskh Arabic", Arial, sans-serif';

      const words = String(headline).split(/\s+/).filter(Boolean);
      const lines = [];
      let line = '';
      for (const word of words) {
        const candidate = line ? line + ' ' + word : word;
        if (line && context.measureText(candidate).width > maxTextWidth && lines.length < 1) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      if (line) lines.push(line);
      if (lines.length > 2) {
        lines.length = 2;
        let second = lines[1];
        while (second && context.measureText(second + '…').width > maxTextWidth) {
          second = second.split(/\s+/).slice(0, -1).join(' ');
        }
        lines[1] = second ? second + '…' : '…';
      }
      while (fontSize > 16 && lines.some(text => context.measureText(text).width > maxTextWidth)) {
        fontSize -= 1;
        context.font = '700 ' + fontSize + 'px "Noto Sans Arabic", "Noto Naskh Arabic", Arial, sans-serif';
      }

      context.shadowColor = 'rgba(0,0,0,0.56)';
      context.shadowBlur = Math.max(3, Math.round(7 * scale));
      context.lineJoin = 'round';
      context.strokeStyle = 'rgba(0,0,0,0.52)';
      context.lineWidth = Math.max(2, Math.round(3 * scale));
      const lineHeight = Math.round(fontSize * 1.2);
      const firstY = lines.length > 1
        ? height - margin - lineHeight * 1.25
        : height - margin - lineHeight * 0.7;
      lines.forEach((text, index) => {
        const y = firstY + (lines.length > 1 ? index * lineHeight : 0);
        context.strokeText(text, x, y, maxTextWidth);
        context.fillStyle = '#ffffff';
        context.fillText(text, x, y, maxTextWidth);
      });

      context.shadowBlur = 0;
      context.font = '700 ' + Math.max(11, Math.round(height * 0.036)) + 'px "Noto Sans Arabic", "Noto Naskh Arabic", Arial, sans-serif';
      context.fillStyle = '#62e5d5';
      context.fillText('گوشی‌باز', x, bandTop + Math.round(18 * scale));
      context.restore();

      const mime = outputMimeType || (source.startsWith('data:image/png') ? 'image/png' : 'image/jpeg');
      return {
        dataUrl: canvas.toDataURL(mime, quality),
        width,
        height,
        mime
      };
    }, {
      source: sourceDataUrl,
      headline,
      outputMimeType,
      quality: Math.max(0.6, Math.min(0.98, Number(quality) || 0.92))
    });

    if (!result || !result.dataUrl) {
      return { ok: false, reason: 'thumbnail_canvas_render_failed' };
    }
    return {
      ok: true,
      dataUrl: result.dataUrl,
      width: result.width,
      height: result.height,
      mime: result.mime,
      headline
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'thumbnail_overlay_failed:' + String(error && error.message || error).slice(0, 120)
    };
  }
}

module.exports = {
  normalizeHeadline,
  applyFiloEditorialThumbnailOverlay
};
