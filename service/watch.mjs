import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {setTimeout as pause} from 'node:timers/promises';
import {need,read,save,sha,now,atomic} from './common.mjs';
import {localRequest} from './http.mjs';
import {watchError,publicWatchError,validateInventory,catalogEvidence} from './watch-catalog.mjs';
import {healthPolicy,healthEvidence} from './npu-health.mjs';
import {cleanError} from './common.mjs';

const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const publicJob=j=>({id:j.id,status:j.status,selectedMachineId:j.selectedMachineId,machineName:j.selectedMachineId,createdAt:j.createdAt,updatedAt:j.updatedAt,finishedAt:j.finishedAt,exitCode:j.exitCode,archiveReady:j.archiveReady,archiveError:j.archiveError?cleanError({message:j.archiveError}):j.archiveError,error:j.error?cleanError({message:j.error}):j.error});
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
  need((p.machineId&&typeof p.machineId==='string')||(p.group&&typeof p.group==='string')||p.allowAnyMachine===true||p.machinePool!==undefined,'WATCH_SELECTOR_REQUIRED');
  need(!p.allowTaskArguments,'WATCH_TASK_ARGUMENTS_DISABLED');
  need(p.npuHealthPolicy===undefined||['strict','allow-warning-alarm'].includes(p.npuHealthPolicy),'INVALID_NPU_HEALTH_POLICY');
  if(p.machinePool!==undefined){
    need(Array.isArray(p.machinePool)&&p.machinePool.length>0&&p.machinePool.length<=12&&new Set(p.machinePool).size===p.machinePool.length&&p.machinePool.every(id=>typeof id==='string'&&id.length>0&&id.length<=256)&&!p.machineId&&!p.machineIds&&!p.group&&!p.allowAnyMachine,'INVALID_WATCH_MACHINE_POOL');
    need(Number.isInteger(p.machineCount)&&p.machineCount>=1&&p.machineCount<=p.machinePool.length,'INVALID_WATCH_MACHINE_COUNT');
    if(p.machineCount>1)need(p.outputs?.includes(p.groupCompletionOutput)&&Number.isInteger(p.groupRanksPerMachine)&&p.groupRanksPerMachine>=1&&p.groupRanksPerMachine<=128,'GROUP_COMPLETION_CONTRACT_REQUIRED');
  }else need(p.machineCount===undefined,'WATCH_MACHINE_POOL_REQUIRED');
  if(p.machineIds!==undefined){
    need(Array.isArray(p.machineIds)&&p.machineIds.length>=2&&p.machineIds.length<=12&&new Set(p.machineIds).size===p.machineIds.length&&p.machineIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=256)&&p.machineIds.includes(p.machineId)&&!p.group&&!p.allowAnyMachine,'INVALID_WATCH_MACHINE_GROUP');
    need(typeof p.groupCompletionOutput==='string'&&p.outputs?.includes(p.groupCompletionOutput)&&Number.isInteger(p.groupRanksPerMachine)&&p.groupRanksPerMachine>=1&&p.groupRanksPerMachine<=128,'GROUP_COMPLETION_CONTRACT_REQUIRED');
  }
}
export function watchPlan(profile,task,key){
  validateWatchProfile(profile);const expected=task.code.revision;need(/^[\w.-]{1,128}$/.test(expected),'INVALID_ACTUAL_REVISION');
  const context=profile.machineIds?`export AICONNECTOR_RUN_KEY=${quote(key)}\nexport AICONNECTOR_GROUP_MACHINE_IDS=${quote(JSON.stringify(profile.machineIds))}\nexport AICONNECTOR_GROUP_RANKS_PER_MACHINE=${profile.groupRanksPerMachine}\n`:'';
  need(!profile.machinePool,'WATCH_POOL_NOT_RESERVED');
  const shell=`set -eu\nexport AICONNECTOR_NPU_HEALTH_POLICY=${quote(healthPolicy(profile))}\n${context}aic_revision="$( ${profile.revisionCommand}\n)"\nprintf '%s\\n' "$aic_revision" > "$SHW_RESULTS_DIR/aiconnector-revision.txt"\nif [ "$aic_revision" != ${quote(expected)} ]; then printf 'CODE_REVISION_MISMATCH\\n' >&2; exit 86; fi\n${profile.shell}`.trim();
  need(Buffer.byteLength(shell)<=4096,'WATCH_COMMAND_TOO_LARGE');
  return {id:'aic-'+sha(key).slice(0,48),shell,...(profile.machineId?{machineId:profile.machineId}:profile.group?{group:profile.group}:{})};
}
export function checkGroupReservation(r,remote){
  need(r&&!r.releasedAt&&r.machineId===remote.machineId&&JSON.stringify(r.machineIds)===JSON.stringify(remote.machineIds)&&r.taskId===remote.taskId&&r.planSha256===remote.planSha256&&r.generation===1&&typeof r.grantId==='string'&&r.grantId.length>0&&Array.isArray(r.allocations)&&r.allocations.length===remote.machineIds.length&&r.allocations.every((a,i)=>a.machineId===remote.machineIds[i]&&a.resourceKey)&&new Set(r.allocations.map(a=>a.resourceKey)).size===remote.machineIds.length,'GROUP_RESERVATION_OWNERSHIP_INVALID');
  if(remote.grantId)need(r.grantId===remote.grantId&&r.generation===remote.generation,'GROUP_GRANT_CHANGED');
}

