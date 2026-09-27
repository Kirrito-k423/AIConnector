import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {ROOT,save,read,run,sha} from '../../service/common.mjs';
import {Maintenance} from '../../service/maintenance.mjs';
import {Inputs} from '../../service/inputs.mjs';
import {agentConfig,snapshotAgent} from '../../service/agent-config.mjs';
import {capabilities,preflight,checkRequirements} from '../../service/capabilities.mjs';
import {modelFixture} from './model_fixture.mjs';
import {prepareUpgrade,applyUpgrade} from '../../service/upgrade.mjs';

const temp=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'AIC maintenance 中文 ')));
function fixture(dir){
  const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify({port:1,unrelated:'preserve'}));
  const profile={kind:'maintenance',entry:'maintain',repository:'aiconnector-maintenance',revision:'maintenance-v1',outputs:[],maintenance:{enabled:true,files:{config:{path:file,format:'json',write:true,pointers:['/port']}},commands:{validate:{argv:[process.execPath,'-e',`const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[1]));process.exit(v.port===8766?0:2)`,file],readOnly:true}}},verification:[{id:'port',kind:'local-json',file:'config',pointer:'/port',equals:8766},{id:'validate',kind:'command',command:'validate',equals:0}]};
  return {key:'repair/1/run-1',profile,task:{requirements:{mode:'maintenance',tools:['patch_local_json'],checks:['port','validate']},code:{repository:profile.repository,revision:profile.revision},environment:{target:'maintenance'},invocation:{entry:'maintain',arguments:[]},artifacts:[]},agent:snapshotAgent(agentConfig({}),dir),timeoutSeconds:30,maxTurns:20};
}
test('maintenance grants enforce pointer, hash, backup, replay and rollback across restart',async()=>{
 const dir=temp();try{
  const spec=fixture(dir),m=new Maintenance(spec,dir),first=m.readFile('config');
  await assert.rejects(m.writeFile('bad','config',first.sha256,undefined,[{pointer:'/unrelated',value:'overwrite'}]),/JSON_POINTER_NOT_AUTHORIZED/);
  const result=await m.writeFile('patch-1','config',first.sha256,undefined,[{pointer:'/port',value:8766}]);
  const restarted=new Maintenance(spec,dir);assert.deepEqual(await restarted.writeFile('patch-1','config',first.sha256,undefined,[{pointer:'/port',value:8766}]),result);
  assert.equal(JSON.parse(fs.readFileSync(spec.profile.maintenance.files.config.path)).unrelated,'preserve');
  await assert.rejects(restarted.writeFile('patch-1','config',first.sha256,undefined,[{pointer:'/port',value:2}]),/ACTION_ID_CONFLICT/);
  await restarted.restore('rollback','patch-1');assert.equal(m.readFile('config').sha256,first.sha256);
  restarted.actions['ambiguous']={state:'intent',digest:sha(JSON.stringify({kind:'command',request:{id:'validate'}}))};restarted.persist();
  await assert.rejects(new Maintenance(spec,dir).command('ambiguous','validate'),/ACTION_UNKNOWN/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('capability discovery chooses a unique matching profile and refuses smoke, stale and missing skill tools',()=>{
 const dir=temp();try{
  const spec=fixture(dir),c={node:'windows-inner',connector:{namespace:'test'},runner:{enabled:true,model:{id:'fixture'},agent:spec.agent,profiles:{maintenance:spec.profile,'local-smoke':{kind:'builtin-smoke',entry:'smoke',repository:'aiconnector-builtin'}}}};
  const remote=capabilities(c,{apiKey:'private'},spec.agent),task=structuredClone(spec.task);task.environment.target='auto';task.invocation.entry='auto';
  assert.equal(preflight(task,remote).profile.id,'maintenance');assert.ok(!JSON.stringify(remote).includes(dir));assert.ok(!JSON.stringify(remote).includes('private'));
  const missing=structuredClone(task);missing.environment.target='no-such-profile';
  try{preflight(missing,remote);assert.fail('must reject missing entry');}catch(e){assert.equal(e.message,'RECEIVER_PROFILE_NOT_FOUND_OR_AMBIGUOUS');assert.equal(e.diagnostic.requested.mode,'maintenance');assert.ok(e.diagnostic.available.some(p=>p.id==='local-smoke'));assert.match(e.diagnostic.next,/维护入口/);}
  task.environment.target='local-smoke';assert.throws(()=>preflight(task,remote),/CAPABILITY_MISMATCH/);
  assert.throws(()=>preflight(spec.task,{...remote,generated_at:'2020-01-01T00:00:00Z'}),/STALE/);
  assert.throws(()=>checkRequirements(spec.task,spec.profile,{skills:[{requiredTools:['unavailable_tool']}]}),/SKILL_TOOL_MISSING/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('input ZIP states distinguish staged, exposed and read; unsafe paths and links are rejected',()=>{
 const dir=temp();try{
  fs.mkdirSync(path.join(dir,'inputs'));const bytes=zipSync({'source/data.txt':strToU8('INPUT_MARKER')});fs.writeFileSync(path.join(dir,'inputs','source.zip'),bytes);
  const a={name:'source.zip',bytes:bytes.length,sha256:sha(bytes)},inputs=new Inputs(dir,[a]);
  assert.equal(inputs.state.files[0].exposed_to_model,false);const id=inputs.list().files[0].id;assert.equal(inputs.state.files[0].read_by_agent,false);
  assert.equal(inputs.read(id).content,'INPUT_MARKER');assert.equal(inputs.state.files[0].uploaded_to_server,false);assert.equal(inputs.state.files[0].read_by_agent,true);
  const bad=temp();try{fs.mkdirSync(path.join(bad,'inputs'));const b=zipSync({'../escape.txt':strToU8('no')});fs.writeFileSync(path.join(bad,'inputs','bad.zip'),b);assert.throws(()=>new Inputs(bad,[{name:'bad.zip',bytes:b.length,sha256:sha(b)}]),/UNSAFE_INPUT_PATH/);}finally{fs.rmSync(bad,{recursive:true,force:true});}
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

for(const claimsOnly of [false,true])test(`real Pi ${claimsOnly?'cannot declare success without repair':'continues after premature summary, repairs, reads Skill/input and verifies API'}`,async()=>{
 const dir=temp(),spec=fixture(dir);let httpCalls=0;
 const server=http.createServer((req,res)=>{httpCalls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:JSON.parse(fs.readFileSync(path.join(dir,'config.json'))).port===8766}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 spec.profile.maintenance.apis={health:{baseUrl:`http://127.0.0.1:${server.address().port}`,route:'/api/health',readOnly:true}};
 spec.profile.verification.push({id:'health',kind:'local-api',api:'health',pointer:'/ok',equals:true});
 fs.mkdirSync(path.join(dir,'skill'));fs.writeFileSync(path.join(dir,'skill/SKILL.md'),'SKILL_ACTUALLY_LOADED');fs.writeFileSync(path.join(dir,'skill/reference.md'),'REFERENCE_ACTUALLY_LOADED');
 spec.agent=snapshotAgent(agentConfig({skills:[{path:'skill/SKILL.md',references:['reference.md'],requiredTools:['patch_local_json']}]}),dir);
 fs.mkdirSync(path.join(dir,'inputs'));const input=zipSync({'input.txt':strToU8('REAL_INPUT')});fs.writeFileSync(path.join(dir,'inputs','input.zip'),input);spec.task.artifacts=[{name:'input.zip',bytes:input.length,sha256:sha(input)}];
 const original=sha(fs.readFileSync(path.join(dir,'config.json'))),inputId=sha(sha(input)+'/input.txt').slice(0,32);
 const model=await modelFixture({delay:20,handler:(_data,n)=>({...(
  claimsOnly?[{tool:'submit_summary',args:{summary:'声称已完成但没有修改配置',metrics:{repair_completed:true}}},{content:'done'}][Math.min(n-1,1)]:[
   {tool:'submit_summary',args:{summary:'首次检查发现端口不正确，尚未修复。',metrics:{repair_completed:false}}},
   {content:'首次总结结束'},
   {tool:'read_input',args:{id:inputId}},
   {tool:'read_local_file',args:{file:'config'}},
   {tool:'patch_local_json',args:{action_id:'fix-port',file:'config',expected_sha256:original,changes:[{pointer:'/port',value:8766}]}},
   {tool:'verify_task'},
   {tool:'submit_summary',args:{summary:'已备份修复端口，独立配置和 API 校验通过。',metrics:{repair_completed:true}}},
   {content:'done'}
  ][Math.min(n-1,7)]),usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})});
 try{
  spec.model={api:'openai-completions',baseUrl:model.url,id:'fixture',compat:{supportsDeveloperRole:false}};save(path.join(dir,'spec.json'),spec);
  const p=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',dir],{input:JSON.stringify({apiKey:'PRIVATE_KEY'})});assert.equal(p.code,0,p.err);
  const result=read(path.join(dir,'result.json'));assert.equal(result.outcome,claimsOnly?'blocked':'succeeded',JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(dir,'execution-intent.json')),false);assert.ok(result.agent.continuations>=1);assert.equal(result.agent.usage.totalTokens,model.requests*120);
  assert.ok(result.agent.duration_ms>=model.requests*20);assert.ok(!result.agent.tools.includes('run_experiment'));assert.equal(result.agent.skills.length,1);
  assert.match(JSON.stringify(model.calls[0]),/SKILL_ACTUALLY_LOADED/);assert.match(JSON.stringify(model.calls[0]),/REFERENCE_ACTUALLY_LOADED/);
  assert.match(JSON.stringify(model.calls[0]),/acceptance_contract/);assert.match(JSON.stringify(model.calls[0]),/8766/,'Pi must see the expected repair value, not only an opaque check ID');
  const zip=unzipSync(fs.readFileSync(path.join(dir,'result.zip')));assert.ok(zip['actions.json']);assert.ok(zip['acceptance.json']);assert.ok(!Object.values(zip).some(b=>Buffer.from(b).includes(dir)));assert.ok(!zip['config.json']);
  if(!claimsOnly){assert.ok(fs.existsSync(path.join(dir,'backups/fix-port.bin')));assert.ok(httpCalls>=2);assert.equal(result.acceptance.status,'passed');assert.ok(read(path.join(dir,'input-state.json')).files[0].read_by_agent);}
 }finally{await model.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('real Pi rejects missing maintenance capability before model or smoke execution',async()=>{
 const dir=temp(),spec=fixture(dir),model=await modelFixture();try{
  spec.profile={kind:'builtin-smoke'};spec.model={api:'openai-completions',baseUrl:model.url,id:'fixture'};save(path.join(dir,'spec.json'),spec);
  await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',dir],{input:JSON.stringify({apiKey:'PRIVATE_KEY'})});
  const r=read(path.join(dir,'result.json'));assert.equal(r.outcome,'blocked');assert.equal(r.agent.stop_reason,'CAPABILITY_MODE_MISMATCH');assert.equal(model.requests,0);assert.deepEqual(r.agent.tools,[]);
 }finally{await model.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('upgrade preserves identity, model, vault and profiles while backing up and activating explicit local grants',()=>{
 const dir=temp();try{
  const spec=fixture(dir),connector=path.join(dir,'connector.json'),file=path.join(dir,'service.local.json'),policy=path.join(dir,'policy.local.json');
  fs.writeFileSync(connector,JSON.stringify({poll_seconds:60,token_env:'TEST_ONLY',repository:'test/relay'}));
  const original={schema:'aiconnector.service.v1',node:'windows-inner',port:43111,connectorConfig:connector,dataDir:path.join(dir,'data'),runner:{enabled:true,model:{api:'openai-completions',baseUrl:'http://127.0.0.1:18181/v1',id:'retained',compat:{supportsDeveloperRole:false}},profiles:{'local-smoke':{kind:'builtin-smoke',entry:'smoke',repository:'aiconnector-builtin'}}}};
  fs.writeFileSync(file,JSON.stringify(original));fs.writeFileSync(policy,JSON.stringify({profileId:'maintenance',profile:spec.profile}));
  fs.mkdirSync(original.dataDir);fs.writeFileSync(path.join(original.dataDir,'credentials.dpapi'),'OPAQUE_VAULT');
  const plan=prepareUpgrade(file,policy);assert.deepEqual(JSON.parse(fs.readFileSync(file)),original,'dry-run must not write');
  const backup=applyUpgrade(plan),updated=JSON.parse(fs.readFileSync(file));assert.deepEqual(JSON.parse(fs.readFileSync(backup)),original);
  assert.deepEqual(updated.runner.model,original.runner.model);assert.deepEqual(updated.runner.profiles['local-smoke'],original.runner.profiles['local-smoke']);assert.equal(updated.dataDir,original.dataDir);assert.equal(updated.node,original.node);
  assert.equal(fs.readFileSync(path.join(original.dataDir,'credentials.dpapi'),'utf8'),'OPAQUE_VAULT');assert.equal(updated.runner.profiles.maintenance.kind,'maintenance');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
