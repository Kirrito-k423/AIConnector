import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WindowProfiler} from '../../service/window-profiler.mjs';
import {readWindows,diagnostics} from '../../service/telemetry.mjs';

test('exclusive windows preserve ten seconds through stage switches and late sampling; CPU is separate',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC windows '));
 try{
  let clock=0,cpu=0;const file=path.join(dir,'worker-windows.jsonl');
  const p=new WindowProfiler(file,'sample/1/run-1',{clock:()=>clock,cpu:()=>cpu,origin:0,timer:false});
  clock=3000;cpu=100;p.set('model.wait');clock=7000;cpu=200;p.set('tool.read_input');
  clock=23000;cpu=500;p.sample();p.close();
  const rows=readWindows(file);assert.equal(rows.length,3);
  assert.deepEqual(rows.map(r=>r.elapsed_ms),[10000,10000,3000]);
  for(const r of rows)assert.ok(Math.abs(r.segments.reduce((n,x)=>n+x.wall_ms,0)-r.elapsed_ms)<.01);
  assert.deepEqual(rows[0].segments.map(x=>x.wall_ms),[3000,4000,3000]);
  assert.equal(rows.reduce((n,r)=>n+r.cpu_ms,0),500);assert.equal(rows[1].cpu_sample_max_ms,16000);
  assert.equal(rows[2].partial,true);assert.ok(rows[1].segments.every(x=>x.stage==='tool.read_input'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
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