export class WatchClient {
  constructor(config,{signal}={}) {this.config=config;this.signal=signal;this.token='';}
  async identity(){
    try{
    const r=await localRequest(this.config.baseUrl+'/healthz',{signal:this.signal,maxBytes:16384});need(r.status===200,'WATCH_INSTANCE_IDENTITY_REQUIRED');
    const value=JSON.parse(r.body.toString('utf8'));
    need(typeof value.serviceId==='string'&&value.serviceId.length>0&&value.serviceId.length<=256&&typeof value.runId==='string'&&value.runId.length>0&&value.runId.length<=256,'WATCH_INSTANCE_IDENTITY_REQUIRED');
    need(!this.config.expectedServiceId||value.serviceId===this.config.expectedServiceId,'WATCH_INSTANCE_CHANGED');
    this.instanceRunId=value.runId;return value;
    }catch(e){throw watchError(e,'/healthz','identity');}
  }
  async sessionToken(){
    if(this.token)return;
    this.tokenPending??=(async()=>{
      if(this.config.expectedServiceId&&!this.instanceRunId)await this.identity();
      const match=b=>b.toString('utf8').match(/<meta\s+name="watch-token"\s+content="([^"]+)"/);
      try{const r=await localRequest(this.config.baseUrl+'/',{signal:this.signal,maxBytes:65536,stopWhen:b=>Boolean(match(b))});
        need(r.status===200,'WATCH_UNAVAILABLE');this.token=match(r.body)?.[1]||'';need(this.token,'WATCH_TOKEN_MISSING');
      }catch(e){throw watchError(e,'/','token');}
    })().finally(()=>{this.tokenPending=null;});
    await this.tokenPending;
  }
  async call(route,{method='GET',body,maxBytes=1048576,bytes=false,timeoutSeconds=15}={}) {
    try{
    for(let attempt=0;attempt<2;attempt++) {
      await this.sessionToken();
      const r=await localRequest(this.config.baseUrl+route,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{'X-Watch-Token':this.token,'Content-Type':'application/json',...(this.config.expectedServiceId?{'X-Watch-Instance':this.instanceRunId}:{})},signal:this.signal,maxBytes,timeoutSeconds});
      // A rejected token is checked before dispatch in SHW, so only this response can retry POST.
      if(r.status===403&&attempt===0){this.token='';continue;}
      need(r.status>=200&&r.status<300,'WATCH_HTTP_'+r.status);
      if(bytes)return r.body;
      try{return JSON.parse(r.body.toString('utf8'));}catch{throw new Error('INVALID_WATCH_JSON');}
    }
    }catch(e){throw watchError(e,route);}
  }
  async machineInventory(){
    try{return validateInventory(await this.call('/api/tasks/machines',{maxBytes:262144}));}
    catch(e){throw watchError(e,'/api/tasks/machines');}
  }
  async catalog(options={}){
    let controller=null;const errors=[];
    try{
      const identity=await this.identity();this.config={...this.config,expectedServiceId:identity.serviceId};
      controller={service_id:identity.serviceId,run_id:identity.runId,
        version:typeof identity.version==='string'&&/^[a-zA-Z0-9_.+-]{1,128}$/.test(identity.version)?identity.version:null,build_id:typeof identity.buildId==='string'&&/^[a-f0-9]{40,64}$/.test(identity.buildId)?identity.buildId:null,
        capabilities:Array.isArray(identity.capabilities)?identity.capabilities.filter(c=>typeof c==='string'&&/^[a-z0-9-]{1,80}$/.test(c)).slice(0,24):null};
    }catch(e){errors.push(publicWatchError(e));}
    let evidence;
    try{evidence=catalogEvidence(await this.machineInventory(),{...options,errors});}
    catch(e){evidence=catalogEvidence(null,{...options,errors:[...errors,publicWatchError(e)]});}
    return {...evidence,controller,controller_identity_known:controller!==null};
  }
  async environment(profile={}) {
    const params=new URLSearchParams();if(profile.machineId)params.set('machineId',profile.machineId);if(profile.group)params.set('group',profile.group);
    const [catalog,status,ready]=await Promise.allSettled([this.catalog(),this.call('/api/status'),this.call('/api/tasks/ready?'+params)]);
    const errors=[...(catalog.value?.errors||[]),...[status,ready].filter(r=>r.status==='rejected').map(r=>publicWatchError(r.reason))];
    let monitor=status.status==='fulfilled'?status.value:null;
    if(monitor&&Buffer.byteLength(JSON.stringify(monitor))>8192){monitor=null;errors.push({route:'/api/status',phase:'output',code:'MONITOR_OUTPUT_TOO_LARGE'});}
    let readyRows=ready.status==='fulfilled'?ready.value:null;
    const ready_total=Array.isArray(readyRows)?readyRows.length:null;
    if(readyRows&&(!Array.isArray(readyRows)||Buffer.byteLength(JSON.stringify(readyRows))>2048)){
      readyRows=null;errors.push({route:'/api/tasks/ready',phase:'output',code:'READY_OUTPUT_TOO_LARGE_OR_INVALID'});
    }
    return {observed_at:now(),catalog:catalog.value,query_complete:catalog.value?.query_complete===true,
      ready:readyRows,ready_total,monitor,errors,ready_is_not_npu_idle:true};
  }
}

