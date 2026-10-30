'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REGULAR_FONT = '/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf';
const BOLD_FONT = '/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf';

function escapeDrawText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function probeVideo(filePath) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height',
    '-show_entries', 'format=duration',
    '-of', 'json',
    filePath
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  const data = JSON.parse(raw);
  const video = (data.streams || []).find(stream => stream.codec_type === 'video');
  if (!video) throw new Error('filo_end_card_video_stream_missing');
  return {
    width: Number(video.width),
    height: Number(video.height),
    durationSeconds: Number(data.format && data.format.duration)
  };
}

function appendFiloEndCard(inputPath, outputPath, options = {}) {
  const width = Number(options.width) || 720;
  const height = Number(options.height) || 1280;
  const durationSeconds = Math.max(1.2, Math.min(2.2, Number(options.durationSeconds) || 1.6));
  const regularFont = options.regularFont || REGULAR_FONT;
  const boldFont = options.boldFont || BOLD_FONT;

  if (!fs.existsSync(inputPath)) throw new Error('filo_end_card_input_missing');
  if (!fs.existsSync(regularFont) || !fs.existsSync(boldFont)) {
    throw new Error('filo_persian_end_card_fonts_missing');
  }
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error('filo_end_card_output_must_differ_from_input');
  }

  const before = probeVideo(inputPath);
  if (before.width !== width || before.height !== height || !Number.isFinite(before.durationSeconds)) {
    throw new Error('filo_end_card_input_dimensions_or_duration_invalid');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = outputPath + '.tmp.mp4';
  const firstLine = escapeDrawText('برای ویدیوهای بیشتر');
  const secondLine = escapeDrawText('گوشی‌باز را در فیلو دنبال کنید');
  const filter = [
    `[0:v]fps=30,scale=${width}:${height},setsar=1,format=yuv420p[main]`,
    `[1:v]drawtext=fontfile=${regularFont}:text='${firstLine}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=h*0.43:text_shaping=1,` +
      `drawtext=fontfile=${boldFont}:text='${secondLine}':fontcolor=0x7FE6D2:fontsize=40:x=(w-text_w)/2:y=h*0.53:text_shaping=1[card]`,
    '[main][card]concat=n=2:v=1:a=0[v]'
  ].join(';');

  try {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-f', 'lavfi', '-t', String(durationSeconds),
      '-i', `color=c=0x101827:s=${width}x${height}:r=30`,
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-af', `apad=pad_dur=${durationSeconds}`,
      '-movflags', '+faststart',
      tempPath
    ], { stdio: 'pipe', timeout: 120000 });

    const after = probeVideo(tempPath);
    const minimumDuration = before.durationSeconds + durationSeconds - 0.12;
    if (after.width !== width || after.height !== height ||
        after.durationSeconds < minimumDuration || !fs.statSync(tempPath).size) {
      throw new Error('filo_end_card_output_validation_failed');
    }
    fs.renameSync(tempPath, outputPath);
    return {
      width: after.width,
      height: after.height,
      durationSeconds: Math.round(after.durationSeconds * 100) / 100,
      endCardSeconds: durationSeconds,
      outputBytes: fs.statSync(outputPath).size,
      text: 'برای ویدیوهای بیشتر | گوشی‌باز را در فیلو دنبال کنید'
    };
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

module.exports = { appendFiloEndCard };
