import fs from 'node:fs';
import path from 'node:path';
import {sha,now,read,need,cleanError} from './common.mjs';
import {WatchClient,watchPlan,checkGroupReservation} from './watch.mjs';
import {groupCompletion} from './group-completion.mjs';

const occupied=new Set(['reserving','held','unknown']);
const active=new Set(['claiming','launching','running','unknown']);
export class Resources {
  constructor(config,ledger,persist){Object.assign(this,{c:config,ledger,persist});}
  keys(profile,key){
    const shared=profile.resourceKeys||[];
    if(['builtin-smoke','watch-catalog'].includes(profile.kind))return ['run:'+key,...shared];
    if(profile.kind==='simplehtmlwatch'&&profile.machineId&&((this.c.runner.maxConcurrentRuns??1)>1||profile.machineIds))return [...(profile.machineIds||[profile.machineId]).map(id=>'watch:'+this.c.runner.agent.simpleHtmlWatch.baseUrl+':'+id),...shared];
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
  async acquire(job,profile,task){
    // This fixed diagnostic only GETs inventory and checks a local registry
    // digest. It must remain readable while experiments/unknown intents hold
    // resources; it neither acquires nor clears their leases or write grants.
    if(profile.kind==='watch-catalog'){
      job.resources={keys:['run:'+job.key],state:'held',acquired_at:now(),read_only:true};this.persist();return true;
    }
    const keys=this.keys(profile,job.key),conflict=this.conflict(job,keys);
    if(conflict){job.wait_reason='RESOURCE_BUSY';job.wait_owner=conflict.key;return false;}
    job.resources??={keys,state:'waiting'};
    if(job.resources.state==='held'){
      if(job.resources.remote)need(job.resources.remote.machineId===profile.machineId&&job.resources.remote.baseUrl===this.c.runner.agent.simpleHtmlWatch.baseUrl,'RESERVATION_TARGET_CHANGED');
      if(profile.machineIds){const plan=watchPlan(profile,task,job.key),r=job.resources.remote;need(JSON.stringify(r.machineIds)===JSON.stringify(profile.machineIds)&&r.taskId===plan.id&&r.planSha256===sha(plan.shell),'GROUP_PLAN_CHANGED');}
      return true;
    }
    if(profile.kind!=='simplehtmlwatch'||(this.c.runner.maxConcurrentRuns??1)===1&&!job.resources.remote&&!profile.machineIds){
      job.resources={keys,state:'held',acquired_at:now()};this.persist();return true;
    }
    need(profile.machineId,'PARALLEL_FIXED_MACHINE_REQUIRED');
    const plan=profile.machineIds?watchPlan(profile,task,job.key):null;
    const group=plan?{machineIds:profile.machineIds,taskId:plan.id,planSha256:sha(plan.shell)}:{};
    const remote=job.resources.remote||{id:'aic-r-'+sha(job.key).slice(0,48),machineId:profile.machineId,baseUrl:this.c.runner.agent.simpleHtmlWatch.baseUrl,...group};
    if(plan)need(remote.planSha256===group.planSha256&&JSON.stringify(remote.machineIds)===JSON.stringify(group.machineIds),'GROUP_PLAN_CHANGED');
    job.resources={...job.resources,keys,remote,state:'reserving'};this.persist();
    try{
      const client=new WatchClient({baseUrl:remote.baseUrl,...(plan?{expectedServiceId:remote.serviceId}:{})});
      if(plan){const identity=await client.identity();remote.serviceId=identity.serviceId;client.config.expectedServiceId=remote.serviceId;this.persist();}
      const catalog=await client.call('/api/tasks/reservations');
      need(catalog.schema==='simplehtmlwatch.reservations.v1','WATCH_RESERVATIONS_REQUIRED');
      if(plan)need(catalog.atomicGroups===1,'WATCH_GROUP_RESERVATIONS_REQUIRED');
      const reservation=catalog.reservations[remote.id]||await client.call('/api/tasks/reservations',{method:'POST',body:{id:remote.id,machineId:remote.machineId,...group}});
      need(reservation.id===remote.id&&reservation.machineId===remote.machineId&&!reservation.releasedAt,'RESERVATION_OWNERSHIP_INVALID');
      if(plan){checkGroupReservation(reservation,remote);remote.grantId=reservation.grantId;remote.generation=reservation.generation;remote.allocations=reservation.allocations;}
      job.resources={keys:[...keys,...(reservation.allocations||[{resourceKey:reservation.resourceKey}]).map(a=>'physical:'+remote.baseUrl+':'+a.resourceKey)],state:'held',remote,acquired_at:now()};this.persist();return true;
    }catch(e){
      // Reserve is idempotent and starts no SSH command. Reconcile the same ID
      // after a lost reply; never discard an uncertain reservation.
      if(['WATCH_GROUP_RESERVATIONS_REQUIRED','WATCH_INSTANCE_IDENTITY_REQUIRED','WATCH_HTTP_400','WATCH_HTTP_404','WATCH_HTTP_410'].includes(e.message)){job.resources.state='waiting';this.persist();throw e;}
      job.resources.state=e.message==='WATCH_HTTP_409'?'waiting':'unknown';
      job.wait_reason=e.message==='WATCH_HTTP_404'?'WATCH_RESERVATIONS_REQUIRED':cleanError(e);
      this.persist();return false;
    }
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
      const client=new WatchClient({baseUrl:r.remote.baseUrl,...(r.remote.machineIds?{expectedServiceId:r.remote.serviceId}:{})});
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
