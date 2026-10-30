// Isolated feasibility tools. Nothing here is mounted in the production API.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, createCipheriv, randomUUID} = require('node:crypto');
const {createReadStream} = require('node:fs');
const http = require('node:http');
const ROOT = path.resolve(__dirname, '../..');
// Large scratch files live outside the project folder: the project sits in
// OneDrive, which would upload multi-GB test files and video parts.
function localWorkDir(...parts) {
  const base = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'CutCrew')
    : path.join(require('node:os').homedir(), '.cache', 'cutcrew');
  return path.join(base, ...parts);
}
const WORK = process.env.TELEGRAM_WORK_DIR ? path.resolve(process.env.TELEGRAM_WORK_DIR) : localWorkDir('telegram', 'phase0');
const BLOCK = 512 * 1024;
class Phase0Error extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
function inside(root, target) {
  const relative = path.relative(root, path.resolve(target));
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function configuration(env = process.env) {
  const required = ['TELEGRAM_BOT_TOKEN','TELEGRAM_API_ID','TELEGRAM_API_HASH','TELEGRAM_STORAGE_CHANNEL_ID'];
  const missing = required.filter(key => !env[key]?.trim());
  const errors = [];
  if (env.TELEGRAM_BOT_TOKEN && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN)) errors.push('TELEGRAM_BOT_TOKEN');
  if (env.TELEGRAM_API_ID && !/^[1-9]\d{0,9}$/.test(env.TELEGRAM_API_ID)) errors.push('TELEGRAM_API_ID');
  if (Number(env.TELEGRAM_API_ID) > 2147483647) errors.push('TELEGRAM_API_ID');
  if (env.TELEGRAM_API_HASH && !/^[a-f0-9]{32}$/i.test(env.TELEGRAM_API_HASH)) errors.push('TELEGRAM_API_HASH');
  if (env.TELEGRAM_STORAGE_CHANNEL_ID && !/^-100\d{5,16}$/.test(env.TELEGRAM_STORAGE_CHANNEL_ID)) errors.push('TELEGRAM_STORAGE_CHANNEL_ID');
  let url;
  try {
    url = new URL(env.TELEGRAM_BOT_API_URL || 'http://127.0.0.1:8081');
    // Phase 0 deliberately uses a loopback-only Bot API. No token-bearing redirects.
    if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  } catch { errors.push('TELEGRAM_BOT_API_URL'); }
  const sessionPath = path.resolve(ROOT, env.TELEGRAM_SESSION_PATH || '.local/telegram/bot.session');
  if (!inside(path.join(ROOT,'.local/telegram'),sessionPath)) errors.push('TELEGRAM_SESSION_PATH');
  const requestMs = Number(env.TELEGRAM_REQUEST_TIMEOUT_MS || 30000);
  const uploadMs = Number(env.TELEGRAM_UPLOAD_TIMEOUT_MS || 1800000);
  if (!Number.isInteger(requestMs) || requestMs < 1000 || requestMs > 120000) errors.push('TELEGRAM_REQUEST_TIMEOUT_MS');
  if (!Number.isInteger(uploadMs) || uploadMs < 1000 || uploadMs > 3600000) errors.push('TELEGRAM_UPLOAD_TIMEOUT_MS');
  return {ready:!missing.length&&!errors.length,missing,errors:[...new Set(errors)],
    token:env.TELEGRAM_BOT_TOKEN,apiId:Number(env.TELEGRAM_API_ID),apiHash:env.TELEGRAM_API_HASH,
    channelId:env.TELEGRAM_STORAGE_CHANNEL_ID,baseUrl:url?.origin,sessionPath,requestMs,uploadMs};
}
function rpcCode(error) {
  // Teleproto subclasses expose generic BAD_REQUEST/UNAUTHORIZED strings;
  // recover specific categories from known class names without reading messages.
  const names = {FileReferenceEmptyError:'FILE_REFERENCE_EMPTY',FileReferenceExpiredError:'FILE_REFERENCE_EXPIRED',
    FileReferenceInvalidError:'FILE_REFERENCE_INVALID',ChannelPrivateError:'CHANNEL_PRIVATE',ChannelInvalidError:'CHANNEL_INVALID',
    BotMethodInvalidError:'BOT_METHOD_INVALID',ChatAdminRequiredError:'CHAT_ADMIN_REQUIRED',AuthKeyUnregisteredError:'AUTH_KEY_UNREGISTERED',
    SessionRevokedError:'SESSION_REVOKED',ApiIdInvalidError:'API_ID_INVALID',AccessTokenInvalidError:'ACCESS_TOKEN_INVALID',
    AccessTokenExpiredError:'ACCESS_TOKEN_EXPIRED',PhoneMigrateError:'TELEGRAM_DC_MIGRATION',NetworkMigrateError:'TELEGRAM_DC_MIGRATION',UserMigrateError:'TELEGRAM_DC_MIGRATION'};
  return names[error.constructor?.name] || error.errorMessage || error.code || '';
}
function safeFailure(error) {
  const raw = rpcCode(error);
  const allowed = ['FILE_REFERENCE_EMPTY','FILE_REFERENCE_EXPIRED','FILE_REFERENCE_INVALID','CHANNEL_PRIVATE','CHANNEL_INVALID','TELEGRAM_DC_MIGRATION',
    'BOT_METHOD_INVALID','CHAT_ADMIN_REQUIRED','AUTH_KEY_UNREGISTERED','SESSION_REVOKED','API_ID_INVALID',
    'ACCESS_TOKEN_INVALID','ACCESS_TOKEN_EXPIRED'];
  if (String(raw).startsWith('FLOOD_WAIT') || error.seconds) return {code:'TELEGRAM_WAIT',retryAfterSeconds:Math.min(86400,Math.max(0,Number(error.seconds)||0))};
  if (error instanceof Phase0Error) return {code:error.code,...Object.fromEntries(Object.entries(error.details).filter(([key,value])=>['status','telegramErrorCode','retryAfterSeconds','offset'].includes(key)&&Number.isFinite(value)))};
  if (allowed.includes(raw)) return {code:raw};
  return {code:'TELEGRAM_OPERATION_FAILED'};
}
async function privateJson(file, data) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  // A unique temporary file plus rename prevents partially written manifests.
  const temp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});
  await fs.rename(temp,file);
}
async function hashFile(file) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
async function fixture(kind) {
  if (!['small','large'].includes(kind)) throw new Phase0Error('FIXTURE_KIND_INVALID');
  const size=kind==='large'?1500000000:8*1024*1024;
  await fs.mkdir(WORK,{recursive:true,mode:0o700});
  const file=path.join(WORK,`fixture-${kind}.bin`),manifest=file+'.json';
  try {
    const saved=JSON.parse(await fs.readFile(manifest,'utf8'));
    if(saved.size===size&&(await fs.stat(file)).size===size&&await hashFile(file)===saved.sha256)return{...saved,file};
    throw new Phase0Error('FIXTURE_CHANGED');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  try{await fs.lstat(file);throw new Phase0Error('FIXTURE_INCOMPLETE');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const disk=await fs.statfs(WORK);
  if(disk.bavail*disk.bsize<size+128*1024*1024)throw new Phase0Error('INSUFFICIENT_DISK_SPACE');
  const handle=await fs.open(file,'wx',0o600),hash=createHash('sha256');
  const cipher=createCipheriv('aes-256-ctr',createHash('sha256').update('cutcrew-phase0-fixture-v1').digest(),Buffer.alloc(16));
  try{
    for(let written=0;written<size;){
      const chunk=cipher.update(Buffer.alloc(Math.min(1024*1024,size-written)));hash.update(chunk);
      let used=0;while(used<chunk.length){const result=await handle.write(chunk,used,chunk.length-used);if(!result.bytesWritten)throw new Phase0Error('FIXTURE_WRITE_FAILED');used+=result.bytesWritten;}
      written+=chunk.length;
    }
  }finally{await handle.close();}
  const result={schema:1,kind,size,sha256:hash.digest('hex')};await privateJson(manifest,result);return{...result,file};
}
// Streams a multipart upload with node:http. fetch() is not used here: its
// built-in 300 s wait-for-response limit fires while the local Bot API is
// still pushing a large file to Telegram, regardless of our own timeout.
function postMultipart(url, fields, file, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled=false;
    const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const boundary='----cutcrew'+randomUUID().replace(/-/g,'');
    const name=path.basename(file).replace(/["\r\n\\]/g,'_');
    const head=Buffer.from(Object.entries(fields).map(([key,value])=>`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`).join('')+
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail=Buffer.from(`\r\n--${boundary}--\r\n`);
    let request;
    const timer=setTimeout(()=>{request?.destroy();done(new Error('timeout'));},timeoutMs);
    fs.stat(file).then(stat=>{
      request=http.request(url,{method:'POST',headers:{'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':head.length+stat.size+tail.length}});
      request.on('error',error=>done(error));
      request.on('response',response=>{
        // No redirects are followed: the URL carries the bot token.
        const chunks=[];let size=0;
        response.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){response.destroy();done(new Error('response too large'));}else chunks.push(chunk);});
        response.on('end',()=>done(null,{status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
        response.on('error',error=>done(error));
      });
      request.write(head);
      const stream=createReadStream(file);
      stream.on('error',error=>{request.destroy();done(error);});
      stream.on('end',()=>request.end(tail));
      stream.pipe(request,{end:false});
    },error=>done(error));
  });
}
async function botCall(config, method, fields={}, document) {
  const url=`${config.baseUrl}/bot${config.token}/${method}`;
  let status,text;
  if(document){
    try{({status,body:text}=await postMultipart(url,fields,document,config.uploadMs));}
    catch{throw new Phase0Error('BOT_UPLOAD_TRANSPORT_FAILED');}
  }else{
    let response;
    try { response=await fetch(url,{method:'POST',body:new URLSearchParams(Object.entries(fields).map(([key,value])=>[key,String(value)])),redirect:'error',signal:AbortSignal.timeout(config.requestMs)}); }
    catch {throw new Phase0Error('LOCAL_BOT_API_UNREACHABLE');}
    status=response.status;
    try{text=await response.text();}catch{throw new Phase0Error('BOT_API_INVALID_RESPONSE');}
  }
  let data;try{data=JSON.parse(text);}catch{throw new Phase0Error('BOT_API_INVALID_RESPONSE');}
  if(status<200||status>=300||!data.ok)throw new Phase0Error('BOT_API_REJECTED',{status,telegramErrorCode:Number(data.error_code)||0,retryAfterSeconds:Number(data.parameters?.retry_after)||0});
  return data.result;
}
async function checkBot(config,call=botCall) {
  const me=await call(config,'getMe');if(!me.is_bot)throw new Phase0Error('BOT_IDENTITY_INVALID');
  const chat=await call(config,'getChat',{chat_id:config.channelId});
  if(String(chat.id)!==config.channelId||!['channel','supergroup'].includes(chat.type)||chat.username||chat.active_usernames?.length)throw new Phase0Error('PRIVATE_STORAGE_CHAT_REQUIRED');
  const member=await call(config,'getChatMember',{chat_id:config.channelId,user_id:me.id});
  // Supergroup administrators can send documents; can_post_messages is a
  // channel-only field and must not be required for a group administrator.
  if(member.status!=='creator'&&!(member.status==='administrator'&&(chat.type==='supergroup'||member.can_post_messages)))throw new Phase0Error('BOT_CANNOT_POST');
  return {botId:String(me.id),privateChannel:chat.type==='channel',privateStorageChat:true,storageChatType:chat.type,canPost:true};
}
function rangePlan(offset,length,size) {
  if(![offset,length,size].every(Number.isSafeInteger)||offset<0||length<1||length>4*1024*1024||offset+length>size)throw new Phase0Error('INVALID_SAMPLE_RANGE');
  const aligned=Math.floor(offset/BLOCK)*BLOCK;
  return {aligned,skip:offset-aligned,blocks:Math.ceil((offset-aligned+length)/BLOCK),length};
}
async function readRange(client,peer,message,offset,length,signal) {
  const size=Number(message.document?.size?.toString());
  const plan=rangePlan(offset,length,size),parts=[];let bytes=0;
  // teleproto uses a byte limit (not GramJS's historical chunk-count limit).
  const iterator=client.iterDownload(message,{offset:plan.aligned,requestSize:BLOCK,
    limit:plan.blocks*BLOCK,signal});
  try{for await(const chunk of iterator){if(signal?.aborted)throw new Phase0Error('DOWNLOAD_TIMEOUT');parts.push(Buffer.from(chunk));bytes+=chunk.length;if(bytes>=plan.skip+length)break;}}
  finally{await iterator.return?.();}
  const output=Buffer.concat(parts).subarray(plan.skip,plan.skip+length);
  if(output.length!==length)throw new Phase0Error('TRUNCATED_DOWNLOAD');
  return output;
}
function sampleRanges(size) {
  const length=Math.min(65536,size);
  const starts=[0,1,4095,BLOCK-3,1024*1024-5,Math.floor(size/2)-13,size-length];
  return [...new Set(starts.map(start=>Math.max(0,Math.min(size-length,start))))].map(offset=>({offset,length}));
}
async function verifySamples(size,localRead,remoteRead,refresh) {
  const samples=[];
  for(const range of sampleRanges(size)){
    const started=performance.now(),actual=await remoteRead(range.offset,range.length);
    const expected=await localRead(range.offset,range.length);
    if(!actual.equals(expected))throw new Phase0Error('SAMPLE_MISMATCH',{offset:range.offset});
    samples.push({...range,matched:true,elapsedMs:Math.round(performance.now()-started)});
  }
  await refresh();
  const last=samples.at(-1),fresh=await remoteRead(last.offset,last.length);
  if(!fresh.equals(await localRead(last.offset,last.length)))throw new Phase0Error('REFRESH_SAMPLE_MISMATCH');
  return {samples,referenceRefreshChecked:true};
}
module.exports={ROOT,WORK,localWorkDir,BLOCK,Phase0Error,configuration,rpcCode,safeFailure,inside,privateJson,hashFile,fixture,botCall,checkBot,rangePlan,readRange,sampleRanges,verifySamples};
