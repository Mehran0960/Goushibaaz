'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function positiveDimension(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 64 || n > 4096) {
    throw new Error('invalid_' + name);
  }
  return n;
}

function probeMedia(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('media_probe_input_missing');
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,width,height,channels,sample_rate',
    '-show_entries', 'format=duration,size',
    '-of', 'json',
    filePath
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000 });
  const data = JSON.parse(raw);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video') || null;
  const audio = streams.find(stream => stream.codec_type === 'audio') || null;
  if (!video) throw new Error('media_video_stream_missing');
  return {
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    videoCodec: String(video.codec_name || ''),
    audio: audio ? {
      codec: String(audio.codec_name || ''),
      channels: Number(audio.channels) || null,
      sampleRate: Number(audio.sample_rate) || null
    } : null,
    durationSeconds: Number(data.format && data.format.duration) || null,
    bytes: Number(data.format && data.format.size) || fs.statSync(filePath).size
  };
}

function buildPortraitFilter(width, height) {
  const w = positiveDimension(width, 'width');
  const h = positiveDimension(height, 'height');
  // The foreground is scaled to fit and is NEVER cropped. A blurred, darkened
  // duplicate fills the remaining canvas so landscape sources still export 9:16.
  return [
    '[0:v]split=2[bgsrc][fgsrc]',
    '[bgsrc]scale=' + w + ':' + h + ':force_original_aspect_ratio=increase,' +
      'crop=' + w + ':' + h + ',boxblur=22:10,eq=brightness=-0.28:saturation=0.78[bg]',
    '[fgsrc]scale=' + w + ':' + h + ':force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,setsar=1,format=yuv420p[v]'
  ].join(';');
}

function convertToPortrait(inputPath, outputPath, options = {}) {
  const width = positiveDimension(options.width || 1080, 'width');
  const height = positiveDimension(options.height || 1920, 'height');
  const source = probeMedia(inputPath);
  if (!source.audio) throw new Error('source_audio_track_missing');
  const maxBytes = Number(options.maxBytes) || 48_000_000;
  const audioBitrate = String(options.audioBitrate || '96k');
  const videoBitrate = String(options.maxrate || '1100k');
  const bufferSize = String(options.bufsize || '2200k');
  const crf = String(Number.isFinite(Number(options.crf)) ? Number(options.crf) : 27);
  const preset = String(options.preset || 'veryfast');
  const timeout = Number(options.timeoutMs) || 240000;

  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-filter_complex_threads', '2',
    '-filter_complex', buildPortraitFilter(width, height),
    '-map', '[v]',
    '-map', '0:a:0',
    '-c:v', 'libx264', '-preset', preset, '-crf', crf,
    '-pix_fmt', 'yuv420p',
    '-maxrate', videoBitrate, '-bufsize', bufferSize,
    '-r', '30',
    '-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2', '-ar', '48000',
    '-movflags', '+faststart',
    outputPath
  ], { stdio: 'pipe', timeout });

  const result = probeMedia(outputPath);
  if (result.width !== width || result.height !== height) {
    throw new Error('portrait_output_dimensions_invalid');
  }
  if (!result.audio || result.audio.codec !== 'aac') {
    throw new Error('portrait_output_audio_missing_or_invalid');
  }
  if (!Number.isFinite(result.durationSeconds) || result.durationSeconds < 1) {
    throw new Error('portrait_output_duration_invalid');
  }
  if (result.bytes < 100_000 || result.bytes > maxBytes) {
    throw new Error('portrait_output_size_out_of_range');
  }
  return {
    width: result.width,
    height: result.height,
    durationSeconds: Math.round(result.durationSeconds * 100) / 100,
    audioCodec: result.audio.codec,
    audioChannels: result.audio.channels,
    outputBytes: result.bytes,
    outputPath
  };
}

module.exports = { probeMedia, buildPortraitFilter, convertToPortrait };
