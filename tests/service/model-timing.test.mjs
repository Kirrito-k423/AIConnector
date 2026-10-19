import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelTiming} from '../../service/model-timing.mjs';
import {WindowWriter} from '../../service/window-writer.mjs';

test('100000 stream deltas add only bounded boundary records and never retain content',async()=>{
  let written=0,t=0,closed=false;const rows=[];
  const writer={dropped:0,append:r=>{written++;rows.push(r);},close:async()=>{closed=true;}};
  const timing=new ModelTiming('unused','fixture',{writer,clock:()=>++t,wall:()=>String(t),limit:2});
  const runtime={streamSimple:(_m,_c,options)=>({options,push:()=>{}})};timing.install(runtime);
  for(let n=0;n<5;n++){
    const stream=runtime.streamSimple({},{});await stream.options.onPayload({secret:'NEVER_CAPTURE'});await stream.options.onResponse({status:200,headers:{secret:'NEVER_CAPTURE'}});
    for(let i=0;i<100000;i++)stream.push({type:'text_delta',delta:'NEVER_CAPTURE'});
    stream.push({type:'done',message:{stopReason:'stop'}});
  }
  await timing.close('GOAL_VERIFIED');assert.equal(closed,true);assert.equal(written,25);
  assert.equal(timing.snapshot().requests.length,2);assert.equal(timing.snapshot().dropped_requests,3);assert.doesNotMatch(JSON.stringify(rows),/NEVER_CAPTURE/);
});

test('a blocked local log does not hold the completed timing snapshot used for the result ZIP',async()=>{
  let release,closed=false;
  const gate=new Promise(r=>release=r),writer=new WindowWriter('unused',{io:{stat:async()=>({size:0}),appendFile:()=>gate}});
  const timing=new ModelTiming('unused','slow-disk',{writer}),runtime={streamSimple:()=>({push:()=>{}})};
  timing.install(runtime);runtime.streamSimple({},{});
  await Promise.resolve();await Promise.resolve(); // optional writer is waiting on IO
  assert.equal(timing.stop('RUN_TIMEOUT'),undefined,'finalize in memory without waiting for IO');
  const snapshot=timing.snapshot();assert.equal(snapshot.requests[0].state,'ended');assert.equal(snapshot.runner_stop_reason,'RUN_TIMEOUT');assert.equal(snapshot.local_log_draining,true);
  const close=timing.close('RUN_TIMEOUT').then(()=>closed=true);await Promise.resolve();assert.equal(closed,false);
  release();await close;assert.equal(closed,true);
});
