'use strict';

const assert = require('node:assert/strict');
const { looksRelevant, persianTitle } = require('./editorial_content.cjs');

assert.equal(looksRelevant('Cat Jumpscare', 'A cat suddenly jumps in front of the camera'), true);
assert.equal(looksRelevant('Unexpected football trick shot', ''), true);
assert.equal(looksRelevant('Satisfying pottery process', ''), true);
assert.equal(looksRelevant('دوربین مخفی ایرانی', 'یک موقعیت طنز'), true);
assert.equal(looksRelevant('Iranian political protest', 'A street demonstration'), false);

assert.equal(persianTitle('Cat Jumpscare', ''), 'رفتار غیرمنتظره یک گربه');
assert.equal(persianTitle('Squirrel eating a nut', ''), 'رفتار جالب یک حیوان');
assert.equal(persianTitle('Cooking food art', ''), 'یک ایده خلاقانه در آشپزی');
assert.equal(persianTitle('Unexpected football trick shot', ''), 'نمایش یک مهارت ورزشی دیدنی');

for (const title of [
  persianTitle('Cat Jumpscare', ''),
  persianTitle('Satisfying pottery process', ''),
  persianTitle('Unexpected football trick shot', '')
]) {
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(title), false, 'Filo titles should not contain emoji');
}

console.log('EDITORIAL_CONTENT_TESTS_PASSED');