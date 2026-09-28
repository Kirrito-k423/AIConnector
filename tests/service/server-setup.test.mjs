import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateRegistry} from '../../service/server-registry.mjs';
import {probeProfile} from '../../service/server-setup.mjs';

test('server registry only grants fixed commands on the locally selected machines',()=>{
  const value={schema:'aiconnector.server-registry.v1',machineIds:['actual-id'],profiles:{probe:probeProfile('actual-id')}};
  assert.doesNotThrow(()=>validateRegistry(value));
  for(const patch of [{machineId:'other'},{kind:'command',argv:['powershell.exe']},{allowAnyMachine:true},{group:'A5'},{mode:'maintenance'},{shell:'x'.repeat(4096)}]){
    assert.throws(()=>validateRegistry({...value,profiles:{probe:{...value.profiles.probe,...patch}}}));
  }
  assert.throws(()=>validateRegistry({...value,profiles:{probe:{...value.profiles.probe,verification:[]}}}));
});

import http from 'node:http';
import {start} from '../../service/server.mjs';
import {agentConfig,snapshotAgent} from '../../service/agent-config.mjs';
import {loadConfig,read,save,run,ROOT,sha} from '../../service/common.mjs';
import {watchFixture} from './watch_fixture.mjs';
import {modelFixture} from './model_fixture.mjs';
import {Maintenance} from '../../service/maintenance.mjs';
import {WatchExecution} from '../../service/watch.mjs';
import {verifyTask} from '../../service/verification.mjs';

