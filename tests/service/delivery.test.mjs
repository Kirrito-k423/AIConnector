import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Connector} from '../../service/connector.mjs';
import {Runner} from '../../service/runner.mjs';
import {save} from '../../service/common.mjs';

test('ready result upload is not overtaken by later background polling',async()=>{
  let release;const gate=new Promise(r=>release=r),order=[];
  const connector=new Connector({connector:{token_env:'AICONNECTOR_FIXTURE'}},{},async(_exe,args)=>{
    const action=args[args.indexOf('-Action')+1];order.push(action);
    if(order.length===1)await gate;
    return {code:0,out:'{"ok":true}\n'};
  });
  const first=connector.call('Poll');
  const upload=connector.call('Upload'),poll=connector.call('Poll');release();
  await Promise.all([first,upload,poll]);assert.deepEqual(order,['Poll','Upload','Poll']);
});

test('a blocked delivery does not prevent another ready job entering delivery',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC delivery ')),ledger={jobs:{}};
  let release;const gate=new Promise(r=>release=r),uploads=[],complete=[];
  for(const key of ['first','second']){
    const job=ledger.jobs[key]={key,dir:path.join(dir,key),state:'running'};
    save(path.join(job.dir,'worker.json'),{state:'ready'});save(path.join(job.dir,'result.json'),{outcome:'succeeded'});
  }
  const runner=new Runner({runner:{enabled:false}}, {call:async(action,args)=>{
    if(action==='Upload'){uploads.push(args.key);if(args.key==='first')await gate;return {name:'fixture.zip'};}
    if(action==='Complete'){complete.push(args.key);return {};}
    assert.fail(action);
  }},ledger,()=>{},{});
  try {
    await runner.tick({runs:[]});await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(uploads,['first','second']);assert.deepEqual(complete,['second']);
  } finally {release();await runner.idle();fs.rmSync(dir,{recursive:true,force:true});}
});
