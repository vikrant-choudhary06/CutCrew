const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const poc=require('../src/services/telegramStorage');
const {deadline,makeReader}=require('../src/services/telegramClient');
const env={TELEGRAM_BOT_TOKEN:'123456789:'+ 'x'.repeat(35),TELEGRAM_API_ID:'12345',TELEGRAM_API_HASH:'a'.repeat(32),TELEGRAM_STORAGE_CHANNEL_ID:'-1001234567890'};
test('configuration reports only missing/invalid names and refuses remote token-bearing Bot API endpoints',()=>{
 assert.equal(poc.configuration({}).ready,false);assert.equal(poc.configuration(env).ready,true);
 for(const url of ['https://api.telegram.org','http://evil.example','http://127.0.0.1:8081/?token=secret','http://user:pass@localhost:8081'])assert.ok(poc.configuration({...env,TELEGRAM_BOT_API_URL:url}).errors.includes('TELEGRAM_BOT_API_URL'));
 assert.ok(poc.configuration({...env,TELEGRAM_SESSION_PATH:'../outside.session'}).errors.includes('TELEGRAM_SESSION_PATH'));
 assert.equal(JSON.stringify(poc.safeFailure(new Error(env.TELEGRAM_BOT_TOKEN))).includes(env.TELEGRAM_BOT_TOKEN),false);
 assert.deepEqual(poc.safeFailure(new poc.Phase0Error('SAFE',{token:env.TELEGRAM_BOT_TOKEN,status:429})),{code:'SAFE',status:429});
 assert.equal(poc.safeFailure({errorMessage:'FLOOD_WAIT_10',seconds:10}).retryAfterSeconds,10);
});
test('large offsets and unaligned ranges use bounded 512 KiB-aligned requests',()=>{
 assert.deepEqual(poc.rangePlan(poc.BLOCK-3,65536,1500000000),{aligned:0,skip:poc.BLOCK-3,blocks:2,length:65536});
 assert.ok(poc.rangePlan(5500000000,65536,6000000000).aligned>4294967296);
 for(const args of [[-1,1,10],[0,0,10],[10,1,10],[0,5*1024*1024,1500000000]])assert.throws(()=>poc.rangePlan(...args),/INVALID_SAMPLE_RANGE/);
});
function fakeClient(bytes,check=()=>{}){
 return{async *iterDownload(message,options){check(message,options);const end=Math.min(bytes.length,options.offset+options.limit);for(let i=options.offset;i<end;i+=poc.BLOCK)yield bytes.subarray(i,Math.min(i+poc.BLOCK,end));}};
}
const message=bytes=>({id:42,media:{},document:{id:1,size:bytes.length,fileReference:Buffer.from([1])}});
test('partial retrieval returns exact bytes across boundaries and near EOF without whole-file buffering',async()=>{
 const bytes=randomBytes(poc.BLOCK*3+91),msg=message(bytes),requests=[];
 const client=fakeClient(bytes,(_message,opts)=>requests.push(opts));
 for(const offset of [1,4095,poc.BLOCK-3,poc.BLOCK+17,bytes.length-100]){const length=Math.min(65536,bytes.length-offset);assert.deepEqual(await poc.readRange(client,{},msg,offset,length),bytes.subarray(offset,offset+length));}
 assert.ok(requests.every(r=>r.offset%poc.BLOCK===0&&r.requestSize===poc.BLOCK&&r.limit<=2*poc.BLOCK));
});
test('partial retrieval detects truncation and cancellation',async()=>{
 const bytes=Buffer.alloc(100),msg={...message(bytes),document:{id:1,size:1000}};
 await assert.rejects(poc.readRange(fakeClient(bytes),{},msg,0,1000),/TRUNCATED_DOWNLOAD/);
 await assert.rejects(poc.readRange(fakeClient(bytes),{},msg,0,10,AbortSignal.abort()),/DOWNLOAD_TIMEOUT/);
});
test('expired cached references refresh the saved message once and preserve file identity',async()=>{
 const bytes=randomBytes(poc.BLOCK+100),old=message(bytes),fresh=message(bytes);let fetches=0;
 old.document.fileReference=Buffer.alloc(0);
 const client=fakeClient(bytes,msg=>{if(!msg.document.fileReference.length)throw{errorMessage:'FILE_REFERENCE_EXPIRED'};});
 const reader=makeReader(client,{},old,async id=>{assert.equal(id,42);fetches++;return fresh;});
 assert.deepEqual(await reader.read(13,512),bytes.subarray(13,525));assert.equal(fetches,1);assert.equal(reader.refreshes,1);
 const changed=makeReader(client,{},old,async()=>({...fresh,document:{...fresh.document,id:2}}));await assert.rejects(changed.read(0,10),/REFERENCED_FILE_CHANGED/);
});
test('persistent reference errors do not cause an infinite retry loop',async()=>{
 const bytes=Buffer.alloc(100),msg=message(bytes);let attempts=0;
 const client=fakeClient(bytes,()=>{attempts++;throw{errorMessage:'FILE_REFERENCE_EXPIRED'};});
 await assert.rejects(makeReader(client,{},msg,async()=>msg).read(0,10));assert.equal(attempts,2);
});

