import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {start} from '../../service/server.mjs';

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
