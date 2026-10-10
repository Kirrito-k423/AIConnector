import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WindowProfiler} from '../../service/window-profiler.mjs';
import {WindowWriter} from '../../service/window-writer.mjs';
import {readWindows,diagnostics} from '../../service/telemetry.mjs';

test('exclusive windows preserve ten seconds through stage switches and late sampling; CPU is separate',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC windows '));
 try{
  let clock=0,cpu=0;const file=path.join(dir,'worker-windows.jsonl');
  const p=new WindowProfiler(file,'sample/1/run-1',{clock:()=>clock,cpu:()=>cpu,origin:0,timer:false});
  clock=3000;cpu=100;p.set('model.wait');clock=7000;cpu=200;p.set('tool.read_input');
  clock=23000;cpu=500;p.sample();await p.close();
  const rows=readWindows(file);assert.equal(rows.length,3);
  assert.deepEqual(rows.map(r=>r.elapsed_ms),[10000,10000,3000]);
  for(const r of rows)assert.ok(Math.abs(r.segments.reduce((n,x)=>n+x.wall_ms,0)-r.elapsed_ms)<.01);
  assert.deepEqual(rows[0].segments.map(x=>x.wall_ms),[3000,4000,3000]);
  assert.equal(rows.reduce((n,r)=>n+r.cpu_ms,0),500);assert.equal(rows[1].cpu_sample_max_ms,16000);
  assert.equal(rows[2].partial,true);assert.ok(rows[1].segments.every(x=>x.stage==='tool.read_input'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('slow local IO never holds a stage callback and bounded queues expose lost windows',async()=>{
 let release,started;const gate=new Promise(r=>release=r),active=new Promise(r=>started=r),written=[];
 const writer=new WindowWriter('fixture',{limit:2,io:{stat:async()=>({size:0}),appendFile:async(_file,text)=>{started();await gate;written.push(JSON.parse(text));}}});
 let clock=0;const p=new WindowProfiler('fixture','sample/1/run-1',{writer,clock:()=>clock,cpu:()=>0,origin:0,timer:false});
 clock=10000;p.sample();await active;
 clock=40000;const before=performance.now();p.set('model.wait');assert.ok(performance.now()-before<50);
 assert.ok(writer.rows.length<=2);assert.equal(writer.dropped,1);
 const closing=p.close();release();await closing;
 assert.equal(written.at(-1).dropped_windows,1);assert.equal(written.at(-1).window,3);
});

test('IO failure is contained and a later window reports the gap',async()=>{
 let calls=0;const written=[];const writer=new WindowWriter('fixture',{io:{stat:async()=>({size:0}),appendFile:async(_file,text)=>{if(!calls++)throw new Error('disk');written.push(JSON.parse(text));}}});
 writer.append({schema:'aiconnector.runtime-window.v1',session:'a',window:0});await writer.close();assert.equal(writer.dropped,1);
 writer.append({schema:'aiconnector.runtime-window.v1',session:'a',window:1});await writer.close();assert.equal(written[0].dropped_windows,1);
});

test('a waiting run exports its actual blocker operation and window; unknown fields never escape',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC blocker '));
 try{
  const key='sample/1/run-1',stamp='2026-10-09T00:00:01Z';
  const events=[{kind:'action_queued',operation_id:'claim',key,blocker_operation_id:'poll'}, {kind:'action_started',operation_id:'poll',action:'Poll'}];
  fs.writeFileSync(path.join(dir,'service-timing.jsonl'),events.map(e=>JSON.stringify({...e,schema:'aiconnector.timing.v1',source:'service',at:stamp})).join('\n'));
  fs.writeFileSync(path.join(dir,'runtime-windows.jsonl'),JSON.stringify({schema:'aiconnector.runtime-window.v1',session:'a'.repeat(32),source:'connector',pid:1,window:0,window_start:'2026-10-09T00:00:00Z',window_end:'2026-10-09T00:00:10Z',elapsed_ms:10000,cpu_ms:25,headers:'SECRET',segments:[{stage:'canonical',parent_stage:'state.save',wall_ms:10000,operation_id:'poll',action:'Poll',key:'',body:'SECRET'}]}));
  const d=diagnostics({stateDir:dir,dataDir:dir,node:'windows-inner'},{jobs:{}},{},key);
  assert.equal(d.events.length,2);assert.equal(d.windows.length,1);
  assert.equal(d.windows[0].segments[0].parent_stage,'state.save');assert.ok(!JSON.stringify(d.windows).includes('SECRET'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
