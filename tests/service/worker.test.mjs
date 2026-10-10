import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {save,read,run,ROOT,sha} from '../../service/common.mjs';
import {modelFixture} from './model_fixture.mjs';
import {agentConfig,snapshotAgent} from '../../service/agent-config.mjs';

async function exercise(options={},edit=()=>{}){
 const fixture=await modelFixture(options),dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC worker 中文 '));
 const spec={key:'pi-smoke/1/run-1',task:{requirements:{mode:'smoke',checks:['cpu-smoke']},code:{repository:'aiconnector-builtin',revision:'builtin-smoke-v1'},environment:{target:'local-smoke'},invocation:{entry:'smoke',arguments:[]},artifacts:[]},profile:{kind:'builtin-smoke',outputs:['metrics.json']},model:{api:'openai-completions',baseUrl:fixture.url,id:'fixture',compat:{supportsDeveloperRole:false}},timeoutSeconds:20,maxTurns:12};
 edit(spec,dir);save(path.join(dir,'spec.json'),spec);
 try {
  const p=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',dir],{input:JSON.stringify({apiKey:'LOCAL_FIXTURE_KEY'})});
  assert.equal(p.code,0,p.err);const worker=read(path.join(dir,'worker.json'));const result=read(path.join(dir,'result.json'));
  const zip=unzipSync(fs.readFileSync(path.join(dir,'result.zip')));
  return {worker,result,zip,requests:fixture.requests,execution:read(path.join(dir,'execution.json'))};
 }finally{await fixture.close();fs.rmSync(dir,{recursive:true,force:true});}
}

test('real pinned Pi calls a real CPU experiment and returns verified ZIP',async()=>{
 const r=await exercise();assert.equal(r.worker.state,'ready');assert.equal(r.result.outcome,'succeeded');assert.equal(r.result.actual_revision,'builtin-smoke-v1');assert.equal(r.requests,2);
 assert.equal(JSON.parse(strFromU8(r.zip['metrics.json'])).sum,50005000);assert.equal(r.execution.exit_code,0);assert.match(strFromU8(r.zip['stdout.txt']),/50005000/);
});
test('model timing separates provider setup, headers, first output and stream completion without storing content',async()=>{
 const r=await exercise({delay:90,handler:(_d,n)=>({tool:n===1?'run_experiment':'submit_summary',args:n===1?{}:{summary:'timing fixture',metrics:{}},firstOutputDelay:120,endDelay:100})});
 assert.equal(r.result.outcome,'succeeded');
 const timing=JSON.parse(strFromU8(r.zip['model-timing.json']));assert.equal(r.requests,2);assert.equal(timing.dropped_events,0);
 const dispatched=timing.requests.filter(r=>r.request_ready_at!==null);assert.equal(dispatched.length,2,JSON.stringify(timing));
 for(const row of dispatched){assert.equal(row.state,'ended');assert.ok(row.headers_ms-row.ready_ms>=75,JSON.stringify(row));assert.ok(row.first_output_ms-row.headers_ms>=100,JSON.stringify(row));assert.ok(row.output_stream_ms>=80);assert.ok(row.duration_ms>=row.first_output_ms);assert.equal(row.sdk_usage,null);}
 assert.doesNotMatch(JSON.stringify(timing),/LOCAL_FIXTURE_KEY|timing fixture|127\.0\.0\.1/);
});
test('invalid model credential yields a blocked delivery without experiment',async()=>{const r=await exercise({fail:true});assert.equal(r.result.outcome,'blocked');assert.equal(r.execution,undefined);});
test('total Pi deadline retains a trace of the request with no first output',async()=>{
 const r=await exercise({hold:true},s=>s.timeoutSeconds=1);
 assert.equal(r.result.agent.stop_reason,'RUN_TIMEOUT');assert.equal(r.execution,undefined);
 const timing=JSON.parse(strFromU8(r.zip['model-timing.json']));assert.equal(timing.runner_stop_reason,'RUN_TIMEOUT');assert.ok(timing.requests.length>0);
 // Total budget includes preparation before a stream call; aborted bookkeeping
 // calls can be much shorter than that budget. The API sends no response.
 assert.ok(r.result.agent.duration_ms>=900,JSON.stringify(r.result.agent));
 assert.ok(timing.requests.every(r=>r.state==='ended'&&r.first_output_at===null&&r.duration_ms>=0),JSON.stringify(timing));
});
test('revision mismatch never executes',async()=>{const r=await exercise({},s=>s.task.code.revision='wrong');assert.equal(r.result.outcome,'blocked');assert.equal(r.execution,undefined);});
test('prior durable execution intent is never replayed',async()=>{const r=await exercise({},(s,dir)=>save(path.join(dir,'execution-intent.json'),{key:s.key}));assert.equal(r.result.outcome,'blocked');assert.equal(r.execution,undefined);});
test('model repeats run_experiment but actual experiment executes once',async()=>{const r=await exercise({repeat:true});assert.equal(r.result.outcome,'succeeded');assert.equal(r.worker.events.filter(e=>e.type==='execution_started').length,1);assert.equal(r.requests,3);});

