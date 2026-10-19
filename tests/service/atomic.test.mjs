import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {replaceAtomicFile} from '../../service/common.mjs';

test('transient Windows sharing failures retain the original until atomic replacement succeeds',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC atomic ')),source=path.join(dir,'new.tmp'),target=path.join(dir,'state.json');
  fs.writeFileSync(source,'new');fs.writeFileSync(target,'old');let attempts=0;const waits=[];
  try{
    replaceAtomicFile(source,target,{platform:'win32',rename:(a,b)=>{
      assert.equal(a,source);assert.equal(b,target);assert.equal(fs.readFileSync(target,'utf8'),'old');
      if(++attempts<=3)throw Object.assign(new Error('sharing'),{code:['EPERM','EACCES','EBUSY'][attempts-1]});
      fs.renameSync(a,b);
    },wait:ms=>{waits.push(ms);assert.equal(fs.readFileSync(target,'utf8'),'old');}});
    assert.equal(fs.readFileSync(target,'utf8'),'new');assert.equal(fs.existsSync(source),false);
    assert.equal(attempts,4);assert.deepEqual(waits,[10,20,40]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('persistent Windows denial is bounded and never removes the old state',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC atomic denial ')),source=path.join(dir,'new.tmp'),target=path.join(dir,'state.json');
  fs.writeFileSync(source,'new');fs.writeFileSync(target,'old');let attempts=0,total=0;
  const error=Object.assign(new Error('denied'),{code:'EPERM'});
  try{
    assert.throws(()=>replaceAtomicFile(source,target,{platform:'win32',rename:()=>{attempts++;throw error;},wait:ms=>total+=ms}),e=>e===error);
    assert.equal(attempts,8);assert.equal(total,450);
    assert.equal(fs.readFileSync(target,'utf8'),'old');assert.equal(fs.readFileSync(source,'utf8'),'new');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('unrelated filesystem errors and other platforms are not retried',()=>{
  for(const [platform,code] of [['win32','ENOSPC'],['win32','ENOENT'],['darwin','EPERM']]){
    let attempts=0;const error=Object.assign(new Error('failure'),{code});
    assert.throws(()=>replaceAtomicFile('source','target',{platform,rename:()=>{attempts++;throw error;},wait:()=>assert.fail('unexpected retry')}),e=>e===error);
    assert.equal(attempts,1);
  }
});
