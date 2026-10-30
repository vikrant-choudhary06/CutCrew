const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const scraper=require('../src/services/scraperService');
const fixture=i=>({imdb_id:'tt'+String(i).padStart(7,'0'),title:'Featured '+i,plot:'A story',poster_url:'https://example.com/poster.jpg',backdrop_url:'https://example.com/background.jpg',title_type:'Movie'});
const handler=require('../src/routes/featured');
test('featured eligibility rejects future releases, duplicate IDs and missing landscape artwork',()=>{
 const rows=[fixture(1),fixture(1),{...fixture(2),backdrop_url:''},{...fixture(3),plot:''},{...fixture(4),release_date:'2099-01-01'},{...fixture(5),poster_url:'javascript:bad'}];
 assert.deepEqual(handler.eligible(rows).map(item=>item.imdb_id),[fixture(1).imdb_id]);
});
test('featured pool shares concurrent upstream requests and caches a mixed catalogue',async()=>{
 const actual=scraper.fetchTrending,calls=[];
 scraper.fetchTrending=async(type,limit)=>{calls.push({type,limit});await new Promise(r=>setTimeout(r,20));return Array.from({length:type==='movie'?12:8},(_,i)=>({...fixture(i+(type==='movie'?0:100)),title_type:type==='series'?'TV Series':'Movie'}))};
 const app=express();app.get('/',handler);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const url='http://127.0.0.1:'+server.address().port;const responses=await Promise.all([fetch(url),fetch(url)]);for(const response of responses){assert.equal(response.status,200);assert.equal((await response.json()).data.length,20)}assert.equal(calls.length,2);await fetch(url);assert.equal(calls.length,2);assert.ok(calls.some(c=>c.type==='movie'&&c.limit===20));}
 finally{scraper.fetchTrending=actual;server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('cold upstream failure is retryable and a single available catalogue still supplies a pool',async()=>{
 const actual=scraper.fetchTrending;
 async function request(impl){
  scraper.fetchTrending=impl;delete require.cache[require.resolve('../src/routes/featured')];
  const app=express();app.get('/',require('../src/routes/featured'));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{const response=await fetch('http://127.0.0.1:'+server.address().port);return{status:response.status,body:await response.json()}}
  finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 }
 try{
  assert.equal((await request(async()=>{throw new Error('offline')})).status,503);
  const partial=await request(async type=>{if(type==='series')throw new Error('offline');return Array.from({length:10},(_,i)=>fixture(i))});
  assert.equal(partial.status,200);assert.equal(partial.body.data.length,10);
 }finally{scraper.fetchTrending=actual;}
});
