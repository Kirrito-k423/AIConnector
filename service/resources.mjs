import fs from 'node:fs';
import path from 'node:path';
import {sha,now,read,need,cleanError} from './common.mjs';
import {WatchClient,watchPlan,checkGroupReservation} from './watch.mjs';
import {groupCompletion} from './group-completion.mjs';
import {isIP} from 'node:net';
import {npuAdmission} from './npu-resources.mjs';

const occupied=new Set(['reserving','held','unknown']);
const active=new Set(['claiming','launching','running','unknown']);
const queueReasons=new Set(['ready','已停用','任务占用','已被预约','实验等待单暂留或持有','监控未在线','监控状态已过期','残留进程诊断或清理中']);
const queueReason=m=>!m?'NOT_IN_CATALOG':queueReasons.has(m.reason)?m.reason:'unknown';
export class Resources {
  constructor(config,ledger,persist){Object.assign(this,{c:config,ledger,persist});}
  keys(profile,key){
    const shared=profile.resourceKeys||[];
    if(profile.machinePool)return shared;
    if(['builtin-smoke','watch-catalog','file-export','file-transfer'].includes(profile.kind))return ['run:'+key,...shared];
    if(profile.kind==='simplehtmlwatch'&&profile.machineId&&((this.c.runner.maxConcurrentRuns??1)>1||profile.machineIds||profile.poolSelected))return [...(profile.machineIds||[profile.machineId]).map(id=>'watch:'+this.c.runner.agent.simpleHtmlWatch.baseUrl+':'+id),...shared];
    // Arbitrary command and maintenance grants may touch shared directories or
    // remote hosts. Keep them exclusive until their full footprint is declared.
    return ['*'];
  }
  conflict(job,keys){
    return Object.values(this.ledger.jobs).find(other=>{
      if(other===job)return false;
      const r=other.resources;
      const held=r?occupied.has(r.state):active.has(other.state);
      if(!held)return false;
      const theirs=r?.keys||['*'];return keys.includes('*')||theirs.includes('*')||keys.some(k=>theirs.includes(k));
    });
  }
  async feedback(job,profile){
    if(profile?.kind!=='simplehtmlwatch')return;
    const client=new WatchClient(this.c.runner.agent.simpleHtmlWatch);
    const rows=await client.machineInventory(),ids=profile.machinePool||profile.machineIds||[profile.machineId];
    let monitor={};if(profile.npuResources)try{monitor=await client.call('/api/status',{maxBytes:1048576,timeoutSeconds:2});}catch{}
    const feedback={schema:'aiconnector.queue.v1',required_machines:profile.machineCount||profile.machineIds?.length||1,observed_at:now(),machines:ids.slice(0,12).map(id=>{
      const m=rows.find(m=>m.id===id);return {id,...(m&&isIP(m.host)&&this.c.runner.queueFeedbackIncludeAddresses!==false?{host:m.host}:{}),available:m?.ready===true,reason:queueReason(m)};
    })};
    if(profile.machinePool){
      for(const m of feedback.machines){const raw=rows.find(r=>r.id===m.id);if(raw&&this.conflict(job,['watch:'+client.config.baseUrl+':'+m.id,'physical:'+client.config.baseUrl+':'+raw.resourceKey,...(profile.resourceKeys||[])])){m.available=false;m.reason='RESOURCE_BUSY';}}
      if(profile.npuResources)for(const m of feedback.machines){m.npu=npuAdmission(monitor[m.id],profile.npuResources,profile.npuHealthPolicy);if(!m.npu.allowed){m.available=false;m.reason=m.npu.reason;}}
      const keys=new Set();feedback.available_machines=0;
      for(const m of feedback.machines){const raw=rows.find(r=>r.id===m.id);if(m.available&&raw){if(keys.has(raw.resourceKey))m.available=false;else{keys.add(raw.resourceKey);feedback.available_machines++;}}}
      feedback.available_machines=Math.min(feedback.required_machines,feedback.available_machines);
    }
    const signature=v=>sha(JSON.stringify({...v,observed_at:undefined}));
    if(signature(feedback)!==signature(job.queue_feedback)||Date.now()-Date.parse(job.queue_feedback?.observed_at||0)>=300000){job.queue_feedback=feedback;this.persist();}
  }
  async acquire(job,profile,task){
    if(profile.machinePool){
      try{return await this.acquirePool(job,profile,task);}
      catch(e){
        if(['POOL_PROFILE_CHANGED','WATCH_GROUP_RESERVATIONS_REQUIRED','WATCH_HTTP_400','WATCH_HTTP_404','WATCH_HTTP_410'].includes(e.message))throw e;
        job.resources??={keys:this.keys(profile,job.key)};
        job.resources.state=job.resources.remote?'unknown':'waiting';job.wait_reason=cleanError(e);this.persist();return false;
      }
    }
    // This fixed diagnostic only GETs inventory and checks a local registry
    // digest. It must remain readable while experiments/unknown intents hold
    // resources; it neither acquires nor clears their leases or write grants.
    if(profile.kind==='watch-catalog'){
      job.resources={keys:['run:'+job.key],state:'held',acquired_at:now(),read_only:true};this.persist();return true;
    }
    const keys=[...new Set([...this.keys(profile,job.key),...(job.resources?.keys||[]).filter(k=>k.startsWith('physical:'))])],conflict=this.conflict(job,keys);
    if(conflict){job.wait_reason='RESOURCE_BUSY';job.wait_owner=conflict.key;return false;}
    job.resources??={keys,state:'waiting'};
    if(job.resources.state==='held'){
      if(job.resources.remote)need(job.resources.remote.machineId===profile.machineId&&job.resources.remote.baseUrl===this.c.runner.agent.simpleHtmlWatch.baseUrl,'RESERVATION_TARGET_CHANGED');
      if(profile.machineIds){const plan=watchPlan(profile,task,job.key),r=job.resources.remote;need(JSON.stringify(r.machineIds)===JSON.stringify(profile.machineIds)&&r.taskId===plan.id&&r.planSha256===sha(plan.shell),'GROUP_PLAN_CHANGED');}
      return true;
    }
    if(profile.kind!=='simplehtmlwatch'||(this.c.runner.maxConcurrentRuns??1)===1&&!job.resources.remote&&!profile.machineIds&&!profile.poolSelected){
      job.resources={keys,state:'held',acquired_at:now()};this.persist();return true;
    }
    need(profile.machineId,'PARALLEL_FIXED_MACHINE_REQUIRED');
    const plan=profile.machineIds?watchPlan(profile,task,job.key):null;
    const group=plan?{machineIds:profile.machineIds,taskId:plan.id,planSha256:sha(plan.shell)}:{};
    const remote=job.resources.remote||{id:'aic-r-'+sha(job.key).slice(0,48),machineId:profile.machineId,baseUrl:this.c.runner.agent.simpleHtmlWatch.baseUrl,...group};
    if(plan)need(remote.planSha256===group.planSha256&&JSON.stringify(remote.machineIds)===JSON.stringify(group.machineIds),'GROUP_PLAN_CHANGED');
    job.resources={...job.resources,keys,remote,state:'reserving'};this.persist();
    try{
      const client=new WatchClient({baseUrl:remote.baseUrl,...(remote.serviceId?{expectedServiceId:remote.serviceId}:{})});
      if(plan){const identity=await client.identity();remote.serviceId=identity.serviceId;client.config.expectedServiceId=remote.serviceId;this.persist();}
      const catalog=await client.call('/api/tasks/reservations');
      need(catalog.schema==='simplehtmlwatch.reservations.v1','WATCH_RESERVATIONS_REQUIRED');
      if(plan)need(catalog.atomicGroups===1,'WATCH_GROUP_RESERVATIONS_REQUIRED');
      const reservation=catalog.reservations[remote.id]||await client.call('/api/tasks/reservations',{method:'POST',body:{id:remote.id,machineId:remote.machineId,...group}});
      need(reservation.id===remote.id&&reservation.machineId===remote.machineId&&!reservation.releasedAt,'RESERVATION_OWNERSHIP_INVALID');
      if(plan){checkGroupReservation(reservation,remote);remote.grantId=reservation.grantId;remote.generation=reservation.generation;remote.allocations=reservation.allocations;}
      job.resources={...job.resources,keys:[...new Set([...keys,...(reservation.allocations||[{resourceKey:reservation.resourceKey}]).map(a=>'physical:'+remote.baseUrl+':'+a.resourceKey)])],state:'held',remote,acquired_at:now()};this.persist();return true;
    }catch(e){
      // Reserve is idempotent and starts no SSH command. Reconcile the same ID
      // after a lost reply; never discard an uncertain reservation.
      if(['WATCH_GROUP_RESERVATIONS_REQUIRED','WATCH_INSTANCE_IDENTITY_REQUIRED','WATCH_HTTP_400','WATCH_HTTP_404','WATCH_HTTP_410'].includes(e.message)){job.resources.state='waiting';this.persist();throw e;}
      job.resources.state=e.message==='WATCH_HTTP_409'?'waiting':'unknown';
      job.wait_reason=e.message==='WATCH_HTTP_404'?'WATCH_RESERVATIONS_REQUIRED':cleanError(e);
      this.persist();return false;
    }
  }
  async acquirePool(job,profile,task){
    const definition=sha(JSON.stringify(profile));
    const previous=job.resources;
    // A lost reserve response is an ownership question, never permission to
    // choose another machine. A confirmed conflict has no granted resources.
    if(previous?.selectedProfile&&previous.state!=='waiting'){
      need(previous.pool_definition_sha256===definition,'POOL_PROFILE_CHANGED');
      return this.acquire(job,previous.selectedProfile,task);
    }
    if(previous?.selectedProfile&&previous.state==='waiting'&&previous.remote){
      need(previous.pool_definition_sha256===definition,'POOL_PROFILE_CHANGED');
      // Reconcile before abandoning even a 409 selection: other clients may
      // have observed the same durable reservation while the reply was lost.
      const client=new WatchClient({baseUrl:previous.remote.baseUrl,expectedServiceId:previous.remote.serviceId});
      const reservations=await client.call('/api/tasks/reservations');
      need(reservations.schema==='simplehtmlwatch.reservations.v1','WATCH_RESERVATIONS_REQUIRED');
      if(reservations.reservations?.[previous.remote.id])return this.acquire(job,previous.selectedProfile,task);
    }
    const client=new WatchClient(this.c.runner.agent.simpleHtmlWatch);
    const identity=await client.identity();client.config={...client.config,expectedServiceId:identity.serviceId};
    const rows=await client.machineInventory();
    const monitor=profile.npuResources?await client.call('/api/status',{maxBytes:1048576,timeoutSeconds:2}):null;
    const allowed=profile.machinePool.map(id=>rows.find(m=>m.id===id)).filter(Boolean);
    const seen=new Set(),selected=[];
    const machines=profile.machinePool.map(id=>{
      const m=allowed.find(m=>m.id===id),reason=queueReason(m);
      const candidate=m?{...profile,machinePool:undefined,machineCount:undefined,machineId:m.id,poolSelected:true}:null;
      const conflict=m&&this.conflict(job,[...this.keys(candidate,job.key),'physical:'+client.config.baseUrl+':'+m.resourceKey]);
      const npu=profile.npuResources?npuAdmission(monitor?.[id],profile.npuResources,profile.npuHealthPolicy):null;
      const available=Boolean(m&&m.enabled===true&&['online','partial'].includes(m.status)&&m.ready===true&&!conflict&&!seen.has(m.resourceKey)&&(!npu||npu.allowed));
      if(available&&selected.length<profile.machineCount){selected.push(m);seen.add(m.resourceKey);}
      return {id,...(m&&isIP(m.host)&&this.c.runner.queueFeedbackIncludeAddresses!==false?{host:m.host}:{}),available,reason:conflict?'RESOURCE_BUSY':npu&&!npu.allowed?npu.reason:reason,...(npu?{npu}:{})};
    });
    const feedback={schema:'aiconnector.queue.v1',required_machines:profile.machineCount,available_machines:selected.length,observed_at:now(),machines};
    // A stable digest avoids publishing a new capability comment per 5s poll.
    if(sha(JSON.stringify({...feedback,observed_at:undefined}))!==sha(JSON.stringify({...job.queue_feedback,observed_at:undefined})))job.queue_feedback=feedback;
    if(selected.length<profile.machineCount){
      job.resources={keys:this.keys(profile,job.key),state:'waiting'};job.wait_reason='NO_AVAILABLE_MACHINE';delete job.wait_owner;this.persist();return false;
    }
    const pinned={...profile,machineId:selected[0].id,poolSelected:true,poolSha256:sha(JSON.stringify(profile.machinePool))};delete pinned.machinePool;delete pinned.machineCount;
    if(profile.machineCount>1)pinned.machineIds=selected.map(m=>m.id);
    const plan=profile.machineCount>1?watchPlan(pinned,task,job.key):null;
    const remote={id:'aic-r-'+sha(job.key).slice(0,48),machineId:pinned.machineId,baseUrl:client.config.baseUrl,serviceId:identity.serviceId,...(plan?{machineIds:pinned.machineIds,taskId:plan.id,planSha256:sha(plan.shell)}:{})};
    // Selection and intent are frozen before any reservation POST.
    job.resources={keys:[...this.keys(pinned,job.key),...selected.map(m=>'physical:'+client.config.baseUrl+':'+m.resourceKey)],state:'reserving',remote,selectedProfile:pinned,pool_definition_sha256:definition};this.persist();
    const granted=await this.acquire(job,pinned,task);
    if(granted){delete job.queue_feedback;delete job.wait_reason;delete job.wait_owner;this.persist();}
    return granted;
  }
  async release(job){
    const r=job.resources;if(!r||r.state==='released'||r.state==='waiting')return;
    const result=read(path.join(job.dir,'result.json'));
    if(!result)return;
    if(r.remote){
      if(r.remote.machineIds&&fs.existsSync(path.join(job.dir,'watch-task.json'))){
        try{const spec=read(path.join(job.dir,'spec.json'));need(spec&&result.execution?.unknown!==true,'GROUP_EXECUTION_UNKNOWN');r.completion=groupCompletion(spec,job.dir);}
        catch(e){r.state='unknown';r.error=cleanError(e);this.persist();return;}
      }
      const client=new WatchClient({baseUrl:r.remote.baseUrl,...(r.remote.serviceId?{expectedServiceId:r.remote.serviceId}:{})});
      try{
        const catalog=await client.call('/api/tasks/reservations');
        need(catalog.schema==='simplehtmlwatch.reservations.v1','WATCH_RESERVATIONS_REQUIRED');
        const reservation=catalog.reservations[r.remote.id];
        // A failed reserve before any worker started may leave no reservation.
        if(!reservation&&!fs.existsSync(path.join(job.dir,'spec.json'))){r.state='released';this.persist();return;}
        need(reservation?.machineId===r.remote.machineId,'RESERVATION_OWNERSHIP_INVALID');
        if(r.remote.machineIds&&!reservation.releasedAt)checkGroupReservation(reservation,r.remote);
        if(!reservation.releasedAt)await client.call('/api/tasks/reservations/release',{method:'POST',body:{id:r.remote.id}});
      }catch(e){r.state='unknown';r.error=cleanError(e);this.persist();return;}
    }else if(result.execution?.unknown||result.acceptance?.unknown){r.state='unknown';r.error='EXECUTION_UNKNOWN';this.persist();return;}
    r.state='released';r.released_at=now();delete r.error;this.persist();
  }
}
