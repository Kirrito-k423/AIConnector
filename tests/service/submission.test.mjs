import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {start} from '../../service/server.mjs';
import {zipSync,strToU8} from 'fflate';
import {definitionSha} from '../../service/profile-data.mjs';

test('immutable submission rejection survives restart and does not keep retrying',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC rejected submission '));let service;
 const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const connectorFile=path.join(dir,'connector.json'),file=path.join(dir,'service.json');
 fs.writeFileSync(connectorFile,JSON.stringify({api_base:'http://127.0.0.1',poll_seconds:1,token_env:'AICONNECTOR_FIXTURE',repository:'fixture/relay'}));
 fs.writeFileSync(file,JSON.stringify({schema:'aiconnector.service.v1',node:'mac-outer',port,dataDir:'data',connectorConfig:connectorFile,runner:{enabled:false,profiles:{}}}));
 const data={schema:'aiconnector.capabilities.v1',node:'windows-inner',generated_at:new Date().toISOString(),enabled:true,model_configured:true,config_sha256:'a'.repeat(64),profiles:[{id:'cpu',mode:'smoke',tools:[],checks:['cpu-smoke'],entry:'smoke',repository:'aiconnector-builtin',revision:'builtin-smoke-v1'}]};
 let submits=0;
 const connector={call:async action=>{
   if(action==='Submit'){submits++;throw new Error('REVISION_IS_IMMUTABLE');}
   return {runs:[],outbox:[],receiver_capabilities:{data}};
 },close:async()=>{}};
 const task={task_id:'test',revision:1,run_id:'retry',title:'immutable test',objective:'changed revision',requirements:{mode:'smoke',checks:['cpu-smoke']},code:{repository:'aiconnector-builtin',revision:'builtin-smoke-v1'},environment:{target:'cpu'},invocation:{entry:'smoke',arguments:[]},acceptance:['cpu-smoke'],artifacts:[]};
 try{
   service=await start(file,{secrets:{},connector});
   const response=await fetch(service.url+'/api/tasks',{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:JSON.stringify({task})});
   const reply=await response.json();assert.equal(response.status,202,JSON.stringify(reply));
   const wait=()=>new Promise(r=>setTimeout(r,2200));await wait();
   assert.equal(submits,1);assert.equal(service.status().submissions[0].state,'rejected');assert.equal(service.status().submissions[0].error,'REVISION_IS_IMMUTABLE');
   await service.close();service=await start(file,{secrets:{},connector});await wait();
   assert.equal(submits,1);assert.equal(service.status().submissions[0].state,'rejected');
 }finally{await service?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('sender rejects mismatched profile attachment before queueing or publishing',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC profile submission '));let service;
 const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const connectorFile=path.join(dir,'connector.json'),file=path.join(dir,'service.json');
 fs.writeFileSync(connectorFile,JSON.stringify({api_base:'http://127.0.0.1',poll_seconds:1,token_env:'AICONNECTOR_FIXTURE',repository:'fixture/relay'}));
 fs.writeFileSync(file,JSON.stringify({schema:'aiconnector.service.v1',node:'mac-outer',port,dataDir:'data',connectorConfig:connectorFile,runner:{enabled:false,profiles:{}}}));
 const profile={kind:'simplehtmlwatch',machineId:'approved',mode:'probe',entry:'probe',revision:'v1',repository:'fixture-device',revisionCommand:'printf v1',shell:'printf fixture',outputs:['out.json'],verification:[{id:'exit',kind:'execution',equals:0}],executionMode:'direct'};
 const data={schema:'aiconnector.capabilities.v1',node:'windows-inner',generated_at:new Date().toISOString(),enabled:true,model_configured:true,config_sha256:'a'.repeat(64),profiles:[{id:'maintenance',mode:'maintenance',tools:['configure_server_profiles'],checks:['server-profiles-loaded'],entry:'registry',repository:'registry',revision:'registry-v1'}]};
 let uploads=0,submits=0;const connector={call:async action=>{if(action==='Upload')uploads++;if(action==='Submit')submits++;return {runs:[],outbox:[],receiver_capabilities:{data}};},close:async()=>{}};
 const task={task_id:'bad-profile',revision:1,run_id:'digest',title:'profile pin',objective:'one field',requirements:{mode:'maintenance',tools:['configure_server_profiles'],checks:['server-profiles-loaded'],server_profiles:[{id:'device',revision:'v1',definition_sha256:'0'.repeat(64)}]},code:{repository:'registry',revision:'registry-v1'},environment:{target:'maintenance'},invocation:{entry:'registry',arguments:[]},acceptance:['exact profile loaded'],artifacts:[]};
 const zipBase64=Buffer.from(zipSync({'profile.json':strToU8(JSON.stringify({device:profile}))})).toString('base64');
 try{
  service=await start(file,{secrets:{},connector});
  const response=await fetch(service.url+'/api/tasks',{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:JSON.stringify({task,zipBase64})});
  assert.equal(response.status,400);assert.equal((await response.json()).error,'REQUESTED_PROFILE_MISMATCH');
  assert.equal(service.status().submissions.length,0);assert.equal(uploads,0);assert.equal(submits,0);
  assert.ok(!fs.existsSync(path.join(dir,'data/submissions')));
  assert.notEqual(definitionSha(profile),task.requirements.server_profiles[0].definition_sha256);
 }finally{await service?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
