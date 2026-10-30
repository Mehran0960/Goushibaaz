'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REGULAR_FONT = '/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf';
const BOLD_FONT = '/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf';

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: options.encoding,
      stdio: options.encoding ? ['ignore', 'pipe', 'pipe'] : 'pipe',
      timeout: options.timeout || 120000
    });
  } catch (error) {
    const detail = String(error && error.stderr || error && error.message || 'command_failed')
      .replace(/\s+/g, ' ').slice(0, 500);
    throw new Error('original_video_' + path.basename(command) + '_failed:' + detail);
  }
}

function mediaDuration(filePath) {
  const raw = run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ], { encoding: 'utf8', timeout: 20000 }).trim();
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error('original_video_duration_unavailable');
  return value;
}

function probeVideo(filePath) {
  const raw = run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height',
    '-show_entries', 'format=duration',
    '-of', 'json', filePath
  ], { encoding: 'utf8', timeout: 20000 });
  const data = JSON.parse(raw);
  const video = (data.streams || []).find(stream => stream.codec_type === 'video');
  const audio = (data.streams || []).find(stream => stream.codec_type === 'audio');
  if (!video || !audio) throw new Error('original_video_missing_audio_or_video_stream');
  return {
    width: Number(video.width),
    height: Number(video.height),
    durationSeconds: Number(data.format && data.format.duration),
    hasAudio: true
  };
}

function escapeDrawText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/;/g, '\\;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function wrapWords(value, maxChars = 26) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (Array.from(next).length > maxChars && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function drawText(text, y, fontSize, color, start, end, font = BOLD_FONT) {
  const escaped = escapeDrawText(text);
  const enable = "between(t," + start.toFixed(3) + "," + end.toFixed(3) + ")";
  return "drawtext=fontfile=" + font + ":text='" + escaped + "':fontcolor=" + color +
    ":fontsize=" + fontSize + ":x=(w-text_w)/2:y=" + y +
    ":text_shaping=1:enable='" + enable + "'";
}

function drawBox(y, height, start, end, fill = '0x26364F@0.96') {
  const enable = "between(t," + start.toFixed(3) + "," + end.toFixed(3) + ")";
  return "drawbox=x=54:y=" + y + ":w=612:h=" + height + ":color=" + fill +
    ":t=fill:enable='" + enable + "'";
}

function visualTheme(puzzle) {
  const topic = String(puzzle.topic || '');
  if (/کلامی|لغز|معمای کلامی/.test(topic)) {
    return {
      background: '0x21170F', border: '0x9A6B36@0.8', panel: '0x3A2818@0.96',
      option: '0x4A3420@0.96', answer: '0x53351F@0.96', accent: '0xFFD18A',
      header: 'گوشی‌باز | معمای کلامی', intro: 'یک معمای کلامی برای تو.'
    };
  }
  if (/منطقی|منطق/.test(topic)) {
    return {
      background: '0x171327', border: '0x65558F@0.8', panel: '0x272044@0.96',
      option: '0x352A58@0.96', answer: '0x382B64@0.96', accent: '0xD7B7FF',
      header: 'گوشی‌باز | آزمون منطق', intro: 'یک چالش منطقی برای تو.'
    };
  }
  if (/دیداری/.test(topic)) {
    return {
      background: '0x0B2022', border: '0x3D8B83@0.8', panel: '0x133B3A@0.96',
      option: '0x1B4B4A@0.96', answer: '0x164F49@0.96', accent: '0x87F0D0',
      header: 'گوشی‌باز | چالش دیداری', intro: 'یک چالش دیداری برای تو.'
    };
  }
  return {
    background: '0x0D1727', border: '0x40516B@0.8', panel: '0x17263D@0.96',
    option: '0x26364F@0.96', answer: '0x163E4A@0.96', accent: '0x83E7D4',
    header: 'گوشی‌باز | چالش عددی', intro: 'یک چالش عددی برای تو.'
  };
}

