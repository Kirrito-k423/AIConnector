import fs from 'node:fs';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {need,sha} from './common.mjs';
import {Encrypter,Decrypter,generateIdentity,identityToRecipient} from 'age-encryption';
import {decodeInputArchive} from './inputs.mjs';
import {validateOwnedTask} from './file-transfer.mjs';

// Source paths and delivery names are a local grant, never task/model arguments.
// Return a private in-memory bundle. Callers must encrypt it before publication.
export const MAX_EXPORT_BYTES=3*1024*1024;
export const EXPORT_REVISION='file-export-v1';
export const EXPORT_OUTPUTS=['transfer.age','transfer.json'];
export const EXPORT_CHECKS=[{id:'export-sealed',kind:'output-json',file:'transfer.json',pointer:'/sealed',equals:true}];
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const safePart=s=>s.length>0&&s!=='.'&&s!=='..'&&!/[\\/:\x00-\x1f]/.test(s)&&!/[. ]$/.test(s)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s);
export function validateExportGrant(g){
  need(g?.enabled===true,'EXPORT_NOT_AUTHORIZED');
  need(typeof g.root==='string'&&path.isAbsolute(g.root),'INVALID_EXPORT_ROOT');
  need(Number.isInteger(g.maxBytes)&&g.maxBytes>0&&g.maxBytes<=MAX_EXPORT_BYTES,'INVALID_EXPORT_QUOTA');
  need(Array.isArray(g.files)&&g.files.length>0&&g.files.length<=128,'INVALID_EXPORT_FILES');
  const names=new Set();
  for(const f of g.files){
    need(typeof f.path==='string'&&f.path.length<=512&&f.path.split('/').every(safePart),'INVALID_EXPORT_PATH');
    need(typeof f.name==='string'&&f.name.length<=128&&safePart(f.name)&&!['manifest.json','.aiconnector-receipt.json'].includes(f.name.toLowerCase()),'INVALID_EXPORT_NAME');
    const key=f.name.toLowerCase();need(!names.has(key),'DUPLICATE_EXPORT_NAME');names.add(key);
  }
  return g;
}
function identity(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
function stat(file){try{return fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')throw new Error('EXPORT_FILE_MISSING');throw e;}}
export function collectExport(grant,{key,secrets=[]}={}){
  const g=validateExportGrant(grant),rootStat=stat(g.root);
  need(rootStat.isDirectory()&&!rootStat.isSymbolicLink(),'EXPORT_LINK_FORBIDDEN');
  const root=fs.realpathSync(g.root),entries={},files=[];let total=0;
  for(const [i,item] of g.files.entries()){
    const parts=item.path.split('/');let file=root;
    for(const part of parts){file=path.join(file,part);need(!stat(file).isSymbolicLink(),'EXPORT_LINK_FORBIDDEN');}
    const before=stat(file);need(before.isFile(),'EXPORT_NOT_REGULAR_FILE');need(before.nlink===1,'EXPORT_LINK_FORBIDDEN');
    total+=before.size;need(total<=g.maxBytes,'EXPORT_TOO_LARGE');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{
      const current=fs.fstatSync(fd);need(current.isFile()&&identity(current,before)&&current.nlink===1,'EXPORT_FILE_CHANGED');
      // realpath and path identity are checked again after opening to reject a
      // replaced ancestor (including Windows junctions) before reading content.
      need(fs.realpathSync(file)===file&&identity(stat(file),current),'EXPORT_LINK_FORBIDDEN');
      const buffer=Buffer.alloc(current.size+1);let size=0;
      while(size<buffer.length){const n=fs.readSync(fd,buffer,size,buffer.length-size,size);if(!n)break;size+=n;}
      need(size===current.size&&identity(fs.fstatSync(fd),current)&&identity(stat(file),current)&&fs.realpathSync(file)===file,'EXPORT_FILE_CHANGED');
      const data=buffer.subarray(0,size),entry='files/'+String(i).padStart(4,'0');entries[entry]=new Uint8Array(data);
      need(!secrets.some(s=>typeof s==='string'&&s.length>3&&data.includes(Buffer.from(s))),'SECRET_IN_EXPORT');
      files.push({entry,name:item.name,bytes:size,sha256:sha(data)});
    }finally{fs.closeSync(fd);}
  }
  need(rootStat.dev===stat(g.root).dev&&rootStat.ino===stat(g.root).ino&&fs.realpathSync(g.root)===root,'EXPORT_ROOT_CHANGED');
  entries['manifest.json']=strToU8(JSON.stringify({schema:'aiconnector.export-manifest.v1',...(key?{key}:{}),files}));
  return {bytes:Buffer.from(zipSync(entries,{level:0})),fileCount:files.length,totalBytes:total};
}

export function exportProfile(grant,recipient,{allowPublicCiphertext=false}={}){
  return {kind:'file-export',mode:'transfer',executionMode:'direct',repository:'aiconnector-file-export',revision:EXPORT_REVISION,entry:'export-files',
    outputs:[...EXPORT_OUTPUTS],verification:structuredClone(EXPORT_CHECKS),export:grant,delivery:{kind:'age-public-relay',recipient,allowPublicCiphertext}};
}
export function validateExportProfile(p){
  need(p.kind==='file-export'&&p.mode==='transfer'&&p.executionMode==='direct'&&p.repository==='aiconnector-file-export'&&p.revision===EXPORT_REVISION&&p.entry==='export-files'&&p.allowTaskArguments!==true,'INVALID_EXPORT_PROFILE');
  validateExportGrant(p.export);
  need(JSON.stringify(p.outputs)===JSON.stringify(EXPORT_OUTPUTS)&&JSON.stringify(p.verification)===JSON.stringify(EXPORT_CHECKS),'INVALID_EXPORT_CONTRACT');
  // Installing the feature or configuring a directory does not authorize even
  // ciphertext on a public repository. No fallback to plaintext or another host.
  need(p.delivery?.kind==='age-public-relay'&&p.delivery.allowPublicCiphertext===true,'EXPORT_CHANNEL_NOT_AUTHORIZED');
  need(typeof p.delivery.recipient==='string'&&/^age1[a-z0-9]{58}$/.test(p.delivery.recipient),'INVALID_EXPORT_RECIPIENT');
  const e=new Encrypter();try{e.addRecipient(p.delivery.recipient);}catch{throw new Error('INVALID_EXPORT_RECIPIENT');}
}
export function transferTask({task_id,revision,run_id,profile,recipient_sha256}){
  return {task_id,revision,run_id,title:'文件传输',objective:'导出接收端固定授权文件并加密回传。',
    code:{repository:'aiconnector-file-export',revision:EXPORT_REVISION},environment:{target:profile},invocation:{entry:'export-files',arguments:[]},
    requirements:{mode:'transfer',execution_mode:'direct',tools:[],checks:['export-sealed'],data_export:{format:'age-v1',recipient_sha256}},
    acceptance:['固定授权文件已加密封装；Mac 解密、清单校验与取件成功须单独确认。'],artifacts:[]};
}
export function validateTransferTask(t){
  if(t?.code?.repository==='aiconnector-file-transfer')return validateOwnedTask(t);
  const allowed=['task_id','revision','run_id','title','objective','code','environment','invocation','requirements','acceptance','artifacts','receiver_config_sha256'];
  need(t&&Object.keys(t).every(k=>allowed.includes(k)),'PRIVATE_TRANSFER_METADATA_FORBIDDEN');
  const expected=transferTask({...t,profile:t.environment?.target,recipient_sha256:t.requirements?.data_export?.recipient_sha256});
  // Fixed public text and exact subobjects prevent paths, source or internal
  // file names being copied into public Issue metadata by another AI.
  for(const k of ['title','objective','code','environment','invocation','requirements','acceptance','artifacts'])need(JSON.stringify(canonical(t[k]))===JSON.stringify(canonical(expected[k])),'PRIVATE_TRANSFER_METADATA_FORBIDDEN');
  need(/^[a-f0-9]{64}$/.test(t.requirements.data_export.recipient_sha256),'INVALID_EXPORT_RECIPIENT_PIN');
}
export async function sealExport(p,key,{secrets=[]}={}){
  validateExportProfile(p);
  const bundle=collectExport(p.export,{key,secrets}),e=new Encrypter();e.addRecipient(p.delivery.recipient);
  const bytes=Buffer.from(await e.encrypt(bundle.bytes));
  return {bytes,evidence:{schema:'aiconnector.sealed-export.v1',key,format:'age-v1',recipient_sha256:sha(p.delivery.recipient),ciphertext_sha256:sha(bytes),ciphertext_bytes:bytes.length,sealed:true,
    scope:'Encrypted package prepared; transport receipt and recipient file verification are separate.'}};
}
export async function newExportIdentity(){const identity=await generateIdentity();return {identity,recipient:await identityToRecipient(identity)};}
export async function openExport(bytes,evidence,identity,key){
  need(bytes.length<=MAX_EXPORT_BYTES+128*1024&&evidence?.schema==='aiconnector.sealed-export.v1'&&evidence.sealed===true&&evidence.format==='age-v1'&&evidence.key===key&&bytes.length===evidence.ciphertext_bytes&&sha(bytes)===evidence.ciphertext_sha256,'EXPORT_BINDING_MISMATCH');
  let recipient;try{recipient=await identityToRecipient(identity);}catch{throw new Error('INVALID_EXPORT_IDENTITY');}
  need(sha(recipient)===evidence.recipient_sha256,'EXPORT_RECIPIENT_MISMATCH');
  const d=new Decrypter();d.addIdentity(identity);let plaintext;
  try{plaintext=await d.decrypt(bytes);}catch{throw new Error('EXPORT_DECRYPT_FAILED');}
  need(plaintext.length<=MAX_EXPORT_BYTES+128*1024,'EXPORT_TOO_LARGE');
  const entries=decodeInputArchive(Buffer.from(plaintext)),manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(entries['manifest.json']));
  need(manifest.schema==='aiconnector.export-manifest.v1'&&manifest.key===key&&Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=128,'INVALID_EXPORT_MANIFEST');
  const names=new Set(),used=new Set(['manifest.json']);let total=0;
  const files=manifest.files.map((f,i)=>{
    need(typeof f.name==='string'&&f.name.length<=128&&safePart(f.name)&&!['manifest.json','.aiconnector-receipt.json'].includes(f.name.toLowerCase())&&!names.has(f.name.toLowerCase()),'INVALID_EXPORT_NAME');names.add(f.name.toLowerCase());
    need(f.entry==='files/'+String(i).padStart(4,'0')&&entries[f.entry]&&Number.isInteger(f.bytes)&&f.bytes>=0&&/^[a-f0-9]{64}$/.test(f.sha256),'INVALID_EXPORT_MANIFEST');used.add(f.entry);
    const data=Buffer.from(entries[f.entry]);total+=data.length;need(total<=MAX_EXPORT_BYTES&&data.length===f.bytes&&sha(data)===f.sha256,'EXPORT_FILE_HASH_MISMATCH');return {name:f.name,bytes:data,sha256:f.sha256};
  });
  need(Object.keys(entries).length===used.size&&Object.keys(entries).every(n=>used.has(n)),'INVALID_EXPORT_MANIFEST');return files;
}
