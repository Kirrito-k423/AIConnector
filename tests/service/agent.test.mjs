import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {unzipSync} from 'fflate';
import {agentConfig,snapshotAgent} from '../../service/agent-config.mjs';
import {save,read,run,ROOT} from '../../service/common.mjs';
import {WatchExecution,WatchClient,archiveFiles} from '../../service/watch.mjs';
import {webTools} from '../../service/web-tools.mjs';
import {watchFixture,tarBundle} from './watch_fixture.mjs';
import {modelFixture} from './model_fixture.mjs';
import {start} from '../../service/server.mjs';

const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'AIC agent 中文 '));
const profile={kind:'simplehtmlwatch',entry:'experiment',repository:'fixture',machineId:'fixture-machine',revisionCommand:'printf fixture-rev',shell:'printf "fixture" > "$SHW_RESULTS_DIR/metrics.json"',outputs:['metrics.json']};
function watchSpec(url,dir){return {key:'watch/1/test',task:{code:{repository:'fixture',revision:'fixture-rev'},environment:{target:'fixture'},invocation:{entry:'experiment',arguments:[]},artifacts:[]},profile,agent:snapshotAgent(agentConfig({simpleHtmlWatch:{enabled:true,baseUrl:url,pollSeconds:1}}),dir)};}

