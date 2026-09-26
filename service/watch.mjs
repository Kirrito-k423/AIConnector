import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {setTimeout as pause} from 'node:timers/promises';
import {need,read,save,sha,now,atomic} from './common.mjs';
import {localRequest} from './http.mjs';

const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const publicJob=j=>({id:j.id,status:j.status,selectedMachineId:j.selectedMachineId,machineName:j.machineName,createdAt:j.createdAt,updatedAt:j.updatedAt,finishedAt:j.finishedAt,exitCode:j.exitCode,archiveReady:j.archiveReady,archiveError:j.archiveError,error:j.error});
const terminal=j=>['succeeded','failed'].includes(j.status)&&Number.isInteger(j.exitCode);

// Parse bounded regular files in memory; never extract remote paths or follow tar links.
export function archiveFiles(bytes) {
  const tar=gunzipSync(bytes,{maxOutputLength:16*1024*1024}),files=new Map();
  for(let offset=0;offset+512<=tar.length;) {
    const h=tar.subarray(offset,offset+512);if(h.every(b=>b===0))break;
    const field=(from,len)=>h.subarray(from,from+len).toString('utf8').split('\0')[0];
    const checksum=parseInt(field(148,8).trim(),8);
    need([...h].reduce((n,b,i)=>n+(i>=148&&i<156?32:b),0)===checksum,'INVALID_TAR_CHECKSUM');
    let name=(field(345,155)?field(345,155)+'/':'')+field(0,100);name=name.replace(/^\.\//,'');
    const size=parseInt(field(124,12).trim()||'0',8),type=field(156,1);
    need(Number.isSafeInteger(size)&&size>=0&&offset+512+size<=tar.length,'INVALID_TAR_SIZE');
    need(!name.startsWith('/')&&!name.includes('\\')&&!name.split('/').includes('..'),'UNSAFE_TAR_PATH');
    if(type==='0'||type==='') {need(!files.has(name),'DUPLICATE_TAR_FILE');files.set(name,tar.subarray(offset+512,offset+512+size));}
    else need(type==='5','UNSUPPORTED_TAR_ENTRY');
    offset+=512+Math.ceil(size/512)*512;
  }
  return files;
}

export function validateWatchProfile(p) {
  need(p&&p.kind==='simplehtmlwatch','WATCH_PROFILE_REQUIRED');
  need(typeof p.shell==='string'&&p.shell.length>0&&typeof p.revisionCommand==='string'&&p.revisionCommand.length>0,'WATCH_COMMAND_REQUIRED');
  need(!(p.machineId&&p.group),'INVALID_WATCH_SELECTOR');
  need((p.machineId&&typeof p.machineId==='string')||(p.group&&typeof p.group==='string')||p.allowAnyMachine===true,'WATCH_SELECTOR_REQUIRED');
  need(!p.allowTaskArguments,'WATCH_TASK_ARGUMENTS_DISABLED');
}

export class WatchClient {
  constructor(config,{signal}={}) {this.config=config;this.signal=signal;this.token='';}
  async call(route,{method='GET',body,maxBytes=1048576,bytes=false}={}) {
    for(let attempt=0;attempt<2;attempt++) {
      if(!this.token){const r=await localRequest(this.config.baseUrl+'/',{signal:this.signal});need(r.status===200,'WATCH_UNAVAILABLE');this.token=r.body.toString('utf8').match(/<meta\s+name="watch-token"\s+content="([^"]+)"/)?.[1]||'';need(this.token,'WATCH_TOKEN_MISSING');}
      const r=await localRequest(this.config.baseUrl+route,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{'X-Watch-Token':this.token,'Content-Type':'application/json'},signal:this.signal,maxBytes});
      // A rejected token is checked before dispatch in SHW, so only this response can retry POST.
      if(r.status===403&&attempt===0){this.token='';continue;}
      need(r.status>=200&&r.status<300,'WATCH_HTTP_'+r.status);
      return bytes?r.body:JSON.parse(r.body.toString('utf8'));
    }
  }
  async environment(profile={}) {
    const params=new URLSearchParams();if(profile.machineId)params.set('machineId',profile.machineId);if(profile.group)params.set('group',profile.group);
    const [status,ready]=await Promise.all([this.call('/api/status'),this.call('/api/tasks/ready?'+params)]);
    return {observed_at:now(),ready,monitor:status,ready_is_not_npu_idle:true};
  }
}

