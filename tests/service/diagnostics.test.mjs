import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Runner} from '../../service/runner.mjs';
import {Connector} from '../../service/connector.mjs';

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC receipt diagnostics ')),key='sample/1/run-1';
  const job={key,dir,state:'confirmed',diagnostics_enabled:true},ledger={jobs:{[key]:job}};
  return {dir,key,job,ledger,c:{dataDir:dir,stateDir:dir,node:'windows-inner',runner:{enabled:false}},snapshot:{runs:[{key,phase:'receipt'}]}};
}

test('receipt diagnostics enter the transport queue despite busy jobs, dirty state and background retries',async()=>{
  const f=fixture(),calls=[];
  f.ledger.jobs.other={key:'sample/1/run-2',dir:path.join(f.dir,'other'),state:'waiting'};
  f.snapshot.runs.push({key:'sample/1/run-3',phase:'accepted'});
  const connector={running:true,dirty:true,queue:[{background:true}],call:async(a,args)=>{calls.push({a,args});return {name:'diagnostics.zip'};}};
  const runner=new Runner(f.c,connector,f.ledger,()=>{},{});
  try{
    await runner.tick(f.snapshot);await runner.idle();
    assert.equal(calls.length,1);assert.equal(calls[0].a,'UploadDiagnostics');
    assert.ok(calls[0].args.expiresAt>Date.now());assert.equal(f.job.delivery_diagnostics.state,'published');
    await runner.tick(f.snapshot);await runner.idle();assert.equal(calls.length,1);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('diagnostics respect their own delivery and keep only one upload in flight',async()=>{
  const f=fixture(),calls=[];let release;const gate=new Promise(r=>release=r);
  const second={key:'sample/1/run-2',dir:path.join(f.dir,'other'),state:'confirmed',diagnostics_enabled:true};
  f.ledger.jobs[second.key]=second;f.snapshot.runs.push({key:second.key,phase:'receipt'});
  const runner=new Runner(f.c,{call:async(a,args)=>{calls.push(args.key);await gate;return {name:'diagnostics.zip'};}},f.ledger,()=>{},{});
  try{
    runner.pending.set('delivery:'+f.key,gate);
    runner.exportDiagnostics(f.job,f.snapshot);assert.equal(runner.pending.size,1);
    runner.pending.delete('delivery:'+f.key);
    await runner.tick(f.snapshot);await Promise.resolve();assert.deepEqual(calls,[f.key]);
    assert.ok(!second.delivery_diagnostics?.artifact);
    release();await runner.idle();await runner.tick(f.snapshot);await runner.idle();
    assert.deepEqual(calls,[f.key,second.key]);
  }finally{release();await runner.idle();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('receipt retry budget survives restart and expires visibly without changing the task',async()=>{
  const f=fixture();let calls=0;
  const connector={call:async()=>{calls++;throw new Error('NETWORK_ERROR_0');}};
  try{
    let runner=new Runner(f.c,connector,f.ledger,()=>{},{});
    await runner.tick(f.snapshot);await runner.idle();
    assert.equal(f.job.delivery_diagnostics.attempts,1);const deadline=f.job.delivery_diagnostics.deadline_at;
    assert.equal(f.job.delivery_diagnostics.state,'retrying');
    runner=new Runner(f.c,connector,f.ledger,()=>{},{});
    await runner.tick(f.snapshot);await runner.idle();assert.equal(calls,1);
    f.job.delivery_diagnostics.attempts=12;f.job.delivery_diagnostics.retry_at=0;
    await runner.tick(f.snapshot);await runner.idle();
    assert.equal(calls,1);assert.equal(f.job.delivery_diagnostics.state,'expired');
    assert.equal(f.job.delivery_diagnostics.error,'DIAGNOSTICS_RETRY_EXHAUSTED');
    assert.equal(f.job.delivery_diagnostics.deadline_at,deadline);assert.equal(f.job.state,'confirmed');
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('an expired queued sidecar never starts an upload or preempts the active Poll',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC diagnostic deadline '));
  let release;const gate=new Promise(r=>release=r),actions=[];
  const connector=new Connector({dataDir:dir,connector:{token_env:'AIC_FIXTURE'}},{},async(_exe,args)=>{
    const action=args[args.indexOf('-Action')+1];actions.push(action);await gate;return {code:0,out:'{"ok":true}\n'};
  });
  const fallback=setTimeout(release,200);
  try{
    const active=connector.call('Poll');
    await assert.rejects(connector.call('UploadDiagnostics',{expiresAt:Date.now()+25}),/DIAGNOSTICS_DEADLINE_EXCEEDED/);
    assert.deepEqual(actions,['Poll']);assert.equal(connector.queue.length,0);assert.equal(connector.running,true);
    release();await active;
  }finally{clearTimeout(fallback);release();await connector.close();fs.rmSync(dir,{recursive:true,force:true});}
});
