import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Connector} from '../../service/connector.mjs';

function fixture(failPoll=false){
 let release;const gate=new Promise(r=>release=r),order=[];
 const connector=new Connector({connector:{token_env:'AICONNECTOR_FIXTURE'}},{},async(_exe,args)=>{
  const action=args[args.indexOf('-Action')+1];order.push(action);
  if(order.length===1)await gate;
  return failPoll&&action==='Poll'?{code:1,out:'{"code":"HTTP_TIMEOUT"}'}:{code:0,out:'{"ok":true}'};
 });
 return {connector,order,release};
}

for(const firstAction of ['Status','Poll'])test(`Poll callers share one ${firstAction==='Poll'?'executing':'queued'} request, and success releases the slot`,async()=>{
 const f=fixture(),first=f.connector.call(firstAction);
 try{
  const polls=Array.from({length:20},()=>f.connector.call('Poll'));
  assert.ok(polls.every(p=>p===polls[0]));assert.equal(f.connector.queue.filter(x=>x.action==='Poll').length,firstAction==='Poll'?0:1);
  const expected=firstAction==='Poll'?['Poll']:['Status','Poll'];
  f.release();await Promise.all([first,...polls]);assert.deepEqual(f.order,expected);
  await f.connector.call('Poll');assert.deepEqual(f.order,[...expected,'Poll']);
 }finally{f.release();await f.connector.close();}
});

test('a failed Poll releases its shared slot without swallowing failures',async()=>{
 const f=fixture(true),first=f.connector.call('Status');
 try{
  const poll=f.connector.call('Poll'),same=f.connector.call('Poll');assert.equal(poll,same);
  const rejected=assert.rejects(poll,/HTTP_TIMEOUT/);f.release();await first;await rejected;
  assert.equal(f.connector.pollRequest,null);
  await assert.rejects(f.connector.call('Poll'),/HTTP_TIMEOUT/);assert.equal(f.order.filter(a=>a==='Poll').length,2);
 }finally{f.release();await f.connector.close();}
});

test('queued Poll gets a turn after four foreground dispatches even behind an old backlog',async()=>{
 const f=fixture(),first=f.connector.call('Status');
 try{
  const claims=Array.from({length:30},()=>f.connector.call('Claim'));
  const poll=f.connector.call('Poll');f.release();await Promise.all([first,...claims,poll]);
  assert.deepEqual(f.order.slice(0,6),['Status','Claim','Claim','Claim','Claim','Poll']);
  assert.equal(f.order.filter(a=>a==='Claim').length,30);
 }finally{f.release();await f.connector.close();}
});

test('ten-second overdue Poll runs at the next boundary without preempting active work',async()=>{
 const f=fixture(),clock=Date.now;let time=clock();Date.now=()=>time;
 try{
  const first=f.connector.call('Upload'),oldClaims=Array.from({length:20},()=>f.connector.call('Claim'));
  time+=5000;const poll=f.connector.call('Poll');time+=10000;
  assert.deepEqual(f.order,['Upload']);
  f.release();await Promise.all([first,...oldClaims,poll]);assert.deepEqual(f.order.slice(0,2),['Upload','Poll']);
 }finally{Date.now=clock;f.release();await f.connector.close();}
});

test('capability publication gets a turn within twelve foreground dispatches under transfer backlog',async()=>{
 const f=fixture(),first=f.connector.call('Upload');
 try{
  const backlog=Array.from({length:40},()=>f.connector.call('Claim'));
  const advertise=f.connector.call('Advertise'),poll=f.connector.call('Poll');
  f.release();await Promise.all([first,...backlog,advertise,poll]);
  assert.ok(f.order.indexOf('Advertise')<=13,`advertisement starved at ${f.order.indexOf('Advertise')}`);
  assert.ok(f.order.indexOf('Poll')<=5,'announcement fairness preserves discovery fairness');
 }finally{f.release();await f.connector.close();}
});

test('sixty-second overdue capability publication runs before old uploads at a request boundary',async()=>{
 const f=fixture(),clock=Date.now;let time=clock();Date.now=()=>time;
 try{
  const first=f.connector.call('Upload'),backlog=Array.from({length:20},()=>f.connector.call('Upload'));
  const advertise=f.connector.call('Advertise');time+=60000;
  assert.deepEqual(f.order,['Upload']);f.release();await Promise.all([first,...backlog,advertise]);
  assert.deepEqual(f.order.slice(0,2),['Upload','Advertise']);
 }finally{Date.now=clock;f.release();await f.connector.close();}
});

test('both overdue discovery and publication get turns before backlog without replacing in-flight work',async()=>{
 const f=fixture(),clock=Date.now;let time=clock();Date.now=()=>time;
 try{
  const first=f.connector.call('Upload'),backlog=Array.from({length:20},()=>f.connector.call('Claim'));
  const advertise=f.connector.call('Advertise'),poll=f.connector.call('Poll');time+=60000;
  assert.deepEqual(f.order,['Upload']);f.release();await Promise.all([first,...backlog,advertise,poll]);
  assert.deepEqual(f.order.slice(0,3),['Upload','Poll','Advertise']);
 }finally{Date.now=clock;f.release();await f.connector.close();}
});

test('publication captures changed capabilities on dispatch and a failed capture releases the queue',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC advertise queue '));let release,calls=0,version='old',observed;
 const gate=new Promise(r=>release=r),connector=new Connector({dataDir:dir,connector:{token_env:'AICONNECTOR_FIXTURE'}},{},async(_exe,args)=>{
  if(++calls===1)await gate;
  if(args[args.indexOf('-Action')+1]==='Advertise')observed=JSON.parse(fs.readFileSync(args[args.lastIndexOf('-File')+1]));
  return {code:0,out:'{"ok":true}'};
 });
 try{
  const first=connector.call('Upload'),advertise=connector.call('Advertise',{data:{version},getData:()=>({version})});version='new';release();await Promise.all([first,advertise]);assert.deepEqual(observed,{version:'new'});
  await assert.rejects(connector.call('Advertise',{getData:()=>{throw new Error('CAPABILITY_SNAPSHOT_FAILED');}}),/CAPABILITY_SNAPSHOT_FAILED/);
  await connector.call('Poll');assert.equal(connector.activity.running,false);assert.deepEqual(fs.readdirSync(path.join(dir,'requests')),[]);
 }finally{release();await connector.close();fs.rmSync(dir,{recursive:true,force:true});}
});
