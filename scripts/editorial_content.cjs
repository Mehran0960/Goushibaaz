'use strict';

const EXCLUDED = /\b(protests?|protesters?|demonstrations?|riot|riots|war|missile|military|army|weapon|weapons|election|politics|political|parliament|government|police crackdown)\b|اعتراضات?|تظاهرات|اغتشاش|جنگ|موشک|پهپاد|بمب|نظامی|تسلیحات|سلاح|انتخابات|سیاست|سیاسی|مجلس|دولت|درگیری|سرکوب/i;

const RELEVANT = /\b(cat|cats|kitten|kittens|feline|dog|dogs|puppy|puppies|pet|pets|bird|birds|parrot|parrots|pigeon|mouse|mice|hamster|hamsters|gerbil|gerbils|squirrel|squirrels|monkey|monkeys|rabbit|rabbits|animal|wildlife|funny|unexpected|surprise|caught on camera|playing|playful|fail|visual comedy|oddly satisfying|satisfying|hidden camera|prank|comedy|comed(y|ic)|humou?r|reaction|meme|sketch|football|soccer|basketball|skateboard|parkour|trick shot|science experiment|invention|technology demo|optical illusion|brain teaser|puzzle|cooking|recipe|food art|food hack|kitchen|baking|street food|woodworking|pottery|craft|restoration|dance|music performance|juggling|nature|landscape|weather phenomenon|ocean|volcano|waterfall|travel|tourism|culture|architecture|traditional|family friendly|animation)\b|گربه|سگ|حیوان|پرنده|موش|همستر|بامزه|طنز|خنده|دوربین مخفی|سوتی|پرنک|چالش|واکنش|فوتبال|بسکتبال|ورزش|حرکت نمایشی|آزمایش علمی|اختراع|فناوری|خطای دید|معما|آشپزی|غذا|خوراکی|شیرینی|کاردستی|نجاری|سفال|رضایت.?بخش|بازسازی|رقص|نوازندگی|موسیقی|طبیعت|آبشار|سفر|گردشگری|فرهنگ|معماری|انیمیشن/i;

function sourceText(fileTitle, description) {
  return [fileTitle, description].filter(Boolean).join(' ').toLocaleLowerCase('fa');
}

function looksRelevant(fileTitle, description = '') {
  const text = sourceText(fileTitle, description);
  return Boolean(text) && !EXCLUDED.test(text) && RELEVANT.test(text);
}

function persianTitle(fileTitle, description = '') {
  const text = sourceText(fileTitle, description);
  if (/\b(cat|cats|kitten|kittens|feline)\b|گربه/.test(text)) return 'رفتار غیرمنتظره یک گربه';
  if (/\b(dog|dogs|puppy|puppies)\b|سگ/.test(text)) return 'حرکت بامزه یک سگ';
  if (/\b(bird|birds|parrot|parrots|pigeon)\b|پرنده/.test(text)) return 'رفتار جالب یک پرنده';
  if (/\b(mouse|mice|hamster|hamsters|gerbil|gerbils)\b|موش|همستر/.test(text)) return 'رفتار بامزه موش‌های خانگی';
  if (/\b(squirrel|squirrels|monkey|monkeys|rabbit|rabbits)\b/.test(text)) return 'رفتار جالب یک حیوان';
  if (/\b(football|soccer|basketball|trick shot|parkour|freestyle|sports? skill|goal|dunk|skateboard)\b|فوتبال|بسکتبال|ورزش|دریبل|حرکت نمایشی|اسکیت/.test(text)) return 'نمایش یک مهارت ورزشی دیدنی';
  if (/\b(science experiment|invention|technology demo|optical illusion|brain teaser|puzzle)\b|آزمایش علمی|اختراع|فناوری|خطای دید|معما/.test(text)) return 'نتیجه جالب یک آزمایش یا خطای دید';
  if (/\b(oddly satisfying|satisfying|restoration|woodworking|pottery|craft|miniature|before and after|transformation)\b|رضایت.?بخش|کاردستی|نجاری|سفال|مرمت|بازسازی|قبل و بعد/.test(text)) return 'فرایند ساخت یا بازسازی رضایت‌بخش';
  if (/\b(cooking|recipe|food art|food hack|kitchen|baking|street food)\b|آشپزی|غذا|خوراکی|شیرینی|آشپزخانه/.test(text)) return 'یک ایده خلاقانه در آشپزی';
  if (/\b(magic|dancing|dance|music performance|musician|singing|instrument|juggling)\b|شعبده|جادو|رقص|نوازندگی|موسیقی|خوانندگی|آکروبات/.test(text)) return 'یک اجرای دیدنی و متفاوت';
  if (/\b(nature|landscape|weather phenomenon|ocean|volcano|waterfall|space footage)\b|طبیعت|آبشار|اقیانوس|پدیده جوی|آتشفشان|منظره|فضا/.test(text)) return 'یک پدیده دیدنی در طبیعت';
  if (/\b(travel|tourism|street life|local culture|traditional|architecture)\b|سفر|گردشگری|فرهنگ|سنتی|معماری|ایرانگردی/.test(text)) return 'نمایی تماشایی از سفر و فرهنگ';
  if (/hidden camera|prank|comedy|humou?r|funny|reaction|meme|sketch|fail|surprise|unexpected|چالش|طنز|خنده|بامزه|سوتی|دوربین مخفی|واکنش/.test(text)) return 'لحظه‌ای سرگرم‌کننده و جالب';
  if (/iranian|tehran|shiraz|ایران|ایرانی|تهران|شیراز|اصفهان/.test(text)) return 'لحظه‌ای جالب از ایران';
  if (/\b(caught on camera|surprise|jumpscare|unexpected|funny|playful|playing|fail)\b/.test(text)) return 'اتفاقی غیرمنتظره و دیدنی';
  return 'ویدیوی کوتاه و جذاب';
}

module.exports = { looksRelevant, persianTitle };