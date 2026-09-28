import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {save,read,lock,atomic,safeEnv,run,cleanError,safeDiagnostic} from '../../service/common.mjs';
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
test('Chinese output survives UTF-8 characters split across process chunks',async()=>{
 const r=await run(process.execPath,['-e',"const b=Buffer.from('中文结果');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),50)"]);
 assert.equal(r.code,0);assert.equal(r.out,'中文结果');
});
test('worker exit evidence remains visible when an unknown run is reconciled without replay',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC exit '));
 try{const ledger={jobs:{'x/1/y':{key:'x/1/y',dir,state:'unknown'}}};save(path.join(dir,'worker-exit.json'),{code:1,signal:null,stderr:'EPERM'});save(path.join(dir,'worker-failure.json'),{code:'EPERM',syscall:'rename'});
 const r=new Runner({runner:{enabled:false}},{},ledger,()=>{},{});await r.tick({runs:[]});assert.equal(ledger.jobs['x/1/y'].state,'unknown');assert.equal(ledger.jobs['x/1/y'].process_exit.code,1);assert.equal(ledger.jobs['x/1/y'].process_failure.syscall,'rename');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('network diagnostics preserve categories without exposing messages or arbitrary fields',()=>{
 for(const [code,expected]of [['ECONNREFUSED','CONNECTION_REFUSED'],['ECONNRESET','CONNECTION_RESET'],['ETIMEDOUT','HTTP_TIMEOUT'],['ENOTFOUND','DNS_ERROR'],['CERT_HAS_EXPIRED','TLS_ERROR']]){
   const cause=Object.assign(new Error('PRIVATE_TOKEN in http://private/path'),{code});
   assert.equal(cleanError(new Error('fetch failed',{cause:new AggregateError([cause])})),expected);
 }
 assert.equal(cleanError(new Error('PRIVATE_TOKEN secret')),'SERVICE_ERROR');
 assert.equal(cleanError(new Error('aborted',{cause:new DOMException('timeout','TimeoutError')})),'HTTP_TIMEOUT');
 assert.deepEqual(safeDiagnostic({code:'TLS_ERROR',line:99,http:0,action:'Advertise',token:'PRIVATE_TOKEN',body:'private',url:'https://private'}),{code:'TLS_ERROR',action:'Advertise',line:99,http:0});
});

test('lost Claim reply closes a proven unlaunched attempt and delivers a blocked result without replay',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC claim lost '));
 try{
   const job={key:'x/1/y',dir,state:'unknown',error:'CONNECTOR_ERROR'},ledger={jobs:{[job.key]:job}},calls=[];
   const r=new Runner({runner:{enabled:false}},{call:async(action,args)=>{calls.push(action);return action==='Upload'?{sha256:'fixture'}:{ok:true};}},ledger,()=>{},{});
   await r.tick({runs:[{key:job.key,phase:'started',claimed:true}]});
   assert.equal(job.state,'delivering');assert.equal(job.recovery.kind,'claim-reconciled-before-launch');
   const result=read(path.join(dir,'result.json'));assert.equal(result.outcome,'blocked');assert.equal(result.execution.executed,false);assert.equal(result.agent.turns,0);
   await r.tick({runs:[{key:job.key,phase:'started',claimed:true}]});
   await r.idle();
   assert.equal(job.state,'submitted');assert.deepEqual(calls,['Upload','Complete']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('public started alone and any launch evidence must never authorize automatic unknown resolution',async()=>{
 for(const evidence of ['unowned','spec.json','watch-task.json','execution-intent.json','worker.json','claimed_at','pid']){
   const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC ambiguous '));
   try{const job={key:'x/1/y',dir,state:'unknown',created_at:'2000-01-01T00:00:00Z'};
     if(evidence.endsWith('.json'))save(path.join(dir,evidence),{});
     if(evidence==='claimed_at')job.claimed_at='2000-01-01T00:00:00Z';if(evidence==='pid')job.pid=99999999;
     const r=new Runner({runner:{enabled:false}},{call:()=>assert.fail('must not replay')},{jobs:{[job.key]:job}},()=>{},{});
     await r.tick({runs:[{key:job.key,phase:'started',claimed:evidence!=='unowned'}]});
     assert.equal(job.state,'unknown',evidence);assert.equal(fs.existsSync(path.join(dir,'result.json')),false);
   }finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
});
