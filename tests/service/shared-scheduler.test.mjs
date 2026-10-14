import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Resources} from '../../service/resources.mjs';
import {WatchExecution,watchPlan} from '../../service/watch.mjs';
import {validateRegistry} from '../../service/server-registry.mjs';
import {capabilities} from '../../service/capabilities.mjs';
import {preflight,checkRequirements} from '../../service/capabilities.mjs';
import {healthSample} from '../../service/npu-health.mjs';
import {Runner} from '../../service/runner.mjs';
import {agentConfig} from '../../service/agent-config.mjs';
import {save,read,sha,alive} from '../../service/common.mjs';
import {unzipSync} from 'fflate';
import {watchFixture} from './watch_fixture.mjs';

const row=(id,ready=true,resourceKey='physical:'+id)=>({id,host:'192.0.2.'+(id==='a'?1:2),resourceKey,enabled:true,status:'online',ready,reason:ready?'ready':'任务占用',updatedAt:new Date().toISOString(),taskIds:[],reservationIds:[],continuationIds:[]});
const p={kind:'simplehtmlwatch',mode:'experiment',executionMode:'direct',entry:'experiment',repository:'fixture',revision:'fixture-rev',revisionCommand:'printf fixture-rev',shell:'true',outputs:['metrics.json'],verification:[{id:'fixture',kind:'output-json',file:'metrics.json',pointer:'/fixture',equals:true}]};
const task={code:{revision:'fixture-rev'}};
const config=url=>({node:'windows-inner',connector:{namespace:'fixture'},runner:{maxConcurrentRuns:4,enabled:true,agent:{simpleHtmlWatch:{enabled:true,baseUrl:url}},profiles:{pool:{...p,machinePool:['a','b'],machineCount:1}}}});
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'AIC shared '));

