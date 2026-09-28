import fs from 'node:fs';
import path from 'node:path';
import {sha,now,read,need,cleanError} from './common.mjs';
import {WatchClient} from './watch.mjs';

const occupied=new Set(['reserving','held','unknown']);
const active=new Set(['claiming','launching','running','unknown']);
export class Resources {
  constructor(config,ledger,persist){Object.assign(this,{c:config,ledger,persist});}
  keys(profile,key){
    const shared=profile.resourceKeys||[];
    if(profile.kind==='builtin-smoke')return ['run:'+key,...shared];
    if(profile.kind==='simplehtmlwatch'&&profile.machineId&&(this.c.runner.maxConcurrentRuns??1)>1)return ['watch:'+this.c.runner.agent.simpleHtmlWatch.baseUrl+':'+profile.machineId,...shared];
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
  async acquire(job,profile){
    const keys=this.keys(profile,job.key),conflict=this.conflict(job,keys);
    if(conflict){job.wait_reason='RESOURCE_BUSY';job.wait_owner=conflict.key;return false;}
    job.resources??={keys,state:'waiting'};
    if(job.resources.state==='held'){
      if(job.resources.remote)need(job.resources.remote.machineId===profile.machineId&&job.resources.remote.baseUrl===this.c.runner.agent.simpleHtmlWatch.baseUrl,'RESERVATION_TARGET_CHANGED');
      return true;
    }
    if(profile.kind!=='simplehtmlwatch'||(this.c.runner.maxConcurrentRuns??1)===1&&!job.resources.remote){
      job.resources={keys,state:'held',acquired_at:now()};this.persist();return true;
    }
    need(profile.machineId,'PARALLEL_FIXED_MACHINE_REQUIRED');
    const remote=job.resources.remote||{id:'aic-r-'+sha(job.key).slice(0,48),machineId:profile.machineId,baseUrl:this.c.runner.agent.simpleHtmlWatch.baseUrl};
    job.resources={...job.resources,keys,remote,state:'reserving'};this.persist();
    try{
      const client=new WatchClient({baseUrl:remote.baseUrl});
      const catalog=await client.call('/api/tasks/reservations');
      need(catalog.schema==='simplehtmlwatch.reservations.v1','WATCH_RESERVATIONS_REQUIRED');
      const reservation=catalog.reservations[remote.id]||await client.call('/api/tasks/reservations',{method:'POST',body:{id:remote.id,machineId:remote.machineId}});
      need(reservation.id===remote.id&&reservation.machineId===remote.machineId&&!reservation.releasedAt,'RESERVATION_OWNERSHIP_INVALID');
      job.resources={keys:[...keys,'physical:'+remote.baseUrl+':'+reservation.resourceKey],state:'held',remote,acquired_at:now()};this.persist();return true;
    }catch(e){
      // Reserve is idempotent and starts no SSH command. Reconcile the same ID
      // after a lost reply; never discard an uncertain reservation.
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
      const client=new WatchClient({baseUrl:r.remote.baseUrl});
      try{
        const catalog=await client.call('/api/tasks/reservations');
        need(catalog.schema==='simplehtmlwatch.reservations.v1','WATCH_RESERVATIONS_REQUIRED');
        const reservation=catalog.reservations[r.remote.id];
        // A failed reserve before any worker started may leave no reservation.
        if(!reservation&&!fs.existsSync(path.join(job.dir,'spec.json'))){r.state='released';this.persist();return;}
        need(reservation?.machineId===r.remote.machineId,'RESERVATION_OWNERSHIP_INVALID');
        if(!reservation.releasedAt)await client.call('/api/tasks/reservations/release',{method:'POST',body:{id:r.remote.id}});
      }catch(e){r.state='unknown';r.error=cleanError(e);this.persist();return;}
    }else if(result.execution?.unknown||result.acceptance?.unknown){r.state='unknown';r.error='EXECUTION_UNKNOWN';this.persist();return;}
    r.state='released';r.released_at=now();delete r.error;this.persist();
  }
}