test('prompt files freeze per task; invalid compaction budget and implicit wildcard access are rejected',()=>{
  const dir=temp();try{
    fs.writeFileSync(path.join(dir,'AGENTS.md'),'first snapshot');const a=snapshotAgent(agentConfig({globalPrompt:'GLOBAL_MARKER',contextFiles:['AGENTS.md']}),dir);
    fs.writeFileSync(path.join(dir,'AGENTS.md'),'changed');assert.equal(a.contexts[0].content,'first snapshot');
    assert.throws(()=>agentConfig({compaction:{reserveTokens:30000,keepRecentTokens:8192}}),/INVALID_COMPACTION_BUDGET/);
    assert.throws(()=>agentConfig({web:{enabled:true,allowedHosts:['*']}}),/INVALID_WEB_HOSTS/);
    assert.throws(()=>agentConfig({simpleHtmlWatch:{baseUrl:'http://remote.example:8765'}}),/INVALID_WATCH_URL/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('SHW lost POST response survives adapter restart without duplicate launch; token rotation and bounded collection',async()=>{
  const fixture=await watchFixture({losePost:true}),dir=temp();fs.mkdirSync(path.join(dir,'work'));
  try{
    const spec=watchSpec(fixture.url,dir),first=new WatchExecution(spec,dir);
    await assert.rejects(first.submit());assert.equal(fixture.posts,1);assert.ok(read(path.join(dir,'watch-task.json')).id);
    const recovered=new WatchExecution(spec,dir);await recovered.submit();fixture.rotate();const result=await recovered.collect();
    assert.equal(result.actual_revision,'fixture-rev');assert.equal(result.exit_code,0);assert.equal(fixture.posts,1);
    assert.ok(fs.existsSync(path.join(dir,'work/metrics.json')));assert.ok(!fs.existsSync(path.join(dir,'work/not-exported.txt')));
    const environment=await new WatchClient({baseUrl:fixture.url}).environment();assert.ok(environment.observed_at);assert.equal(environment.ready_is_not_npu_idle,true);
  }finally{await fixture.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('SHW actual revision mismatch is blocked; unsafe archive paths and symlinks are rejected',async()=>{
  const fixture=await watchFixture({revision:'different',exitCode:86,status:'failed'}),dir=temp();fs.mkdirSync(path.join(dir,'work'));
  try{const w=new WatchExecution(watchSpec(fixture.url,dir),dir);const execution=await w.run();assert.equal(execution.outcome,'blocked');assert.equal(execution.actual_revision,'different');assert.equal(execution.revision_mismatch,true);
    assert.throws(()=>archiveFiles(tarBundle({'../outside':'bad'})),/UNSAFE_TAR_PATH/);
    assert.throws(()=>archiveFiles(tarBundle({'results/link':'bad'},'2')),/UNSUPPORTED_TAR_ENTRY/);
  }finally{await fixture.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('SHW unknown task remains query-only across repeated calls',async()=>{
  const fixture=await watchFixture({status:'unknown'}),dir=temp();
  try{const w=new WatchExecution(watchSpec(fixture.url,dir),dir);await assert.rejects(w.run(),/WATCH_EXECUTION_UNKNOWN/);await assert.rejects(w.run(),/WATCH_EXECUTION_UNKNOWN/);assert.equal(fixture.posts,1);}
  finally{await fixture.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('SHW reconciliation rejects a task ID whose remote command changed',async()=>{
  const fixture=await watchFixture({losePost:true}),dir=temp();
  try{const w=new WatchExecution(watchSpec(fixture.url,dir),dir);await assert.rejects(w.submit());fixture.tamper({shell:'different command'});await assert.rejects(new WatchExecution(watchSpec(fixture.url,dir),dir).submit(),/WATCH_TASK_CONTENT_MISMATCH/);assert.equal(fixture.posts,1);assert.ok(!read(path.join(dir,'execution.json')));}
  finally{await fixture.close();fs.rmSync(dir,{recursive:true,force:true});}
});

for(const transport of ['node','curl'])test(`web ${transport}: fetch/search, exact redirect grants, size limit and no credential inheritance`,async()=>{
  const requests=[];const server=http.createServer((req,res)=>{requests.push(req);if(req.url==='/redirect'){res.writeHead(302,{Location:'http://localhost:'+server.address().port+'/private'});res.end();return;}res.writeHead(200,{'Content-Type':'text/html'});res.end(req.url==='/big'?'x'.repeat(600000):'<p>公开资料 中文</p><script>UNTRUSTED_SCRIPT</script>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const config=agentConfig({web:{enabled:true,transport,proxy:'direct',allowedHosts:[new URL(base).host],searchUrl:base+'/search?q={query}'}}).web;
    const tools=webTools(config);let out=JSON.parse((await tools[0].execute('',{url:base})).content[0].text);assert.match(out.text,/公开资料 中文/);assert.ok(!out.text.includes('UNTRUSTED_SCRIPT'));
    await tools[1].execute('',{query:'NPU & 中文'});assert.ok(requests[1].url.includes('NPU%20%26%20'));
    await assert.rejects(tools[0].execute('',{url:base+'/redirect'}),/WEB_HOST_NOT_ALLOWED/);
    await assert.rejects(tools[0].execute('',{url:base+'/big'}),/HTTP_RESPONSE_TOO_LARGE/);
    assert.ok(requests.every(r=>!r.headers.authorization&&!r.headers['x-watch-token']));assert.ok(requests.every(r=>r.url!=='/private'));
  }finally{await new Promise(r=>server.close(r));}
});

test('real Pi loads frozen context, compacts automatically and restores durable facts without repeating CPU execution',async()=>{
  let main=0,summaries=0;
  const model=await modelFixture({handler:data=>{
    if(!data.tools?.length){summaries++;return {content:'Checkpoint: the CPU experiment already completed. Call get_run_state to recover durable evidence before submitting a summary.'};}
    main++;return [
      {tool:'run_experiment',content:'Fixture planning context. '.repeat(1400)},
      {tool:'get_run_state'},
      {tool:'run_experiment'},
      {tool:'submit_summary',args:{summary:'CPU evidence recovered after automatic compaction.',metrics:{fixture_model:true}}},
      {content:'done'}
    ][main-1]||{content:'done'};
  }}),dir=temp();
  try {
    fs.writeFileSync(path.join(dir,'context.md'),'FROZEN_FILE_CONTEXT');
    const limits={contextWindow:8192,maxTokens:1024};
    const agent=snapshotAgent(agentConfig({globalPrompt:'GLOBAL_LOCAL_CONTEXT',contextFiles:['context.md'],compaction:{keepRecentTokens:512}},limits),dir);
    fs.writeFileSync(path.join(dir,'context.md'),'SHOULD_NOT_BE_LOADED');
    save(path.join(dir,'spec.json'),{key:'compact/1/test',task:{code:{repository:'aiconnector-builtin',revision:'builtin-smoke-v1'},environment:{target:'local-smoke'},invocation:{entry:'smoke',arguments:[]},artifacts:[]},profile:{kind:'builtin-smoke',outputs:['metrics.json']},agent,model:{api:'openai-completions',baseUrl:model.url,id:'fixture',...limits,compat:{supportsDeveloperRole:false}},timeoutSeconds:30,maxTurns:10});
    const p=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',dir],{input:JSON.stringify({apiKey:'LOCAL_FIXTURE_KEY'})});assert.equal(p.code,0,p.err);
    const worker=read(path.join(dir,'worker.json')),result=read(path.join(dir,'result.json'));
    assert.equal(result.outcome,'succeeded',JSON.stringify(worker));assert.ok(summaries>=1,JSON.stringify({worker,calls:model.calls.map(c=>({tools:c.tools?.length,messages:c.messages.length}))}));assert.ok(worker.compaction.count>=1);
    assert.equal(worker.events.filter(e=>e.type==='execution_started').length,1);
    assert.match(JSON.stringify(model.calls[0]),/GLOBAL_LOCAL_CONTEXT/);assert.match(JSON.stringify(model.calls[0]),/FROZEN_FILE_CONTEXT/);assert.doesNotMatch(JSON.stringify(model.calls),/SHOULD_NOT_BE_LOADED/);
    const zip=unzipSync(fs.readFileSync(path.join(dir,'result.zip')));assert.ok(zip['metrics.json']);assert.ok(!Object.values(zip).some(v=>Buffer.from(v).includes('GLOBAL_LOCAL_CONTEXT')));
  }finally{await model.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('real Pi uses SHW tools and exports only approved remote files through result ZIP',async()=>{
  const fixture=await watchFixture(),dir=temp();let step=0;
  const model=await modelFixture({handler:()=>[{tool:'server_status'},{tool:'submit_server_task'},{tool:'server_task_logs'},{tool:'server_task_status'},{tool:'collect_server_result'},{tool:'submit_summary',args:{summary:'Controlled SHW fixture completed.',metrics:{fixture:true}}},{content:'done'}][step++]||{content:'done'}});
  try{
    save(path.join(dir,'spec.json'),{...watchSpec(fixture.url,dir),model:{api:'openai-completions',baseUrl:model.url,id:'fixture',compat:{supportsDeveloperRole:false}},timeoutSeconds:30,maxTurns:10});
    const p=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',dir],{input:JSON.stringify({apiKey:'LOCAL_FIXTURE_KEY'})});assert.equal(p.code,0,p.err);
    const result=read(path.join(dir,'result.json'));assert.equal(result.outcome,'succeeded',JSON.stringify(result));assert.equal(fixture.posts,1);
    const zip=unzipSync(fs.readFileSync(path.join(dir,'result.zip')));assert.ok(zip['metrics.json']);assert.ok(!zip['not-exported.txt']);assert.equal(result.actual_revision,'fixture-rev');
  }finally{await fixture.close();await model.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('dashboard saves agent settings without replacing the configured model gateway, compat, profiles or secrets',async()=>{
  const dir=temp(),fixture=await watchFixture();let service;
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  try {
    const connector=path.join(dir,'connector.json'),file=path.join(dir,'service.local.json');
    fs.writeFileSync(connector,JSON.stringify({poll_seconds:60,token_env:'AIC_TEST_MISSING_TOKEN',repository:'fixture/relay'}));
    fs.writeFileSync(file,JSON.stringify({schema:'aiconnector.service.v1',node:'windows-inner',port,dataDir:path.join(dir,'state'),connectorConfig:connector,powershell:'nonexistent-fixture-pwsh',runner:{enabled:false,model:{api:'openai-completions',baseUrl:'http://127.0.0.1:18181/v1',id:'existing-model',compat:{supportsDeveloperRole:false}},profiles:{'local-smoke':{kind:'builtin-smoke',entry:'smoke',repository:'aiconnector-builtin'}}}}));
    service=await start(file,{secrets:{apiKey:'PRIVATE_MODEL_KEY',githubToken:'PRIVATE_GITHUB_KEY'}});
    const headers={Authorization:'Bearer '+service.token,'Content-Type':'application/json'};
    const agent=agentConfig({globalPrompt:'configured in browser',simpleHtmlWatch:{enabled:true,baseUrl:fixture.url}});
    let r=await fetch(service.url+'/api/agent-settings',{method:'POST',headers,body:JSON.stringify({agent,enabled:false,timeoutSeconds:1800,maxTurns:32,profiles:service.config.runner.profiles,modelLimits:{contextWindow:65536,maxTokens:4096}})});
    assert.equal(r.status,200,await r.text());const disk=JSON.parse(fs.readFileSync(file));
    assert.equal(disk.runner.model.baseUrl,'http://127.0.0.1:18181/v1');assert.equal(disk.runner.model.compat.supportsDeveloperRole,false);assert.equal(disk.runner.model.contextWindow,65536);
    assert.ok(!fs.readFileSync(file,'utf8').includes('PRIVATE_'));assert.equal(service.status().service.model_configured,true);
    r=await fetch(service.url+'/api/agent-check',{method:'POST',headers,body:'{}'});const check=await r.json();assert.equal(check.checks.simpleHtmlWatch.ok,true);assert.equal(check.checks.context.ok,true);assert.equal(fixture.posts,0);
    r=await fetch(service.url+'/api/agent-settings',{method:'POST',headers,body:JSON.stringify({agent:{...agent,compaction:{enabled:true,reserveTokens:60000,keepRecentTokens:20000}},enabled:false,timeoutSeconds:1800,maxTurns:32,profiles:disk.runner.profiles})});
    assert.equal(r.status,400);assert.equal(JSON.parse(fs.readFileSync(file)).runner.agent.globalPrompt,'configured in browser');
  }finally{if(service)await service.close();await fixture.close();fs.rmSync(dir,{recursive:true,force:true});}
});