test('real Teleproto reference errors refresh once and expose only safe categories',async()=>{
 const {FileReferenceExpiredError}=require('teleproto/errors');
 const bytes=randomBytes(100),old=message(bytes),fresh=message(bytes);let fetches=0;
 old.document.fileReference=Buffer.alloc(0);
 const error=new FileReferenceExpiredError({request:undefined});
 assert.equal(poc.safeFailure(error).code,'FILE_REFERENCE_EXPIRED');
 const client=fakeClient(bytes,msg=>{if(!msg.document.fileReference.length)throw error;});
 const reader=makeReader(client,{},old,async()=>{fetches++;return fresh;});
 assert.deepEqual(await reader.read(0,50),bytes.subarray(0,50));assert.equal(fetches,1);
});
test('sample checks detect shifted data and verify reads after explicit refresh',async()=>{
 const bytes=randomBytes(poc.BLOCK+33),read=async(offset,length)=>bytes.subarray(offset,offset+length);let refreshed=false;
 const result=await poc.verifySamples(bytes.length,read,read,async()=>{refreshed=true});assert.equal(refreshed,true);assert.equal(result.referenceRefreshChecked,true);assert.ok(result.samples.every(s=>s.matched));
 await assert.rejects(poc.verifySamples(bytes.length,read,async(_o,l)=>Buffer.alloc(l),async()=>{}),/SAMPLE_MISMATCH/);
});
test('deadlines clean up hung operations and do not expose underlying errors',async()=>{
 let cleaned=false;await assert.rejects(deadline(new Promise(()=>{}),10,async()=>{cleaned=true}),/MTPROTO_TIMEOUT/);assert.equal(cleaned,true);
});
test('channel access checks reject public channels or missing posting permission',async()=>{
 const config=poc.configuration(env);
 const call=async(_config,method)=>method==='getMe'?{id:123456789,is_bot:true}:method==='getChat'?{id:env.TELEGRAM_STORAGE_CHANNEL_ID,type:'channel'}:{status:'administrator',can_post_messages:true};
 assert.equal((await poc.checkBot(config,call)).canPost,true);
 await assert.rejects(poc.checkBot(config,async(c,m,f)=>m==='getChat'?{id:config.channelId,type:'channel',username:'public'}:call(c,m,f)),/PRIVATE_STORAGE_CHAT_REQUIRED/);
 await assert.rejects(poc.checkBot(config,async(c,m,f)=>m==='getChatMember'?{status:'member'}:call(c,m,f)),/BOT_CANNOT_POST/);
});

test('private supergroup administrators are supported without channel-only posting flags',async()=>{
 const config=poc.configuration(env);
 const call=async(_c,m)=>m==='getMe'?{id:123456789,is_bot:true}:m==='getChat'?{id:config.channelId,type:'supergroup'}:{status:'administrator'};
 const result=await poc.checkBot(config,call);assert.equal(result.storageChatType,'supergroup');assert.equal(result.privateStorageChat,true);assert.equal(result.privateChannel,false);
 await assert.rejects(poc.checkBot(config,async(c,m,f)=>m==='getChatMember'?{status:'member'}:call(c,m,f)),/BOT_CANNOT_POST/);
 await assert.rejects(poc.checkBot(config,async(c,m,f)=>m==='getChat'?{id:config.channelId,type:'supergroup',active_usernames:['public']}:call(c,m,f)),/PRIVATE_STORAGE_CHAT_REQUIRED/);
 await assert.rejects(poc.checkBot(config,async(c,m,f)=>m==='getChat'?{id:config.channelId,type:'private'}:call(c,m,f)),/PRIVATE_STORAGE_CHAT_REQUIRED/);
});
test('Bot API multipart upload streams a local fixture and never follows a redirect with the token',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cutcrew-tg-poc-')),file=path.join(dir,'test.bin'),bytes=randomBytes(65536);await fs.writeFile(file,bytes);
 let received=false;
 const server=http.createServer(async(req,res)=>{if(req.url.endsWith('/redirect')){res.writeHead(302,{Location:'https://example.com/'});res.end();return}const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);received=body.includes(bytes)&&body.includes(Buffer.from('Synthetic test'));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result:{accepted:true}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const config={...poc.configuration(env),baseUrl:'http://127.0.0.1:'+server.address().port};
 try{assert.equal((await poc.botCall(config,'sendDocument',{caption:'Synthetic test'},file)).accepted,true);assert.equal(received,true);await assert.rejects(poc.botCall(config,'redirect'),/LOCAL_BOT_API_UNREACHABLE/);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.unlink(file);await fs.rmdir(dir);}
});

test('large uploads wait past the 300 s fetch limit, honour our own timeout and refuse redirects',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cutcrew-tg-slow-')),file=path.join(dir,'part.bin'),bytes=randomBytes(300000);await fs.writeFile(file,bytes);
 let delay=0,mode='ok';
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
  if(mode==='redirect'){res.writeHead(302,{Location:'https://example.com/'});res.end();return}
  setTimeout(()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result:{intact:body.includes(bytes)&&body.includes(Buffer.from('Line one\nLine two'))}}));},delay);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base={...poc.configuration(env),baseUrl:'http://127.0.0.1:'+server.address().port};
 try{
  delay=1500;assert.equal((await poc.botCall({...base,uploadMs:10000},'sendDocument',{caption:'Line one\nLine two'},file)).intact,true);
  delay=3000;await assert.rejects(poc.botCall({...base,uploadMs:1000},'sendDocument',{caption:'x'},file),/BOT_UPLOAD_TRANSPORT_FAILED/);
  delay=0;mode='redirect';await assert.rejects(poc.botCall({...base,uploadMs:5000},'sendDocument',{caption:'x'},file),/BOT_API_INVALID_RESPONSE|BOT_API_REJECTED/);
  await assert.rejects(poc.botCall({...base,uploadMs:5000},'sendDocument',{},path.join(dir,'missing.bin')),/BOT_UPLOAD_TRANSPORT_FAILED/);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
