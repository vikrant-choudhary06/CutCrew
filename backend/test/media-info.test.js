const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {spawnSync}=require('node:child_process');
const media=require('../src/services/mediaService');
const actualSign=media.signMedia;
media.signMedia=()=>'/fixture';
const inspect=require('../src/services/mediaInfo');
media.signMedia=actualSign;
test('real media inspection returns duration/audio metadata through the local relay',async context=>{
 if(spawnSync('ffprobe',['-version'],{windowsHide:true}).status!==0){context.skip('ffprobe unavailable');return;}
 const generated=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440','-f','lavfi','-i','sine=frequency=880','-t','2','-map','0:v','-map','1:a','-map','2:a','-c:v','ffv1','-c:a','pcm_s16le','-metadata:s:a:0','language=eng','-metadata:s:a:1','language=hin','-f','matroska','pipe:1'],{windowsHide:true,maxBuffer:4*1024*1024,timeout:15000});assert.equal(generated.status,0);
 const app=express();app.get('/fixture',(_req,res)=>res.type('video/x-matroska').send(generated.stdout));app.get('/info',inspect);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const root='http://127.0.0.1:'+server.address().port;assert.equal((await fetch(root+'/info?token=invalid')).status,400);const token=actualSign('https://public.example/video',{},'mkv').split('token=')[1];const response=await fetch(root+'/info?token='+token,{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);const data=await response.json();assert.equal(data.audio.length,2);assert.deepEqual(data.audio.map(x=>x.language),['eng','hin']);assert.deepEqual(data.audio.map(x=>x.index),[0,1]);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