function makeAudioSegment(espeakBin, filePath, text) {
  run(espeakBin, [
    '-v', 'fa', '-s', '145', '-a', '165', '-p', '48',
    '-w', filePath, text
  ], { timeout: 30000 });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1000) {
    throw new Error('original_video_persian_voice_generation_failed');
  }
  return mediaDuration(filePath);
}

function buildOriginalPuzzleVideo(puzzle, options = {}) {
  if (!puzzle || !puzzle.id || !puzzle.title || !puzzle.question ||
      !Array.isArray(puzzle.options) || puzzle.options.length !== 3 ||
      !Number.isInteger(puzzle.answerIndex) || puzzle.answerIndex < 0 || puzzle.answerIndex > 2 ||
      !puzzle.explanation) throw new Error('original_puzzle_payload_invalid');

  const outputPath = options.outputPath;
  const workDir = options.workDir || path.dirname(outputPath || process.cwd());
  const width = Number(options.width) || 720;
  const height = Number(options.height) || 1280;
  const espeakBin = options.espeakBin || process.env.ESPEAK_NG_BIN || 'espeak-ng';
  const regularFont = options.regularFont || REGULAR_FONT;
  const boldFont = options.boldFont || BOLD_FONT;

  if (!outputPath) throw new Error('original_puzzle_output_path_required');
  if (width !== 720 || height !== 1280) throw new Error('original_puzzle_profile_must_be_720x1280');
  if (!fs.existsSync(regularFont) || !fs.existsSync(boldFont)) throw new Error('original_puzzle_persian_fonts_missing');

  fs.mkdirSync(workDir, { recursive: true });
  const audioDir = path.join(workDir, 'original-puzzle-audio-' + puzzle.id);
  fs.rmSync(audioDir, { recursive: true, force: true });
  fs.mkdirSync(audioDir, { recursive: true });

  const theme = visualTheme(puzzle);
  const optionLabels = ['گزینه اول', 'گزینه دوم', 'گزینه سوم'];
  const segments = [
    theme.intro,
    puzzle.question,
    puzzle.options.map((value, i) => optionLabels[i] + ': ' + value).join('. '),
    'سه... دو... یک...',
    'پاسخ درست: ' + optionLabels[puzzle.answerIndex] + '، ' + puzzle.options[puzzle.answerIndex] + '.',
    'دلیلش: ' + puzzle.explanation,
    'جوابت را در دیدگاه بنویس.'
  ];
  const audioFiles = [];
  const durations = [];
  for (let i = 0; i < segments.length; i++) {
    const filePath = path.join(audioDir, String(i).padStart(2, '0') + '.wav');
    durations.push(makeAudioSegment(espeakBin, filePath, segments[i]));
    audioFiles.push(filePath);
  }

  const audioPath = path.join(audioDir, 'narration.wav');
  const audioInputs = audioFiles.flatMap(file => ['-i', file]);
  const filter = audioFiles.map((_, i) => '[' + i + ':a]apad=pad_dur=0.18[a' + i + ']').join(';') +
    ';' + audioFiles.map((_, i) => '[a' + i + ']').join('') +
    'concat=n=' + audioFiles.length + ':v=0:a=1[aout]';
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...audioInputs,
    '-filter_complex', filter,
    '-map', '[aout]', '-c:a', 'pcm_s16le', audioPath
  ], { timeout: 60000 });

  const gap = 0.18;
  const starts = [];
  let cursor = 0;
  for (let i = 0; i < durations.length; i++) {
    starts.push(cursor);
    cursor += durations[i] + (i < durations.length - 1 ? gap : 0);
  }
  const introStart = starts[0];
  const questionStart = starts[1];
  const optionsStart = starts[2];
  const countdownStart = starts[3];
  const answerStart = starts[4];
  const explanationStart = starts[5];
  const ctaStart = starts[6];
  const countdownDur = durations[3];
  const explanationDur = durations[5];
  const answerEnd = explanationStart + explanationDur + gap + durations[6];
  const optionsEnd = answerStart;
  const end = Math.max(mediaDuration(audioPath) + 0.9, answerEnd + 0.5);
  const questionLines = wrapWords(puzzle.question, 27);
  const explanationLines = wrapWords(puzzle.explanation, 31);

  const filters = [
    'drawbox=x=15:y=15:w=690:h=1250:color=' + theme.border + ':t=3',
    'drawbox=x=35:y=205:w=650:h=300:color=' + theme.panel + ':t=fill',
    drawText(theme.header, 64, 34, theme.accent, 0, end),
    drawText('قبل از جواب، خودت حلش کن!', 145, 32, 'white', 0, answerStart),
    ...questionLines.map((line, i) =>
      drawText(line, 280 + i * 62, 39, 'white', questionStart, answerStart)),
    ...puzzle.options.map((option, i) => {
      const y = 570 + i * 135;
      return [
        drawBox(y, 94, optionsStart, optionsEnd, theme.option),
        drawText((i + 1) + ') ' + option, y + 27, 38, 'white', optionsStart, optionsEnd)
      ].join(',');
    }),
    drawText('جوابت رو حدس بزن و کامنت کن', 1000, 29, '0xB9C7D9', optionsStart, optionsEnd),
    drawText('۳', 955, 84, theme.accent, countdownStart, countdownStart + Math.max(0.4, countdownDur / 3)),
    drawText('۲', 955, 84, theme.accent, countdownStart + countdownDur / 3, countdownStart + (countdownDur * 2 / 3)),
    drawText('۱', 955, 84, theme.accent, countdownStart + (countdownDur * 2 / 3), answerStart),
    "drawbox=x=54:y=425:w=612:h=180:color=' + theme.answer + ':t=fill:enable='between(t," + answerStart.toFixed(3) + "," + end.toFixed(3) + ")'",
    drawText('پاسخ درست', 465, 40, theme.accent, answerStart, end),
    drawText(puzzle.options[puzzle.answerIndex], 545, 58, 'white', answerStart, end),
    ...explanationLines.map((line, i) =>
      drawText(line, 700 + i * 60, 30, '0xE7EDF5', explanationStart, end, regularFont)),
    drawText('جوابت درست بود؟ در دیدگاه بنویس', 1050, 27, theme.accent, ctaStart, end, regularFont)
  ];
  const videoFilter = 'fps=30,' + filters.join(',') + ',format=yuv420p';

  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=' + theme.background + ':s=' + width + 'x' + height + ':r=30:d=' + end.toFixed(3),
    '-i', audioPath,
    '-vf', videoFilter,
    '-map', '0:v:0', '-map', '1:a:0',
    '-af', 'apad=pad_dur=1.0',
    '-t', end.toFixed(3),
    '-c:v', 'libvpx-vp9', '-b:v', '950k', '-deadline', 'realtime', '-cpu-used', '6',
    '-row-mt', '1', '-pix_fmt', 'yuv420p',
    '-c:a', 'libopus', '-b:a', '96k',
    '-f', 'webm', outputPath
  ], { timeout: 180000 });

  const probe = probeVideo(outputPath);
  const sourceBytes = fs.statSync(outputPath).size;
  if (probe.width !== width || probe.height !== height || probe.durationSeconds < end - 0.3 ||
      probe.durationSeconds > 180 || sourceBytes < 50000 || sourceBytes > 45000000) {
    throw new Error('original_puzzle_output_validation_failed');
  }

  fs.rmSync(audioDir, { recursive: true, force: true });
  return {
    puzzleId: puzzle.id,
    width: probe.width,
    height: probe.height,
    durationSeconds: Math.round(probe.durationSeconds * 100) / 100,
    audio: 'Persian eSpeak NG narration',
    sourceBytes,
    coverSeekSeconds: Math.min(4, Math.max(2.5, questionStart + 0.5))
  };
}

module.exports = { buildOriginalPuzzleVideo, probeVideo };
