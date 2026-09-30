import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {timing,diagnostics,readTiming} from '../../service/telemetry.mjs';
import {Connector} from '../../service/connector.mjs';

test('timing correlates queue wait and request work without exporting bodies or headers',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC timing '));
  try {
    const c={dataDir:dir,stateDir:path.join(dir,'connector'),node:'windows-inner',tickSeconds:10,connector:{token_env:'AICONNECTOR_FIXTURE',poll_seconds:60}};
    let release;const gate=new Promise(r=>release=r);
    const connector=new Connector(c,{},async(_exe,args)=>{
      assert.equal(args[args.indexOf('-PollSeconds')+1],'10');
      if(args[args.indexOf('-Action')+1]==='Poll')await gate;
      return {code:0,out:'{"ok":true}\n'};
    });
    const first=connector.call('Poll'),second=connector.call('Upload',{key:'sample/1/run-1'});
    await new Promise(r=>setTimeout(r,20));release();await Promise.all([first,second]);
    timing(dir,'example',{body:'SECRET_BODY',headers:'SECRET_HEADER',code:'bad message SECRET_TOKEN',key:'bad?token=SECRET_TOKEN'});
    const dump=fs.readFileSync(path.join(dir,'service-timing.jsonl'),'utf8');assert.ok(!dump.includes('SECRET'));
    const result=diagnostics(c,{jobs:{}},{},'sample/1/run-1');
    assert.equal(result.events.filter(e=>e.kind==='action_queued').length,1);
    assert.ok(result.events.find(e=>e.kind==='action_dispatched').queue_wait_ms>=15);
    assert.ok(result.events.find(e=>e.kind==='action_finished').total_ms>=15);
    assert.equal(new Set(result.events.map(e=>e.operation_id)).size,1);
    assert.throws(()=>diagnostics(c,{jobs:{}},{},'../secret'),/INVALID_RUN_ID/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('bounded timing export survives rotation and ignores an unfinished last line',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC timing rotation '));
  try{
    const file=path.join(dir,'service-timing.jsonl');fs.writeFileSync(file,' '.repeat(2*1024*1024)+'\n');
    timing(dir,'rotated',{key:'sample/1/run-1'});fs.appendFileSync(file,'{"incomplete":');
    assert.ok(fs.existsSync(file+'.1'));assert.equal(readTiming(file).at(-1).kind,'rotated');
    assert.ok(fs.statSync(file).size<1024);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
