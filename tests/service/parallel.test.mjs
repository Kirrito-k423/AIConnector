import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Runner} from '../../service/runner.mjs';
import {Resources} from '../../service/resources.mjs';
import {agentConfig} from '../../service/agent-config.mjs';
import {read,save,alive} from '../../service/common.mjs';
import {watchFixture} from './watch_fixture.mjs';
import {modelFixture} from './model_fixture.mjs';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(30);}assert.fail('condition did not become true');}

test('four real isolated Pi processes run concurrently; slow delivery does not hold slots or stop supervision',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC parallel ')),ledger={jobs:{}};
 let release,hold=true;const gate=new Promise(r=>release=r);
 const model=await modelFixture({delay:150,handler:async data=>{
   if(hold)await gate;
   const count=data.messages.filter(m=>m.role==='tool').length;
   return count===0?{tool:'run_experiment'}:{tool:'submit_summary',args:{summary:'CPU fixture evidence',metrics:{fixture:true}}};
 }});
 const c={file:path.join(dir,'config.json'),node:'windows-inner',dataDir:dir,stateDir:path.join(dir,'connector'),connector:{token_env:'FAKE'},runner:{enabled:true,maxConcurrentRuns:4,timeoutSeconds:30,maxTurns:6,profiles:{smoke:{kind:'builtin-smoke',entry:'smoke',repository:'builtin',outputs:['metrics.json']}},agent:agentConfig(),model:{api:'openai-completions',id:'fixture',baseUrl:model.url,compat:{supportsDeveloperRole:false}}}};
 const runs=Array.from({length:6},(_,i)=>({key:`parallel/1/run-${i}`,phase:'accepted',task:{requirements:{mode:'smoke',checks:['cpu-smoke']},environment:{target:'smoke'},invocation:{entry:'smoke',arguments:[]},code:{repository:'builtin',revision:'builtin-smoke-v1'},artifacts:[]}}));
 const claims=[],completed=[];let releaseUpload;const uploadGate=new Promise(r=>releaseUpload=r);
 const connector={call:async(action,args)=>{
   if(action==='Claim'){claims.push(args.key);return {execute:true,task:runs.find(r=>r.key===args.key).task};}
   if(action==='Upload'){await uploadGate;return {sha256:'fixture'};}
   if(action==='Complete'){completed.push(args.key);return {};}
   assert.fail(action);
 }};
 let runner=new Runner(c,connector,ledger,()=>{}, {githubToken:'fixture',apiKey:'fixture'});
 const tick=setInterval(()=>void runner.tick({runs}),40);
 try{
   await until(()=>model.requests===4);assert.equal(claims.length,4);assert.equal(runner.slots(),4);
   const pids=Object.values(ledger.jobs).filter(j=>j.pid).map(j=>j.pid);assert.equal(new Set(pids).size,4);
   await runner.idle();runner=new Runner(c,connector,ledger,()=>{}, {githubToken:'fixture',apiKey:'fixture'});
   await runner.tick({runs});assert.equal(claims.length,4,'supervisor restart must not launch the active runs again');
   hold=false;release();
   await until(()=>claims.length===6);
   assert.equal(completed.length,0,'uploads deliberately remain blocked');
   await until(()=>Object.values(ledger.jobs).every(j=>read(path.join(j.dir,'worker.json'))?.state==='ready'));
   await until(()=>runner.slots()===0);assert.equal(new Set(claims).size,6);
   releaseUpload();await until(()=>completed.length===6);
   const results=Object.values(ledger.jobs).map(j=>{
     const sessions=path.join(j.dir,'sessions'),modelErrors=[];
     // Controlled fixture only: retain the SDK's actual error, rather than
     // guessing from the production-safe MODEL_REQUEST_FAILED category.
     for(const file of fs.existsSync(sessions)?fs.readdirSync(sessions):[]){
       if(!file.endsWith('.jsonl'))continue;
       for(const line of fs.readFileSync(path.join(sessions,file),'utf8').split('\n').filter(Boolean)){
         const message=JSON.parse(line).message;
         if(message?.errorMessage)modelErrors.push({stopReason:message.stopReason,error:message.errorMessage.slice(0,2000)});
       }
     }
     return {key:j.key,result:read(path.join(j.dir,'result.json')),worker:read(path.join(j.dir,'worker.json')),modelErrors};
   });
   assert.ok(results.every(j=>j.result.outcome==='succeeded'),JSON.stringify(results.filter(j=>j.result.outcome!=='succeeded')));
 }finally{
   clearInterval(tick);hold=false;release();releaseUpload();await runner.idle();
   for(const j of Object.values(ledger.jobs))if(alive(j.pid))try{process.kill(j.pid);}catch{}
   await model.close();await until(()=>Object.values(ledger.jobs).every(j=>!alive(j.pid)),10000);fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('resource waits do not claim or call the model; unknown scope blocks only its resource and legacy scope stays exclusive',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC resources ')),watch=await watchFixture({loseReserve:true});
 const ledger={jobs:{}},c={runner:{maxConcurrentRuns:4,agent:agentConfig({simpleHtmlWatch:{enabled:true,baseUrl:watch.url}})}};
 const resources=new Resources(c,ledger,()=>{}),profile=id=>({kind:'simplehtmlwatch',machineId:id});
 const job=id=>ledger.jobs[id]={key:id,dir:path.join(dir,id),state:'waiting'};
 try{
   const a=job('a'),b=job('b'),other=job('other');
   assert.equal(await resources.acquire(a,profile('machine-a')),false);assert.equal(a.resources.state,'unknown');
   assert.equal(await resources.acquire(b,profile('machine-a')),false);assert.equal(b.wait_owner,'a');
   assert.equal(await resources.acquire(other,profile('machine-b')),true);
   other.resources.keys.push('workspace:shared-project');
   const shared=job('shared');assert.equal(await resources.acquire(shared,{...profile('machine-c'),resourceKeys:['workspace:shared-project']}),false);
   assert.equal(shared.wait_owner,'other');
   assert.equal(await resources.acquire(a,profile('machine-a')),true,'query original reservation after dropped response');
   assert.equal(watch.posts,0,'reserving machines must not execute SSH');
   assert.equal(watch.requests.filter(r=>r.url==='/api/tasks/reservations'&&r.body).length,2);
   const global=job('maintenance');assert.equal(await resources.acquire(global,{kind:'maintenance'}),false);
   save(path.join(a.dir,'result.json'),{execution:{unknown:false}});await resources.release(a);
   assert.equal(a.resources.state,'released');assert.equal(await resources.acquire(b,profile('machine-a')),true);
   ledger.jobs.legacy={key:'legacy',state:'unknown'};assert.equal(resources.conflict(job('fresh'),['unrelated']).key,'legacy');
 }finally{await watch.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('scheduler never resolves an in-flight Claim before its reply arrives',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC pending claim '));
 try{
   const ledger={jobs:{x:{key:'x',dir,state:'claiming',resources:{keys:['run:x'],state:'held'}}}},runner=new Runner({runner:{enabled:false}}, {},ledger,()=>{},{});
   let release;const gate=new Promise(r=>release=r);runner.schedule('start:x',()=>gate);
   await runner.tick({runs:[{key:'x',phase:'started',claimed:true}]});assert.equal(ledger.jobs.x.state,'claiming');assert.equal(fs.existsSync(path.join(dir,'result.json')),false);
   release();await runner.idle();await runner.tick({runs:[{key:'x',phase:'started',claimed:true}]});assert.equal(ledger.jobs.x.state,'delivering');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
