import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {collectExport,validateExportGrant,exportProfile,transferTask,validateTransferTask,newExportIdentity,sealExport,openExport} from '../../service/file-export.mjs';
import {capabilities,preflight,checkRequirements} from '../../service/capabilities.mjs';
import {save,read,run,ROOT,sha} from '../../service/common.mjs';
import {decryptResult,dataCli} from '../../service/data-cli.mjs';
import {zipSync,strToU8} from 'fflate';

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC export ')),root=path.join(dir,'approved');fs.mkdirSync(root);
  fs.writeFileSync(path.join(root,'报告.md'),'PRIVATE_REPORT_正文');fs.writeFileSync(path.join(root,'source.zip'),Buffer.from([0,1,2,3]));
  return {dir,root,grant:{enabled:true,root,files:[{path:'报告.md',name:'报告.md'},{path:'source.zip',name:'source.zip'}],maxBytes:1024},close(){fs.rmSync(dir,{recursive:true,force:true});}};
}
test('fixed export packages precisely authorized text/binary files and hashes without a model or shell',()=>{
  const f=fixture();try{
    fs.writeFileSync(path.join(f.root,'UNRELATED_SECRET'),'do not read');
    const result=collectExport(f.grant),zip=unzipSync(result.bytes),manifest=JSON.parse(strFromU8(zip['manifest.json']));
    assert.equal(result.fileCount,2);assert.deepEqual(Object.keys(zip).sort(),['files/0000','files/0001','manifest.json']);
    assert.equal(strFromU8(zip['files/0000']),'PRIVATE_REPORT_正文');assert.deepEqual(Buffer.from(zip['files/0001']),Buffer.from([0,1,2,3]));
    assert.equal(manifest.files[0].name,'报告.md');assert.match(manifest.files[0].sha256,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(manifest),/UNRELATED_SECRET|approved/);
  }finally{f.close();}
});
test('export requires explicit local authorization, bounded quotas and a fixed nonempty list',()=>{
  const f=fixture();try{
    for(const g of [{...f.grant,enabled:false},{...f.grant,files:[]},{...f.grant,maxBytes:32*1024*1024},{...f.grant,root:'relative'}])assert.throws(()=>validateExportGrant(g));
    assert.throws(()=>collectExport({...f.grant,maxBytes:4}),/EXPORT_TOO_LARGE/);
    assert.throws(()=>collectExport({...f.grant,files:[{path:'missing',name:'missing'}]}),/EXPORT_FILE_MISSING/);
  }finally{f.close();}
});
test('source traversal, absolute paths, Windows streams and unsafe or duplicate delivery names are rejected',()=>{
  const f=fixture();try{
    for(const p of ['../secret','/secret','C:\\secret','sub/../secret','file:stream','a\\b','./report','file.'])assert.throws(()=>validateExportGrant({...f.grant,files:[{path:p,name:'safe'}]}),/INVALID_EXPORT_PATH/);
    for(const name of ['../secret','CON','dir/name','a:b','file.','manifest.json'])assert.throws(()=>validateExportGrant({...f.grant,files:[{path:'报告.md',name}]}),/INVALID_EXPORT_NAME/);
    assert.throws(()=>validateExportGrant({...f.grant,files:[{path:'报告.md',name:'Report'},{path:'source.zip',name:'report'}]}),/DUPLICATE_EXPORT_NAME/);
  }finally{f.close();}
});
test('export refuses symlinks, parent-directory links, hard links and directories',()=>{
  const f=fixture();try{
    const outside=path.join(f.dir,'private');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'secret'),'PRIVATE');
    fs.symlinkSync(outside,path.join(f.root,'linked'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>collectExport({...f.grant,files:[{path:'linked/secret',name:'safe'}]}),/EXPORT_LINK_FORBIDDEN/);
    fs.linkSync(path.join(outside,'secret'),path.join(f.root,'hard'));
    assert.throws(()=>collectExport({...f.grant,files:[{path:'hard',name:'safe'}]}),/EXPORT_LINK_FORBIDDEN/);
    assert.throws(()=>collectExport({...f.grant,files:[{path:'linked',name:'safe'}]}),/EXPORT_LINK_FORBIDDEN/);
    fs.mkdirSync(path.join(f.root,'directory'));assert.throws(()=>collectExport({...f.grant,files:[{path:'directory',name:'safe'}]}),/EXPORT_NOT_REGULAR_FILE/);
  }finally{f.close();}
});
test('encrypted export reveals no file names, paths, content or plaintext hashes; recipient validates each file',async()=>{
  const f=fixture();try{
    const keys=await newExportIdentity(),p=exportProfile(f.grant,keys.recipient,{allowPublicCiphertext:true}),key='transfer/1/run';
    const sealed=await sealExport(p,key),text=sealed.bytes.toString('latin1')+JSON.stringify(sealed.evidence);
    assert.doesNotMatch(text,/报告|source\.zip|PRIVATE_REPORT|approved/);assert.ok(!text.includes(sha('PRIVATE_REPORT_正文')));
    const files=await openExport(sealed.bytes,sealed.evidence,keys.identity,key);assert.equal(files.length,2);assert.equal(files[0].name,'报告.md');assert.equal(files[0].bytes.toString(),'PRIVATE_REPORT_正文');
    await assert.rejects(openExport(sealed.bytes,sealed.evidence,(await newExportIdentity()).identity,key),/EXPORT_RECIPIENT_MISMATCH/);
    await assert.rejects(openExport(sealed.bytes,sealed.evidence,keys.identity,'another/1/run'),/EXPORT_BINDING_MISMATCH/);
    const corrupt=Buffer.from(sealed.bytes);corrupt[corrupt.length-1]^=1;
    await assert.rejects(openExport(corrupt,{...sealed.evidence,ciphertext_sha256:sha(corrupt)},keys.identity,key),/EXPORT_DECRYPT_FAILED/);
    await assert.rejects(sealExport(p,key,{secrets:['PRIVATE_REPORT']}),/SECRET_IN_EXPORT/);
  }finally{f.close();}
});
test('transfer preflight works without model credentials and rejects unapproved channels, recipient drift and private public metadata',async()=>{
  const f=fixture();try{
    const keys=await newExportIdentity(),p=exportProfile(f.grant,keys.recipient,{allowPublicCiphertext:true});
    const config={node:'windows-inner',connector:{namespace:'test'},runner:{enabled:true,profiles:{'data-001':p},agent:{}}},cap=capabilities(config,{}),task=transferTask({task_id:'transfer',revision:1,run_id:'run',profile:'data-001',recipient_sha256:sha(keys.recipient)});
    assert.equal(cap.model_configured,false);assert.equal(cap.profiles[0].resources.machine_count,0);assert.equal(preflight(task,cap).ok,true);checkRequirements(task,p);
    assert.doesNotMatch(JSON.stringify(cap),/报告|source\.zip|approved|AGE-SECRET-KEY/);
    const reordered=JSON.parse(JSON.stringify(task));reordered.invocation={arguments:[],entry:'export-files'};assert.doesNotThrow(()=>validateTransferTask(reordered));
    assert.throws(()=>preflight({...task,objective:'Read C:\\private\\project'},cap),/PRIVATE_TRANSFER_METADATA_FORBIDDEN/);
    assert.throws(()=>preflight({...task,private_directory:'C:\\secret'},cap),/PRIVATE_TRANSFER_METADATA_FORBIDDEN/);
    assert.throws(()=>preflight({...task,requirements:{...task.requirements,data_export:{format:'age-v1',recipient_sha256:'0'.repeat(64)}}},cap),/CAPABILITY_MISMATCH/);
    const disabled=capabilities({...config,runner:{...config.runner,profiles:{'data-001':exportProfile(f.grant,keys.recipient)}}},{});assert.equal(disabled.profiles[0].ready,false);assert.equal(disabled.profiles[0].error,'EXPORT_CHANNEL_NOT_AUTHORIZED');
    assert.throws(()=>preflight(task,disabled),/CAPABILITY_MISMATCH/);
  }finally{f.close();}
});
test('real worker exports and returns encrypted ZIP even when the model is unavailable; revocation blocks reads',async()=>{
  const f=fixture();try{
    const keys=await newExportIdentity(),profile=exportProfile(f.grant,keys.recipient,{allowPublicCiphertext:true});
    for(const revoked of [false,true]){
      const dir=path.join(f.dir,revoked?'revoked':'job');fs.mkdirSync(dir);
      const authorization=path.join(f.dir,'local-config.json');fs.writeFileSync(authorization,JSON.stringify({profile}));
      const spec={key:'transfer/1/run',profile,exportAuthorization:{file:authorization,sha256:revoked?'0'.repeat(64):sha(fs.readFileSync(authorization))},model:{api:'openai-completions',baseUrl:'http://127.0.0.1:1',id:'OFFLINE'},task:transferTask({task_id:'transfer',revision:1,run_id:'run',profile:'data-001',recipient_sha256:sha(keys.recipient)}),timeoutSeconds:10,maxTurns:1};
      save(path.join(dir,'spec.json'),spec);
      const child=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',dir],{input:'{}'});assert.equal(child.code,0,child.err);
      const result=read(path.join(dir,'result.json')),zip=unzipSync(fs.readFileSync(path.join(dir,'result.zip')));
      assert.equal(result.outcome,revoked?'blocked':'succeeded',JSON.stringify(result));assert.equal(result.agent.turns,0);assert.equal(JSON.parse(strFromU8(zip['model-timing.json'])).requests_started,0);
      if(revoked){assert.equal(result.metrics.runner_error,'EXPORT_AUTHORIZATION_CHANGED');assert.equal(zip['transfer.age'],undefined);}
      else{
        const files=await openExport(Buffer.from(zip['transfer.age']),JSON.parse(strFromU8(zip['transfer.json'])),keys.identity,spec.key);assert.equal(files.length,2);
        for(const [name,data]of Object.entries(zip)){assert.doesNotMatch(name,/报告|source\.zip/);assert.doesNotMatch(strFromU8(data),/PRIVATE_REPORT|source\.zip|报告\.md|AGE-SECRET-KEY/);}
        assert.ok(result.execution.executor_duration_ms>=0);assert.equal(result.execution.engine,'direct');
      }
    }
  }finally{f.close();}
});
test('Mac retrieval writes only fully verified files, keeps receipt local and never overwrites an existing destination',async()=>{
  const f=fixture();try{
    const keys=await newExportIdentity(),key='transfer/1/run',sealed=await sealExport(exportProfile(f.grant,keys.recipient,{allowPublicCiphertext:true}),key);
    const raw=zipSync({'transfer.age':sealed.bytes,'transfer.json':strToU8(JSON.stringify(sealed.evidence)),'result.json':strToU8(JSON.stringify({outcome:'succeeded',acceptance:{status:'passed'},execution:{engine:'direct'}}))});
    const result=path.join(f.dir,'result.zip');fs.writeFileSync(result,raw);const destination=path.join(f.dir,'retrieved');
    const options={result,expectedSha:sha(raw),identity:keys.identity,key,destination};
    await assert.rejects(decryptResult({...options,expectedSha:'0'.repeat(64)}),/RESULT_HASH_MISMATCH/);assert.equal(fs.existsSync(destination),false);
    await assert.rejects(decryptResult({...options,identity:(await newExportIdentity()).identity}),/EXPORT_RECIPIENT_MISMATCH/);assert.equal(fs.existsSync(destination),false);
    const receipt=await decryptResult(options);assert.equal(receipt.files_verified,true);assert.equal(fs.readFileSync(path.join(destination,'报告.md'),'utf8'),'PRIVATE_REPORT_正文');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination,'.aiconnector-receipt.json'))),receipt);
    await assert.rejects(decryptResult(options),/EXPORT_DESTINATION_EXISTS/);
  }finally{f.close();}
});
test('key initialization stores identity locally without returning it or overwriting existing keys',async()=>{
  const f=fixture();try{
    const identity=path.join(f.dir,'identity.txt'),recipient=path.join(f.dir,'recipient.txt'),args=['init-key','--identity',identity,'--recipient',recipient];
    const response=await dataCli([...args]);assert.equal(response.private_key_saved,true);assert.match(fs.readFileSync(identity,'utf8'),/^AGE-SECRET-KEY-/);assert.doesNotMatch(JSON.stringify(response),/AGE-SECRET-KEY/);
    if(process.platform!=='win32')assert.equal(fs.statSync(identity).mode&0o777,0o600);
    await assert.rejects(dataCli([...args]),/EXPORT_KEY_EXISTS/);
  }finally{f.close();}
});
