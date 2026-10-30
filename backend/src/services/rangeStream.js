const {setTimeout:delay}=require('node:timers/promises');
const {once}=require('node:events');
const health=require('./playbackHealth');
const CHUNK_SIZE=4*1024*1024;
function openRange(value){const match=/^bytes=(\d+)-$/.exec(value||''),start=match?Number(match[1]):null;return Number.isSafeInteger(start)&&start>=0?start:null}
function invalid(message){return Object.assign(new Error(message),{code:'INVALID_RANGE'})}
function contentRange(response){const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range']||'');if(!match)throw invalid('Invalid source byte range');const [start,end,total]=match.slice(1).map(Number);if(![start,end,total].every(Number.isSafeInteger)||start>end||end>=total)throw invalid('Invalid source byte range');return{start,end,total}}
function retryable(error,signal){const status=error.response?.status;return !signal.aborted&&error.code!=='INVALID_RANGE'&&(!status||status===429||status>=500)}
async function streamRanges(first,start,open,res,signal,{sourceId}={}){
 const initial=contentRange(first);if(initial.start!==start)throw invalid('Source returned the wrong byte range');
 const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]),owned=new Set([first.data]);
 res.status(206).set('Content-Range',`bytes ${start}-${initial.total-1}/${initial.total}`).set('Content-Length',String(initial.total-start)).set('Accept-Ranges','bytes');
 function validate(response,cursor){const range=contentRange(response);if(response.status!==206||range.start!==cursor||range.total!==initial.total||range.end>Math.min(initial.total-1,cursor+CHUNK_SIZE-1))throw invalid('Source changed its byte range');return range}
 async function fetchChunk(cursor){
  const began=Date.now();
  for(let attempt=0;;attempt++){
   let response;
   try{
    response=await open(`bytes=${cursor}-${Math.min(initial.total-1,cursor+CHUNK_SIZE-1)}`,combined);owned.add(response.data);response.request?.setTimeout?.(0);const range=validate(response,cursor),parts=[];let bytes=0;
    for await(const chunk of response.data){if(combined.aborted)throw combined.reason;bytes+=chunk.length;if(bytes>range.end-range.start+1)throw invalid('Source exceeded its byte range');parts.push(chunk)}
    if(bytes!==range.end-range.start+1)throw new Error('Source truncated its byte range');owned.delete(response.data);health.range(sourceId,{bytes,networkBytes:bytes,fetchMs:Date.now()-began,chunks:1});return{range,bytes:Buffer.concat(parts)};
   }catch(error){response?.data.destroy();if(response)owned.delete(response.data);if(attempt>=2||!retryable(error,combined)){if(!combined.aborted)health.range(sourceId,{failures:1});throw error}health.range(sourceId,{retries:1});await delay(100*2**attempt,undefined,{signal:combined});}
  }
 }
 let item={response:first,range:validate(first,start)},pending;
 try{
  while(!combined.aborted){
   const {range}=item,next=range.end+1;
   // Exactly one bounded chunk is read ahead. Its errors are observed immediately.
   pending=next<initial.total?fetchChunk(next).then(value=>({value}),error=>({error})):null;
   if(item.bytes){if(!res.write(item.bytes))await once(res,'drain',{signal:combined})}
   else{
    let response=item.response,cursor=range.start,retries=0;const began=Date.now();
    while(cursor<=range.end){
     try{
      for await(const chunk of response.data){if(combined.aborted)throw combined.reason;if(cursor+chunk.length>range.end+1)throw invalid('Source exceeded its byte range');const accepted=res.write(chunk);cursor+=chunk.length;if(!accepted)await once(res,'drain',{signal:combined})}
      if(cursor!==range.end+1)throw new Error('Source truncated its byte range');
     }catch(error){response.data.destroy();owned.delete(response.data);if(retries++>=2||!retryable(error,combined))throw error;health.range(sourceId,{retries:1});response=await open(`bytes=${cursor}-${range.end}`,combined);owned.add(response.data);const replacement=validate(response,cursor);if(replacement.end!==range.end)throw invalid('Source changed a resumed byte range');}
    }
    owned.delete(response.data);health.range(sourceId,{bytes:range.end-range.start+1,streamMs:Date.now()-began,chunks:1});
   }
   if(!pending){res.end();return}
   const ready=await pending;if(ready.error)throw ready.error;item=ready.value;
  }
 }finally{controller.abort();for(const stream of owned)stream.destroy();if(pending)await pending;}
}
module.exports={CHUNK_SIZE,openRange,streamRanges};
