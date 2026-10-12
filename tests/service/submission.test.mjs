import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {start} from '../../service/server.mjs';
import {zipSync,strToU8} from 'fflate';
import {definitionSha} from '../../service/profile-data.mjs';
import {newExportIdentity,exportProfile} from '../../service/file-export.mjs';
import {capabilities} from '../../service/capabilities.mjs';
import {sha} from '../../service/common.mjs';
import {ownedTransferProfile} from '../../service/file-transfer.mjs';

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

test('transfer API constructs public-safe metadata and rejects paths before queueing, without a model',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC transfer submission '));let service;
 const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const connectorFile=path.join(dir,'connector.json'),file=path.join(dir,'service.json');
 fs.writeFileSync(connectorFile,JSON.stringify({api_base:'http://127.0.0.1',poll_seconds:1,token_env:'AICONNECTOR_FIXTURE',repository:'fixture/relay'}));
 fs.writeFileSync(file,JSON.stringify({schema:'aiconnector.service.v1',node:'mac-outer',port,dataDir:'data',connectorConfig:connectorFile,runner:{enabled:false,profiles:{}}}));
 const keys=await newExportIdentity(),profile=exportProfile({enabled:true,root:dir,files:[{path:'SECRET_REPORT.md',name:'PRIVATE_NAME.md'}],maxBytes:1024},keys.recipient,{allowPublicCiphertext:true});
 const data=capabilities({node:'windows-inner',connector:{namespace:'fixture'},runner:{enabled:true,profiles:{'data-001':profile},agent:{}}},{});
 const connector={call:async()=>({runs:[],outbox:[],receiver_capabilities:{data}}),close:async()=>{}};
 const request={task_id:'transfer',revision:1,run_id:'run',profile:'data-001',recipient_sha256:data.profiles[0].data_export.recipient_sha256};
 try{
   service=await start(file,{secrets:{},connector});
   const post=body=>fetch(service.url+'/api/transfers',{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
   const rejected=await post({...request,path:'C:\\private'});assert.equal(rejected.status,400);assert.equal((await rejected.json()).error,'PRIVATE_TRANSFER_METADATA_FORBIDDEN');assert.equal(service.status().submissions.length,0);
   const response=await post(request);assert.equal(response.status,202,JSON.stringify(await response.json()));
   const task=service.status().submissions[0].task;assert.equal(task.requirements.mode,'transfer');assert.equal(task.title,'文件传输');assert.equal(task.objective,'导出接收端固定授权文件并加密回传。');assert.doesNotMatch(JSON.stringify(task),/SECRET_REPORT|PRIVATE_NAME|AGE-SECRET-KEY|C:\\/);
 }finally{await service?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('owned transfer encrypts path requests before persistence and repeated submission keeps original ciphertext identity',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC private request '));let service;
 const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const connectorFile=path.join(dir,'connector.json'),file=path.join(dir,'service.json');
 fs.writeFileSync(connectorFile,JSON.stringify({api_base:'http://127.0.0.1',poll_seconds:1,token_env:'AICONNECTOR_FIXTURE',repository:'fixture/relay'}));
 fs.writeFileSync(file,JSON.stringify({schema:'aiconnector.service.v1',node:'mac-outer',port,dataDir:'data',connectorConfig:connectorFile,runner:{enabled:false,profiles:{}}}));
 const mac=await newExportIdentity(),win=await newExportIdentity(),profile=ownedTransferProfile(mac.recipient,win.recipient);
 const data=capabilities({node:'windows-inner',connector:{namespace:'fixture'},runner:{enabled:true,profiles:{files:profile},agent:{}}},{fileTransferIdentity:win.identity,fileTransferRecipient:win.recipient});
 const connector={call:async()=>({runs:[],outbox:[],receiver_capabilities:{data}}),close:async()=>{}};
 const request={task_id:'transfer',revision:1,run_id:'run',profile:'files',recipient_sha256:data.profiles[0].data_export.recipient_sha256,paths:['C:\\PRIVATE_PROJECT\\NDS_实验复现报告.md'],operation:'read'};
 try{
  service=await start(file,{secrets:{},connector});const post=body=>fetch(service.url+'/api/transfers',{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const first=await post(request);assert.equal(first.status,202,JSON.stringify(await first.json()));const task=service.status().submissions[0].task,pin=task.requirements.data_export.request_zip_sha256;
  assert.doesNotMatch(JSON.stringify(service.status().submissions),/PRIVATE_PROJECT|NDS|实验复现报告|AGE-SECRET-KEY/);
  const again=await post(request);assert.equal(again.status,200);assert.equal(service.status().submissions[0].task.requirements.data_export.request_zip_sha256,pin);
  const changed=await post({...request,paths:['C:\\another']});assert.equal(changed.status,400);assert.equal((await changed.json()).error,'RUN_IS_IMMUTABLE');
  const encrypted=fs.readFileSync(path.join(dir,'data/submissions',sha('transfer/1/run')+'.zip'));assert.doesNotMatch(encrypted.toString('latin1'),/PRIVATE_PROJECT|NDS/);
 }finally{await service?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
