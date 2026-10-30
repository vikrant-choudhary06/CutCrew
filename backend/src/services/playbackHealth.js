const crypto=require('node:crypto');
const sources=new Map(),conversions=new Map(),sessions=new Map();
const sourceId=url=>crypto.createHash('sha256').update(url).digest('hex').slice(0,16);
function source(id){if(!sources.has(id)){if(sources.size>=500)sources.delete(sources.keys().next().value);sources.set(id,{bytes:0,networkBytes:0,streamMs:0,fetchMs:0,chunks:0,retries:0,failures:0,stalls:0})}const item=sources.get(id);item.updated=Date.now();return item;}
function range(id,data){const item=source(id||'unlabelled');for(const key of ['bytes','networkBytes','streamMs','fetchMs','chunks','retries','failures'])item[key]+=Math.max(0,Number(data[key])||0)}
function penalty(url){const item=sources.get(sourceId(url));return item&&Date.now()-item.updated<600000?Math.min(60,item.retries*2+item.failures*5+item.stalls*3):0}
function conversionStart(url,mode){const id=crypto.randomUUID();if(conversions.size>=100)conversions.delete(conversions.keys().next().value);conversions.set(id,{source:sourceId(url),mode,started:Date.now(),active:true,speed:0,mediaSeconds:0,bytes:0});return id}
function conversionUpdate(id,data){const item=conversions.get(id);if(item)Object.assign(item,data)}
function conversionEnd(id){const item=conversions.get(id);if(item){item.active=false;item.elapsedMs=Date.now()-item.started}}
function playback(id,data){const old=sessions.get(id);if(old&&data.event==='sample'&&Date.now()-old.updated<5000)return false;if(!old&&sessions.size>=200)sessions.delete(sessions.keys().next().value);const previous=old?.stalls||0;const item=source(data.source);item.stalls+=Math.max(0,data.stalls-previous);if(data.event==='failure'&&old?.event!=='failure')item.failures++;sessions.set(id,{...data,updated:Date.now()});return true}
function snapshot(){return{sources:Object.fromEntries([...sources].map(([id,value])=>[id,{...value,averageMbps:value.fetchMs>0?Number((value.networkBytes*8/value.fetchMs/1000).toFixed(2)):null}])),conversions:[...conversions.values()].map(item=>({...item,elapsedMs:item.active?Date.now()-item.started:item.elapsedMs})),sessions:[...sessions.values()]}}
module.exports={sourceId,range,penalty,conversionStart,conversionUpdate,conversionEnd,playback,snapshot};
