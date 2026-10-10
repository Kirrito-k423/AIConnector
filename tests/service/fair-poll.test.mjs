import test from 'node:test';
import assert from 'node:assert/strict';
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
