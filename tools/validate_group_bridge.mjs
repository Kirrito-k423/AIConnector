// Actual Node worker against the actual Go HTTP controller; SSH is a Go fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Resources} from '../service/resources.mjs';
import {agentConfig,snapshotAgent} from '../service/agent-config.mjs';
import {save,read,run,ROOT} from '../service/common.mjs';
const baseUrl=process.argv[2],machineIds=JSON.parse(process.argv[3]);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aic-native-group-'));
try{
 const key='native-group/1/run-fixture',agent=snapshotAgent(agentConfig({simpleHtmlWatch:{enabled:true,baseUrl,pollSeconds:1}}),dir);
 const profile={kind:'simplehtmlwatch',executionMode:'direct',mode:'experiment',machineId:machineIds[0],machineIds,repository:'fixture',entry:'fixed',revision:'fixture-rev',revisionCommand:'printf fixture-rev',shell:'true',outputs:['metrics.json','group-completion.json'],groupCompletionOutput:'group-completion.json',groupRanksPerMachine:8,verification:[{id:'sum',kind:'output-json',file:'metrics.json',pointer:'/sum',equals:7}]};
 const task={code:{repository:'fixture',revision:'fixture-rev'},requirements:{mode:'experiment',execution_mode:'direct',tools:[],checks:['sum','group-processes-stopped'],resources:{machine_count:8,atomic_group:true}},environment:{target:'fixed'},invocation:{entry:'fixed',arguments:[]},artifacts:[]};
 const job={key,dir,state:'waiting'},resources=new Resources({runner:{maxConcurrentRuns:4,agent}},{jobs:{job}},()=>{});
 assert.equal(await resources.acquire(job,profile,task),true,JSON.stringify(job.resources));
 save(path.join(dir,'spec.json'),{key,profile,task,agent,reservation:job.resources.remote,timeoutSeconds:15,maxTurns:12});
 const child=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',dir],{input:'{}'});assert.equal(child.code,0,child.err);
 const result=read(path.join(dir,'result.json'));assert.equal(result.outcome,'succeeded',JSON.stringify(result));assert.equal(result.agent.turns,0);assert.equal(result.agent.stop_reason,'DIRECT_VERIFIED');
 assert.equal(result.execution.resource_grant.machine_count,8);await resources.release(job);assert.equal(job.resources.state,'released',JSON.stringify(job.resources));assert.equal(job.resources.completion.rank_count,64);
 console.log(JSON.stringify({scope:'real Go controller/Node worker, mock SSH and rank exits; no NPU',reserved_machines:8,verified_rank_exits:64,model_turns:0,stop_reason:result.agent.stop_reason,released:true}));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
