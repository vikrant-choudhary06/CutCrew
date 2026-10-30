const fs=require('node:fs/promises');
const {configuration,Phase0Error,privateJson,readRange,rpcCode}=require('./telegramStorage');

async function deadline(promise,ms,cleanup=async()=>{}) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{Promise.resolve(cleanup()).catch(()=>{});reject(new Phase0Error('MTPROTO_TIMEOUT'));},ms)})]);}
  finally{clearTimeout(timer);}
}
function makeReader(client,peer,initial,fetchMessage,timed=promise=>promise,timeoutMs=30000){
  let current=initial,refreshes=0;
  const identity={id:initial.document.id.toString(),size:Number(initial.document.size.toString())};
  const refresh=async()=>{
    const value=await fetchMessage(initial.id,identity);
    if(!value?.document||value.document.id.toString()!==identity.id||Number(value.document.size.toString())!==identity.size)throw new Phase0Error('REFERENCED_FILE_CHANGED');
    current=value;refreshes++;
  };
  return {
    refresh,
    get refreshes(){return refreshes},
    invalidateCachedReference(){current.document.fileReference=Buffer.alloc(0)},
    async read(offset,length){
      for(let attempt=0;attempt<2;attempt++){
        try{return await timed(readRange(client,peer,current,offset,length,AbortSignal.timeout(timeoutMs)))}
        catch(error){if(attempt||!/^FILE_REFERENCE/.test(rpcCode(error)))throw error;await refresh();}
      }
    },
  };
}
// downloads: parallel MTProto download connections (Phase 0 keeps 1/1;
// streaming raises them so several chunks are fetched at once).
async function connect(config=configuration(),{downloadSessions=1,downloadInflight=1}={}) {
  const sessions=Math.min(16,Math.max(1,downloadSessions|0)),inflight=Math.min(8,Math.max(1,downloadInflight|0));
  if(!config.ready)throw new Phase0Error('CONFIGURATION_INCOMPLETE');
  const {TelegramClient,Api,Logger,helpers}=require('teleproto');
  const {StringSession}=require('teleproto/sessions');
  const expectedBot=config.token.split(':')[0];let saved='';
  try{
    const info=await fs.lstat(config.sessionPath);if(!info.isFile()||info.isSymbolicLink())throw new Phase0Error('SESSION_FILE_INVALID');
    const record=JSON.parse(await fs.readFile(config.sessionPath,'utf8'));
    if(record.botId!==expectedBot||typeof record.session!=='string')throw new Phase0Error('SESSION_IDENTITY_MISMATCH');
    saved=record.session;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const client=new TelegramClient(new StringSession(saved),config.apiId,config.apiHash,{
    // The library counts the first attempt here. Allow a bounded DC migration
    // and retry during initial bot authentication.
    baseLogger:new Logger('none'),connectionRetries:2,requestRetries:3,timeout:20,
    floodSleepThreshold:0,autoReconnect:false,maxConcurrentDownloads:sessions*inflight,
    downloadPool:{partSize:512*1024,sessions,inflightPerDc:inflight,maxSessions:sessions,requestRetries:1,requestDeadlineMs:config.requestMs},
  });
  client.onError=async()=>{}; // Errors are reported by the sanitized operator boundary.
  const timed=promise=>deadline(promise,config.requestMs,()=>client.destroy());
  try{
    await timed(client.connect());
    if(!await timed(client.checkAuthorization()))await timed(client.invoke(new Api.auth.ImportBotAuthorization({
      flags:0,apiId:config.apiId,apiHash:config.apiHash,botAuthToken:config.token,
    })));
    const me=await timed(client.getMe());
    if(!me.bot||String(me.id)!==expectedBot)throw new Phase0Error('SESSION_IDENTITY_MISMATCH');
    // Resolves this bot's known channel only; no history scans or user login.
    const peer=await timed(client.getInputEntity(helpers.returnBigInt(config.channelId)));
    await privateJson(config.sessionPath,{schema:1,botId:expectedBot,session:client.session.save()});
    async function message(id,expected){
      const rows=await timed(client.getMessages(peer,{ids:[id]})),value=rows[0];
      if(!value?.document)throw new Phase0Error('UPLOADED_MESSAGE_NOT_ACCESSIBLE');
      const identity={id:value.document.id.toString(),size:Number(value.document.size.toString())};
      if(expected&&(identity.id!==expected.id||identity.size!==expected.size))throw new Phase0Error('REFERENCED_FILE_CHANGED');
      return value;
    }
    // Bounded lookup of specific message IDs (no history scan). Missing or
    // non-document messages come back as null.
    async function messages(ids){
      if(!Array.isArray(ids)||!ids.length||ids.length>100)throw new Phase0Error('INVALID_MESSAGE_IDS');
      const rows=await timed(client.getMessages(peer,{ids}));
      return ids.map((id,i)=>{const row=rows[i];return row?.document?{id,caption:row.message||'',documentId:row.document.id.toString(),size:Number(row.document.size.toString())}:null;});
    }
    const reader=initial=>makeReader(client,peer,initial,message,timed,config.requestMs);
    return {botId:String(me.id),message,messages,reader,close:()=>client.destroy()};
  }catch(error){await client.destroy().catch(()=>{});throw error;}
}
module.exports={connect,deadline,makeReader};