test('exit zero with an explicitly incomplete user goal must not be a successful task',async()=>{
 const r=await exercise({handler:(_data,n)=>[
  {tool:'run_experiment'},
  {tool:'submit_summary',args:{summary:'维护未完成；没有修改配置或执行 SSH 探测。',metrics:{repair_completed:false,config_validated:false}}},
  {content:'当前没有维护工具。'}
 ][Math.min(n-1,2)]},s=>{s.task.objective='修复执行入口并完成配置校验';s.task.acceptance=['配置修复和校验通过'];});
 assert.notEqual(r.result.outcome,'succeeded','CPU 自检退出码 0 不能覆盖未完成的用户目标');
 assert.equal(r.execution.exit_code,0);
});

test('token budget stops tool execution and reports cumulative usage',async()=>{
 const r=await exercise({handler:()=>({tool:'run_experiment',usage:{prompt_tokens:1200,completion_tokens:20,total_tokens:1220}})},(s,d)=>s.agent=snapshotAgent(agentConfig({budget:{maxTotalTokens:1024}}),d));
 assert.equal(r.result.outcome,'blocked');assert.equal(r.result.agent.stop_reason,'MODEL_USAGE_BUDGET');assert.ok(r.result.agent.usage.totalTokens>=1220);assert.equal(r.execution,undefined);
});

test('missing capability can report blocked without executing an unrelated CPU smoke',async()=>{
 const r=await exercise({handler:(_d,n)=>n===1?{tool:'submit_summary',args:{summary:'当前入口没有用户所需的 SSH 修复工具。',metrics:{repair_completed:false}}}:{content:'无法执行维护'}});
 assert.equal(r.result.outcome,'blocked');assert.equal(r.execution,undefined);assert.equal(r.result.agent.stop_reason,'NO_PROGRESS');
});

test('model timing and premature receipt claims cannot become authoritative result facts',async()=>{
 const r=await exercise({handler:(_d,n)=>[
   {tool:'run_experiment'},
   {tool:'submit_summary',args:{summary:'Pi 耗时 15000ms、4 轮，receipt 已校验。',metrics:{duration_ms:15000,turns:4,stop_reason:'completed',session_end:'2026-09-27T11:25:50.600Z',receipt_verified:true,input_marker:'retained',npu:true}}},
   {content:'已完成'}
 ][Math.min(n-1,2)]});
 assert.equal(r.result.outcome,'succeeded');
 for(const key of ['duration_ms','turns','stop_reason','session_end','receipt_verified'])assert.equal(r.result.metrics[key],undefined,key);
 assert.equal(r.result.metrics.input_marker,'retained');assert.equal(r.result.metrics.npu,false);
 assert.doesNotMatch(r.result.summary,/15000|receipt 已校验/);
 assert.match(r.result.summary,/GOAL_VERIFIED/);
 assert.equal(r.result.model_report.verified,false);
 assert.match(JSON.parse(strFromU8(r.zip['report.json'])).summary,/receipt 已校验/);
});

test('verified summary at the last allowed turn closes without another model request',async()=>{
 const r=await exercise({},s=>s.maxTurns=2);
 assert.equal(r.result.outcome,'succeeded',JSON.stringify(r.result));
 assert.equal(r.result.agent.stop_reason,'GOAL_VERIFIED');
 assert.equal(r.requests,2);assert.equal(r.result.agent.turns,2);
 assert.equal(r.result.acceptance.status,'passed');
});

