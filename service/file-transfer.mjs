import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {Encrypter,Decrypter,identityToRecipient} from 'age-encryption';
import {zipSync,strToU8} from 'fflate';
import {need,sha,atomic,read,save,now} from './common.mjs';
import {decodeInputArchive} from './inputs.mjs';

export const TRANSFER_REVISION='file-transfer-v1',PART_BYTES=3*1024*1024;
export const TRANSFER_OUTPUTS=['transfer-index.age','transfer-index.json'];
export const TRANSFER_CHECKS=[{id:'transfer-sealed',kind:'output-json',file:'transfer-index.json',pointer:'/sealed',equals:true}];
export function ownedTransferProfile(recipient,requestRecipient){return {
  kind:'file-transfer',mode:'transfer',executionMode:'direct',entry:'transfer-files',repository:'aiconnector-file-transfer',revision:TRANSFER_REVISION,
  outputs:[...TRANSFER_OUTPUTS],verification:structuredClone(TRANSFER_CHECKS),
  access:{scope:'owned-filesystem',enabled:true},delivery:{kind:'age-public-relay',allowPublicCiphertext:true,recipient,requestRecipient}
};}
function recipientOK(value){need(typeof value==='string'&&/^age1[a-z0-9]{58}$/.test(value),'INVALID_EXPORT_RECIPIENT');try{const e=new Encrypter();e.addRecipient(value);}catch{throw new Error('INVALID_EXPORT_RECIPIENT');}}
export function validateOwnedProfile(p){
  need(p.kind==='file-transfer'&&p.mode==='transfer'&&p.executionMode==='direct'&&p.entry==='transfer-files'&&p.repository==='aiconnector-file-transfer'&&p.revision===TRANSFER_REVISION&&p.allowTaskArguments!==true,'INVALID_EXPORT_PROFILE');
  need(p.access?.scope==='owned-filesystem'&&p.access.enabled===true,'EXPORT_NOT_AUTHORIZED');
  need(p.delivery?.kind==='age-public-relay'&&p.delivery.allowPublicCiphertext===true,'EXPORT_CHANNEL_NOT_AUTHORIZED');recipientOK(p.delivery.recipient);recipientOK(p.delivery.requestRecipient);
  need(JSON.stringify(p.outputs)===JSON.stringify(TRANSFER_OUTPUTS)&&JSON.stringify(p.verification)===JSON.stringify(TRANSFER_CHECKS),'INVALID_EXPORT_CONTRACT');
}
export async function encryptRequest(request,recipient,key){
  recipientOK(recipient);need(['read','list','find'].includes(request.operation)&&Array.isArray(request.paths)&&request.paths.length>0&&request.paths.length<=64&&request.paths.every(p=>typeof p==='string'&&p.length>0&&p.length<=32768&&!p.includes('\0'))&&(request.operation!=='find'||typeof request.name==='string'&&request.name.length>0&&request.name.length<=256&&!/[\\/\0]/.test(request.name)),'INVALID_TRANSFER_REQUEST');
  const bytes=Buffer.from(JSON.stringify({schema:'aiconnector.file-request.v1',key,...request}));need(bytes.length<=65536,'TRANSFER_REQUEST_TOO_LARGE');
  const e=new Encrypter();e.addRecipient(recipient);const sealed=await e.encrypt(bytes);return Buffer.from(zipSync({'request.age':sealed},{level:0}));
}
export function ownedTransferTask({task_id,revision,run_id,profile,recipient_sha256,request_recipient_sha256,request_zip_sha256,artifacts=[]}){return {
  task_id,revision,run_id,title:'文件传输',objective:'读取接收端所属账户可访问的文件或目录，加密回传。',code:{repository:'aiconnector-file-transfer',revision:TRANSFER_REVISION},
  environment:{target:profile},invocation:{entry:'transfer-files',arguments:[]},
  requirements:{mode:'transfer',execution_mode:'direct',tools:[],checks:['transfer-sealed'],data_export:{format:'age-v1',recipient_sha256,request_recipient_sha256,request_zip_sha256}},
  acceptance:['文件或目录已加密封装；Mac 解密、逐文件校验与资料验收须分别确认。'],artifacts
};}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export function validateOwnedTask(t){
  need(Object.keys(t).every(k=>['task_id','revision','run_id','title','objective','code','environment','invocation','requirements','acceptance','artifacts','receiver_config_sha256'].includes(k)),'PRIVATE_TRANSFER_METADATA_FORBIDDEN');
  const d=t.requirements?.data_export;need(d&&['recipient_sha256','request_recipient_sha256','request_zip_sha256'].every(k=>/^[a-f0-9]{64}$/.test(d[k])),'INVALID_EXPORT_RECIPIENT_PIN');
  need(Array.isArray(t.artifacts)&&t.artifacts.length<=1&&t.artifacts.every(a=>a.sha256===d.request_zip_sha256),'TRANSFER_REQUEST_BINDING_MISMATCH');
  const expected=ownedTransferTask({...t,profile:t.environment?.target,...d,artifacts:t.artifacts});
  for(const k of ['title','objective','code','environment','invocation','requirements','acceptance'])need(JSON.stringify(canonical(t[k]))===JSON.stringify(canonical(expected[k])),'PRIVATE_TRANSFER_METADATA_FORBIDDEN');
}
async function decrypt(bytes,identity){const d=new Decrypter();try{d.addIdentity(identity);return Buffer.from(await d.decrypt(bytes));}catch{throw new Error('EXPORT_DECRYPT_FAILED');}}
export async function readTransferRequest(spec,dir,identity){
  validateOwnedProfile(spec.profile);validateOwnedTask(spec.task);need(identity&&await identityToRecipient(identity)===spec.profile.delivery.requestRecipient,'TRANSFER_IDENTITY_MISMATCH');
  need(spec.task.artifacts.length===1,'TRANSFER_REQUEST_REQUIRED');const a=spec.task.artifacts[0],bytes=fs.readFileSync(path.join(dir,'inputs',a.name));
  need(bytes.length===a.bytes&&sha(bytes)===a.sha256&&a.sha256===spec.task.requirements.data_export.request_zip_sha256,'TRANSFER_REQUEST_BINDING_MISMATCH');
  const entries=decodeInputArchive(bytes);need(Object.keys(entries).length===1&&entries['request.age']&&entries['request.age'].length<131072,'INVALID_TRANSFER_REQUEST');
  const plain=await decrypt(entries['request.age'],identity);need(plain.length<=65536,'TRANSFER_REQUEST_TOO_LARGE');const r=JSON.parse(plain);
  need(r.schema==='aiconnector.file-request.v1'&&r.key===spec.key&&['read','list','find'].includes(r.operation)&&Array.isArray(r.paths)&&r.paths.length>0&&r.paths.length<=64&&(r.operation!=='find'||typeof r.name==='string'&&r.name.length>0&&r.name.length<=256&&!/[\\/\0]/.test(r.name)),'INVALID_TRANSFER_REQUEST');
  r.paths=r.paths.flatMap(p=>p==='@home'?[os.homedir()]:p==='@roots'?process.platform==='win32'?Array.from({length:26},(_,i)=>String.fromCharCode(65+i)+':\\').filter(p=>fs.existsSync(p)):['/']:[p]);
  need(r.paths.every(p=>typeof p==='string'&&path.isAbsolute(p)&&p.length<=32768&&!p.includes('\0')),'INVALID_TRANSFER_REQUEST');return r;
}
function safeName(name){return typeof name==='string'&&name.length<=32768&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[\\:\x00-\x1f]/.test(p)&&!/[. ]$/.test(p)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));}
const identity=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
async function* walk(file,name,{workspace,excluded}={}){
  const normalize=p=>process.platform==='win32'?p.toLowerCase():p;
  if(workspace&&normalize(path.resolve(file))===normalize(workspace)){excluded.push({name,reason:'active-transfer-workspace'});return;}
  const stat=await fs.promises.lstat(file);need(!stat.isSymbolicLink(),'EXPORT_LINK_FORBIDDEN');
  if(stat.isFile()){need(safeName(name),'INVALID_EXPORT_NAME');yield {file,name,stat};return;}
  need(stat.isDirectory(),'EXPORT_NOT_REGULAR_FILE');
  need(safeName(name),'INVALID_EXPORT_NAME');yield {file,name,stat,directory:true};
  const d=await fs.promises.opendir(file);for await(const child of d){yield* walk(path.join(file,child.name),name+'/'+child.name,{workspace,excluded});}
  need(identity(stat,await fs.promises.lstat(file)),'EXPORT_DIRECTORY_CHANGED');
}
export async function buildTransfer(spec,dir,identityKey,{signal,checkGrant=()=>{}}={}){
  const request=await readTransferRequest(spec,dir,identityKey),stateFile=path.join(dir,'transfer-state.json');
  const previous=read(stateFile);if(previous){need(previous.key===spec.key&&previous.request_sha256===spec.task.requirements.data_export.request_zip_sha256,'TRANSFER_REQUEST_BINDING_MISMATCH');need(previous.state==='sealed','TRANSFER_INTERRUPTED');return previous;}
  const state={schema:'aiconnector.transfer-state.v1',key:spec.key,request_sha256:spec.task.requirements.data_export.request_zip_sha256,state:'reading',parts:[],started_at:now()};save(stateFile,state);
  const files=[],directories=[],excluded=[],workspace=fs.realpathSync(dir),partDir=path.join(dir,'transfer-parts');fs.mkdirSync(partDir,{recursive:true,mode:0o700});
  const addPart=async(payload,record)=>{
    checkGrant();need(!signal?.aborted,'EXECUTION_TIMEOUT');
    const e=new Encrypter();e.addRecipient(spec.profile.delivery.recipient);const privateBytes=zipSync({'binding.json':strToU8(JSON.stringify({key:spec.key,...record})),'bytes':payload},{level:0});
    const sealed=await e.encrypt(privateBytes),zip=Buffer.from(zipSync({'part.age':sealed},{level:0})),digest=sha(zip),name=digest+'.zip';
    atomic(path.join(partDir,name),zip);state.parts.push({sha256:digest,bytes:zip.length,name});return digest;
  };
  const transferId=crypto.randomBytes(16).toString('hex');
  if(['list','find'].includes(request.operation)){
    const rows=[],errors=[],skipped=[];
    const find=async source=>{checkGrant();need(!signal?.aborted,'EXECUTION_TIMEOUT');try{
      const stat=await fs.promises.lstat(source);if(stat.isSymbolicLink()){skipped.push({path:source,reason:'link'});return;}
      if(path.basename(source).toLowerCase()===request.name.toLowerCase())rows.push({path:source,type:stat.isDirectory()?'directory':'file'});
      if(stat.isDirectory()){const d=await fs.promises.opendir(source);for await(const entry of d)await find(path.join(source,entry.name));}
    }catch(e){if(['EACCES','EPERM','ENOENT','EBUSY'].includes(e.code))errors.push({path:source,code:e.code});else throw e;}};
    for(const source of request.paths){if(request.operation==='find'){await find(source);continue;}checkGrant();const stat=await fs.promises.lstat(source);need(!stat.isSymbolicLink(),'EXPORT_LINK_FORBIDDEN');
      if(stat.isDirectory()){const d=await fs.promises.opendir(source);for await(const entry of d){need(!signal?.aborted,'EXECUTION_TIMEOUT');rows.push({path:path.join(source,entry.name),type:entry.isDirectory()?'directory':entry.isFile()?'file':entry.isSymbolicLink()?'link':'other'});}}
      else rows.push({path:source,type:stat.isFile()?'file':'other'});
    }
    const bytes=Buffer.from(JSON.stringify({schema:'aiconnector.file-list.v1',operation:request.operation,paths:request.paths,entries:rows,query_complete:errors.length===0&&skipped.length===0,errors,skipped})),hash=sha(bytes),parts=[];
    for(let offset=0;offset<bytes.length;offset+=PART_BYTES)parts.push({sha256:await addPart(bytes.subarray(offset,offset+PART_BYTES),{transferId,file:0,offset}),offset,bytes:Math.min(PART_BYTES,bytes.length-offset)});
    files.push({name:'listing.json',bytes:bytes.length,sha256:hash,parts});
  }else for(const [selection,source] of request.paths.entries()){
    need(!(await fs.promises.lstat(source)).isSymbolicLink(),'EXPORT_LINK_FORBIDDEN');
    for await(const item of walk(await fs.promises.realpath(source),'selection-'+selection+'/'+(path.basename(source)||'root'),{workspace,excluded})){
      if(item.directory){directories.push(item.name);continue;}
      checkGrant();const fd=fs.openSync(item.file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      try{
        const before=fs.fstatSync(fd);need(identity(before,item.stat)&&fs.realpathSync(item.file)===path.resolve(item.file),'EXPORT_FILE_CHANGED');
        const hash=crypto.createHash('sha256'),parts=[],file=files.length;let offset=0;
        while(offset<before.size){
          const length=Math.min(PART_BYTES,before.size-offset),bytes=Buffer.alloc(length);let n=0;
          while(n<length){const got=fs.readSync(fd,bytes,n,length-n,offset+n);need(got>0,'EXPORT_FILE_CHANGED');n+=got;}
          hash.update(bytes);
          parts.push({sha256:await addPart(bytes,{transferId,file,offset}),offset,bytes:length});offset+=length;
        }
        need(identity(before,fs.fstatSync(fd))&&identity(before,fs.lstatSync(item.file))&&fs.realpathSync(item.file)===path.resolve(item.file),'EXPORT_FILE_CHANGED');
        files.push({name:item.name,bytes:offset,sha256:hash.digest('hex'),parts});
      }finally{fs.closeSync(fd);}
    }
  }
  checkGrant();need(!signal?.aborted,'EXECUTION_TIMEOUT');
  const manifest={schema:'aiconnector.file-transfer.v1',key:spec.key,transferId,operation:request.operation,files,directories,excluded,selection_complete:excluded.length===0},plain=Buffer.from(JSON.stringify(manifest));
  // Data size is not capped at one ZIP. Only the bounded index is an output.
  need(plain.length<3*1024*1024,'TRANSFER_INDEX_TOO_LARGE');const e=new Encrypter();e.addRecipient(spec.profile.delivery.recipient);const sealed=Buffer.from(await e.encrypt(plain));
  checkGrant();atomic(path.join(dir,'work','transfer-index.age'),sealed);
  const index={schema:'aiconnector.transfer-index.v1',key:spec.key,recipient_sha256:sha(spec.profile.delivery.recipient),index_sha256:sha(sealed),sealed:true,parts:state.parts.map(({sha256,bytes})=>({sha256,bytes}))};
  need(state.parts.length<=4096,'TRANSFER_INDEX_TOO_LARGE');
  need(Buffer.byteLength(JSON.stringify(index))<262144,'TRANSFER_INDEX_TOO_LARGE');atomic(path.join(dir,'work','transfer-index.json'),JSON.stringify(index));
  state.state='sealed';state.ended_at=now();save(stateFile,state);return state;
}
export async function openTransferIndex(bytes,index,identityKey,key){
  need(bytes.length<4*1024*1024&&index.schema==='aiconnector.transfer-index.v1'&&index.key===key&&index.sealed===true&&sha(bytes)===index.index_sha256&&sha(await identityToRecipient(identityKey))===index.recipient_sha256,'EXPORT_BINDING_MISMATCH');
  need(Array.isArray(index.parts)&&index.parts.length<=4096&&index.parts.every(p=>/^[a-f0-9]{64}$/.test(p.sha256)&&Number.isInteger(p.bytes)&&p.bytes>0&&p.bytes<5242880)&&new Set(index.parts.map(p=>p.sha256)).size===index.parts.length,'INVALID_TRANSFER_INDEX');
  const manifest=JSON.parse(await decrypt(bytes,identityKey));need(manifest.schema==='aiconnector.file-transfer.v1'&&manifest.key===key&&/^[a-f0-9]{32}$/.test(manifest.transferId)&&Array.isArray(manifest.files),'INVALID_TRANSFER_INDEX');
  if(manifest.excluded===undefined&&manifest.selection_complete===undefined){manifest.excluded=[];manifest.selection_complete=true;}
  need(Array.isArray(manifest.excluded)&&manifest.excluded.every(e=>safeName(e.name)&&e.reason==='active-transfer-workspace')&&typeof manifest.selection_complete==='boolean'&&manifest.selection_complete===(manifest.excluded.length===0),'INVALID_TRANSFER_INDEX');
  const names=new Set(),parts=new Map(index.parts.map(p=>[p.sha256,p])),used=new Set();
  need(Array.isArray(manifest.directories)&&manifest.directories.every(safeName),'INVALID_TRANSFER_INDEX');
  const dirs=new Set(manifest.directories.map(n=>n.toLowerCase()));need(dirs.size===manifest.directories.length,'INVALID_TRANSFER_INDEX');
  for(const f of manifest.files){need(safeName(f.name)&&!names.has(f.name.toLowerCase())&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&/^[a-f0-9]{64}$/.test(f.sha256)&&Array.isArray(f.parts),'INVALID_TRANSFER_INDEX');names.add(f.name.toLowerCase());let offset=0;
    need(!dirs.has(f.name.toLowerCase()),'INVALID_TRANSFER_INDEX');
    for(const p of f.parts){need(parts.has(p.sha256)&&!used.has(p.sha256)&&p.offset===offset&&Number.isInteger(p.bytes)&&p.bytes>0&&p.bytes<=PART_BYTES,'INVALID_TRANSFER_INDEX');used.add(p.sha256);offset+=p.bytes;}
    need(offset===f.bytes,'INVALID_TRANSFER_INDEX');
  }
  need(used.size===parts.size,'INVALID_TRANSFER_INDEX');return manifest;
}
export async function openTransferPart(bytes,identityKey,{key,transferId,file,offset,sha256,expectedBytes}){
  need(bytes.length<5242880&&sha(bytes)===sha256,'RESULT_HASH_MISMATCH');const entries=decodeInputArchive(bytes);need(Object.keys(entries).length===1&&entries['part.age'],'INVALID_TRANSFER_PART');
  const privateParts=decodeInputArchive(await decrypt(entries['part.age'],identityKey)),binding=JSON.parse(new TextDecoder().decode(privateParts['binding.json']));
  need(Object.keys(privateParts).length===2&&JSON.stringify(binding)===JSON.stringify({key,transferId,file,offset})&&privateParts.bytes?.length===expectedBytes,'TRANSFER_PART_BINDING_MISMATCH');return Buffer.from(privateParts.bytes);
}
