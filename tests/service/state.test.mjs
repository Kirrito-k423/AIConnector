import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {save,read,lock,atomic,safeEnv} from '../../service/common.mjs';
import {Runner} from '../../service/runner.mjs';
import {storeSecrets,loadSecrets} from '../../service/vault.mjs';

test('corrupt durable ledger fails closed; live owner prevents a second service',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC state '));
 try {const f=path.join(dir,'state.json');save(f,{claims:['done']});assert.deepEqual(read(f),{claims:['done']});const data=JSON.parse(fs.readFileSync(f));data.data='{}';atomic(f,JSON.stringify(data));assert.throws(()=>read(f),/STORE_CORRUPT/);
 const unlock=lock(path.join(dir,'owner.lock'));assert.throws(()=>lock(path.join(dir,'owner.lock')),/ALREADY_RUNNING/);unlock();const unlock2=lock(path.join(dir,'owner.lock'));unlock2();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('ambiguous claim is never granted again and blocks automatic dispatch',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC recovery '));
 try {const ledger={jobs:{'x/1/y':{key:'x/1/y',dir,state:'claiming'}}};let calls=0;const c={node:'windows-inner',runner:{enabled:true,profiles:{},model:{}},connector:{token_env:'FAKE'}};
 const r=new Runner(c,{call:()=>{calls++;throw new Error('UNEXPECTED');}},ledger,()=>{},{apiKey:'fixture',githubToken:'fixture'});
 await r.tick({runs:[]});assert.equal(ledger.jobs['x/1/y'].state,'unknown');assert.equal(calls,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Windows DPAPI credential roundtrip keeps plaintext out of its file',{skip:process.platform!=='win32'},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC vault '));
 try {const c={dataDir:dir,powershell:'powershell.exe'},secret={githubToken:'SYNTHETIC_GITHUB_TOKEN',apiKey:'SYNTHETIC_MODEL_KEY'};await storeSecrets(c,secret);assert.deepEqual(await loadSecrets(c),secret);assert.ok(!fs.readFileSync(path.join(dir,'credentials.dpapi'),'utf8').includes(secret.apiKey));}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('experiment environment preserves OS paths but excludes API and cloud credentials',()=>{
 const saved=process.env.AICONNECTOR_AI_API_KEY;process.env.AICONNECTOR_AI_API_KEY='PRIVATE_FIXTURE';
 try{assert.equal(safeEnv().AICONNECTOR_AI_API_KEY,undefined);assert.equal(safeEnv().PATH||safeEnv().Path,process.env.PATH||process.env.Path);}
 finally{if(saved===undefined)delete process.env.AICONNECTOR_AI_API_KEY;else process.env.AICONNECTOR_AI_API_KEY=saved;}
});
