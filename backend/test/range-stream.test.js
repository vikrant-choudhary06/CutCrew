const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {Readable}=require('node:stream');
const {CHUNK_SIZE,openRange,streamRanges}=require('../src/services/rangeStream');
test('open-ended ranges are relayed as bounded source requests without losing bytes',async()=>{
 const bytes=Buffer.alloc(CHUNK_SIZE*2+123,37);bytes[bytes.length-1]=99;const requested=[];
 const open=async value=>{requested.push(value);const match=/bytes=(\d+)-(\d+)/.exec(value);assert.ok(match);const start=Number(match[1]),end=Math.min(Number(match[2]),bytes.length-1);return{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`},data:Readable.from([bytes.subarray(start,end+1)])}};
 const app=express();app.get('/',async(req,res)=>{try{const start=openRange(req.headers.range);await streamRanges(await open(`bytes=${start}-${start+CHUNK_SIZE-1}`),start,open,res,new AbortController().signal)}catch{res.destroy()}});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{const r=await fetch('http://127.0.0.1:'+server.address().port,{headers:{Range:'bytes=123-'}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),`bytes 123-${bytes.length-1}/${bytes.length}`);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(123));assert.equal(requested.length,2);assert.equal(openRange('bytes=0-'),0);assert.equal(openRange('bytes=0-10'),null);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('inconsistent upstream byte ranges are rejected before streaming',async()=>{const res={status(){throw new Error('Must not send headers')}};await assert.rejects(streamRanges({status:206,headers:{'content-range':'bytes 0-99/100'},data:Readable.from([])},50,()=>{},res,new AbortController().signal),/wrong byte range/);});

test('next chunk is prefetched before the current chunk finishes',async()=>{
 const {Writable}=require('node:stream');const bytes=Buffer.alloc(CHUNK_SIZE+512,41);let nextStarted=false;
 const first={status:206,headers:{'content-range':`bytes 0-${CHUNK_SIZE-1}/${bytes.length}`},data:Readable.from((async function*(){yield bytes.subarray(0,1024);await new Promise(resolve=>setImmediate(resolve));assert.equal(nextStarted,true,'must overlap next request with current body');yield bytes.subarray(1024,CHUNK_SIZE)})())};
 const output=[];const res=new Writable({write(chunk,_encoding,done){output.push(Buffer.from(chunk));done()}});res.status=()=>res;res.set=()=>res;
 await streamRanges(first,0,async()=>{nextStarted=true;return{status:206,headers:{'content-range':`bytes ${CHUNK_SIZE}-${bytes.length-1}/${bytes.length}`},data:Readable.from([bytes.subarray(CHUNK_SIZE)])}},res,new AbortController().signal);assert.deepEqual(Buffer.concat(output),bytes);
});
test('an interrupted chunk resumes from the last delivered byte without duplicates',async()=>{
 const {Writable}=require('node:stream');const bytes=Buffer.alloc(1024,63),output=[],ranges=[];
 const first={status:206,headers:{'content-range':'bytes 0-1023/1024'},data:Readable.from((async function*(){yield bytes.subarray(0,100);throw new Error('temporary disconnect')})())};
 const res=new Writable({write(chunk,_encoding,done){output.push(Buffer.from(chunk));done()}});res.status=()=>res;res.set=()=>res;
 await streamRanges(first,0,async range=>{ranges.push(range);return{status:206,headers:{'content-range':'bytes 100-1023/1024'},data:Readable.from([bytes.subarray(100)])}},res,new AbortController().signal);
 assert.deepEqual(ranges,['bytes=100-1023']);assert.deepEqual(Buffer.concat(output),bytes);
});
test('disconnecting cancels the in-flight prefetch',async()=>{
 const {Writable}=require('node:stream'),controller=new AbortController();let prefetchedSignal;
 const first={status:206,headers:{'content-range':`bytes 0-${CHUNK_SIZE-1}/${CHUNK_SIZE+100}`},data:Readable.from((async function*(){yield Buffer.alloc(10);yield Buffer.alloc(CHUNK_SIZE-10)})())};
 const res=new Writable({write(_chunk,_encoding,done){controller.abort();done()}});res.status=()=>res;res.set=()=>res;
 await assert.rejects(streamRanges(first,0,(_range,signal)=>new Promise((_resolve,reject)=>{prefetchedSignal=signal;signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})}),res,controller.signal));assert.equal(prefetchedSignal.aborted,true);
});

test('a transient prefetch failure retries the same bounded chunk without duplicating output',async()=>{
 const {Writable}=require('node:stream'),output=[],ranges=[];
 const first={status:206,headers:{'content-range':`bytes 0-${CHUNK_SIZE-1}/${CHUNK_SIZE+100}`},data:Readable.from([Buffer.alloc(CHUNK_SIZE,1)])};
 const res=new Writable({write(chunk,_encoding,done){output.push(Buffer.from(chunk));done()}});res.status=()=>res;res.set=()=>res;
 await streamRanges(first,0,async range=>{ranges.push(range);if(ranges.length===1)throw Object.assign(new Error('temporary'),{response:{status:503}});return{status:206,headers:{'content-range':`bytes ${CHUNK_SIZE}-${CHUNK_SIZE+99}/${CHUNK_SIZE+100}`},data:Readable.from([Buffer.alloc(100,2)])}},res,new AbortController().signal);
 assert.equal(ranges.length,2);assert.equal(ranges[0],ranges[1]);assert.deepEqual(Buffer.concat(output),Buffer.concat([Buffer.alloc(CHUNK_SIZE,1),Buffer.alloc(100,2)]));
});