test('Issue 16: default completed execution uses opaque ID, never the raw controller host',async()=>{
  const w=await watchFixture(),dir=temp();fs.mkdirSync(path.join(dir,'work'));
  try{
    const execution=await new WatchExecution({key:'privacy/1/run',task,profile:{...p,machineId:'fixture-machine'},agent:{simpleHtmlWatch:{baseUrl:w.url,pollSeconds:.01}}},dir).run();
    assert.equal(execution.server_task.machineName,'fixture-machine');
    assert.doesNotMatch(JSON.stringify(execution),/192\.0\.2\.1/);
  }finally{await w.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('a shared pool reserves the available alternative; all-busy remains queued without Claim or SSH',async()=>{
  const machines=[row('a',false),row('b')],w=await watchFixture({machines}),dir=temp(),c=config(w.url),ledger={jobs:{}};
  const r=new Resources(c,ledger,()=>{}),job=ledger.jobs.one={key:'pool/1/run',dir,state:'waiting'};
  try{
    assert.equal(await r.acquire(job,c.runner.profiles.pool,task),true);
    assert.equal(job.resources.remote.machineId,'b');
    assert.equal(job.resources.selectedProfile.machineId,'b');
    job.state='running';
    assert.equal(w.posts,0);
    machines[1].ready=false;machines[1].reason='已被预约';
    const next=ledger.jobs.two={key:'pool/1/next',dir:path.join(dir,'next'),state:'waiting'};
    assert.equal(await r.acquire(next,c.runner.profiles.pool,task),false);
    assert.equal(next.wait_reason,'NO_AVAILABLE_MACHINE');
    assert.deepEqual(next.queue_feedback.machines.map(m=>m.host),['192.0.2.1','192.0.2.2']);
    const cap=capabilities(c,{},undefined,ledger.jobs);
    assert.equal(cap.scheduler.waiting[0].key,next.key);
    assert.equal(w.posts,0);
  }finally{await w.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('pool reservation lost reply freezes the original selection and recovers by its original ID',async()=>{
  const machines=[row('a'),row('b')],w=await watchFixture({machines,loseReserve:true}),dir=temp(),c=config(w.url),ledger={jobs:{}};
  const job=ledger.jobs.one={key:'lost/1/run',dir,state:'waiting'};
  try{
    assert.equal(await new Resources(c,ledger,()=>{}).acquire(job,c.runner.profiles.pool,task),false);
    const original=job.resources.remote.id;assert.equal(job.resources.state,'unknown');
    machines[0].ready=false;
    assert.equal(await new Resources(c,ledger,()=>{}).acquire(job,c.runner.profiles.pool,task),true);
    assert.equal(job.resources.remote.id,original);assert.equal(job.resources.remote.machineId,'a');
    assert.equal(w.requests.filter(r=>r.url==='/api/tasks/reservations'&&r.body).length,1);
  }finally{await w.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('pool registry restricts members to local authorization and declares group completion',()=>{
  const registry={schema:'aiconnector.server-registry.v1',machineIds:['a','b'],profiles:{pool:{...p,machinePool:['a','b'],machineCount:1}}};
  assert.doesNotThrow(()=>validateRegistry(registry));
  assert.throws(()=>validateRegistry({...registry,profiles:{pool:{...registry.profiles.pool,machinePool:['a','foreign']}}}),/SERVER_POOL_SCOPE/);
  assert.throws(()=>validateRegistry({...registry,profiles:{pool:{...registry.profiles.pool,machineCount:2}}}),/GROUP_COMPLETION_CONTRACT_REQUIRED/);
});

test('Warning/Alarm policy is explicit in fixed shell; strict remains selectable',()=>{
  assert.match(watchPlan({...p,machineId:'a'},task,'health/1/run').shell,/export AICONNECTOR_NPU_HEALTH_POLICY='allow-warning-alarm'/);
  assert.match(watchPlan({...p,machineId:'a',npuHealthPolicy:'strict'},task,'health/1/strict').shell,/export AICONNECTOR_NPU_HEALTH_POLICY='strict'/);
});

test('two-node pool skips a physical alias and reserves the whole chosen group once',async()=>{
  const machines=[row('a',true,'physical:one'),row('alias',true,'physical:one'),row('b')],w=await watchFixture({machines}),dir=temp(),c=config(w.url),ledger={jobs:{}};
  const profile={...p,machinePool:['a','alias','b'],machineCount:2,outputs:['metrics.json','group-completion.json'],groupCompletionOutput:'group-completion.json',groupRanksPerMachine:4};
  const job=ledger.jobs.one={key:'two/1/run',dir,state:'waiting'};
  try{
    assert.equal(await new Resources(c,ledger,()=>{}).acquire(job,profile,task),true);
    assert.deepEqual(job.resources.remote.machineIds,['a','b']);
    assert.equal(job.resources.remote.allocations.length,2);
    const posts=w.requests.filter(r=>r.url==='/api/tasks/reservations'&&r.body);assert.equal(posts.length,1);
    assert.deepEqual(JSON.parse(posts[0].body).machineIds,['a','b']);
    const requirements={...task,requirements:{mode:'experiment',execution_mode:'direct',tools:[],checks:['fixture','group-processes-stopped'],resources:{machine_count:2,atomic_group:true,pool_sha256:sha(JSON.stringify(profile.machinePool))}}};
    assert.doesNotThrow(()=>checkRequirements(requirements,job.resources.selectedProfile));
  }finally{await w.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('sender auto selects a declared pool, retains queue state outside readiness, and bounds feedback size',()=>{
  const c=config('http://127.0.0.1:1234');c.runner.profiles.fixed={...p,machineId:'a'};
  const remote=capabilities(c),request={requirements:{mode:'experiment',checks:['fixture'],execution_mode:'direct'},code:{repository:'fixture',revision:'fixture-rev'},environment:{target:'auto'},invocation:{entry:'auto',arguments:[]}};
  assert.equal(preflight(request,remote).profile.id,'pool');
  const jobs=Object.fromEntries(Array.from({length:200},(_,i)=>[i,{key:'long/1/run-'+i,state:'waiting',queue_feedback:{machines:Array.from({length:12},()=>({id:'x'.repeat(256),host:'2001:db8::1',reason:'任务占用'}))}}]));
  const busy=capabilities(c,{},undefined,jobs);assert.ok(Buffer.byteLength(JSON.stringify(busy))<24000);assert.equal(busy.scheduler.waiting_total,200);assert.equal(busy.scheduler.waiting_truncated,true);
  assert.equal(preflight(request,busy).ok,true,'busy is queued, not a capability refusal');
});

test('auto excludes pools with a different entry or code revision before choosing an available profile',()=>{
  for(const patch of [{entry:'another-experiment'},{revision:'another-rev'}]){
    const c=config('http://127.0.0.1:1234');c.runner.profiles.fixed={...p,machineId:'a'};Object.assign(c.runner.profiles.pool,patch);
    const request={requirements:{mode:'experiment',checks:['fixture'],execution_mode:'direct'},code:{repository:'fixture',revision:'fixture-rev'},environment:{target:'auto'},invocation:{entry:'experiment',arguments:[]}};
    assert.equal(preflight(request,capabilities(c)).profile.id,'fixed');
  }
});

test('Alarm/Warning execute and return annotated ZIP through a real worker; strict blocks before SSH',async()=>{
  for(const policy of ['allow-warning-alarm','strict']){
    const npu='| NPU ID | Name | Health |\n| 0 | Ascend950DT | Alarm |\n| 1 | Ascend950DT | Warning |\n';
    const machines=[row('a',false),row('b',false)],monitor={'b':{results:[{commandId:'npu',stdout:npu,exitCode:0,endedAt:new Date().toISOString()}]}},w=await watchFixture({machines,monitor}),dir=temp(),c=config(w.url),ledger={jobs:{}};
    c.file=path.join(dir,'config.json');c.dataDir=dir;c.stateDir=path.join(dir,'connector');c.runner.timeoutSeconds=20;c.runner.maxTurns=4;c.runner.maxConcurrentRuns=1;c.runner.agent=agentConfig({simpleHtmlWatch:{enabled:true,baseUrl:w.url}});c.runner.profiles.pool.npuHealthPolicy=policy;
    const request={code:{repository:'fixture',revision:'fixture-rev'},requirements:{mode:'experiment',tools:[],checks:['fixture'],execution_mode:'direct',resources:{machine_count:1,atomic_group:false,pool_sha256:sha(JSON.stringify(c.runner.profiles.pool.machinePool))}},environment:{target:'pool'},invocation:{entry:'experiment',arguments:[]},artifacts:[]};
    const runs=[{key:'worker/1/'+policy,phase:'accepted',task:request}],claims=[];
    const connector={call:async(action,args)=>{if(action==='Claim'){claims.push(args.key);return {execute:true,claim_owner:args.claimOwner,task:request};}if(action==='Upload')return {sha256:'fixture'};if(action==='Complete')return {};throw new Error(action);}};
    const runner=new Runner(c,connector,ledger,()=>{},{githubToken:'PRIVATE_GITHUB_TEST_TOKEN'});
    try{
      await runner.tick({runs});await runner.idle();assert.equal(claims.length,0);assert.equal(w.posts,0);
      const queued=Object.values(ledger.jobs)[0];assert.equal(queued.state,'waiting');assert.equal(queued.wait_reason,'NO_AVAILABLE_MACHINE');
      machines[1].ready=true;machines[1].reason='ready';queued.next_attempt=0;
      const deadline=Date.now()+15000;let completed;
      while(Date.now()<deadline){await runner.tick({runs});completed=Object.values(ledger.jobs)[0];if(completed&&['ready','blocked'].includes(read(path.join(completed.dir,'worker.json'))?.state))break;await new Promise(r=>setTimeout(r,30));}
      const result=read(path.join(completed.dir,'result.json'));assert.ok(result,JSON.stringify(completed));assert.equal(claims.length,1);assert.equal(result.agent.turns,0);
      if(policy==='strict'){assert.equal(w.posts,0);assert.equal(result.agent.stop_reason,'NPU_HEALTH_GATE');}
      else{
        assert.equal(w.posts,1);assert.equal(result.outcome,'succeeded',JSON.stringify(result));assert.equal(result.execution.npu_health.has_alarm,true);assert.equal(result.execution.npu_health.has_warning,true);
        assert.match(result.summary,/Warning\/Alarm/);
        const zip=unzipSync(fs.readFileSync(path.join(completed.dir,'result.zip'))),facts=JSON.parse(Buffer.from(zip['npu-health.json']));
        assert.equal(facts.before[0].machine_id,'b');assert.equal(facts.before[0].known,true);assert.equal(facts.before[0].devices[0].status,'Alarm');
        assert.doesNotMatch(Buffer.from(zip['execution.json']).toString(),/192\.0\.2/);
      }
    }finally{await runner.idle();for(const j of Object.values(ledger.jobs))if(alive(j.pid))try{process.kill(j.pid);}catch{}await w.close();fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('health evidence preserves unknown/stale samples instead of manufacturing OK',()=>{
  assert.equal(healthSample({}).known,false);
  const stale=healthSample({results:[{commandId:'npu',stdout:'| NPU ID | Name | Health |\n| 0 | Ascend950DT | Alarm |',exitCode:0,endedAt:'2020-01-01T00:00:00Z'}]});
  assert.equal(stale.has_alarm,true);assert.equal(stale.fresh,false);
  assert.equal(healthSample({results:[{commandId:'npu',stdout:'| NPU ID | Name | Health |\n| 0 | Ascend950DT | OK |\n| 1 | Ascend950DT | NA |',exitCode:0,endedAt:new Date().toISOString()}]}).known,false);
});
