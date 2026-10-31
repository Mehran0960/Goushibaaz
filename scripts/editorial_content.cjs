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
  // Titles must describe an observable subject/action from source metadata.
  // Empty means "not enough evidence to caption safely"; callers must reject it.
  if (/\\b(cat|cats|kitten|kittens|feline)\\b|گربه/.test(text)) {
    if (/jumpscare|jump scare|sudden|suddenly|startled|surprise|unexpected|ناگهان|غافلگیر|واکنش/.test(text)) {
      return 'پرش یا واکنش ناگهانی گربه';
    }
    if (/drink|drinking|water|بطری|آب می.?نوش/.test(text)) return 'رفتار یک گربه هنگام آب خوردن';
    return '';
  }
  if (/\\b(dog|dogs|puppy|puppies)\\b|سگ/.test(text)) {
    if (/reaction|unexpected|surprise|startled|fail|caught on camera|واکنش|غافلگیر|غیرمنتظره|سوتی/.test(text)) {
      return 'واکنش غیرمنتظره یک سگ';
    }
    if (/jump|run|play|playing|fetch|بازی|دویدن|پرش/.test(text)) return 'یک سگ در حال بازی و تحرک';
    return '';
  }
  if (/\\b(bird|birds|parrot|parrots|pigeon)\\b|پرنده|طوطی/.test(text)) {
    if (/drink|drinking|bottle cap|water|آب.?خوردن|در.?بطری/.test(text)) return 'پرنده‌ای در حال آب خوردن از درِ بطری';
    if (/talk|speak|sing|dance|trick|پرواز|صحبت|آواز|رقص/.test(text)) return 'مهارت یا رفتار جالب یک پرنده';
    return '';
  }
  if (/\\b(mouse|mice|hamster|hamsters|gerbil|gerbils)\\b|موش|همستر/.test(text)) {
    if (/run|escape|jump|play|unexpected|فرار|پرش|بازی|غافلگیر/.test(text)) return 'حرکت غیرمنتظره یک حیوان کوچک';
    return '';
  }
  if (/\\b(squirrel|squirrels)\\b/.test(text)) {
    if (/eat|eating|nut|food|خور|غذا/.test(text)) return 'سنجابی در حال خوردن خوراکی';
    if (/jump|run|play|unexpected|پرش|دویدن|بازی|غافلگیر/.test(text)) return 'حرکت غیرمنتظره یک سنجاب';
    return '';
  }
  if (/\\b(football|soccer|basketball|trick shot|parkour|freestyle|sports? skill|goal|dunk|skateboard)\\b|فوتبال|بسکتبال|ورزش|دریبل|حرکت نمایشی|اسکیت/.test(text)) {
    if (/trick shot|freestyle|impossible|skill|goal|dunk|parkour|unexpected|باورنکردنی|مهارت|گل|شوت|دریبل|حرکت نمایشی/.test(text)) {
      if (/football|soccer|فوتبال/.test(text)) return 'یک حرکت یا شوت مهارتی در فوتبال';
      if (/basketball|بسکتبال/.test(text)) return 'یک حرکت مهارتی در بسکتبال';
      return 'اجرای یک مهارت ورزشی';
    }
    return '';
  }
  if (/\\b(science experiment|experiment|optical illusion|brain teaser|puzzle|invention|technology demo)\\b|آزمایش علمی|اختراع|فناوری|خطای دید|معما/.test(text)) {
    if (/unexpected|surprise|reveal|result|illusion|puzzle|غیرمنتظره|غافلگیر|نتیجه|خطای دید|معما/.test(text)) return 'نتیجه یا خطای دیدِ یک آزمایش';
    return '';
  }
  if (/\\b(oddly satisfying|satisfying|restoration|woodworking|pottery|craft|miniature|before and after|transformation)\\b|رضایت.?بخش|کاردستی|نجاری|سفال|مرمت|بازسازی|قبل و بعد/.test(text)) {
    if (/before and after|transformation|restoration|reveal|نتیجه|قبل و بعد|تغییر|بازسازی|مرمت/.test(text)) return 'تغییر چشمگیر در فرایند ساخت یا بازسازی';
    return '';
  }
  if (/\\b(redcurrant|currant|jam recipe)\\b|مربا/.test(text) && /recipe|jam|مربا|آشپزی/.test(text)) return 'طرز تهیه مربا';
  if (/\\b(cooking|recipe|food art|food hack|kitchen|baking|street food)\\b|آشپزی|غذا|خوراکی|شیرینی|آشپزخانه/.test(text)) {
    if (/unusual|unexpected|giant|creative|surprise|reveal|غیرمعمول|غافلگیر|غافلگیرکننده|ترکیب عجیب/.test(text)) return 'یک ترکیب یا روش غیرمعمول در آشپزی';
    return '';
  }
  if (/\\b(magic|dancing|dance|music performance|musician|singing|instrument|juggling)\\b|شعبده|جادو|رقص|نوازندگی|موسیقی|خوانندگی|آکروبات/.test(text)) {
    if (/trick|performance|juggling|skill|شعبده|مهارت|اجرا|نمایشی/.test(text)) return 'اجرای یک مهارت نمایشی';
    return '';
  }
  if (/\\b(travel|tourism|street life|local culture|traditional|architecture)\\b|سفر|گردشگری|فرهنگ|سنتی|معماری|ایرانگردی/.test(text)) {
    if (/hidden|unusual|unexpected|rare|غیرمعمول|غیرمنتظره|کم.?نظیر/.test(text)) return 'نمایی متفاوت از یک مکان یا فرهنگ';
    return '';
  }
  if (/hidden camera|prank|comedy|humou?r|funny|reaction|meme|sketch|fail|surprise|unexpected|caught on camera|چالش|طنز|خنده|بامزه|سوتی|دوربین مخفی|واکنش/.test(text)) {
    if (/hidden camera|prank|دوربین مخفی|پرنک/.test(text)) return 'اتفاقی غیرمنتظره در دوربین مخفی';
    if (/reaction|واکنش/.test(text)) return 'واکنش واقعی و غیرمنتظره';
    if (/fail|سوتی/.test(text)) return 'یک سوتی ثبت‌شده در لحظه';
    if (/surprise|unexpected|غافلگیر|غیرمنتظره/.test(text)) return 'اتفاقی غیرمنتظره در چند ثانیه';
    return '';
  }
  return '';
}

module.exports = { looksRelevant, persianTitle };