import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {start} from '../../service/server.mjs';

test('a pending capability advertisement does not prevent discovery ticks being dispatched',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC admission '));let service,release;
 const gate=new Promise(r=>release=r),socket=http.createServer();
 await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const connectorFile=path.join(dir,'connector.json'),file=path.join(dir,'service.json'),actions=[];
 fs.writeFileSync(connectorFile,JSON.stringify({schema:'aiconnector.config.v2',layout:'task-issues-run-releases-v1',namespace:'fixture',api_base:'http://127.0.0.1',poll_seconds:1,token_env:'AICONNECTOR_FIXTURE',repository:'fixture/relay'}));
 fs.writeFileSync(file,JSON.stringify({schema:'aiconnector.service.v1',node:'windows-inner',port,dataDir:'data',connectorConfig:connectorFile,runner:{enabled:false,profiles:{}}}));
 const connector={call:async(action,args)=>{actions.push(action);if(action==='Advertise'){await gate;return {confirmed:true,data:args.data};}return {runs:[],outbox:[]};},close:async()=>{}};
 try{
   service=await start(file,{secrets:{},connector});await new Promise(r=>setTimeout(r,3200));
   assert.equal(actions[0],'Poll');assert.equal(actions.filter(a=>a==='Advertise').length,1);
   assert.ok(actions.filter(a=>a==='Poll').length>=3,actions.join(','));
 }finally{release();await service?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('real serial control queue drains the acceptance Flush after a slow Poll instead of starting another scan',async()=>{
 const {Connector}=await import('../../service/connector.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC slow scan '));let service;
 const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const cfg=path.join(dir,'config.local.json'),relay=path.join(dir,'connector.json');
 fs.writeFileSync(relay,JSON.stringify({schema:'aiconnector.config.v1',api_base:'http://127.0.0.1',poll_seconds:1,token_env:'AICONNECTOR_FIXTURE',repository:'fixture/relay',issue:1}));
 fs.writeFileSync(cfg,JSON.stringify({schema:'aiconnector.service.v1',node:'windows-inner',port,dataDir:dir,connectorConfig:relay,runner:{enabled:false,profiles:{}}}));
 const order=[];
 const connector=new Connector({dataDir:dir,stateDir:dir,node:'windows-inner',connectorConfig:relay,tickSeconds:1,connector:{token_env:'AICONNECTOR_FIXTURE'}},{},async(_exe,args)=>{
  const action=args[args.indexOf('-Action')+1];order.push(action);
  if(order.length===1)await new Promise(r=>setTimeout(r,2300));
  return {code:0,out:JSON.stringify({runs:[],outbox:action==='Poll'?[{key:'sample/1/run-1',kind:'accepted',status:'pending'}]:[]})};
 });
 try{
  service=await start(cfg,{secrets:{},connector});
  await new Promise(r=>setTimeout(r,3500));
  assert.deepEqual(order.slice(0,2),['Poll','Flush']);
  const log=fs.readFileSync(path.join(dir,'service-timing.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const pollEnd=log.find(e=>e.kind==='action_finished'&&e.action==='Poll');
  const nextPoll=log.find(e=>e.kind==='action_dispatched'&&e.action==='Poll'&&Date.parse(e.at)>Date.parse(pollEnd.at));
  if(nextPoll)assert.ok(Date.parse(nextPoll.at)-Date.parse(pollEnd.at)>=950);
 }finally{await service?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
