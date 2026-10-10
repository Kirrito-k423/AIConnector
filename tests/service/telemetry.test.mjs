import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {timing,diagnostics,deliveryDiagnostics,readTiming,closeWaitTiming} from '../../service/telemetry.mjs';
import {Connector} from '../../service/connector.mjs';

test('timing correlates queue wait and request work without exporting bodies or headers',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC timing '));
  try {
    const c={dataDir:dir,stateDir:path.join(dir,'connector'),node:'windows-inner',tickSeconds:10,connector:{token_env:'AICONNECTOR_FIXTURE',poll_seconds:60}};
    let release;const gate=new Promise(r=>release=r);
    const connector=new Connector(c,{},async(_exe,args)=>{
      assert.equal(args[args.indexOf('-PollSeconds')+1],'10');
      if(args[args.indexOf('-Action')+1]==='Poll')await gate;
      return {code:0,out:'{"ok":true}\n'};
    });
    const first=connector.call('Poll'),second=connector.call('Upload',{key:'sample/1/run-1'});
    await new Promise(r=>setTimeout(r,20));release();await Promise.all([first,second]);
    timing(dir,'example',{body:'SECRET_BODY',headers:'SECRET_HEADER',code:'bad message SECRET_TOKEN',key:'bad?token=SECRET_TOKEN'});
    const dump=fs.readFileSync(path.join(dir,'service-timing.jsonl'),'utf8');assert.ok(!dump.includes('SECRET'));
    const result=diagnostics(c,{jobs:{}},{},'sample/1/run-1');
    assert.ok(result.events.filter(e=>e.kind==='action_queued').some(e=>e.key==='sample/1/run-1'));
    assert.ok(result.events.find(e=>e.kind==='action_dispatched'&&e.key==='sample/1/run-1').queue_wait_ms>=15);
    assert.ok(result.events.find(e=>e.kind==='action_finished'&&e.key==='sample/1/run-1').total_ms>=15);
    assert.equal(new Set(result.events.map(e=>e.operation_id)).size,2);assert.ok(result.events.find(e=>e.kind==='action_queued'&&e.key)?.blocker_operation_id);
    assert.throws(()=>diagnostics(c,{jobs:{}},{},'../secret'),/INVALID_RUN_ID/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('periodic queue waits use the async local writer and stay correlated in diagnostics',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC async waits '));
 try{
  timing(dir,'action_wait',{operation_id:'claim',key:'sample/1/run-1',blocker_operation_id:'poll',queue_wait_ms:10000});
  timing(dir,'action_wait',{operation_id:'claim',key:'sample/1/run-1',blocker_operation_id:'poll',queue_wait_ms:20000});
  await closeWaitTiming(dir);
  const rows=readTiming(path.join(dir,'queue-wait-timing.jsonl'));assert.equal(rows.length,2);
  assert.equal(rows[1].queue_wait_ms,20000);
  const d=diagnostics({dataDir:dir,stateDir:dir,node:'windows-inner'},{jobs:{}},{},'sample/1/run-1');
  assert.equal(d.events.length,2);assert.ok(d.events.every(e=>e.blocker_operation_id==='poll'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('public delivery sidecar exports only bounded correlation fields and times',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC safe export '));
 try{
   const key='sample/1/run-1',c={dataDir:dir,stateDir:dir,node:'windows-inner'};
   fs.writeFileSync(path.join(dir,'service-timing.jsonl'),JSON.stringify({schema:'aiconnector.timing.v1',at:new Date().toISOString(),key,kind:'http_finished',endpoint:'asset',method:'POST',elapsed_ms:42,headers:'SECRET_TOKEN',url:'https://private',category:'PRIVATE SECRET TOKEN'})+'\n');
   const result=deliveryDiagnostics(c,{jobs:{[key]:{dir:'/private/path',worker:{secret:'SECRET_TOKEN'},timings:{claim_queued_at:new Date().toISOString(),bad_at:'SECRET_TOKEN',packaging_ms:5},claim_attempts:1}}},{scopes:{secret:'SECRET_TOKEN'}},key);
   assert.equal(result.timings.packaging_ms,5);assert.ok(result.timings.claim_queued_at);
   assert.equal(result.events[0].elapsed_ms,42);assert.ok(!JSON.stringify(result).includes('SECRET'));
   assert.ok(!JSON.stringify(result).includes('/private'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('bounded timing export survives rotation and ignores an unfinished last line',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC timing rotation '));
  try{
    const file=path.join(dir,'service-timing.jsonl');fs.writeFileSync(file,' '.repeat(2*1024*1024)+'\n');
    timing(dir,'rotated',{key:'sample/1/run-1'});fs.appendFileSync(file,'{"incomplete":');
    assert.ok(fs.existsSync(file+'.1'));assert.equal(readTiming(file).at(-1).kind,'rotated');
    assert.ok(fs.statSync(file).size<1024);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
