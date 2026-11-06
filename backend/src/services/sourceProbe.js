const crypto = require('node:crypto');
const { openMedia } = require('./mediaService');
const health=require('./playbackHealth');
const { fromPlaylist } = require('./audioTracks');
const cache = new Map(), pending = new Map();
function signature(bytes) {
  const head = bytes.subarray(0,64);
  if (head.includes(Buffer.from('ftyp')) || head.includes(Buffer.from('styp'))) return 'mp4';
  if (bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return 'matroska';
  if (bytes.length >= 188 && bytes[0] === 0x47 && (bytes.length < 376 || bytes[188] === 0x47)) return 'mpeg-ts';
  if (bytes.toString('utf8').replace(/^\uFEFF/,'').trimStart().startsWith('#EXTM3U')) return 'hls';
  return null;
}
async function probe(stream, {signal,open=openMedia,depth=0,timeoutMs=4500} = {}) {
  const controller = new AbortController();
  const abort = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  let response;
  try {
    response = await open(stream.link, stream.headers, 'bytes=0-4095', abort);
    if (response.status !== 200 && response.status !== 206) return {ok:false,reason:'http-'+response.status};
    if (/html|json/i.test(response.headers['content-type'] || '')) return {ok:false,reason:'non-media-response'};
    const chunks=[];let length=0;
    for await (const chunk of response.data) {
      const part=Buffer.from(chunk).subarray(0,4096-length);chunks.push(part);length+=part.length;
      if (length>=4096) break;
    }
    const format=signature(Buffer.concat(chunks));
    if(format==='hls'){
      const text=Buffer.concat(chunks).toString('utf8');
      const audioTracks=depth===0?fromPlaylist(text):[];
      const uri=text.split(/\r?\n/).map(line=>line.trim()).find(line=>line&&!line.startsWith('#'));
      if(!uri||depth>=2)return {ok:false,reason:'invalid-playlist'};
      const target=new URL(uri,response.config?.url||stream.link);
      const headers={...stream.headers};
      if(target.origin!==new URL(stream.link).origin)for(const key of Object.keys(headers))if(/^(cookie|authorization)$/i.test(key))delete headers[key];
      response.data.destroy();
      const segment=await probe({...stream,link:target.href,headers},{signal:abort,open,depth:depth+1,timeoutMs});
      return {...segment,format:'hls',seekable:false,...(audioTracks.length?{audioTracks}:{})};
    }
    return {ok:!!format,format:format==='matroska'?'mkv':format,reason:format||'invalid-media',seekable:response.status===206&&/^bytes 0-\d+\/\d+$/.test(response.headers['content-range']||'')};
  } catch(error) {
    return {ok:false,reason:abort.aborted?'probe-timeout':error.response?.status?'http-'+error.response.status:'source-unavailable'};
  } finally { response?.data.destroy(); controller.abort(); }
}
async function checked(stream,signal,timeoutMs) {
  const key=crypto.createHash('sha256').update(JSON.stringify([stream.link,stream.headers||{}])).digest('hex');
  const previous=cache.get(key);
  if(previous?.until>Date.now())return previous.result;
  if(pending.has(key))return pending.get(key);
  const task=probe(stream,{signal,timeoutMs}).then(result=>{
    if(!signal?.aborted){if(cache.size>=1000)cache.delete(cache.keys().next().value);cache.set(key,{result,until:Date.now()+(result.ok?30000:15000)})}
    return result;
  }).finally(()=>pending.delete(key));
  pending.set(key,task);return task;
}
// timeoutMs: per-link limit (default 4.5 s); some sources prepare a file on first request.
// client=app plays MKV directly, so MKV is not pushed down for apps.
async function filterPlayable(streams,{signal,check=checked,timeoutMs,client='web'}={}) {
  const valid=[];
  // Bounded batches avoid creating a connection for every provider mirror.
  for(let index=0;index<Math.min(streams.length,6)&&!signal?.aborted;index+=3){
    const batch=await Promise.all(streams.slice(index,index+3).map(async stream=>({stream,result:await check(stream,signal,timeoutMs)})));
    for(const item of batch)if(item.result.ok)valid.push(item);
    if(valid.length)break;
  }
  // Web: MKV after MP4/HLS, and HEVC / 10-bit / >720p MKV (re-encoded) after the rest.
  const mkv=item=>item.result.format==='mkv'||item.stream.type==='mkv';
  const rank=item=>(client!=='app'&&mkv(item)?20+(item.stream.hevc||(item.stream.height||0)>720?10:0):0)+health.penalty(item.stream.link)+(item.result.seekable?0:8);
  return valid.sort((a,b)=>rank(a)-rank(b)).map(item=>({...item.stream,...(['mp4','mkv','hls'].includes(item.result.format)?{type:item.result.format}:{}),...(item.result.audioTracks?.length&&!item.stream.audioTracks?.length?{audioTracks:item.result.audioTracks}:{})}));
}
module.exports={probe,signature,filterPlayable};
