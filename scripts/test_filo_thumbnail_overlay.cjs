'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { applyFiloEditorialThumbnailOverlay, normalizeHeadline } = require('./filo_thumbnail_overlay.cjs');

async function main() {
  assert.equal(normalizeHeadline('  روش   پخت‌ کیک شکلاتی  '), 'روش پخت کیک شکلاتی');
  assert.equal(normalizeHeadline(''), '');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d');
      context.fillStyle = '#2471a3';
      context.fillRect(0, 0, 640, 360);
      return canvas.toDataURL('image/jpeg', 0.9);
    });
    const result = await applyFiloEditorialThumbnailOverlay(page, source, 'روش پخت کیک شکلاتی', {
      outputMimeType: 'image/jpeg'
    });
    assert.equal(result.ok, true);
    assert.equal(result.width, 640);
    assert.equal(result.height, 360);
    assert.equal(result.mime, 'image/jpeg');
    assert.equal(result.dataUrl.startsWith('data:image/jpeg;base64,'), true);

    const compared = await page.evaluate(async ({ before, after }) => {
      const load = async url => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return context.getImageData(600, 340, 1, 1).data;
      };
      const a = await load(before);
      const b = await load(after);
      return { before: [...a], after: [...b] };
    }, { before: source, after: result.dataUrl });
    assert.ok(compared.after[0] < compared.before[0] || compared.after[1] < compared.before[1],
      'the editorial lower-third must visibly alter the selected thumbnail frame');

    const missing = await applyFiloEditorialThumbnailOverlay(page, source, '');
    assert.equal(missing.ok, false);
    console.log('FILO_THUMBNAIL_OVERLAY_TESTS_OK');
  } finally {
    await browser.close();
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
