// Telegram storage Phase 2: inspect, validate and prepare an owner-supplied
// video before it is split (telegramintegration.md §5).
//
// Preparation happens BEFORE splitting: moving the MP4 index changes byte
// offsets, so the file that gets split and checksummed is the final one.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

class PrepareError extends Error {
  // retryable=false means the source itself is the problem; retrying won't help.
  constructor(code, { retryable = false, details } = {}) { super(code); this.code = code; this.retryable = retryable; this.details = details; }
}

const FFPROBE = () => process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';

// Browser-playable inside MP4 without conversion.
const BROWSER_VIDEO = { h264: ['yuv420p', 'yuvj420p'], av1: ['yuv420p'], vp9: ['yuv420p'] };
const BROWSER_AUDIO = ['aac', 'mp3', 'opus', 'flac'];
// ffprobe reports ISO 639-2 tags; the index stores ISO 639-1 where one exists.
const ISO639 = { hin: 'hi', eng: 'en', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr', pan: 'pa', guj: 'gu',
  urd: 'ur', jpn: 'ja', kor: 'ko', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', rus: 'ru', chi: 'zh', zho: 'zh', ara: 'ar' };
const normalizeLanguage = tag => {
  const value = String(tag || '').toLowerCase();
  if (!value || value === 'und' || value === 'unk') return null;
  return ISO639[value] || value;
};

// Runs a tool without a shell. stdout is size-capped; stderr keeps the tail.
function run(command, args, { timeoutMs = 600000, maxStdout = 4 * 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return reject(new PrepareError('FFMPEG_UNAVAILABLE', { retryable: true })); }
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(value); };
    const onAbort = () => { child.kill('SIGKILL'); finish(new PrepareError('PREPARE_CANCELLED', { retryable: true })); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new PrepareError('FFMPEG_TIMEOUT', { retryable: true })); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > maxStdout) { child.kill('SIGKILL'); finish(new PrepareError('FFPROBE_OUTPUT_TOO_LARGE')); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', error => finish(new PrepareError(error.code === 'ENOENT' ? 'FFMPEG_UNAVAILABLE' : 'FFMPEG_FAILED', { retryable: true })));
    child.on('close', code => finish(null, { code, stdout, stderr }));
  });
}

// ---------- inspection ----------

async function probe(file, options = {}) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new PrepareError('SOURCE_NOT_FOUND');
  if (stat.size < 1) throw new PrepareError('SOURCE_EMPTY');
  const result = await run(FFPROBE(), ['-v', 'error', '-show_entries',
    'format=format_name,duration,size:stream=index,codec_type,codec_name,pix_fmt,width,height,channels,disposition:stream_tags=language,title',
    '-of', 'json', file], { timeoutMs: 120000, ...options });
  if (result.code !== 0) throw new PrepareError('SOURCE_UNREADABLE');
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new PrepareError('SOURCE_UNREADABLE'); }
  const streams = data.streams || [];
  // Cover art is reported as a video stream; skip attached pictures.
  const video = streams.filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.filter(s => s.codec_type === 'audio');
  const duration = Number(data.format?.duration);
  return {
    size: stat.size,
    formatName: data.format?.format_name || '',
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    video: video.map(s => ({ index: s.index, codec: s.codec_name, pixelFormat: s.pix_fmt, width: s.width, height: s.height })),
    audio: audio.map(s => ({ index: s.index, codec: s.codec_name, channels: s.channels ?? null,
      language: normalizeLanguage(s.tags?.language), title: s.tags?.title ? String(s.tags.title).slice(0, 100) : null })),
    subtitles: streams.filter(s => s.codec_type === 'subtitle').length,
  };
}

const isMp4Family = info => /(^|,)(mov|mp4|m4a|3gp|3g2|mj2)(,|$)/.test(info.formatName);

// Reads top-level MP4 boxes: faststart means 'moov' (the index) comes before 'mdat'.
async function mp4Layout(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    let offset = 0, moov = -1, mdat = -1;
    for (let boxes = 0; offset + 8 <= size && boxes < 10000; boxes++) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        boxSize = Number(header.readBigUInt64BE(8));
      } else if (boxSize === 0) boxSize = size - offset;
      if (!Number.isSafeInteger(boxSize) || boxSize < 8) return { valid: false, faststart: false };
      if (type === 'moov' && moov < 0) moov = offset;
      if (type === 'mdat' && mdat < 0) mdat = offset;
      offset += boxSize;
    }
    const valid = moov >= 0 && mdat >= 0 && offset === size;
    return { valid, faststart: valid && moov < mdat, moovOffset: moov, mdatOffset: mdat };
  } finally { await handle.close(); }
}

// Decides what preparation the source needs, without running it.
function planPreparation(info, { allowTranscode = false } = {}) {
  if (!info.video.length) throw new PrepareError('NO_VIDEO_STREAM');
  if (info.video.length > 1) throw new PrepareError('MULTIPLE_VIDEO_STREAMS');
  if (!info.durationSeconds) throw new PrepareError('DURATION_UNKNOWN');
  const video = info.video[0];
  const videoOk = (BROWSER_VIDEO[video.codec] || []).includes(video.pixelFormat);
  const audioOk = info.audio.every(a => BROWSER_AUDIO.includes(a.codec));
  if (!videoOk && !allowTranscode) throw new PrepareError('VIDEO_NOT_BROWSER_COMPATIBLE', { details: { codec: video.codec, pixelFormat: video.pixelFormat } });
  return {
    transcodeVideo: !videoOk,
    transcodeAudio: !audioOk,
    // Copying streams into a new MP4 keeps video quality unchanged.
    needsRemux: !isMp4Family(info) || info.subtitles > 0 || !videoOk || !audioOk,
  };
}

