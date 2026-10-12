import {sha,now,need,cleanError} from './common.mjs';

export const CATALOG_REVISION='watch-catalog-v1';
export function catalogProfile(machineIds){
  return {kind:'watch-catalog',mode:'probe',executionMode:'direct',entry:'server-catalog',repository:'aiconnector-watch-catalog',revision:CATALOG_REVISION,
    authorizedMachineIds:machineIds??null,outputs:['server-catalog.json'],verification:[
      {id:'catalog-complete',kind:'output-json',file:'server-catalog.json',pointer:'/query_complete',equals:true},
      {id:'catalog-requested-hosts',kind:'output-json',file:'server-catalog.json',pointer:'/requested_hosts_complete',equals:true}]};
}
export function watchError(error,route,phase='request'){
  error.watch_route??=route.split('?')[0];error.watch_phase??=phase;return error;
}
export function publicWatchError(error){
  return {code:cleanError(error),route:error.watch_route||'unknown',phase:error.watch_phase||'unknown'};
}
export function validateCatalogHosts(hosts){
  need(Array.isArray(hosts)&&hosts.length<=12&&new Set(hosts).size===hosts.length&&hosts.every(h=>/^[a-f0-9]{64}$/.test(h)),'INVALID_CATALOG_HOSTS');
}
export function validateInventory(value){
  need(Array.isArray(value)&&value.length<=512,'INVALID_WATCH_CATALOG');
  const ids=new Set();
  for(const m of value){
    need(m&&typeof m.id==='string'&&m.id.length>0&&m.id.length<=256&&!ids.has(m.id)&&typeof m.host==='string'&&m.host.length>0&&m.host.length<=256&&typeof m.resourceKey==='string'&&m.resourceKey.length>0&&m.resourceKey.length<=512,'INVALID_WATCH_CATALOG');ids.add(m.id);
  }
  return value;
}
export function catalogEvidence(rows,{authorizedMachineIds=null,hosts=[],offset=0,limit=12,errors=[]}={}){
  validateCatalogHosts(hosts);need(Number.isInteger(offset)&&offset>=0&&offset<=512&&Number.isInteger(limit)&&limit>=1&&limit<=12,'INVALID_CATALOG_PAGE');
  const observed_at=now(),query_complete=rows!==null;
  const reasons=new Set(['已停用','任务占用','已被预约','实验等待单暂留或持有','监控未在线','监控状态已过期','ready']);
  const all=(rows||[]).map(m=>({id:m.id,host_sha256:sha(m.host),resource_key_sha256:sha(m.resourceKey),
    enabled:typeof m.enabled==='boolean'?m.enabled:null,status:typeof m.status==='string'&&['online','partial','offline','unknown','connecting','error'].includes(m.status)?m.status:'unknown',
    updated_at:typeof m.updatedAt==='string'&&Number.isFinite(Date.parse(m.updatedAt))&&Date.parse(m.updatedAt)>0?m.updatedAt:null,
    ready:typeof m.ready==='boolean'?m.ready:null,reason:reasons.has(m.reason)?m.reason:'unknown',
    authorized:authorizedMachineIds===null?null:authorizedMachineIds.includes(m.id),
    task_count:Array.isArray(m.taskIds)?m.taskIds.length:null,reservation_count:Array.isArray(m.reservationIds)?m.reservationIds.length:null,
    continuation_count:Array.isArray(m.continuationIds)?m.continuationIds.length:null}));
  const selected=hosts.length?all.filter(m=>hosts.includes(m.host_sha256)):all;
  const mappings=hosts.map(host_sha256=>{
    const matches=all.filter(m=>m.host_sha256===host_sha256),allowed=matches.filter(m=>m.authorized===true);
    const chosen=allowed.length===1?allowed[0]:matches.length===1?matches[0]:null;
    return {host_sha256,machine_id:chosen?.id??null,authorized:chosen?.authorized??null,resource_key_sha256:chosen?.resource_key_sha256??null,
      enabled:chosen?.enabled??null,status:chosen?.status??'unknown',ready:chosen?.ready??null,updated_at:chosen?.updated_at??null,reason:chosen?.reason??'unknown',
      state:!query_complete?'unknown':!matches.length?'not_found':chosen?'matched':'ambiguous',alias_count:matches.length};
  });
  return {schema:'aiconnector.watch-catalog.v1',observed_at,query_complete,
    requested_hosts:hosts,requested_hosts_complete:query_complete&&mappings.every(m=>m.state==='matched'),
    all_requested_authorized:hosts.length&&query_complete&&mappings.every(m=>m.authorized!==null)?mappings.every(m=>m.authorized===true):null,
    requested_resources_unique:hosts.length&&query_complete&&mappings.every(m=>m.resource_key_sha256)?new Set(mappings.map(m=>m.resource_key_sha256)).size===hosts.length:null,
    total_machines:query_complete?all.length:null,matched_machines:query_complete?selected.length:null,
    offset,has_more:offset+limit<selected.length,machines:selected.slice(offset,offset+limit),mappings,errors,
    scope:'Read-only controller inventory and existing registry authorization. Includes unavailable machines; ready is not NPU idle or a Grant.',
    ssh_executed:false,npu_workload_executed:false,all_nodes_reserved:false};
}