export class WatchExecution {
  constructor(spec,dir,{signal,event=()=>{},redact=s=>s}={}) {
    Object.assign(this,{spec,dir,signal,event,redact});this.client=new WatchClient({...spec.agent.simpleHtmlWatch,...(spec.reservation?.serviceId?{expectedServiceId:spec.reservation.serviceId}:{})},{signal});this.file=path.join(dir,'watch-task.json');
  }
  get record(){return read(this.file);}
  async health(){
    const ids=this.spec.profile.machineIds||[this.spec.profile.machineId];
    try{return healthEvidence(await this.client.call('/api/status',{maxBytes:1048576,timeoutSeconds:2}),ids,healthPolicy(this.spec.profile));}
    catch(e){return ids.map(machine_id=>({machine_id,policy:healthPolicy(this.spec.profile),known:false,fresh:false,error:cleanError(e)}));}
  }
  remember(job) {
    const record=this.record;need(record&&record.id===job.id,'WATCH_TASK_ID_MISMATCH');
    need(job.shell===record.request.shell&&(job.machineId||'')===(record.request.machineId||'')&&(job.group||'')===(record.request.group||''),'WATCH_TASK_CONTENT_MISMATCH');
    need((job.reservationId||'')===(record.request.reservationId||''),'WATCH_RESERVATION_MISMATCH');
    need((job.reservationGrantId||'')===(record.request.reservationGrantId||'')&&(job.reservationGeneration||0)===(record.request.reservationGeneration||0),'WATCH_GROUP_GRANT_MISMATCH');
    record.job=publicJob(job);record.observed_at=now();save(this.file,record);this.event('server_task_observed',{id:job.id,status:job.status,machine:job.selectedMachineId});return record.job;
  }
  async submit() {
    const existing=this.record;if(existing)return this.status();
    const p=this.spec.profile;validateWatchProfile(p);
    const request={...watchPlan(p,this.spec.task,this.spec.key),...(this.spec.reservation?{reservationId:this.spec.reservation.id}:{}),...(this.spec.reservation?.grantId?{reservationGrantId:this.spec.reservation.grantId,reservationGeneration:this.spec.reservation.generation}:{})};
    need(!p.machineIds||this.spec.reservation?.machineIds,'GROUP_RESERVATION_REQUIRED');
    if(this.spec.reservation){
      const catalog=await this.client.call('/api/tasks/reservations'),r=catalog.reservations?.[this.spec.reservation.id];
      need(catalog.schema==='simplehtmlwatch.reservations.v1'&&r?.machineId===p.machineId&&!r.releasedAt,'RESERVATION_OWNERSHIP_INVALID');
      if(p.machineIds){checkGroupReservation(r,this.spec.reservation);need(r.planSha256===sha(request.shell)&&r.taskId===request.id,'GROUP_PLAN_CHANGED');}
    }
    // Write intent before POST. An unknown response is queried by ID, never submitted again.
    const npu_health=await this.health();
    if(healthPolicy(p)==='strict')need(npu_health.every(s=>s.known&&s.fresh&&!s.has_warning&&!s.has_alarm),'NPU_HEALTH_GATE');
    save(this.file,{id:request.id,request,created_at:now(),npu_health});this.event('server_task_submitting',{id:request.id});
    try{return this.remember(await this.client.call('/api/tasks',{method:'POST',body:request}));}
    catch(error){this.event('server_task_unconfirmed',{id:request.id,status:'unknown'});throw error;}
  }
  async status() {const r=this.record;need(r,'WATCH_NOT_SUBMITTED');return this.remember(await this.client.call('/api/tasks?id='+encodeURIComponent(r.id)));}
  async awaitStatus(){
    let job=await this.status();
    while(!terminal(job)){
      need(!['unknown','abandoned'].includes(job.status),'WATCH_EXECUTION_UNKNOWN');
      await pause(this.spec.agent.simpleHtmlWatch.pollSeconds*1000,undefined,{signal:this.signal});job=await this.status();
    }
    return job;
  }
  async logs() {const r=this.record;need(r,'WATCH_NOT_SUBMITTED');return this.client.call('/api/tasks/logs?id='+encodeURIComponent(r.id));}
  async collect() {
    const cached=read(path.join(this.dir,'execution.json'));if(cached)return cached;
    let job=await this.status();need(terminal(job),'WATCH_TASK_NOT_FINISHED');
    if(!job.archiveReady) {
      try{job=this.remember(await this.client.call('/api/tasks/collect?id='+encodeURIComponent(job.id),{method:'POST',timeoutSeconds:50}));}
      catch(error){if(this.signal?.aborted||!['WATCH_HTTP_502','HTTP_TIMEOUT','TimeoutError'].includes(error.message)&&error.name!=='TimeoutError')throw error;this.event('server_archive_waiting',{id:job.id});}
      // SHW marks exit before its automatic collection completes. A concurrent
      // collect returns 502 while busy; wait for that same archive, never relaunch.
      const deadline=Date.now()+60000;
      while(!job.archiveReady&&Date.now()<deadline) {
        await pause(this.spec.agent.simpleHtmlWatch.pollSeconds*1000,undefined,{signal:this.signal});job=await this.status();
        need(!job.archiveError,'WATCH_ARCHIVE_FAILED');
      }
    }
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
      server_task:publicJob(job),archive_sha256:sha(bytes),npu_health:{policy:healthPolicy(this.spec.profile),before:this.record.npu_health||[],after:await this.health()}};
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