// Checks the declared audio languages against what the file really contains.
function checkLanguages(info, declared = []) {
  const tagged = [...new Set(info.audio.map(a => a.language).filter(Boolean))];
  if (!info.audio.length && declared.length) throw new PrepareError('AUDIO_LANGUAGE_MISMATCH');
  if (tagged.length && declared.some(lang => !tagged.includes(lang))) {
    throw new PrepareError('AUDIO_LANGUAGE_MISMATCH', { details: { tagged, declared } });
  }
  return { tagged, untagged: info.audio.filter(a => !a.language).length };
}

// ---------- decode checks ----------

// Metadata alone doesn't prove the video is intact. 'full' decodes every frame;
// 'sample' decodes short windows at the start, middle and end.
async function decodeCheck(file, info, { mode = 'full', signal, timeoutMs } = {}) {
  const base = ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-xerror'];
  const windows = mode === 'sample'
    ? [0, info.durationSeconds * 0.5, Math.max(0, info.durationSeconds - 5)].map(start => ['-ss', String(Math.max(0, start).toFixed(3)), '-t', '5'])
    : [[]];
  for (const window of windows) {
    const result = await run(FFMPEG(), [...base, ...window, '-i', file, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'],
      { timeoutMs: timeoutMs ?? Math.max(600000, Math.ceil((info.durationSeconds || 0) * 1000)), signal });
    if (result.code !== 0 || result.stderr.trim()) throw new PrepareError('DECODE_FAILED');
  }
  return { mode, windows: windows.length };
}

// The prepared file must open and decode after seeking near the middle and end.
async function seekCheck(file, info, { signal } = {}) {
  for (const fraction of [0.5, 0.9]) {
    const result = await run(FFMPEG(), ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-xerror',
      '-ss', String((info.durationSeconds * fraction).toFixed(3)), '-i', file, '-map', '0:v:0', '-frames:v', '3', '-f', 'null', '-'],
    { timeoutMs: 120000, signal });
    if (result.code !== 0 || result.stderr.trim()) throw new PrepareError('SEEK_CHECK_FAILED');
  }
}

// ---------- preparation ----------

async function freeSpace(directory) {
  const disk = await fs.statfs(directory);
  return disk.bavail * disk.bsize;
}

// Produces the final file to store. Remuxing (stream copy) is preferred;
// transcoding only happens when needed and allowed, and is recorded.
async function prepare(source, workDir, { allowTranscode = false, declaredLanguages = [], decodeMode = 'full', signal } = {}) {
  const info = await probe(source, { signal });
  const plan = planPreparation(info, { allowTranscode });
  const languages = checkLanguages(info, declaredLanguages);
  // 'none' when the source was already decode-checked in the validate stage.
  if (decodeMode !== 'none') await decodeCheck(source, info, { mode: decodeMode, signal });

  await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
  const target = path.join(workDir, 'prepared.mp4');
  let output = source, remuxed = false;
  const layout = isMp4Family(info) ? await mp4Layout(source) : { faststart: false };
  if (plan.needsRemux || !layout.faststart) {
    // Room for the prepared copy plus its split parts, with a margin.
    if (await freeSpace(workDir) < info.size * 2.2 + 256 * 1024 * 1024) throw new PrepareError('INSUFFICIENT_DISK_SPACE', { retryable: true });
    const temp = target + '.partial.mp4';
    await fs.rm(temp, { force: true });
    const args = ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-y', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-sn', '-dn',
      '-map_metadata', '-1', '-map_chapters', '-1',
      ...(plan.transcodeVideo ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']),
      ...(plan.transcodeAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy']),
      '-movflags', '+faststart', '-f', 'mp4', temp];
    const result = await run(FFMPEG(), args, { timeoutMs: Math.max(1800000, Math.ceil(info.durationSeconds * 1000 * (plan.transcodeVideo ? 6 : 1))), signal });
    if (result.code !== 0) { await fs.rm(temp, { force: true }); throw new PrepareError('PREPARE_FAILED', { retryable: true }); }
    // Atomic: a crash never leaves a half-written prepared.mp4 that looks valid.
    await fs.rename(temp, target);
    output = target; remuxed = true;
  }

  const prepared = output === source ? info : await probe(output, { signal });
  const finalLayout = await mp4Layout(output);
  if (!finalLayout.valid || !finalLayout.faststart) throw new PrepareError('FASTSTART_NOT_ACHIEVED');
  if (remuxed) await decodeCheck(output, prepared, { mode: 'sample', signal });
  await seekCheck(output, prepared, { signal });

  const video = prepared.video[0];
  return {
    file: output,
    copiedSource: output === source,
    remuxed,
    transcoded: plan.transcodeVideo || plan.transcodeAudio,
    transcodedVideo: plan.transcodeVideo,
    transcodedAudio: plan.transcodeAudio,
    media: {
      fileName: path.basename(source).slice(0, 255),
      container: 'mp4',
      videoCodec: video.codec,
      audioCodec: prepared.audio[0]?.codec ?? null,
      pixelFormat: video.pixelFormat,
      width: video.width,
      height: video.height,
      durationSeconds: prepared.durationSeconds,
      faststart: true,
      transcoded: plan.transcodeVideo || plan.transcodeAudio,
      tracks: { audio: prepared.audio, subtitlesDropped: info.subtitles, taggedLanguages: languages.tagged },
    },
  };
}

module.exports = { PrepareError, probe, mp4Layout, planPreparation, checkLanguages, decodeCheck, seekCheck, prepare, normalizeLanguage, run };
