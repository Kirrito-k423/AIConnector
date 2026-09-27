import fs from 'node:fs';
import path from 'node:path';
import {need,sha,read,save,atomic,now,run,safeEnv,loadConfig,cleanError} from './common.mjs';
import {WatchClient} from './watch.mjs';
import {localRequest} from './http.mjs';

const identifier=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export function pointer(value,p) {
  need(typeof p==='string'&&(p===''||p.startsWith('/')),'INVALID_JSON_POINTER');
  return p===''?value:p.slice(1).split('/').map(s=>s.replaceAll('~1','/').replaceAll('~0','~')).reduce((v,k)=>v&&Object.hasOwn(v,k)?v[k]:undefined,value);
}
export function validateMaintenance(p) {
  need(p.kind==='maintenance'&&p.maintenance?.enabled===true,'MAINTENANCE_NOT_AUTHORIZED');
  need(typeof p.revision==='string'&&/^[\w.-]{1,128}$/.test(p.revision),'MAINTENANCE_REVISION_REQUIRED');
  for(const [id,f]of Object.entries(p.maintenance.files||{})){
    need(identifier.test(id)&&path.isAbsolute(f.path),'INVALID_MAINTENANCE_FILE');
    need(['text','json','service-config'].includes(f.format),'INVALID_FILE_FORMAT');
    if(f.write)need(Array.isArray(f.pointers)&&f.pointers.length>0||f.format==='text','WRITE_SCOPE_REQUIRED');
    for(const x of f.pointers||[])need(typeof x==='string'&&x.startsWith('/')&&!x.includes('__proto__')&&!x.includes('/credentials'),'INVALID_WRITE_SCOPE');
  }
  for(const [id,c]of Object.entries(p.maintenance.commands||{}))need(identifier.test(id)&&Array.isArray(c.argv)&&c.argv.length>0&&c.argv.every(x=>typeof x==='string')&&typeof c.readOnly==='boolean'&&Number.isInteger(c.timeoutSeconds??30)&&(c.timeoutSeconds??30)>=1&&(c.timeoutSeconds??30)<=600,'INVALID_MAINTENANCE_COMMAND');
  for(const [id,a]of Object.entries(p.maintenance.apis||{})){
    const u=new URL(a.baseUrl);need(identifier.test(id)&&u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'INVALID_MAINTENANCE_API');
    need(typeof a.route==='string'&&a.route.startsWith('/api/')&&!a.route.includes('://')&&['GET','POST'].includes(a.method||'GET')&&typeof a.readOnly==='boolean','INVALID_MAINTENANCE_API');
    need(['none','watch','dashboard'].includes(a.auth||'none'),'INVALID_MAINTENANCE_API_AUTH');
    if(a.auth==='dashboard')need(path.isAbsolute(a.tokenFile),'INVALID_MAINTENANCE_API_AUTH');
  }
}
export class Maintenance {
  constructor(spec,dir,{signal,redact=s=>s,event=()=>{}}={}) {
    validateMaintenance(spec.profile);Object.assign(this,{spec,dir,signal,redact,event});this.policy=spec.profile.maintenance;
    this.file=path.join(dir,'actions.json');this.actions=read(this.file,{});
  }
  persist(){save(this.file,this.actions);}
  async action(id,kind,request,fn){
    need(identifier.test(id),'INVALID_ACTION_ID');const digest=sha(JSON.stringify({kind,request})),previous=this.actions[id];
    if(previous){need(previous.digest===digest,'ACTION_ID_CONFLICT');need(previous.state==='done','ACTION_UNKNOWN');return previous.result;}
    need(!Object.values(this.actions).some(a=>a.state==='unknown'||a.state==='intent'||a.result?.unknown),'ACTION_UNKNOWN');
    need(Object.keys(this.actions).length<(this.spec.agent?.budget?.maxActions??64),'ACTION_BUDGET');
    // Intent is durable before any side effect. Unknown actions are never replayed.
    const row=this.actions[id]={id,kind,digest,state:'intent',started_at:now()};this.persist();
    try{const result=await fn(row);row.state='done';row.result=result;row.ended_at=now();this.persist();this.event('maintenance_action',{id,kind,ok:true});return result;}
    catch(e){row.error=cleanError(e);row.state=row.effect_possible?'unknown':'rejected';row.ended_at=now();this.persist();this.event('maintenance_action',{id,kind,ok:false,code:row.error});throw e;}
  }
  fileInfo(id){
    const grant=this.policy.files?.[id];need(grant,'FILE_NOT_AUTHORIZED');
    const file=path.resolve(grant.path),normalize=x=>process.platform==='win32'?x.toLowerCase():x;
    need(normalize(fs.realpathSync(file))===normalize(file)&&!fs.lstatSync(file).isSymbolicLink(),'FILE_LINK_FORBIDDEN');
    need(fs.statSync(file).isFile()&&fs.statSync(file).size<=(grant.maxBytes??65536),'LOCAL_FILE_TOO_LARGE');
    const bytes=fs.readFileSync(file);return {grant,file,bytes,digest:sha(bytes)};
  }
  readFile(id,offset=0,length=8192){
    const {bytes,digest}=this.fileInfo(id);need(Number.isInteger(offset)&&offset>=0&&Number.isInteger(length)&&length>0&&length<=16000,'INVALID_READ_RANGE');
    return {id,sha256:digest,bytes:bytes.length,offset,content:this.redact(bytes.subarray(offset,offset+length).toString('utf8')),truncated:offset+length<bytes.length};
  }
  async writeFile(action,id,expected,content,changes){
    return this.action(action,'file-write',{id,expected,content,changes},async row=>{
      const {grant,file,bytes,digest}=this.fileInfo(id);need(grant.write===true,'FILE_WRITE_NOT_AUTHORIZED');need(expected===digest,'FILE_CHANGED');
      let text=content;
      if(grant.format!=='text'){
        need(Array.isArray(changes)&&changes.length>0&&changes.length<=32,'JSON_PATCH_REQUIRED');const value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
        for(const c of changes){
          need(grant.pointers.some(p=>c.pointer===p),'JSON_POINTER_NOT_AUTHORIZED');
          const parts=c.pointer.slice(1).split('/').map(s=>s.replaceAll('~1','/').replaceAll('~0','~'));
          need(parts.every(s=>!['__proto__','prototype','constructor'].includes(s)),'INVALID_JSON_POINTER');
          let parent=value;for(const part of parts.slice(0,-1)){need(parent&&Object.hasOwn(parent,part),'JSON_PARENT_MISSING');parent=parent[part];}
          parent[parts.at(-1)]=c.value;
        }
        text=JSON.stringify(value,null,2)+'\n';
      }else need(typeof text==='string','TEXT_CONTENT_REQUIRED');
      const next=Buffer.from(text);need(next.length<=(grant.maxBytes??65536),'LOCAL_FILE_TOO_LARGE');
      need(this.redact(text)===text,'SECRET_IN_WRITE');
      if(grant.format==='service-config'){
        const candidate=file+'.aic-candidate.local.json';need(!fs.existsSync(candidate),'CONFIG_CANDIDATE_EXISTS');
        atomic(candidate,next);try{loadConfig(candidate);}finally{fs.unlinkSync(candidate);}
      }
      const backup=path.join(this.dir,'backups',action+'.bin');atomic(backup,bytes);
      Object.assign(row,{file_id:id,before_sha256:digest,after_sha256:sha(next),backup,changes:changes?.map(c=>c.pointer)||['text'],effect_possible:true});this.persist();
      atomic(file,next);need(sha(fs.readFileSync(file))===row.after_sha256,'WRITE_VERIFICATION_FAILED');
      return {id,before_sha256:digest,after_sha256:row.after_sha256,backup_action:action,changed_fields:row.changes,verified:true};
    });
  }
  async restore(action,original){
    return this.action(action,'file-restore',{original},async row=>{
      const old=this.actions[original];need(old?.backup&&old.after_sha256,'BACKUP_NOT_FOUND');
      const {file,digest,grant}=this.fileInfo(old.file_id);need(grant.write===true&&digest===old.after_sha256,'ROLLBACK_FILE_CHANGED');
      const bytes=fs.readFileSync(old.backup);need(sha(bytes)===old.before_sha256,'BACKUP_HASH_MISMATCH');
      row.effect_possible=true;this.persist();atomic(file,bytes);return {restored:true,file_id:old.file_id,sha256:sha(bytes)};
    });
  }
  async command(action,id,{verification=false}={}){
    const c=this.policy.commands?.[id];need(c,'COMMAND_NOT_AUTHORIZED');if(verification)need(c.readOnly===true,'VERIFIER_MUST_BE_READ_ONLY');
    return this.action(action,'command',{id},async row=>{
      row.effect_possible=true;this.persist();
      const signal=AbortSignal.any([this.signal||new AbortController().signal,AbortSignal.timeout((c.timeoutSeconds??30)*1000)]);
      const r=await run(c.argv[0],c.argv.slice(1),{cwd:c.cwd,env:safeEnv({AICONNECTOR_RUN_DIR:path.join(this.dir,'work'),AICONNECTOR_INPUT_DIR:path.join(this.dir,'input-files')}),signal,cap:16000});
      return {id,exit_code:r.code,stdout:this.redact(r.out),stderr:this.redact(r.err),unknown:r.code===null};
    });
  }
  async api(action,id,{verification=false}={}){
    const a=this.policy.apis?.[id];need(a,'API_NOT_AUTHORIZED');if(verification)need(a.readOnly===true,'VERIFIER_MUST_BE_READ_ONLY');
    return this.action(action,'local-api',{id},async row=>{
      const method=a.method||'GET';if(!a.readOnly){row.effect_possible=true;this.persist();}
      let value;
      if(a.auth==='watch')value=await new WatchClient({baseUrl:a.baseUrl},{signal:this.signal}).call(a.route,{method,body:a.body,maxBytes:262144});
      else {
        const headers={'Content-Type':'application/json'};
        if(a.auth==='dashboard')headers.Authorization='Bearer '+fs.readFileSync(a.tokenFile,'utf8').trim();
        const r=await localRequest(a.baseUrl+a.route,{method,headers,body:a.body===undefined?undefined:JSON.stringify(a.body),signal:this.signal,maxBytes:262144});
        need(r.status>=200&&r.status<300,'LOCAL_API_HTTP_'+r.status);value=JSON.parse(r.body);
      }
      return {id,value:JSON.parse(this.redact(JSON.stringify(value)))};
    });
  }
  publicActions(){return Object.values(this.actions).map(r=>({id:r.id,kind:r.kind,state:r.state,started_at:r.started_at,ended_at:r.ended_at,error:r.error,file_id:r.file_id,before_sha256:r.before_sha256,after_sha256:r.after_sha256,changed_fields:r.changes,exit_code:r.result?.exit_code,result_sha256:r.result?sha(JSON.stringify(r.result)):null}));}
}
