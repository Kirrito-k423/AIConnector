import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {save,read,run,ROOT} from '../../service/common.mjs';
import {modelFixture} from './model_fixture.mjs';

async function exercise(options={},edit=()=>{}){
 const fixture=await modelFixture(options),dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC worker 中文 '));
 const spec={key:'pi-smoke/1/run-1',task:{code:{repository:'aiconnector-builtin',revision:'builtin-smoke-v1'},environment:{target:'local-smoke'},invocation:{entry:'smoke',arguments:[]},artifacts:[]},profile:{kind:'builtin-smoke',outputs:['metrics.json']},model:{api:'openai-completions',baseUrl:fixture.url,id:'fixture',compat:{supportsDeveloperRole:false}},timeoutSeconds:20,maxTurns:6};
 edit(spec,dir);save(path.join(dir,'spec.json'),spec);
 try {
  const p=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',dir],{input:JSON.stringify({apiKey:'LOCAL_FIXTURE_KEY'})});
  assert.equal(p.code,0,p.err);const worker=read(path.join(dir,'worker.json'));const result=read(path.join(dir,'result.json'));
  const zip=unzipSync(fs.readFileSync(path.join(dir,'result.zip')));
  return {worker,result,zip,requests:fixture.requests,execution:read(path.join(dir,'execution.json'))};
 }finally{await fixture.close();fs.rmSync(dir,{recursive:true,force:true});}
}

test('real pinned Pi calls a real CPU experiment and returns verified ZIP',async()=>{
 const r=await exercise();assert.equal(r.worker.state,'ready');assert.equal(r.result.outcome,'succeeded');assert.equal(r.result.actual_revision,'builtin-smoke-v1');assert.equal(r.requests,3);
 assert.equal(JSON.parse(strFromU8(r.zip['metrics.json'])).sum,50005000);assert.equal(r.execution.exit_code,0);assert.match(strFromU8(r.zip['stdout.txt']),/50005000/);
});
test('invalid model credential yields a blocked delivery without experiment',async()=>{const r=await exercise({fail:true});assert.equal(r.result.outcome,'blocked');assert.equal(r.execution,undefined);});
test('revision mismatch never executes',async()=>{const r=await exercise({},s=>s.task.code.revision='wrong');assert.equal(r.result.outcome,'blocked');assert.equal(r.execution,undefined);});
test('prior durable execution intent is never replayed',async()=>{const r=await exercise({},(s,dir)=>save(path.join(dir,'execution-intent.json'),{key:s.key}));assert.equal(r.result.outcome,'blocked');assert.equal(r.execution,undefined);});
test('model repeats run_experiment but actual experiment executes once',async()=>{const r=await exercise({repeat:true});assert.equal(r.result.outcome,'succeeded');assert.equal(r.worker.events.filter(e=>e.type==='execution_started').length,1);assert.equal(r.requests,4);});