test('Pi can list and read declared output evidence before its final summary',async()=>{
 let evidence;
 const r=await exercise({handler:(data,n)=>{
  if(n===4){try{evidence=JSON.parse(data.messages.at(-1).content);}catch{evidence={error:data.messages.at(-1).content};}}
  return [{tool:'run_experiment'},{tool:'list_outputs'},
   {tool:'read_output',args:{name:'metrics.json'}},
   {tool:'submit_summary',args:{summary:'Read the actual output file.',metrics:{sum:evidence?.content?JSON.parse(evidence.content).sum:0}}},
   {tool:'get_run_state'}][Math.min(n-1,4)];
 }},s=>s.maxTurns=4);
 assert.equal(r.result.outcome,'succeeded',JSON.stringify(r.result));
 assert.equal(r.requests,4);assert.equal(evidence.name,'metrics.json');
 assert.equal(JSON.parse(evidence.content).sum,50005000);
 assert.equal(evidence.truncated,false);assert.match(evidence.sha256,/^[a-f0-9]{64}$/);
});

test('verified execution without a summary still respects the turn limit and retains its exit code',async()=>{
 const r=await exercise({handler:()=>({tool:'run_experiment'})},s=>s.maxTurns=2);
 assert.equal(r.result.outcome,'blocked');assert.equal(r.result.agent.stop_reason,'MODEL_TURN_LIMIT');
 assert.equal(r.result.execution.exit_code,0);assert.equal(r.result.execution.outcome,'succeeded');
 assert.equal(r.worker.events.filter(e=>e.type==='execution_started').length,1);
});

test('an unchecked declared deliverable prevents early completion',async()=>{
 const r=await exercise({},s=>{s.maxTurns=3;s.profile.outputs.push('missing.json');});
 assert.equal(r.result.outcome,'blocked');assert.equal(r.result.acceptance.status,'passed');
 assert.ok(r.worker.output_error);assert.ok(!r.worker.events.some(e=>e.type==='goal_verified'));
});

test('a failed tool later in a multi-tool turn prevents premature success',async()=>{
 const r=await exercise({handler:(_d,n)=>n===1?{tool:'run_experiment'}:{tools:[
  {tool:'submit_summary',args:{summary:'Candidate complete',metrics:{}}},
  {tool:'read_output',args:{name:'not-granted.txt'}}
 ]}},s=>s.maxTurns=2);
 assert.equal(r.result.outcome,'blocked');assert.equal(r.result.agent.stop_reason,'MODEL_TURN_LIMIT');
 assert.ok(!r.worker.events.some(e=>e.type==='goal_verified'));
});

for(const ok of [false,true])test(`a write after a verified summary invalidates completion even when checks still pass: ${ok}`,async()=>{
 const before=JSON.stringify({ok:true});
 const r=await exercise({handler:()=>({tools:[
  {tool:'submit_summary',args:{summary:'Candidate complete',metrics:{}}},
  {tool:'patch_local_json',args:{action_id:'invalidate',file:'config',expected_sha256:sha(before),changes:[{pointer:'/ok',value:ok}]}}
 ]})},(s,dir)=>{
  const file=path.join(fs.realpathSync(dir),'config.json');fs.writeFileSync(file,before);
  s.maxTurns=1;s.task.requirements={mode:'maintenance',checks:['ok']};s.task.code.revision='maint-v1';
  s.profile={kind:'maintenance',revision:'maint-v1',outputs:[],maintenance:{enabled:true,files:{config:{path:file,format:'json',write:true,pointers:['/ok']}}},verification:[{id:'ok',kind:'local-json',file:'config',pointer:'/ok',equals:true}]};
 });
 assert.equal(r.result.outcome,'blocked');assert.equal(r.result.acceptance.status,ok?'passed':'incomplete',JSON.stringify(r.result));
 assert.equal(r.result.acceptance.checks[0].ok,ok);assert.ok(!r.worker.events.some(e=>e.type==='goal_verified'));
});
