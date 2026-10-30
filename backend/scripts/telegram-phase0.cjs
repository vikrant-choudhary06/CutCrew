// Explicit operator-only POC. Does not change the normal playback API or database.
const path=require('node:path'),fs=require('node:fs/promises');
const {spawnSync}=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const poc=require('../src/services/telegramStorage');
require('dotenv').config({path:path.join(poc.ROOT,'.env'),quiet:true});
const {connect}=require('../src/services/telegramClient');
const reportPath=path.join(poc.ROOT,'../reports/TELEGRAM-PHASE0.json');
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
const config=poc.configuration();
const [command='check',kind='small',...flags]=process.argv.slice(2);
const uploads=path.join(poc.WORK,'uploads');
const pointer=kind=>path.join(uploads,`latest-${kind}.json`);
async function remember(record){await poc.privateJson(path.join(uploads,record.runId+'.json'),record);}
async function previous(kind){
  let last;try{last=JSON.parse(await fs.readFile(pointer(kind),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!/^[a-f0-9-]{36}\.json$/.test(last.manifest))throw new poc.Phase0Error('MANIFEST_INVALID');
  let record;try{record=JSON.parse(await fs.readFile(path.join(uploads,last.manifest),'utf8'));}
  catch(error){if(error.code==='ENOENT')throw new poc.Phase0Error('UPLOAD_MANIFEST_MISSING');throw error;}
  if(record.runId+'.json'!==last.manifest||record.kind!==kind||!['small','large'].includes(record.kind))throw new poc.Phase0Error('MANIFEST_INVALID');
  return record;
}
function sameTarget(record){return record?.botId===config.token?.split(':')[0]&&record?.channelId===config.channelId;}
async function check(){
  const bot=await poc.checkBot(config),mt=await connect(config);
  try{if(mt.botId!==bot.botId)throw new poc.Phase0Error('BOT_IDENTITY_MISMATCH');return{botAuthenticated:true,privateChannel:bot.privateChannel,privateStorageChat:true,storageChatType:bot.storageChatType,botCanPost:true,mtprotoAuthenticated:true,channelResolved:true,sameBot:true};}
  finally{await mt.close();}
}
async function upload(kind,newUpload){
  const existing=await previous(kind);
  if(existing&&!newUpload){
    if(!sameTarget(existing))throw new poc.Phase0Error('MANIFEST_TARGET_MISMATCH');
    if(['uploaded','verified'].includes(existing.state))return existing;
    throw new poc.Phase0Error('PREVIOUS_UPLOAD_UNCERTAIN');
  }
  await check();const file=await poc.fixture(kind),runId=randomUUID();
  const record={schema:1,runId,kind,state:'uploading',botId:config.token.split(':')[0],channelId:config.channelId,
    size:file.size,sha256:file.sha256,startedAt:new Date().toISOString()};
  await remember(record);await poc.privateJson(pointer(kind),{manifest:runId+'.json'});
  const caption=`Schema: cutcrew-phase0-v1\nType: Synthetic test bytes (not a movie)\nPart: 01/01\nUpload ID: ${runId}\nSize bytes: ${file.size}\nSHA-256: ${file.sha256}`;
  const started=performance.now();
  try{
    const sent=await poc.botCall(config,'sendDocument',{chat_id:config.channelId,caption,disable_notification:true},file.file);
    if(String(sent.chat?.id)!==config.channelId||!sent.document||sent.document.file_size!==file.size)throw new poc.Phase0Error('UPLOAD_RESPONSE_MISMATCH');
    record.messageId=sent.message_id;record.fileId=sent.document.file_id;record.fileUniqueId=sent.document.file_unique_id;
    record.messageLink=`https://t.me/c/${config.channelId.slice(4)}/${record.messageId}`;
    record.uploadMs=Math.round(performance.now()-started);record.state='uploaded';await remember(record);return record;
  }catch(error){record.state='upload-uncertain';record.error=poc.safeFailure(error);await remember(record);throw error;}
}
async function verify(record){
  if(!record||!sameTarget(record))throw new poc.Phase0Error('UPLOAD_MANIFEST_REQUIRED');
  const fixture=await poc.fixture(record.kind);
  if(fixture.size!==record.size||fixture.sha256!==record.sha256)throw new poc.Phase0Error('FIXTURE_CHANGED');
  const local=await fs.open(fixture.file,'r');let mt;
  try{
    mt=await connect(config);
    const message=await mt.message(record.messageId);
    if(Number(message.document.size.toString())!==record.size)throw new poc.Phase0Error('REMOTE_SIZE_MISMATCH');
    const reader=mt.reader(message);
    const localRead=async(offset,length)=>{const result=Buffer.alloc(length);let done=0;while(done<length){const read=await local.read(result,done,length-done,offset+done);if(!read.bytesRead)throw new poc.Phase0Error('LOCAL_FIXTURE_TRUNCATED');done+=read.bytesRead;}return result;};
    const result=await poc.verifySamples(record.size,localRead,(offset,length)=>reader.read(offset,length),()=>reader.refresh());
    // This invalidates only our cached reference, never the Telegram message/file.
    reader.invalidateCachedReference();
    if(!(await reader.read(0,4096)).equals(await localRead(0,4096)))throw new poc.Phase0Error('STALE_REFERENCE_RECOVERY_FAILED');
    const bytes=Math.min(record.size,32*1024*1024),hash=createHash('sha256'),started=performance.now();
    for(let offset=0;offset<bytes;offset+=4*1024*1024){const length=Math.min(4*1024*1024,bytes-offset),remote=await reader.read(offset,length);if(!remote.equals(await localRead(offset,length)))throw new poc.Phase0Error('BENCHMARK_MISMATCH');hash.update(remote);}
    const elapsedMs=Math.max(1,Math.round(performance.now()-started));
    const fullFile=bytes===record.size;
    if(fullFile&&hash.digest('hex')!==record.sha256)throw new poc.Phase0Error('FILE_CHECKSUM_MISMATCH');
    record.state='verified';record.verifiedAt=new Date().toISOString();
    record.verification={...result,invalidCachedReferenceRecovered:true,refreshesObserved:reader.refreshes,
      benchmark:{bytes,elapsedMs,mbps:Number((bytes*8/elapsedMs/1000).toFixed(2)),fullFileHashVerified:fullFile},
      upload:{bytes:record.size,elapsedMs:record.uploadMs,mbps:Number((record.size*8/Math.max(1,record.uploadMs)/1000).toFixed(2))}};
    await remember(record);return record.verification;
  }finally{await local.close();await mt?.close();}
}
async function main(){
  if(!['check','fixture','run','verify','logout-cloud'].includes(command)||!['small','large'].includes(kind)||flags.some(flag=>flag!=='--new-upload'))throw new poc.Phase0Error('USAGE_INVALID');
  if(command==='fixture'){const file=await poc.fixture(kind);output({phase:0,status:'fixture-ready',kind,bytes:file.size,sha256:file.sha256,path:path.relative(poc.ROOT,file.file)});return;}
  const docker=spawnSync('docker',['info','--format','{{.ServerVersion}}'],{windowsHide:true,timeout:5000,stdio:'ignore'});
  const baseline={phase:0,checkedAt:new Date().toISOString(),productionPlaybackChanged:false,
    configuration:{ready:config.ready,missing:config.missing,invalid:config.errors},dockerEngineAvailable:docker.status===0};
  if(!config.ready){const report={...baseline,status:'blocked-configuration',liveTestsPerformed:false};await poc.privateJson(reportPath,report);output(report);process.exitCode=2;return;}
  if(command==='logout-cloud'){await poc.botCall({...config,baseUrl:'https://api.telegram.org'},'logOut');output({phase:0,status:'cloud-bot-logged-out',note:'Local Bot API may now be used; cloud Bot API login is unavailable for ten minutes.'});return;}
  const access=await check();
  if(command==='check'){const report={...baseline,status:'access-verified',access,smallAndLargeTransfersVerified:false};await poc.privateJson(reportPath,report);output(report);return;}
  const record=command==='run'?await upload(kind,flags.includes('--new-upload')):await previous(kind);
  const verification=await verify(record),small=await previous('small'),large=await previous('large');
  const passed=value=>sameTarget(value)&&value.state==='verified';
  const report={...baseline,status:passed(small)&&passed(large)?'phase0-live-passed':'partial-live-verified',access,
    current:{kind,...verification},completion:{smallFileVerified:passed(small),large1500MBVerified:passed(large)},
    notes:'Large-file download benchmark is sampled/32 MiB, not full-file playback. Invalid cached reference recovery is simulated; real expiry was not forced. No user-account authentication or remote deletions.'};
  await poc.privateJson(reportPath,report);output(report);
}
main().catch(async error=>{const report={phase:0,status:'failed',checkedAt:new Date().toISOString(),failure:poc.safeFailure(error),productionPlaybackChanged:false};await poc.privateJson(reportPath,report).catch(()=>{});output(report);process.exitCode=1;});
