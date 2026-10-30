const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {Readable}=require('node:stream');
const axios=require('axios');
const actualCreate=axios.create,requests=[],bytes=Buffer.alloc(10000,42);
axios.create=()=>({get:async(_url,options)=>{
 const range=options.headers.range;requests.push(range);
 const [,from,to]=/^bytes=(\d+)-(\d+)$/.exec(range);
 const start=Number(from),end=Math.min(Number(to),bytes.length-1);
 return{status:206,headers:{'content-type':'video/mp4','content-range':`bytes ${start}-${end}/${bytes.length}`},data:Readable.from([bytes.subarray(start,end+1)])};
}});
const media=require('../src/services/mediaService');
axios.create=actualCreate;
test('relay remembers source size and clamps tail requests before contacting the source',async()=>{
 const app=express();app.get('/api/media',media.relay);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const url='http://127.0.0.1:'+server.address().port+media.signMedia('https://public.example/range-boundary',{},'original');
  const first=await fetch(url,{headers:{Range:'bytes=0-'}});assert.deepEqual(Buffer.from(await first.arrayBuffer()),bytes);
  const tail=await fetch(url,{headers:{Range:'bytes=9900-'}});assert.deepEqual(Buffer.from(await tail.arrayBuffer()),bytes.subarray(9900));
  assert.equal(requests[1],'bytes=9900-9999');
  const beyond=await fetch(url,{headers:{Range:'bytes=10000-'}});assert.equal(beyond.status,416);assert.equal(beyond.headers.get('content-range'),'bytes */10000');assert.equal(requests.length,2);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
