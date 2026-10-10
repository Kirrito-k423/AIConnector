import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelTiming} from '../../service/model-timing.mjs';

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
