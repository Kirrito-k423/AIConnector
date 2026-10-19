import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {start} from '../../service/server.mjs';

async function fixture(t,call){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC manual poll '));
  const listener=http.createServer();
  await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  fs.writeFileSync(path.join(dir,'connector.json'),JSON.stringify({schema:'aiconnector.config.v2',layout:'task-issues-run-releases-v1',namespace:'fixture',api_base:'http://127.0.0.1',poll_seconds:60,token_env:'AICONNECTOR_FIXTURE',repository:'fixture/relay'}));
  const config=path.join(dir,'config.json');
  fs.writeFileSync(config,JSON.stringify({schema:'aiconnector.service.v1',node:'windows-inner',port,dataDir:'data',connectorConfig:'connector.json',runner:{enabled:false,profiles:{}}}));
  let service;
  t.after(async()=>{await service?.close();fs.rmSync(dir,{recursive:true,force:true});});
  service=await start(config,{secrets:{},connector:{call,close:async()=>{}}});
  return {service,poll:async()=>{
    const r=await fetch(service.url+'/api/poll',{method:'POST',headers:{Authorization:'Bearer '+service.token,'Content-Type':'application/json'},body:'{}'});
    return {status:r.status,body:await r.json()};
  }};
}

test('repeated manual sync requests are acknowledged without errors or extra Polls',async t=>{
  let polls=0;
  const f=await fixture(t,async(action,args)=>{
    if(action==='Poll')polls++;
    return action==='Advertise'?{confirmed:true,data:args.getData()}:{runs:[],outbox:[]};
  });
  const first=await f.poll();
  assert.equal(first.status,202);
  const afterFirst=polls;
  for(let n=0;n<3;n++){
    const next=await f.poll();
    assert.equal(next.status,202,JSON.stringify(next.body));
    assert.equal(next.body.coalesced,true);
    assert.equal(next.body.state,'cooldown');
    assert.equal(next.body.queued,false);
    assert.ok(next.body.retry_after_ms>0&&next.body.retry_after_ms<=15000);
  }
  assert.equal(polls,afterFirst,'multiple tabs cannot multiply the transport work');
});

test('manual sync joins the running Poll without queuing another or cancelling it',async t=>{
  let release,polls=0;
  const gate=new Promise(r=>release=r);
  const f=await fixture(t,async action=>{if(action==='Poll'){polls++;await gate;}return {runs:[],outbox:[]};});
  try{
    for(let n=0;n<2;n++){
      const reply=await f.poll();
      assert.equal(reply.status,202,JSON.stringify(reply.body));
      assert.equal(reply.body.state,'syncing');
      assert.equal(reply.body.coalesced,true);
      assert.equal(reply.body.queued,true);
    }
    assert.equal(polls,1);
  }finally{release();}
});
