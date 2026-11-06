const metadata=require('./mediaMetadata');
const { fromProbe } = require('./audioTracks');
const { spawn } = require('node:child_process');
const { verifyToken, signMedia } = require('./mediaService');
let active = 0;
module.exports = (req,res) => {
  let ticket;
  try { ticket = verifyToken(req.query.token); } catch { return res.status(400).json({message:'Invalid media ticket'}); }
  const cached=metadata.get(ticket);if(cached&&Array.isArray(cached.audio))return res.set('Cache-Control','private, no-store').json(cached);
  if(active >= 2)return res.status(429).json({message:'Media inspection is busy'});
  const input = 'http://127.0.0.1:'+req.socket.localPort+signMedia(ticket.url,ticket.headers,'original',ticket.expires);
  active++;let output='',done=false;
  const rangeAbort=new AbortController();
  const rangeCheck=fetch(input,{headers:{Range:'bytes=1-1'},signal:AbortSignal.any([rangeAbort.signal,AbortSignal.timeout(8000)])}).then(async response=>{const seekable=response.status===206&&/^bytes 1-1\/\d+$/.test(response.headers.get('content-range')||'');await response.body?.cancel();return seekable}).catch(()=>false);
  const child=spawn(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-rw_timeout','10000000','-analyzeduration','2000000','-probesize','1000000','-show_entries','format=duration:stream=index,codec_type,codec_name,pix_fmt,width,height,channels:stream_tags=language,title:stream_disposition=default','-of','json',input],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const finish=(status,data)=>{if(done)return;done=true;active--;clearTimeout(timer);child.kill();if(status===200){rangeCheck.then(seekable=>{if(!res.destroyed){const result={...data,seekable};metadata.put(ticket,result);res.status(status).set('Cache-Control','private, no-store').json(result)}})}else{rangeAbort.abort();if(!res.destroyed)res.status(status).set('Cache-Control','private, no-store').json(data)}};
  const timer=setTimeout(()=>finish(504,{message:'Media information timed out'}),15000);
  res.on('close',()=>{rangeAbort.abort();if(!done){done=true;active--;clearTimeout(timer);child.kill()}});
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>131072)finish(502,{message:'Media information is too large'})});child.stderr.resume();
  child.on('error',()=>finish(503,{message:'Media inspection is unavailable'}));
  child.on('close',code=>{if(done)return;if(code)return finish(502,{message:'Media information is unavailable'});try{const data=JSON.parse(output);const raw=(data.streams||[]).filter(s=>s.codec_type==='audio');const audio=fromProbe(raw).map((t,index)=>({index,language:raw[index].tags?.language||'und',code:t.language,title:t.label,codec:t.codec,channels:t.channels,default:t.default}));const duration=Number(data.format?.duration);const video=(data.streams||[]).find(stream=>stream.codec_type==='video');finish(200,{video,duration:Number.isFinite(duration)&&duration>0?duration:null,audio});}catch{finish(502,{message:'Media information is unavailable'})}});
};
