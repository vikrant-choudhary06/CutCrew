const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {randomUUID}=require('node:crypto');
const media=require('../src/services/mediaService');
const health=require('../src/services/playbackHealth');
const metadata=require('../src/services/mediaMetadata');

test('playback diagnostics validate tickets and measurements and retain no source URL or token',async()=>{
 const app=express();app.use(express.json());app.use(require('../src/routes/playbackMetrics'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const url='https://public.example/health-fixture?private=secret';
  const token=new URL(media.signMedia(url,{},'mp4'),'http://localhost').searchParams.get('token');
  const sample={token,sessionId:randomUUID(),titleId:'tt1375666',event:'sample',playedSeconds:15,bufferAhead:20,stalls:1,stalledSeconds:2,startupMs:800,droppedFrames:0,totalFrames:360};
  const send=body=>fetch('http://127.0.0.1:'+server.address().port+'/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await send({...sample,token:'invalid'})).status,403);
  assert.equal((await send({...sample,bufferAhead:-1})).status,400);
  assert.equal((await send({...sample,sessionId:'invalid'})).status,400);
  assert.equal((await send(sample)).status,202);
  await send({...sample,event:'ended',playedSeconds:30,stalls:2});
  const snapshot=health.snapshot(),row=snapshot.sessions.find(s=>s.source===health.sourceId(url));
  assert.equal(row.playedSeconds,30);assert.equal(snapshot.sources[health.sourceId(url)].stalls,2);
  assert.ok(health.penalty(url)>0);
  assert.equal(JSON.stringify(snapshot).includes('private=secret'),false);
  assert.equal(JSON.stringify(snapshot).includes(token),false);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('metadata cache merges codec and track data and isolates source request headers',()=>{
 const ticket={url:'https://public.example/cache-fixture',headers:{Referer:'https://example.com'}};
 metadata.put(ticket,{video:{codec_name:'h264',height:720}});
 metadata.put(ticket,{audio:[{index:0,language:'eng'}],duration:60});
 assert.equal(metadata.get(ticket).video.height,720);
 assert.equal(metadata.get(ticket).audio[0].language,'eng');
 assert.equal(metadata.get({...ticket,headers:{}}),null);
});