test('one local setup enables probe and scoped maintenance; real Pi registers and reloads a server experiment',async()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'AIC servers 中文 '))),watch=await watchFixture();let service,model;
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const config=path.join(dir,'service.local.json'),connector=path.join(dir,'connector.json');
  fs.writeFileSync(connector,JSON.stringify({poll_seconds:60,token_env:'UNSET_FIXTURE_TOKEN',repository:'fixture/relay'}));
  const disk={schema:'aiconnector.service.v1',node:'windows-inner',port,dataDir:path.join(dir,'state'),connectorConfig:connector,powershell:'nonexistent-fixture-pwsh',runner:{enabled:false,profiles:{'local-smoke':{kind:'builtin-smoke',entry:'smoke',repository:'aiconnector-builtin'}},agent:agentConfig({globalPrompt:'KEEP_GLOBAL_CONTEXT',simpleHtmlWatch:{enabled:true,baseUrl:watch.url}}),model:{api:'openai-completions',baseUrl:'http://127.0.0.1:19999/v1',id:'keep-model'}}};
  fs.writeFileSync(config,JSON.stringify(disk));
  try{
    service=await start(config,{secrets:{apiKey:'PRIVATE_MODEL_KEY'}});
    const call=async(route,data)=>{const r=await fetch(service.url+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,value:await r.json()};};
    const catalog=(await call('/api/server-catalog')).value;assert.equal(catalog.machines[0].id,'fixture-machine');assert.equal(watch.posts,0);
    let response=await call('/api/server-setup',{config_sha256:catalog.config_sha256,machineIds:['guess-A5'],allowMaintenance:true});assert.equal(response.status,400);
    response=await call('/api/server-setup',{config_sha256:catalog.config_sha256,machineIds:['fixture-machine'],allowMaintenance:true});assert.equal(response.status,200,JSON.stringify(response));
    assert.equal(response.value.saved,true);assert.deepEqual(response.value.publication,{state:'pending',background:true});
    assert.equal(watch.posts,0);assert.equal(service.status().capabilities.local.profiles.some(p=>p.mode==='probe'),true);
    assert.equal(service.status().capabilities.local.profiles.some(p=>p.mode==='maintenance'),true);
    const saved=JSON.parse(fs.readFileSync(config));assert.deepEqual(saved.runner.model,disk.runner.model);assert.equal(saved.runner.agent.globalPrompt,'KEEP_GLOBAL_CONTEXT');assert.ok(saved.runner.profiles['local-smoke']);assert.ok(!fs.readFileSync(config,'utf8').includes('PRIVATE_'));
    assert.equal((await call('/api/server-readiness')).value.experiment_entry_configured,false);
    response=await call('/api/server-setup',{config_sha256:catalog.config_sha256,machineIds:['fixture-machine'],allowMaintenance:true});assert.equal(response.value.error,'SERVER_SETUP_CHANGED');
    const c=loadConfig(config),profile=c.runner.profiles['server-maintenance'],registryFile=c.runner.serverRegistry;
    const registry=JSON.parse(fs.readFileSync(registryFile)),experiment={kind:'simplehtmlwatch',mode:'experiment',machineId:'fixture-machine',entry:'fixture-experiment',repository:'fixture',revision:'fixture-rev',revisionCommand:'printf fixture-rev',shell:'printf fixture',outputs:['metrics.json'],verification:[{id:'fixture-output',kind:'output-json',file:'metrics.json',pointer:'/fixture',equals:true}]};
    const work=path.join(dir,'maintenance');fs.mkdirSync(work);let step=0;
    model=await modelFixture({handler:()=>[
      {tool:'read_local_file',args:{file:'server-registry'}},
      {tool:'patch_local_json',args:{action_id:'register-experiment',file:'server-registry',expected_sha256:sha(fs.readFileSync(registryFile)),changes:[{pointer:'/profiles',value:{...registry.profiles,experiment}}]}},
      {tool:'call_local_api',args:{action_id:'reload',api:'reload'}},
      {tool:'submit_summary',args:{summary:'Registered fixture server entry; no claim of hardware execution.',metrics:{entry_configured:true}}},
      {content:'done'}][step++]||{content:'done'}});
    const spec={key:'setup/1/maintenance',profile,agent:snapshotAgent(c.runner.agent,dir),task:{requirements:{mode:'maintenance',checks:['experiment-entry-configured']},code:{repository:profile.repository,revision:profile.revision},environment:{target:'server-maintenance'},invocation:{entry:profile.entry,arguments:[]},artifacts:[]},model:{api:'openai-completions',baseUrl:model.url,id:'fixture',compat:{supportsDeveloperRole:false}},timeoutSeconds:30,maxTurns:10};
    // Attempts to widen machines or introduce local command execution fail before writing.
    const maint=new Maintenance(spec,work);const before=fs.readFileSync(registryFile);
    await assert.rejects(maint.writeFile('bad-machine','server-registry',sha(before),undefined,[{pointer:'/machineIds',value:['other']}]),/JSON_POINTER_NOT_AUTHORIZED/);
    await assert.rejects(maint.writeFile('bad-command','server-registry',sha(before),undefined,[{pointer:'/profiles',value:{bad:{kind:'command',argv:['powershell.exe']}}}]),/SERVER_PROFILE_SCOPE/);
    assert.deepEqual(fs.readFileSync(registryFile),before);
    save(path.join(work,'spec.json'),spec);
    const child=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',work],{input:JSON.stringify({apiKey:'FIXTURE_API_KEY'})});assert.equal(child.code,0,child.err);
    const result=read(path.join(work,'result.json'));assert.equal(result.outcome,'succeeded',JSON.stringify(result));assert.equal(result.agent.stop_reason,'GOAL_VERIFIED');
    assert.equal((await call('/api/server-readiness')).value.experiment_entry_configured,true);assert.equal(watch.posts,0);
    assert.ok(service.status().capabilities.local.profiles.some(p=>p.id==='experiment'&&p.mode==='experiment'));
    const nextDir=path.join(dir,'experiment');fs.mkdirSync(path.join(nextDir,'work'),{recursive:true});
    const next={...spec,key:'setup/1/experiment',profile:experiment,task:{...spec.task,requirements:{mode:'experiment',checks:['fixture-output']},code:{repository:'fixture',revision:'fixture-rev'}}};
    const ex=await new WatchExecution(next,nextDir).run();assert.equal(ex.server_task.selectedMachineId,'fixture-machine');assert.equal(watch.posts,1);
    assert.equal((await verifyTask(next,nextDir,{execution:ex})).status,'passed');
    // Restart rehydrates the separate registry; the main config is not polluted with merged entries.
    assert.ok(!JSON.parse(fs.readFileSync(config)).runner.profiles.experiment);await service.close();service=await start(config,{secrets:{apiKey:'PRIVATE_MODEL_KEY'}});
    assert.ok(service.config.runner.profiles.experiment);assert.equal(service.config.runner.model.id,'keep-model');
  }finally{if(service)await service.close();if(model)await model.close();await watch.close();fs.rmSync(dir,{recursive:true,force:true});}
});
