import {test} from 'node:test'
import assert from 'node:assert/strict'
import {orderFeatured,toFeatured} from '../src/components/featuredSelection.js'
const pool=Array.from({length:15},(_,i)=>({imdb_id:'tt'+String(i).padStart(7,'0'),title:'Film '+i,title_type:'Movie'}))
test('refresh prioritizes unseen titles and removes duplicate identities',()=>{
 const previous=pool.slice(0,5).map(item=>item.imdb_id)
 const next=orderFeatured([...pool,pool[0]],previous,()=>.5)
 assert.equal(next.length,15)
 assert.equal(new Set(next.map(item=>item.imdb_id)).size,15)
 assert.ok(next.slice(0,5).every(item=>!previous.includes(item.imdb_id)))
})
test('small pools reuse previous titles only after fresh candidates',()=>{
 const next=orderFeatured(pool.slice(0,5),pool.slice(0,4).map(item=>item.imdb_id),()=>.5)
 assert.equal(next[0].imdb_id,pool[4].imdb_id)
 assert.equal(next.length,5)
})
test('a mixed pool includes a series within the first five without duplicates',()=>{
 const next=orderFeatured([...pool,{imdb_id:'tt9999999',title_type:'TV Series'}],[],()=>.999)
 assert.ok(next.slice(0,5).some(item=>item.title_type==='TV Series'))
 assert.equal(new Set(next.slice(0,5).map(item=>item.imdb_id)).size,5)
})
test('hero mapping preserves identity, artwork and series playback type',()=>{
 const result=toFeatured({imdb_id:'tt1234567',title:'Example',title_type:'TV Series',runtime_minutes:48,genres:['Drama','Mystery'],rating:8.2,poster_url:'poster',backdrop_url:'background',plot:'A story'})
 assert.equal(result.id,'tt1234567');assert.equal(result.title_type,'TV Series')
 assert.equal(result.runtime,'48m');assert.equal(result.genre,'Drama · Mystery')
 assert.equal(result.backdrop,'background');assert.equal(result.rating,'★ 8.2')
})
