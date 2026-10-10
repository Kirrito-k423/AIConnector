import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {save,read,json,sha,run,ROOT} from '../../service/common.mjs';
import {Maintenance} from '../../service/maintenance.mjs';
import {Inputs} from '../../service/inputs.mjs';
import {ProfileWorkflow} from '../../service/profile-workflow.mjs';
import {profileDefinitions,definitionSha,parseProfileInput} from '../../service/profile-data.mjs';
import {verifyTask} from '../../service/verification.mjs';
import {toolsFor,checkRequirements} from '../../service/capabilities.mjs';
import {modelFixture} from './model_fixture.mjs';

const profile=revision=>({kind:'simplehtmlwatch',mode:'experiment',machineId:'approved',entry:'device',repository:'fixture-device',revision,revisionCommand:'printf '+revision,shell:'printf fixture',outputs:['metrics.json'],verification:[{id:'exit',kind:'execution',equals:0}]});
async function fixture({source=JSON.stringify({device:profile('v2')}),large=false}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'AIC profiles 中文 '))),file=path.join(dir,'registry.json');
  const original={schema:'aiconnector.server-registry.v1',machineIds:['approved'],profiles:{device:profile('v1'),...(large?Object.fromEntries(Array.from({length:20},(_,i)=>['retained-'+i,{...profile('old-'+i),shell:'x'.repeat(1800)}])):{retained:profile('old')})}};
  fs.writeFileSync(file,JSON.stringify(original));let loaded=original.profiles,reloads=0,disconnect=false,stale=false;
  const server=http.createServer((req,res)=>{
    if(req.url==='/api/reload-agent'){
      reloads++;if(disconnect){req.socket.destroy();return;}
      if(!stale)loaded=json(file).profiles;
      res.end(JSON.stringify({reloaded:true}));
    }else res.end(JSON.stringify({reloaded:true,experiment_entry_configured:true,loaded_profiles:profileDefinitions(loaded)}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const p={kind:'maintenance',revision:'registry-v1',entry:'server-registry',repository:'registry',outputs:[],maintenance:{enabled:true,files:{registry:{path:file,format:'server-registry',write:true,pointers:['/profiles']}},apis:{reload:{baseUrl,route:'/api/reload-agent',method:'POST',readOnly:false},readiness:{baseUrl,route:'/api/server-readiness',readOnly:true}}},verification:[{id:'any-entry',kind:'local-api',api:'readiness',pointer:'/experiment_entry_configured',equals:true}]};
  const artifact=zipSync({'update.json':strToU8(source)});fs.mkdirSync(path.join(dir,'inputs'));fs.writeFileSync(path.join(dir,'inputs','profiles.zip'),artifact);
  const spec={key:'fixture/1/profiles',profile:p,task:{requirements:{mode:'maintenance',tools:['configure_server_profiles'],checks:['server-profiles-loaded'],server_profiles:[{id:'device',revision:'v2',definition_sha256:definitionSha(profile('v2'))}]},code:{repository:'registry',revision:'registry-v1'},environment:{target:'maintenance'},invocation:{entry:'server-registry',arguments:[]},artifacts:[{name:'profiles.zip',sha256:sha(artifact),bytes:artifact.length}]}};
  const inputs=new Inputs(dir,spec.task.artifacts),m=new Maintenance(spec,dir),flow=new ProfileWorkflow(m,inputs),input=inputs.state.files[0];
  const args={action_id:'configure-v2',file:'registry',input_id:input.id,input_sha256:input.sha256,expected_sha256:sha(fs.readFileSync(file))};
  return {dir,file,original,spec,inputs,m,flow,args,get reloads(){return reloads;},set disconnect(v){disconnect=v;},set stale(v){stale=v;},close:async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}};
}

test('large registry merges only the staged member and verifies the exact loaded revision',async()=>{
  const f=await fixture({large:true});try{
    checkRequirements(f.spec.task,f.spec.profile);assert.ok(toolsFor(f.spec.profile).includes('configure_server_profiles'));
    const r=await f.flow.configure(f.args),saved=json(f.file);
    assert.equal(r.verified,true);assert.equal(r.hardware_execution_verified,false);assert.deepEqual(saved.machineIds,f.original.machineIds);
    for(const [id,p]of Object.entries(f.original.profiles))if(id!=='device')assert.deepEqual(saved.profiles[id],p);
    assert.equal(saved.profiles.device.revision,'v2');assert.equal(f.reloads,1);
    assert.equal((await verifyTask(f.spec,f.dir,{maintenance:f.m,profileWorkflow:f.flow})).status,'passed');
    assert.equal((await f.flow.configure(f.args)).verified,true);assert.equal(f.reloads,1,'reload action must not repeat');
    assert.equal(f.m.publicActions().filter(r=>r.kind==='file-write').length,1);
    assert.doesNotMatch(JSON.stringify(f.flow.publicRows()),/printf|approved/);
    await assert.rejects(f.flow.configure({...f.args,input_sha256:'0'.repeat(64)}),/ACTION_ID_CONFLICT/);
  }finally{await f.close();}
});
test('written configuration resumes after interruption without rewriting or losing other entries',async()=>{
  const f=await fixture();try{
    const controller=new AbortController(),m=new Maintenance(f.spec,f.dir,{signal:controller.signal,event:(_e,r)=>{if(r.kind==='file-write')controller.abort();}}),flow=new ProfileWorkflow(m,f.inputs);
    await assert.rejects(flow.configure(f.args),/RUN_STOPPED/);assert.equal(f.reloads,0);
    const after=sha(fs.readFileSync(f.file));assert.equal(json(f.file).profiles.device.revision,'v2');
    // Simulate exit after the child journal committed but before workflow update.
    const rows=read(flow.file);delete rows['configure-v2'].after_sha256;save(flow.file,rows);
    const resumed=new ProfileWorkflow(new Maintenance(f.spec,f.dir),new Inputs(f.dir,f.spec.task.artifacts));
    assert.equal((await resumed.configure(f.args)).verified,true);assert.equal(f.reloads,1);
    assert.equal(sha(fs.readFileSync(f.file)),after);assert.equal(resumed.maintenance.publicActions().filter(r=>r.kind==='file-write').length,1);
  }finally{await f.close();}
});
test('unknown reload is not repeated and retains the known completed write',async()=>{
  const f=await fixture();try{
    f.disconnect=true;await assert.rejects(f.flow.configure(f.args));assert.equal(f.reloads,1);
    const after=sha(fs.readFileSync(f.file)),resumed=new ProfileWorkflow(new Maintenance(f.spec,f.dir),f.inputs);
    assert.equal(resumed.publicRows()[0].phases.write,'done');assert.equal(resumed.publicRows()[0].phases.reload,'unknown');
    f.disconnect=false;await assert.rejects(resumed.configure(f.args),/ACTION_UNKNOWN/);assert.equal(f.reloads,1);assert.equal(sha(fs.readFileSync(f.file)),after);
  }finally{await f.close();}
});
test('an existing arbitrary experiment or stale v1 load cannot pass the v2 contract',async()=>{
  const f=await fixture();try{
    let r=await verifyTask(f.spec,f.dir,{maintenance:f.m,profileWorkflow:f.flow});assert.equal(r.status,'incomplete');assert.equal(r.checks[0].ok,true);assert.equal(r.checks.at(-1).error,'PROFILE_CONFIGURATION_REQUIRED');
    f.stale=true;await assert.rejects(f.flow.configure(f.args),/REQUESTED_PROFILE_NOT_LOADED/);
    r=await verifyTask(f.spec,f.dir,{maintenance:f.m,profileWorkflow:f.flow,pass:1});assert.equal(r.status,'incomplete');assert.equal(r.checks.at(-1).error,'REQUESTED_PROFILE_NOT_LOADED');
  }finally{await f.close();}
});
test('file CAS, member hash, old-run binding, machine scope and input contract reject before any effect',async()=>{
  for(const kind of ['cas','hash','binding','member-tamper','scope','wrong-revision','grant']){
    const source=JSON.stringify({device:{...profile('v2'),...(kind==='scope'?{machineId:'not-approved'}:kind==='wrong-revision'?{revision:'v1'}:{})}}),f=await fixture({source});try{
      if(kind==='cas')f.args.expected_sha256='0'.repeat(64);
      if(kind==='hash')f.args.input_sha256='0'.repeat(64);
      if(kind==='binding')f.inputs.artifacts=[];
      if(kind==='member-tamper')fs.appendFileSync(path.join(f.dir,'input-files',f.args.input_id),' ');
      if(kind==='grant')f.m.policy.files.registry.pointers=['/profiles','/machineIds'];
      await assert.rejects(f.flow.configure(f.args));assert.deepEqual(json(f.file),f.original);assert.equal(f.reloads,0);assert.equal(f.m.publicActions().length,0);
    }finally{await f.close();}
  }
});
test('strict profile input rejects duplicate keys, unsafe keys, invalid UTF8, depth and oversized members',()=>{
  for(const text of ['{"x":1,"x":2}','{"x":{"revision":1,"revision":2}}','{"__proto__":{}}','{"x":{"constructor":{}}}','[1]','null','{"x":NaN}','{"x":1,}'])assert.throws(()=>parseProfileInput(Buffer.from(text)));
  assert.throws(()=>parseProfileInput(Buffer.from([0xff])),/UTF8/);
  assert.throws(()=>parseProfileInput(Buffer.from('['.repeat(66)+'0'+']'.repeat(66))),/TOO_DEEP/);
  assert.throws(()=>parseProfileInput(Buffer.alloc(65537)),/TOO_LARGE/);
  assert.equal(definitionSha({b:2,a:1}),definitionSha({a:1,b:2}));
});
test('real pinned Pi configures a staged update with bounded ID/hash arguments and closes in three requests',async()=>{
  const f=await fixture({large:true});let model;
  try{
    model=await modelFixture({handler:(_d,n)=>[
      {tool:'read_local_file',args:{file:'registry',length:1}},
      {tool:'configure_server_profiles',args:f.args},
      {tool:'submit_summary',args:{summary:'附件指定的 v2 入口已加载；未执行 NPU。',metrics:{entry_loaded:true}}}
    ][n-1]||{content:'done'}});
    save(path.join(f.dir,'spec.json'),{...f.spec,model:{api:'openai-completions',baseUrl:model.url,id:'fixture',compat:{supportsDeveloperRole:false}},timeoutSeconds:30,maxTurns:3});
    const child=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',f.dir],{input:JSON.stringify({apiKey:'LOCAL_FIXTURE_KEY'})});assert.equal(child.code,0,child.err);
    const r=read(path.join(f.dir,'result.json'));assert.equal(r.outcome,'succeeded',JSON.stringify(r));assert.equal(r.agent.stop_reason,'GOAL_VERIFIED');assert.equal(model.requests,3);assert.equal(f.reloads,1);
    const zip=unzipSync(fs.readFileSync(path.join(f.dir,'result.zip')));assert.ok(zip['model-timing.json']);assert.equal(JSON.parse(Buffer.from(zip['profile-workflows.json']))[0].requested[0].revision,'v2');
    assert.ok(!read(path.join(f.dir,'worker.json')).events.some(e=>e.type==='model_attempt_failed'));
    assert.ok(Buffer.byteLength(JSON.stringify(f.args))<400,'model does not regenerate the registry');
  }finally{if(model)await model.close();await f.close();}
});
