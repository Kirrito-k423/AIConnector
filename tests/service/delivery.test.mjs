import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Connector} from '../../service/connector.mjs';
import {Runner} from '../../service/runner.mjs';
import {save,sha} from '../../service/common.mjs';

test('ready upload precedes a fresh scan without preempting an active request',async()=>{
  let release;const gate=new Promise(r=>release=r),order=[];
  const connector=new Connector({connector:{token_env:'AICONNECTOR_FIXTURE'}},{},async(_exe,args)=>{
    const action=args[args.indexOf('-Action')+1];order.push(action);
    if(order.length===1)await gate;
    return {code:0,out:'{"ok":true}\n'};
  });
  const first=connector.call('Poll');
  const upload=connector.call('Upload'),poll=connector.call('Poll');release();
  await Promise.all([first,upload,poll]);assert.deepEqual(order,['Poll','Upload','Poll']);
});

test('owned Claim precedes ready upload; scans follow delivery and diagnostics remain last',async()=>{
 let release;const gate=new Promise(r=>release=r),order=[];
 const connector=new Connector({connector:{token_env:'AICONNECTOR_FIXTURE'}},{},async(_exe,args)=>{
   const action=args[args.indexOf('-Action')+1];order.push(action);if(order.length===1)await gate;return {code:0,out:'{"ok":true}\n'};
 });
 const work=[connector.call('Status'),connector.call('Upload'),connector.call('UploadDiagnostics'),connector.call('Claim'),connector.call('Poll')];
 release();await Promise.all(work);assert.deepEqual(order,['Status','Claim','Upload','Poll','UploadDiagnostics']);
});

test('old diagnostics cannot overtake fresh control work even after ninety seconds',async()=>{
 let release,at=Date.now();const gate=new Promise(r=>release=r),order=[],clock=Date.now;
 Date.now=()=>at;
 const connector=new Connector({connector:{token_env:'AICONNECTOR_FIXTURE'}},{},async(_exe,args)=>{
   const action=args[args.indexOf('-Action')+1];order.push(action);if(order.length===1)await gate;return {code:0,out:'{"ok":true}\n'};
 });
 try{
   const first=connector.call('Status'),old=connector.call('UploadDiagnostics');at+=90000;
   const claim=connector.call('Claim');release();await Promise.all([first,old,claim]);
   assert.deepEqual(order,['Status','Claim','UploadDiagnostics']);
 }finally{Date.now=clock;release();}
});

test('a blocked delivery does not prevent another ready job entering delivery',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC delivery ')),ledger={jobs:{}};
  let release;const gate=new Promise(r=>release=r),uploads=[],complete=[];
  for(const key of ['first','second']){
    const job=ledger.jobs[key]={key,dir:path.join(dir,key),state:'running'};
    save(path.join(job.dir,'worker.json'),{state:'ready'});save(path.join(job.dir,'result.json'),{outcome:'succeeded'});
  }
  const runner=new Runner({runner:{enabled:false}}, {call:async(action,args)=>{
    if(action==='Upload'){uploads.push(args.key);if(args.key==='first')await gate;return {name:'fixture.zip'};}
    if(action==='Complete'){complete.push(args.key);return {};}
    assert.fail(action);
  }},ledger,()=>{},{});
  try {
    await runner.tick({runs:[]});await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(uploads,['first','second']);assert.deepEqual(complete,['second']);
  } finally {release();await runner.idle();fs.rmSync(dir,{recursive:true,force:true});}
});

test('diagnostics lost reply freezes the same ZIP across restart and never claims again',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC diagnostics recovery ')),key='sample/1/run-1';
 const job={key,dir,state:'confirmed',diagnostics_enabled:true,timings:{claim_queued_at:new Date().toISOString()}},ledger={jobs:{[key]:job}},hashes=[];
 const c={dataDir:dir,stateDir:dir,node:'windows-inner',runner:{enabled:false}};
 const connector={call:async(action,args)=>{assert.equal(action,'UploadDiagnostics');hashes.push(sha(fs.readFileSync(args.file)));if(hashes.length===1)throw new Error('CONNECTOR_CHANNEL_CLOSED');return {name:'diagnostics.zip',sha256:hashes.at(-1)};}};
 try{
   let runner=new Runner(c,connector,ledger,()=>{},{}),snapshot={runs:[{key,phase:'result'}]};
   await runner.tick(snapshot);await runner.idle();assert.equal(job.state,'confirmed');assert.equal(job.delivery_diagnostics.state,'retrying');
   assert.ok(job.delivery_diagnostics.retry_at>Date.now()+59000);
   await runner.tick(snapshot);await runner.idle();assert.equal(hashes.length,1);
   job.delivery_diagnostics.retry_at=0;job.timings.receipt_observed_at=new Date().toISOString();snapshot.runs[0].phase='receipt';
   runner=new Runner(c,connector,ledger,()=>{},{});await runner.tick(snapshot);await runner.idle();
   assert.equal(hashes.length,2);assert.equal(hashes[0],hashes[1]);assert.equal(job.delivery_diagnostics.state,'published');
   await runner.tick(snapshot);await runner.idle();assert.equal(hashes.length,2);
   delete job.diagnostics_enabled;delete job.delivery_diagnostics;await runner.tick(snapshot);await runner.idle();assert.equal(hashes.length,2,'history must not be backfilled');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
