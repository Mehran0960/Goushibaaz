'use strict';

const assert = require('node:assert/strict');
const { looksRelevant, persianTitle } = require('./editorial_content.cjs');

assert.equal(looksRelevant('Cat Jumpscare', 'A cat suddenly jumps in front of the camera'), true);
assert.equal(looksRelevant('Unexpected football trick shot', ''), true);
assert.equal(looksRelevant('Satisfying pottery process', ''), true);
assert.equal(persianTitle('Commons challenge', ''), '', 'generic source labels must not become publication captions');
assert.equal(persianTitle('Redcurrant jam recipe 19', ''), 'طرز تهیه مربا');
assert.equal(looksRelevant('دوربین مخفی ایرانی', 'یک موقعیت طنز'), true);
assert.equal(looksRelevant('Iranian political protest', 'A street demonstration'), false);

assert.equal(persianTitle('Cat Jumpscare', ''), 'پرش یا واکنش ناگهانی گربه');
assert.equal(persianTitle('Squirrel eating a nut', ''), 'سنجابی در حال خوردن خوراکی');
assert.equal(persianTitle('Cooking food art', ''), '', 'generic cooking metadata must not generate a generic caption');
assert.equal(persianTitle('Unexpected football trick shot', ''), 'یک حرکت یا شوت مهارتی در فوتبال');

for (const title of [
  persianTitle('Cat Jumpscare', ''),
  persianTitle('Satisfying pottery process', ''),
  persianTitle('Unexpected football trick shot', '')
]) {
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(title), false, 'Filo titles should not contain emoji');
}

console.log('EDITORIAL_CONTENT_TESTS_PASSED');