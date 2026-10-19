import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Resources} from '../../service/resources.mjs';
import {WatchExecution} from '../../service/watch.mjs';
import {watchFixture} from './watch_fixture.mjs';
import {save,atomic} from '../../service/common.mjs';
const ids=Array.from({length:8},(_,i)=>'machine-'+i);
const profile={kind:'simplehtmlwatch',machineId:ids[0],machineIds:ids,shell:'true',revisionCommand:'printf fixture-rev',outputs:['metrics.json','group-completion.json'],groupCompletionOutput:'group-completion.json',groupRanksPerMachine:8};
const task={code:{revision:'fixture-rev'}};
for(const concurrency of [1,4])test(`whole group survives lost reserve reply and supervisor restart: concurrency ${concurrency}`,async()=>{
 const w=await watchFixture({loseReserve:true}),dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC group '));
 const ledger={jobs:{}},config={runner:{maxConcurrentRuns:concurrency,agent:{simpleHtmlWatch:{baseUrl:w.url}}}};
 let resources=new Resources(config,ledger,()=>{});const job=ledger.jobs.group={key:'group/1/run',dir,state:'waiting'};
 try{
  assert.equal(await resources.acquire(job,profile,task),false);assert.equal(job.resources.state,'unknown');
  resources=new Resources(config,ledger,()=>{});assert.equal(await resources.acquire(job,profile,task),true);
  assert.equal(w.requests.filter(r=>r.url==='/api/tasks/reservations'&&r.body).length,1,'lost reply reconciles original ID');
  assert.equal(job.resources.remote.allocations.length,8);
  const intruder=ledger.jobs.other={key:'other/1/run',state:'waiting'};
  assert.equal(await resources.acquire(intruder,{kind:'simplehtmlwatch',machineId:ids[6]}),false);
  const ex=new WatchExecution({key:job.key,profile,task,reservation:job.resources.remote,agent:{simpleHtmlWatch:{baseUrl:w.url}}},dir);
  await ex.submit();assert.equal(JSON.parse(w.requests.find(r=>r.url==='/api/tasks'&&r.body).body).reservationGrantId,job.resources.remote.grantId);
  await ex.submit();assert.equal(w.posts,1);
  await assert.rejects(resources.acquire(job,{...profile,shell:'changed'},task),/GROUP_PLAN_CHANGED/);
  save(path.join(dir,'spec.json'),{key:job.key,profile});save(path.join(dir,'result.json'),{execution:{unknown:false}});
  await resources.release(job);assert.equal(job.resources.state,'unknown','coordinator exit alone does not release eight machines');
  atomic(path.join(dir,'work','group-completion.json'),JSON.stringify({schema:'aiconnector.group-completion.v1',run_key:job.key,members:ids.map((machine_id,i)=>({machine_id,ranks:Array.from({length:8},(_,j)=>({rank:i*8+j,exit_code:0,process_id:'fixture-'+i+'-'+j}))}))}));
  await resources.release(job);assert.equal(job.resources.state,'released');assert.equal(job.resources.completion.rank_count,64);
 }finally{await w.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('an old SHW blocks the group before Pi or SSH is launched',async()=>{
 const w=await watchFixture({atomicGroups:0}),job={key:'old/1/run',state:'waiting'},c={runner:{maxConcurrentRuns:4,agent:{simpleHtmlWatch:{baseUrl:w.url}}}};
 try{await assert.rejects(new Resources(c,{jobs:{job}},()=>{}).acquire(job,profile,task),/WATCH_GROUP_RESERVATIONS_REQUIRED/);assert.equal(w.posts,0);assert.equal(job.resources.state,'waiting');}finally{await w.close();}
});
test('an unchanged running SSH task is polled inside one tool, never re-submitted',async()=>{
 const w=await watchFixture({status:'running',finishAfterReads:3}),dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC wait '));
 try{
  const ex=new WatchExecution({key:'wait/1/run',profile:{...profile,machineIds:undefined},task,agent:{simpleHtmlWatch:{baseUrl:w.url,pollSeconds:.01}}},dir);
  await ex.submit();assert.equal((await ex.awaitStatus()).status,'succeeded');assert.equal(w.posts,1);assert.equal(w.reads,3);
 }finally{await w.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('a different instance on the same port cannot execute or release the original group',async()=>{
 const w=await watchFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC identity '));
 try{
  const job={key:'identity/1/run',dir,state:'waiting'},resources=new Resources({runner:{maxConcurrentRuns:4,agent:{simpleHtmlWatch:{baseUrl:w.url}}}},{jobs:{job}},()=>{});
  assert.equal(await resources.acquire(job,profile,task),true);w.replaceInstance('other-service');
  const ex=new WatchExecution({key:job.key,profile,task,reservation:job.resources.remote,agent:{simpleHtmlWatch:{baseUrl:w.url}}},dir);
  await assert.rejects(ex.submit(),/WATCH_INSTANCE_CHANGED/);assert.equal(w.posts,0);
  save(path.join(dir,'result.json'),{execution:{unknown:false}});await resources.release(job);assert.equal(job.resources.state,'unknown');assert.equal(job.resources.error,'WATCH_INSTANCE_CHANGED');
  assert.equal(w.requests.filter(r=>r.url==='/api/tasks/reservations/release').length,0);
 }finally{await w.close();fs.rmSync(dir,{recursive:true,force:true});}
});