export class WatchExecution {
  constructor(spec,dir,{signal,event=()=>{},redact=s=>s}={}) {
    Object.assign(this,{spec,dir,signal,event,redact});this.client=new WatchClient(spec.agent.simpleHtmlWatch,{signal});this.file=path.join(dir,'watch-task.json');
  }
  get record(){return read(this.file);}
  remember(job) {
    const record=this.record;need(record&&record.id===job.id,'WATCH_TASK_ID_MISMATCH');
    need(job.shell===record.request.shell&&(job.machineId||'')===(record.request.machineId||'')&&(job.group||'')===(record.request.group||''),'WATCH_TASK_CONTENT_MISMATCH');
    record.job=publicJob(job);record.observed_at=now();save(this.file,record);this.event('server_task_observed',{id:job.id,status:job.status,machine:job.selectedMachineId});return record.job;
  }
  async submit() {
    const existing=this.record;if(existing)return this.status();
    const p=this.spec.profile;validateWatchProfile(p);
    const expected=this.spec.task.code.revision;need(/^[\w.-]{1,128}$/.test(expected),'INVALID_ACTUAL_REVISION');
    const shell=`set -eu\naic_revision="$( ${p.revisionCommand}\n)"\nprintf '%s\\n' "$aic_revision" > "$SHW_RESULTS_DIR/aiconnector-revision.txt"\nif [ "$aic_revision" != ${quote(expected)} ]; then printf 'CODE_REVISION_MISMATCH\\n' >&2; exit 86; fi\n${p.shell}`;
    need(Buffer.byteLength(shell)<=4096,'WATCH_COMMAND_TOO_LARGE');
    const request={id:'aic-'+sha(this.spec.key).slice(0,48),shell,...(p.machineId?{machineId:p.machineId}:p.group?{group:p.group}:{})};
    // Write intent before POST. An unknown response is queried by ID, never submitted again.
    save(this.file,{id:request.id,request,created_at:now()});this.event('server_task_submitting',{id:request.id});
    try{return this.remember(await this.client.call('/api/tasks',{method:'POST',body:request}));}
    catch(error){this.event('server_task_unconfirmed',{id:request.id,status:'unknown'});throw error;}
  }
  async status() {const r=this.record;need(r,'WATCH_NOT_SUBMITTED');return this.remember(await this.client.call('/api/tasks?id='+encodeURIComponent(r.id)));}
  async logs() {const r=this.record;need(r,'WATCH_NOT_SUBMITTED');return this.client.call('/api/tasks/logs?id='+encodeURIComponent(r.id));}
  async collect() {
    const cached=read(path.join(this.dir,'execution.json'));if(cached)return cached;
    let job=await this.status();need(terminal(job),'WATCH_TASK_NOT_FINISHED');
    if(!job.archiveReady)job=this.remember(await this.client.call('/api/tasks/collect?id='+encodeURIComponent(job.id),{method:'POST'}));
    need(job.archiveReady,'WATCH_ARCHIVE_NOT_READY');
    const bytes=await this.client.call('/api/tasks/archive?id='+encodeURIComponent(job.id),{bytes:true,maxBytes:5*1024*1024});
    const files=archiveFiles(bytes),revision=files.get('results/aiconnector-revision.txt')?.toString('utf8').trim();
    need(revision&&/^[\w.-]{1,128}$/.test(revision),'WATCH_REVISION_EVIDENCE_MISSING');
    const mismatch=revision!==this.spec.task.code.revision;
    const stdout=this.redact(files.get('stdout.log')?.toString('utf8')||''),stderr=this.redact(files.get('stderr.log')?.toString('utf8')||'');
    let total=0;for(const name of this.spec.profile.outputs||[]) {
      need(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(name),'INVALID_OUTPUT_NAME');
      const data=files.get('results/'+name);if(!data)continue;total+=data.length;need(total<4*1024*1024,'OUTPUT_TOO_LARGE');
      atomic(path.join(this.dir,'work',name),data);
    }
    const execution={schema:'aiconnector.execution.v1',key:this.spec.key,actual_revision:revision,exit_code:job.exitCode,
      outcome:mismatch?'blocked':job.exitCode===0?'succeeded':'failed',unknown:false,revision_mismatch:mismatch,
      started_at:this.record.created_at,ended_at:job.finishedAt||now(),time_source:'controller_observed',stdout:stdout.slice(-131072),stderr:stderr.slice(-131072),truncated:stdout.length>131072||stderr.length>131072,
      server_task:publicJob(job),archive_sha256:sha(bytes)};
    save(path.join(this.dir,'execution.json'),execution);this.event('server_result_collected',{id:job.id,exit_code:job.exitCode});return execution;
  }
  async run() {
    let job=await this.submit();
    while(!terminal(job)) {
      need(!['unknown','abandoned'].includes(job.status),'WATCH_EXECUTION_UNKNOWN');
      await pause(this.spec.agent.simpleHtmlWatch.pollSeconds*1000,undefined,{signal:this.signal});job=await this.status();
    }
    return this.collect();
  }
}
