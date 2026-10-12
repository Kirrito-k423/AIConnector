import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {sha,need,cleanError,loadConfig,json,atomic,read,save} from './common.mjs';
import {decodeInputArchive} from './inputs.mjs';
import {newExportIdentity,openExport,transferTask,validateTransferTask,exportProfile,validateExportProfile} from './file-export.mjs';
import {ownedTransferProfile,openTransferIndex,openTransferPart,validateOwnedProfile} from './file-transfer.mjs';
import {loadSecrets,storeSecrets} from './vault.mjs';
import {localRequest} from './http.mjs';

function createFile(file,bytes){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export async function decryptResult({result,expectedSha,identity,key,destination,loadPart}){
  need(/^[a-f0-9]{64}$/.test(expectedSha)&&typeof key==='string'&&key.length<=200,'EXPORT_EXPECTED_BINDING_REQUIRED');
  need(fs.statSync(result).size<5242880,'ZIP_TOO_LARGE');const bytes=fs.readFileSync(result);need(sha(bytes)===expectedSha,'RESULT_HASH_MISMATCH');
  const entries=decodeInputArchive(bytes);need(entries['result.json'],'SEALED_EXPORT_NOT_FOUND');
  const protocol=JSON.parse(new TextDecoder().decode(entries['result.json']));need(protocol.outcome==='succeeded'&&protocol.acceptance?.status==='passed'&&protocol.execution?.engine==='direct','EXPORT_EXECUTION_NOT_VERIFIED');
  need(!fs.existsSync(destination),'EXPORT_DESTINATION_EXISTS');
  if(entries['transfer-index.age'])return retrieveTransfer(entries,identity,key,destination,expectedSha,loadPart);
  need(entries['transfer.age']&&entries['transfer.json'],'SEALED_EXPORT_NOT_FOUND');
  const files=await openExport(Buffer.from(entries['transfer.age']),JSON.parse(new TextDecoder().decode(entries['transfer.json'])),identity,key);
  // All decryption, binding, path and hash checks finish before any plaintext
  // is written. An existing destination or file is never overwritten.
  fs.mkdirSync(destination,{mode:0o700});
  try{
    for(const file of files)createFile(path.join(destination,file.name),file.bytes);
    const receipt={schema:'aiconnector.file-receipt.v1',key,result_sha256:expectedSha,decrypted:true,files_verified:true,
      verified_at:new Date().toISOString(),files:files.map(f=>({name:f.name,sha256:f.sha256,bytes:f.bytes.length})),scope:'Authorized files retrieved; scientific content has not been validated.'};
    createFile(path.join(destination,'.aiconnector-receipt.json'),JSON.stringify(receipt,null,2)+'\n');return receipt;
  }catch(e){fs.rmSync(destination,{recursive:true,force:true});throw e;}
}
async function fileHash(file){const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
async function retrieveTransfer(entries,identity,key,destination,resultSha,loadPart){
  const index=JSON.parse(new TextDecoder().decode(entries['transfer-index.json'])),manifest=await openTransferIndex(Buffer.from(entries['transfer-index.age']),index,identity,key);
  need(typeof loadPart==='function','TRANSFER_PART_LOADER_REQUIRED');
  const stage=destination+'.aiconnector-partial';if(!fs.existsSync(stage))fs.mkdirSync(stage,{mode:0o700});
  need(fs.lstatSync(stage).isDirectory()&&!fs.lstatSync(stage).isSymbolicLink(),'UNSAFE_TRANSFER_DESTINATION');
  const progressFile=path.join(stage,'progress.json'),state=read(progressFile,{key,result_sha256:resultSha,files:{}});
  need(state.key===key&&state.result_sha256===resultSha,'EXPORT_BINDING_MISMATCH');
  for(const [file,f]of manifest.files.entries()){
    const temporary=path.join(stage,file+'.part'),saved=state.files[file]||{parts:0,bytes:0};
    if(fs.existsSync(temporary))need(fs.lstatSync(temporary).isFile()&&!fs.lstatSync(temporary).isSymbolicLink(),'UNSAFE_TRANSFER_DESTINATION');
    else{need(saved.bytes===0,'TRANSFER_CHECKPOINT_MISSING');createFile(temporary,Buffer.alloc(0));}
    need(saved.parts>=0&&saved.parts<=f.parts.length&&saved.bytes===(saved.parts?f.parts[saved.parts-1].offset+f.parts[saved.parts-1].bytes:0)&&fs.statSync(temporary).size>=saved.bytes,'TRANSFER_CHECKPOINT_MISMATCH');
    const fd=fs.openSync(temporary,fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW||0));
    try{
      fs.ftruncateSync(fd,saved.bytes);
      for(let p=saved.parts;p<f.parts.length;p++){
        const part=f.parts[p],cipher=await loadPart(part.sha256),data=await openTransferPart(cipher,identity,{key,transferId:manifest.transferId,file,offset:part.offset,sha256:part.sha256,expectedBytes:part.bytes});
        let written=0;while(written<data.length)written+=fs.writeSync(fd,data,written,data.length-written,part.offset+written);fs.fsyncSync(fd);
        state.files[file]={parts:p+1,bytes:part.offset+part.bytes};save(progressFile,state);
      }
    }finally{fs.closeSync(fd);}
    need(fs.statSync(temporary).size===f.bytes&&await fileHash(temporary)===f.sha256,'EXPORT_FILE_HASH_MISMATCH');
  }
  const assembled=path.join(stage,'assembled');need(!fs.existsSync(assembled),'TRANSFER_COMMIT_INTERRUPTED');fs.mkdirSync(assembled,{mode:0o700});
  try{
    for(const directory of manifest.directories)fs.mkdirSync(path.join(assembled,...directory.split('/')),{recursive:true,mode:0o700});
    for(const [i,f]of manifest.files.entries()){
      const target=path.join(assembled,...f.name.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
      // Keep verified checkpoint files for retry if the final commit is lost.
      try{fs.linkSync(path.join(stage,i+'.part'),target);}catch(e){if(!['ENOTSUP','EOPNOTSUPP','EXDEV','EPERM'].includes(e.code))throw e;fs.copyFileSync(path.join(stage,i+'.part'),target,fs.constants.COPYFILE_EXCL);}fs.chmodSync(target,0o600);
    }
    const receipt={schema:'aiconnector.file-receipt.v1',key,result_sha256:resultSha,decrypted:true,files_verified:true,verified_at:new Date().toISOString(),
      files:manifest.files.map(f=>({name:f.name,sha256:f.sha256,bytes:f.bytes})),directories:manifest.directories,scope:'Files retrieved and verified; content acceptance is separate.'};
    createFile(path.join(assembled,'.aiconnector-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
    need(!fs.existsSync(destination),'EXPORT_DESTINATION_EXISTS');fs.renameSync(assembled,destination);fs.rmSync(stage,{recursive:true,force:true});return receipt;
  }catch(e){fs.rmSync(assembled,{recursive:true,force:true});throw e;}
}
export async function dataCli(args){
  const command=args.shift(),option=(name)=>{const i=args.indexOf('--'+name);need(i>=0&&typeof args[i+1]==='string','MISSING_DATA_OPTION');return args[i+1];};
  if(command==='init-key'){
    const identityFile=path.resolve(option('identity')),recipientFile=path.resolve(option('recipient'));
    need(identityFile!==recipientFile&&!fs.existsSync(identityFile)&&!fs.existsSync(recipientFile),'EXPORT_KEY_EXISTS');
    const keys=await newExportIdentity();createFile(identityFile,keys.identity+'\n');
    try{createFile(recipientFile,keys.recipient+'\n');}catch(e){fs.unlinkSync(identityFile);throw e;}
    return {recipient:keys.recipient,recipient_sha256:sha(keys.recipient),private_key_saved:true};
  }
  if(command==='make-task'){
    const task=transferTask({task_id:option('task-id'),revision:Number(option('revision')),run_id:option('run-id'),profile:option('profile'),recipient_sha256:option('recipient-sha256')});validateTransferTask(task);return task;
  }
  if(['authorize','authorize-owned'].includes(command)){
    need(args.includes('--allow-public-ciphertext'),'EXPORT_CHANNEL_NOT_AUTHORIZED');
    const configFile=path.resolve(option('config')),c=loadConfig(configFile);need(c.node==='windows-inner','RECEIVER_ONLY');
    const id=option('profile');need(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id)&&!['__proto__','constructor','prototype','watch-catalog','server-maintenance'].includes(id),'INVALID_EXPORT_PROFILE_ID');
    need(!Object.hasOwn(c.runner.profiles,id),'EXPORT_PROFILE_EXISTS');
    let recipient;
    if(args.includes('--recipient-text'))recipient=option('recipient-text').trim();
    else{const recipientFile=path.resolve(option('recipient'));need(fs.statSync(recipientFile).size<=256,'INVALID_EXPORT_RECIPIENT');recipient=fs.readFileSync(recipientFile,'utf8').trim();}
    let profile;
    if(command==='authorize-owned'){
      const old=await loadSecrets(c),keys=old.fileTransferIdentity?{identity:old.fileTransferIdentity,recipient:old.fileTransferRecipient}:await newExportIdentity();
      profile=ownedTransferProfile(recipient,keys.recipient);validateOwnedProfile(profile);await storeSecrets(c,{...old,fileTransferIdentity:keys.identity,fileTransferRecipient:keys.recipient});
    }else{profile=exportProfile(json(path.resolve(option('grant'))),recipient,{allowPublicCiphertext:true});validateExportProfile(profile);}
    const before=fs.readFileSync(configFile),disk=JSON.parse(before.toString('utf8').replace(/^\uFEFF/,''));disk.runner.profiles={...disk.runner.profiles,[id]:profile};
    const backup=configFile+'.export-backup-'+Date.now();createFile(backup,before);
    need(sha(fs.readFileSync(configFile))===sha(before),'EXPORT_AUTHORIZATION_CHANGED');atomic(configFile,JSON.stringify(disk,null,2)+'\n');
    let reloaded=false;
    if(args.includes('--reload')){
      const token=fs.readFileSync(path.join(c.dataDir,'dashboard.token'),'utf8');
      const response=await localRequest(`http://127.0.0.1:${c.port}/api/reload-agent`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',timeoutSeconds:30});
      const value=JSON.parse(response.body);need(response.status===200&&value.reloaded===true,'EXPORT_RELOAD_REQUIRED');reloaded=true;
    }
    return {saved:true,profile:id,recipient_sha256:sha(recipient),reload_required:!reloaded,scope:profile.access?.scope||'fixed-local-files',...(profile.export?{max_bytes:profile.export.maxBytes}:{})};
  }
  if(command==='decrypt'){
    const file=path.resolve(option('identity')),stat=fs.lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=256,'INVALID_EXPORT_IDENTITY_FILE');
    const key=option('key'),config=args.includes('--config')?loadConfig(path.resolve(option('config'))):null;
    const loadPart=config?async sha256=>{
      need(config.node==='mac-outer','SENDER_ONLY');const token=fs.readFileSync(path.join(config.dataDir,'dashboard.token'),'utf8');
      const response=await localRequest(`http://127.0.0.1:${config.port}/api/transfers/fetch-part`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({key,sha256}),timeoutSeconds:120});
      const value=JSON.parse(response.body);need(response.status===200&&value.verified===true,'TRANSFER_PART_FETCH_FAILED');const expected=path.join(config.stateDir,'artifacts',sha256+'.zip');need(value.path===expected,'TRANSFER_PART_BINDING_MISMATCH');return fs.readFileSync(expected);
    }:undefined;
    const receipt=await decryptResult({result:path.resolve(option('result')),expectedSha:option('sha256'),identity:fs.readFileSync(file,'utf8').trim(),key,destination:path.resolve(option('destination')),loadPart});
    // Private file names and plaintext hashes stay in the local receipt.
    return {key:receipt.key,decrypted:true,files_verified:true,file_count:receipt.files.length,result_sha256:receipt.result_sha256,receipt_saved:true};
  }
  throw new Error('UNKNOWN_DATA_COMMAND');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await dataCli(process.argv.slice(2)),null,2));}catch(e){console.error(cleanError(e));process.exitCode=1;}
}
