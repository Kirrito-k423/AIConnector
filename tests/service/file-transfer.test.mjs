import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {newExportIdentity} from '../../service/file-export.mjs';
import {ownedTransferProfile,encryptRequest,ownedTransferTask,buildTransfer,openTransferIndex,PART_BYTES} from '../../service/file-transfer.mjs';
import {save,read,run,ROOT,sha} from '../../service/common.mjs';
import {decryptResult,dataCli} from '../../service/data-cli.mjs';
import {loadSecrets,storeSecrets} from '../../service/vault.mjs';
import {capabilities,preflight} from '../../service/capabilities.mjs';
import {Runner} from '../../service/runner.mjs';

async function fixture(operation='read'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC owned transfer ')),source=path.join(dir,'PRIVATE_PROJECT'),job=path.join(dir,'job');fs.mkdirSync(source);fs.mkdirSync(path.join(source,'empty'));fs.mkdirSync(job);fs.mkdirSync(path.join(job,'work'));fs.mkdirSync(path.join(job,'inputs'));
 const large=Buffer.alloc(PART_BYTES+131072,0x7b);large.write('PRIVATE_CONTENT');fs.writeFileSync(path.join(source,'PRIVATE_SOURCE.bin'),large);fs.writeFileSync(path.join(source,'报告.md'),'PRIVATE_REPORT');fs.writeFileSync(path.join(source,'zero'),Buffer.alloc(0));
 const mac=await newExportIdentity(),windows=await newExportIdentity(),key='transfer/1/run',profile=ownedTransferProfile(mac.recipient,windows.recipient);
 const request=await encryptRequest({operation,paths:[source],...(operation==='find'?{name:'报告.md'}:{})},windows.recipient,key),artifact={name:'input.zip',bytes:request.length,sha256:sha(request)};fs.writeFileSync(path.join(job,'inputs',artifact.name),request);
 const task=ownedTransferTask({task_id:'transfer',revision:1,run_id:'run',profile:'files',recipient_sha256:sha(mac.recipient),request_recipient_sha256:sha(windows.recipient),request_zip_sha256:sha(request),artifacts:[artifact]});
 return {dir,source,job,mac,windows,large,spec:{key,profile,task},close(){fs.rmSync(dir,{recursive:true,force:true});}};
}
test('owned directory transfer exceeds one ZIP, preserves binary/text/empty directories and encrypts every name and path',async()=>{
 const f=await fixture();try{
  const transfer=await buildTransfer(f.spec,f.job,f.windows.identity),indexBytes=fs.readFileSync(path.join(f.job,'work','transfer-index.age')),index=JSON.parse(fs.readFileSync(path.join(f.job,'work','transfer-index.json')));
  assert.equal(transfer.parts.length,3);const manifest=await openTransferIndex(indexBytes,index,f.mac.identity,f.spec.key);assert.equal(manifest.files.length,3);assert.ok(manifest.directories.some(d=>d.endsWith('/empty')));
  for(const part of transfer.parts){const bytes=fs.readFileSync(path.join(f.job,'transfer-parts',part.name));assert.ok(bytes.length<5242880);assert.doesNotMatch(bytes.toString('latin1'),/PRIVATE_CONTENT|PRIVATE_PROJECT|PRIVATE_SOURCE/);}
  assert.doesNotMatch(JSON.stringify(index),/PRIVATE_PROJECT|PRIVATE_SOURCE|报告/);
  const result=path.join(f.dir,'result.zip'),bytes=zipSync({'transfer-index.age':indexBytes,'transfer-index.json':strToU8(JSON.stringify(index)),'result.json':strToU8(JSON.stringify({outcome:'succeeded',acceptance:{status:'passed'},execution:{engine:'direct'}}))});fs.writeFileSync(result,bytes);
  const destination=path.join(f.dir,'received'),seen=[],loadPart=async hash=>{seen.push(hash);return fs.readFileSync(path.join(f.job,'transfer-parts',hash+'.zip'));};
  const receipt=await decryptResult({result,expectedSha:sha(bytes),identity:f.mac.identity,key:f.spec.key,destination,loadPart});assert.equal(receipt.files_verified,true);assert.equal(seen.length,3);assert.deepEqual(fs.readFileSync(path.join(destination,'selection-0/PRIVATE_PROJECT/PRIVATE_SOURCE.bin')),f.large);assert.ok(fs.statSync(path.join(destination,'selection-0/PRIVATE_PROJECT/empty')).isDirectory());
 }finally{f.close();}
});
test('Mac network interruption resumes verified plaintext chunks and does not redownload or duplicate them',async()=>{
 const f=await fixture();try{
  await buildTransfer(f.spec,f.job,f.windows.identity);const entries=Object.fromEntries(['transfer-index.age','transfer-index.json'].map(n=>[n,fs.readFileSync(path.join(f.job,'work',n))]));entries['result.json']=strToU8(JSON.stringify({outcome:'succeeded',acceptance:{status:'passed'},execution:{engine:'direct'}}));
  const bytes=zipSync(entries),result=path.join(f.dir,'result.zip');fs.writeFileSync(result,bytes);const destination=path.join(f.dir,'received'),seen=[];
  const options={result,expectedSha:sha(bytes),identity:f.mac.identity,key:f.spec.key,destination};let fail=true;
  const loadPart=async hash=>{seen.push(hash);if(fail&&seen.length===2)throw new Error('TEST_NETWORK_DOWN');return fs.readFileSync(path.join(f.job,'transfer-parts',hash+'.zip'));};
  await assert.rejects(decryptResult({...options,loadPart}),/TEST_NETWORK_DOWN/);assert.equal(fs.existsSync(destination),false);assert.ok(fs.existsSync(destination+'.aiconnector-partial'));fail=false;
  const receipt=await decryptResult({...options,loadPart});assert.equal(receipt.files_verified,true);assert.equal(seen.filter(s=>s===seen[0]).length,1);assert.equal(fs.existsSync(destination+'.aiconnector-partial'),false);
 }finally{f.close();}
});
test('directory list is encrypted, and a real model-free worker reads owned paths without static file grants',async()=>{
 const f=await fixture('list');try{
  const auth=path.join(f.dir,'authorization.json');fs.writeFileSync(auth,JSON.stringify(f.spec.profile));const spec={...f.spec,exportAuthorization:{file:auth,sha256:sha(fs.readFileSync(auth))},model:{api:'openai-completions',baseUrl:'http://127.0.0.1:1',id:'UNAVAILABLE'},timeoutSeconds:30,maxTurns:1};save(path.join(f.job,'spec.json'),spec);
  const cap=capabilities({node:'windows-inner',connector:{namespace:'test'},runner:{enabled:true,profiles:{files:spec.profile},agent:{}}},{fileTransferIdentity:f.windows.identity,fileTransferRecipient:f.windows.recipient});assert.equal(preflight(spec.task,cap).ok,true);assert.equal(cap.profiles[0].data_export.scope,'owned-filesystem');assert.doesNotMatch(JSON.stringify(cap),/PRIVATE_PROJECT|AGE-SECRET-KEY/);
  const child=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',f.job],{input:JSON.stringify({fileTransferIdentity:f.windows.identity})});assert.equal(child.code,0,child.err);const result=read(path.join(f.job,'result.json')),zip=unzipSync(fs.readFileSync(path.join(f.job,'result.zip')));assert.equal(result.outcome,'succeeded',JSON.stringify(result));assert.equal(JSON.parse(strFromU8(zip['model-timing.json'])).requests_started,0);assert.equal(result.agent.turns,0);
  const manifest=await openTransferIndex(Buffer.from(zip['transfer-index.age']),JSON.parse(strFromU8(zip['transfer-index.json'])),f.mac.identity,f.spec.key);assert.equal(manifest.operation,'list');assert.equal(manifest.files[0].name,'listing.json');
 }finally{f.close();}
});
test('Windows delivery restarts from confirmed part uploads and publishes the index result last',async()=>{
 const f=await fixture();try{
  const transfer=await buildTransfer(f.spec,f.job,f.windows.identity),result={outcome:'succeeded'},job={key:f.spec.key,dir:f.job,state:'running'},ledger={jobs:{[job.key]:job}};save(path.join(f.job,'result.json'),result);save(path.join(f.job,'worker.json'),{state:'ready'});fs.writeFileSync(path.join(f.job,'result.zip'),zipSync({'result.json':strToU8(JSON.stringify(result))}));
  const uploaded=[],completed=[],connector={call:async(action,a)=>{if(action==='Upload'){const bytes=fs.readFileSync(a.file),hash=sha(bytes);uploaded.push(hash);if(uploaded.length===2)throw new Error('CONNECTION_RESET');return {sha256:hash,bytes:bytes.length,url:'fixture'};}if(action==='Complete'){completed.push(a.data);return {};}}};
  let runner=new Runner({runner:{enabled:true,profiles:{},agent:{}}},connector,ledger,()=>{},{});await runner.reconcile(job,{runs:[]});await Promise.all(runner.pending.values());assert.equal(completed.length,0);const first=uploaded[0];
  runner=new Runner({runner:{enabled:true,profiles:{},agent:{}}},connector,ledger,()=>{},{});job.delivery_retry_at=0;await runner.reconcile(job,{runs:[]});await Promise.all(runner.pending.values());assert.equal(uploaded.filter(h=>h===first).length,1);assert.equal(completed.length,1);assert.equal(job.state,'submitted');assert.equal(job.transfer_delivery.uploaded,transfer.parts.length);
 }finally{f.close();}
});
test('exact-name search returns encrypted evidence and marks inaccessible/missing roots incomplete',async()=>{
 const f=await fixture('find');try{
  const request=await encryptRequest({operation:'find',name:'报告.md',paths:[f.source,path.join(f.dir,'MISSING')]},f.windows.recipient,f.spec.key),a={name:'input.zip',bytes:request.length,sha256:sha(request)};
  fs.writeFileSync(path.join(f.job,'inputs',a.name),request);f.spec.task.artifacts=[a];f.spec.task.requirements.data_export.request_zip_sha256=a.sha256;
  await buildTransfer(f.spec,f.job,f.windows.identity);const bytes=zipSync({...Object.fromEntries(['transfer-index.age','transfer-index.json'].map(n=>[n,fs.readFileSync(path.join(f.job,'work',n))])),'result.json':strToU8(JSON.stringify({outcome:'succeeded',acceptance:{status:'passed'},execution:{engine:'direct'}}))}),result=path.join(f.dir,'result.zip');fs.writeFileSync(result,bytes);
  const destination=path.join(f.dir,'received');await decryptResult({result,expectedSha:sha(bytes),identity:f.mac.identity,key:f.spec.key,destination,loadPart:async hash=>fs.readFileSync(path.join(f.job,'transfer-parts',hash+'.zip'))});
  const listing=JSON.parse(fs.readFileSync(path.join(destination,'listing.json')));assert.equal(listing.entries.length,1);assert.equal(listing.query_complete,false);assert.equal(listing.errors[0].code,'ENOENT');assert.equal(listing.entries[0].path,path.join(f.source,'报告.md'));
 }finally{f.close();}
});
test('Windows one-time owned authorization stores request identity in DPAPI and preserves credentials and existing profiles',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture();try{
  const connector=path.join(f.dir,'connector.json'),config=path.join(f.dir,'service.json'),recipient=path.join(f.dir,'recipient.txt');
  fs.writeFileSync(connector,JSON.stringify({api_base:'http://127.0.0.1',poll_seconds:1}));fs.writeFileSync(recipient,f.mac.recipient+'\n');
  const original={schema:'aiconnector.service.v1',node:'windows-inner',port:49123,dataDir:path.join(f.dir,'data'),connectorConfig:connector,powershell:'powershell.exe',runner:{enabled:true,profiles:{smoke:{kind:'builtin-smoke',entry:'smoke',repository:'aiconnector-builtin',outputs:['metrics.json']}}}};
  fs.writeFileSync(config,JSON.stringify(original));const c={...original,dataDir:original.dataDir};fs.mkdirSync(c.dataDir);await storeSecrets(c,{githubToken:'SYNTHETIC_GITHUB_TOKEN',apiKey:'SYNTHETIC_MODEL_KEY'});
  const result=await dataCli(['authorize-owned','--config',config,'--profile','owned-files','--recipient',recipient,'--allow-public-ciphertext']);assert.equal(result.scope,'owned-filesystem');
  const secrets=await loadSecrets(c);assert.equal(secrets.githubToken,'SYNTHETIC_GITHUB_TOKEN');assert.equal(secrets.apiKey,'SYNTHETIC_MODEL_KEY');assert.match(secrets.fileTransferIdentity,/^AGE-SECRET-KEY/);
  const disk=JSON.parse(fs.readFileSync(config));assert.deepEqual(disk.runner.profiles.smoke,original.runner.profiles.smoke);assert.equal(disk.runner.profiles['owned-files'].delivery.recipient,f.mac.recipient);assert.doesNotMatch(fs.readFileSync(config,'utf8'),/AGE-SECRET-KEY|SYNTHETIC_GITHUB_TOKEN|SYNTHETIC_MODEL_KEY/);
  await assert.rejects(dataCli(['authorize-owned','--config',config,'--profile','owned-files','--recipient',recipient,'--allow-public-ciphertext']),/EXPORT_PROFILE_EXISTS/);
 }finally{f.close();}
});
