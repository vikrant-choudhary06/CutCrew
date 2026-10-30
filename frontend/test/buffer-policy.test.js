import {test} from 'node:test'
import assert from 'node:assert/strict'
import {bufferAhead,bufferTarget,canResume} from '../src/components/bufferPolicy.js'
test('buffer target waits for a useful runway but caps to remaining short media',()=>{assert.equal(bufferTarget({converted:true}),8);assert.equal(bufferTarget({rebuffer:true}),12);assert.equal(bufferTarget({remaining:2}),1.85);assert.equal(bufferTarget({remaining:.1}),0)})
test('playback does not immediately restart on a tiny buffer after a stall',()=>{assert.equal(canResume({ahead:.5,target:12,elapsedMs:1000,readyState:3}),false);assert.equal(canResume({ahead:12,target:12,elapsedMs:1000,readyState:3}),true);assert.equal(canResume({ahead:2,target:12,elapsedMs:10000,readyState:3}),true);assert.equal(canResume({ahead:12,target:12,elapsedMs:10000,readyState:0}),false)})
test('buffer measurement excludes disconnected future ranges after seeking',()=>{const video={currentTime:3,buffered:{length:2,start:i=>i?30:0,end:i=>i?50:8}};assert.equal(bufferAhead(video),5);video.currentTime=20;assert.equal(bufferAhead(video),0);video.currentTime=30;assert.equal(bufferAhead(video),20)})
