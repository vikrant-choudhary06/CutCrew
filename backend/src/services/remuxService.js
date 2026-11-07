const { spawn } = require('child_process');
const metadata=require('./mediaMetadata');
const health=require('./playbackHealth');
const mkvJump=require('./mkvJump');
const threads=Math.min(8,Math.max(1,Number(process.env.FFMPEG_THREADS)||Math.min(4,require('node:os').availableParallelism())));
let active = 0;
const limit = Math.min(8, Math.max(1, Number(process.env.MAX_REMUX_STREAMS) || 2));
function ffmpegArgs(input, transcodeVideo = false, start = 0, audio = 0, height = 0) {
  const cap=[360,480,720].includes(height)?height:720,rate=cap===360?900:cap===480?1800:3500;
  const readRate=Number(process.env.REMUX_READ_RATE)||0;
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rw_timeout', '15000000',
    ...(readRate>0?['-readrate',String(readRate)]:[]), '-threads',String(threads), ...(start > 0 ? ['-ss', String(start)] : []), '-f', 'matroska', '-i', input,
    '-map', '0:v:0', '-map', `0:a:${audio}?`, '-sn',
    ...(transcodeVideo ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-vf', `scale=w='min(${Math.ceil(cap*16/9/2)*2},iw)':h='min(${cap},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`, '-threads',String(threads),'-maxrate',rate+'k','-bufsize',rate*2+'k'] : ['-c:v', 'copy']),
    '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000',
    '-progress','pipe:2','-stats_period','1','-f', 'mp4', 'pipe:1'];
}
function canCopyVideo(stream) {
  return stream?.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(stream.pix_fmt);
}
function remuxMedia(req, res, ticket, signMedia) {
  const start = Number(req.query.start || 0), audio = Number(req.query.audio || 0), height=Number(req.query.height||0);
  if (!Number.isFinite(start) || start < 0 || start > 172800 || !Number.isInteger(audio) || audio < 0 || audio > 63 || ![0,360,480,720].includes(height)) return res.status(400).json({ error: 'Invalid playback position or audio track' });
  if (req.method === 'HEAD') return res.type('video/mp4').end();
  if (active >= limit) return res.status(503).json({ error: 'Video conversion is busy. Please retry shortly.' });
  const input = 'http://127.0.0.1:' + req.socket.localPort + signMedia(ticket.url, ticket.headers, 'original', ticket.expires);
  const options = { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  active++;
  let released = false, child, probe, gotData = false, probeTimeout, conversionId, jump = null;
  const lookup = new AbortController();
  const release = () => { if (!released) { released = true; active--; if(conversionId)health.conversionEnd(conversionId); } };
  const stop = () => { lookup.abort(); jump?.stream.destroy(); probe?.kill(); child?.kill(); release(); clearTimeout(startup); clearTimeout(lifetime); clearTimeout(probeTimeout); };
  const fail = (status, error) => {
    stop();
    if (!res.headersSent && !res.destroyed) res.status(status).json({ error });
    else res.destroy();
  };
  const startup = setTimeout(() => { if (!gotData) fail(504, 'Video source did not start in time'); }, 40000);
  const lifetime = setTimeout(() => fail(504, 'Playback session expired'), 4 * 3600000);
  lifetime.unref();
  res.on('close', stop);
  async function convert(transcodeVideo) {
    if (res.destroyed || released) return;
    // A deep jump in an MKV without an index: start reading near the wanted
    // point instead of letting ffmpeg download everything before it.
    if (start >= 120) jump = await mkvJump.openAt(input, start, { signal: lookup.signal }).catch(() => null);
    if (res.destroyed || released) { jump?.stream.destroy(); return; }
    conversionId=health.conversionStart(ticket.url,transcodeVideo?'transcode':'copy');
    child = jump
      ? spawn(process.env.FFMPEG_PATH || 'ffmpeg', ffmpegArgs('pipe:0', transcodeVideo, Math.max(0, start - jump.start), audio, height), { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(process.env.FFMPEG_PATH || 'ffmpeg', ffmpegArgs(input, transcodeVideo, start, audio, height), options);
    if (jump) { child.stdin.on('error', () => {}); jump.stream.on('error', () => child.stdin.destroy()); jump.stream.pipe(child.stdin); }
    child.on('error', () => fail(503, 'Server media conversion is unavailable'));
    child.on('close', code => {
      if (code && !res.destroyed) fail(502, 'This video source could not be converted');
      else { stop(); if (!res.destroyed) res.end(); }
    });
    let progress='';
    child.stderr.on('data',chunk=>{progress+=chunk.toString();const lines=progress.split('\n');progress=lines.pop().slice(-4096);for(const line of lines){const [key,value]=line.trim().split('=');const number=parseFloat(value);if(!Number.isFinite(number))continue;if(key==='speed')health.conversionUpdate(conversionId,{speed:number});if(key==='out_time_us')health.conversionUpdate(conversionId,{mediaSeconds:number/1000000});if(key==='total_size')health.conversionUpdate(conversionId,{bytes:number})}});
    child.stdout.once('data', () => { gotData = true; clearTimeout(startup); });
    res.type('video/mp4').set('Cache-Control', 'private, no-store').set('Accept-Ranges', 'none');
    child.stdout.pipe(res, { end: false });
  }
  const cached=metadata.get(ticket);
  if(cached?.video){convert(!canCopyVideo(cached.video)||!!height&&cached.video.height>height);return}
  probe = spawn(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-analyzeduration', '2000000',
    '-probesize', '1000000', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height',
    '-of', 'json', input], options);
  let output = '', probing = true;
  const finishProbe = transcode => {
    if (!probing) return;
    probing = false; clearTimeout(probeTimeout); probe.kill(); convert(transcode);
  };
  probeTimeout = setTimeout(() => finishProbe(true), 10000);
  probe.stdout.on('data', chunk => { if (output.length < 16000) output += chunk.toString(); });
  probe.stderr.resume();
  probe.on('error', () => finishProbe(true));
  probe.on('close', () => {
    let stream;
    try { stream = JSON.parse(output).streams?.[0]; } catch { /* Conservatively transcode unknown video codecs. */ }
    if(stream)metadata.put(ticket,{video:stream});
    finishProbe(!canCopyVideo(stream)||!!height&&stream?.height>height);
  });
}
module.exports = { ffmpegArgs, canCopyVideo, remuxMedia, activeConversions: () => active };
