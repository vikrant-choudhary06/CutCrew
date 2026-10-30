const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const express = require('express');
const { ffmpegArgs, canCopyVideo, remuxMedia } = require('../src/services/remuxService');

test('only browser-compatible H.264 pixel formats use video stream copy', () => {
  assert.equal(canCopyVideo({ codec_name: 'h264', pix_fmt: 'yuv420p' }), true);
  assert.equal(canCopyVideo({ codec_name: 'h264', pix_fmt: 'yuv420p10le' }), false);
  assert.equal(canCopyVideo({ codec_name: 'vc1', pix_fmt: 'yuv420p' }), false);
  assert.equal(canCopyVideo({ codec_name: 'hevc', pix_fmt: 'yuv420p' }), false);
  const args = ffmpegArgs('http://127.0.0.1/media', true);
  assert.ok(args.includes('libx264')); assert.ok(args.includes('yuv420p'));
  assert.equal(args[args.indexOf('-i') + 1], 'http://127.0.0.1/media');
});
test('seek and audio arguments are passed as separate ffmpeg arguments',()=>{
  const args=ffmpegArgs('http://127.0.0.1/media',false,123.5,2);
  assert.equal(args[args.indexOf('-ss')+1],'123.5');
  assert.ok(args.indexOf('-ss')<args.indexOf('-i'));assert.ok(args.includes('0:a:2?'));
});
test('real FFmpeg converts unsupported Matroska video to H.264/AAC MP4', async context => {
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0 ||
      spawnSync('ffprobe', ['-version'], { windowsHide: true }).status !== 0) {
    context.skip('FFmpeg/ffprobe are not installed'); return;
  }
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-f', 'matroska', 'pipe:1'],
    { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(generated.status, 0);
  const app = express();
  app.get('/original', (_req, res) => res.type('video/x-matroska').send(generated.stdout));
  app.get('/convert', (req, res) => remuxMedia(req, res, { url: 'https://public.example/video' }, () => '/original'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/convert', { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /video\/mp4/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.subarray(0, 64).includes(Buffer.from('ftyp')));
    const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height',
      '-of', 'json', '-i', 'pipe:0'], { input: bytes, windowsHide: true, timeout: 10000, encoding: 'utf8' });
    assert.equal(result.status, 0);
    const streams = JSON.parse(result.stdout).streams;
    assert.ok(streams.some(stream => stream.codec_name === 'h264' && stream.width === 160 && stream.height === 90));
    assert.ok(streams.some(stream => stream.codec_name === 'aac'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('real seek preserves selected audio through a bounded-range-only source',async context=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Readable}=require('node:stream');
 const {openRange,CHUNK_SIZE,streamRanges}=require('../src/services/rangeStream');
 if(spawnSync('ffmpeg',['-version'],{windowsHide:true}).status!==0){context.skip('FFmpeg unavailable');return;}
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cutcrew-seek-')),file=path.join(directory,'fixture.mkv');
 const generated=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','6','-map','0:v','-map','1:a','-map','2:a','-c:v','ffv1','-g','10','-c:a','pcm_s16le',file],{windowsHide:true,timeout:15000});assert.equal(generated.status,0);const bytes=fs.readFileSync(file),requested=[];
 const open=async range=>{requested.push(range);const m=/^bytes=(\d+)-(\d+)$/.exec(range);assert.ok(m,'source requires bounded range');const start=Number(m[1]),end=Math.min(Number(m[2]),bytes.length-1);return{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`},data:Readable.from([bytes.subarray(start,end+1)])}};
 const app=express();app.get('/original',async(req,res)=>{try{const start=openRange(req.headers.range);if(start===null){res.type('video/x-matroska').send(bytes);return;}res.type('video/x-matroska');await streamRanges(await open(`bytes=${start}-${start+CHUNK_SIZE-1}`),start,open,res,new AbortController().signal)}catch{res.destroy()}});app.get('/convert',(req,res)=>remuxMedia(req,res,{url:'https://public.example/video'},()=>'/original'));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const response=await fetch('http://127.0.0.1:'+server.address().port+'/convert?start=2&audio=1',{signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);const output=Buffer.from(await response.arrayBuffer());const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name','-of','json','pipe:0'],{input:output,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(probe.status,0);const data=JSON.parse(probe.stdout);assert.ok(Number(data.format.duration)<5&&Number(data.format.duration)>3);const decoded=spawnSync('ffmpeg',['-v','error','-i','pipe:0','-map','0:a:0','-t','1','-ac','1','-ar','48000','-f','s16le','pipe:1'],{input:output,windowsHide:true,timeout:10000,maxBuffer:1024*1024});assert.equal(decoded.status,0);function energy(frequency){let real=0,imaginary=0;for(let i=4800;i<decoded.stdout.length/2-4800;i++){const value=decoded.stdout.readInt16LE(i*2),phase=2*Math.PI*frequency*i/48000;real+=value*Math.cos(phase);imaginary+=value*Math.sin(phase);}return real*real+imaginary*imaginary}assert.ok(energy(880)>25*energy(440),'output must contain the selected second audio track');assert.ok(requested.length>0);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('on-demand conversion is not artificially limited to near realtime',()=>{const previous=process.env.REMUX_READ_RATE;delete process.env.REMUX_READ_RATE;try{const args=ffmpegArgs('http://127.0.0.1/media',true,0,0,480);assert.equal(args.includes('-readrate'),false);assert.ok(args.includes('-threads'));assert.ok(args.includes('1800k'));assert.match(args[args.indexOf('-vf')+1],/480/);}finally{if(previous===undefined)delete process.env.REMUX_READ_RATE;else process.env.REMUX_READ_RATE=previous;}});

test('the data saver preset produces a real 360p H264 stream',context=>{
 if(spawnSync('ffmpeg',['-version'],{windowsHide:true}).status!==0){context.skip('FFmpeg unavailable');return}
 const fixture=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=1280x720:rate=10','-t','1','-c:v','ffv1','-f','matroska','pipe:1'],{windowsHide:true,timeout:10000,maxBuffer:8*1024*1024});assert.equal(fixture.status,0);
 const converted=spawnSync('ffmpeg',ffmpegArgs('pipe:0',true,0,0,360),{input:fixture.stdout,windowsHide:true,timeout:10000,maxBuffer:8*1024*1024});assert.equal(converted.status,0);
 const probe=spawnSync('ffprobe',['-v','error','-show_entries','stream=width,height,codec_name','-of','json','pipe:0'],{input:converted.stdout,windowsHide:true,encoding:'utf8',timeout:5000});assert.equal(probe.status,0);
 assert.deepEqual(JSON.parse(probe.stdout).streams[0],{codec_name:'h264',width:640,height:360});
});
test('a 40-second conversion builds ahead of playback rather than taking 40 seconds',async context=>{
 if(spawnSync('ffmpeg',['-version'],{windowsHide:true}).status!==0){context.skip('FFmpeg unavailable');return}
 const generated=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-t','40','-c:v','ffv1','-f','matroska','pipe:1'],{windowsHide:true,timeout:10000,maxBuffer:8*1024*1024});assert.equal(generated.status,0);
 const app=express();app.get('/original',(_req,res)=>res.type('video/x-matroska').send(generated.stdout));app.get('/convert',(req,res)=>remuxMedia(req,res,{url:'https://public.example/long-video'},()=>'/original'));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const start=Date.now(),r=await fetch('http://127.0.0.1:'+server.address().port+'/convert',{signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer()),elapsed=Date.now()-start;assert.ok(elapsed<20000,`conversion took ${elapsed} ms`);const probe=spawnSync('ffprobe',['-v','error','-count_frames','-show_entries','stream=nb_read_frames','-of','json','pipe:0'],{input:bytes,windowsHide:true,encoding:'utf8',timeout:5000});assert.equal(probe.status,0);assert.equal(Number(JSON.parse(probe.stdout).streams[0].nb_read_frames),400,probe.stdout);context.diagnostic(`40 seconds of video prepared in ${elapsed} ms`);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
