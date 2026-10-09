import fs from 'node:fs';
import path from 'node:path';
import {WindowWriter} from './window-writer.mjs';

const waitWriters=new Map();
export async function closeWaitTiming(dir){const writer=waitWriters.get(dir);if(writer){await writer.close();waitWriters.delete(dir);}}

const fields=new Set(['operation_id','action','key','queue_wait_ms','elapsed_ms','total_ms','queue_depth','code','attempt','retry_at','bytes','blocker_operation_id','blocker_action','stage','cpu_ms','exception_type','native_code','line','dropped_events']);
const keyPattern=/^[a-z0-9][a-z0-9_-]{0,63}\/[1-9][0-9]{0,9}\/[a-z0-9][a-z0-9_-]{0,63}$/;
export function timing(dir,kind,values={}) {
  if(!dir)return;
  try {
    const row={schema:'aiconnector.timing.v1',at:new Date().toISOString(),source:'service',kind};
    for(const [k,v]of Object.entries(values)){
      if(!fields.has(k))continue;
      if(k==='key'){if(keyPattern.test(v))row[k]=v;}
      else if(typeof v==='number'&&Number.isFinite(v))row[k]=v;
      else if(typeof v==='string'&&/^[a-zA-Z0-9_:.+-]{1,120}$/.test(v))row[k]=v;
    }
    if(kind==='action_wait'){
      let writer=waitWriters.get(dir);if(!writer){writer=new WindowWriter(path.join(dir,'queue-wait-timing.jsonl'),{limit:64});waitWriters.set(dir,writer);}
      writer.append(row);return;
    }
    fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,'service-timing.jsonl');
    if(fs.existsSync(file)&&fs.statSync(file).size>=2*1024*1024){fs.rmSync(file+'.1',{force:true});fs.renameSync(file,file+'.1');}
    fs.appendFileSync(file,JSON.stringify(row)+'\n',{mode:0o600});
  } catch {} // Observability cannot grant, retry or invalidate an execution.
}

export function readTiming(file) {
  const rows=[];
  for(const p of [file+'.1',file]){
    let fd;
    try {fd=fs.openSync(p,'r');} catch(e){if(e.code==='ENOENT')continue;throw e;}
    try {
      const size=fs.fstatSync(fd).size,offset=Math.max(0,size-2*1024*1024-16384),buffer=Buffer.alloc(size-offset);
      fs.readSync(fd,buffer,0,buffer.length,offset);
      const lines=buffer.toString('utf8').split('\n');if(offset)lines.shift();
      for(const line of lines)try{const row=JSON.parse(line);if(row.schema==='aiconnector.timing.v1')rows.push(row);}catch{}
    } finally {fs.closeSync(fd);}
  }
  return rows;
}

export function readWindows(file) {
  const rows=[];
  for(const p of [file+'.1',file])try{
    const stat=fs.statSync(p);if(stat.size>2*1024*1024+65536)continue;
    for(const line of fs.readFileSync(p,'utf8').split('\n'))try{
      const r=JSON.parse(line);
      if(r.schema!=='aiconnector.runtime-window.v1'||!['connector','worker','service'].includes(r.source)||!(/^[a-f0-9]{32}$/.test(r.session)))continue;
      if(!Number.isFinite(r.elapsed_ms)||r.elapsed_ms<0||r.elapsed_ms>10001||!Number.isFinite(r.cpu_ms)||r.cpu_ms<0)continue;
      if(!Number.isInteger(r.window)||r.window<0||!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(r.window_start)||!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(r.window_end)||!Number.isFinite(Date.parse(r.window_start))||!Number.isFinite(Date.parse(r.window_end)))continue;
      const segments=(r.segments||[]).slice(0,256).map(v=>{
        if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(v.stage)||!Number.isFinite(v.wall_ms)||v.wall_ms<0)return null;
        return {stage:v.stage,parent_stage:/^[a-zA-Z0-9_.-]{1,80}$/.test(v.parent_stage)?v.parent_stage:'',wall_ms:v.wall_ms,operation_id:/^[a-zA-Z0-9_-]{0,96}$/.test(v.operation_id)?v.operation_id:'',action:/^[a-zA-Z0-9_.-]{1,80}$/.test(v.action)?v.action:'',key:keyPattern.test(v.key)?v.key:''};
      }).filter(Boolean);
      rows.push({schema:r.schema,source:r.source,session:r.session,pid:Number.isInteger(r.pid)?r.pid:null,window:r.window,window_start:r.window_start,window_end:r.window_end,elapsed_ms:r.elapsed_ms,cpu_ms:r.cpu_ms,cpu_sample_max_ms:Number.isFinite(r.cpu_sample_max_ms)&&r.cpu_sample_max_ms>=0?r.cpu_sample_max_ms:null,dropped_windows:Number.isInteger(r.dropped_windows)&&r.dropped_windows>=0?r.dropped_windows:0,partial:r.partial===true,segments});
    }catch{}
  }catch{}
  const unique=new Map();
  for(const row of rows){const id=row.session+':'+row.window;const previous=unique.get(id);if(!previous||row.elapsed_ms>=previous.elapsed_ms)unique.set(id,row);}
  return [...unique.values()].sort((a,b)=>Date.parse(a.window_start)-Date.parse(b.window_start));
}

export function diagnostics(c,ledger,snapshot,key='') {
  if(key&&!keyPattern.test(key))throw new Error('INVALID_RUN_ID');
  const events=[...readTiming(path.join(c.dataDir,'service-timing.jsonl')),...readTiming(path.join(c.dataDir,'queue-wait-timing.jsonl')),...readTiming(path.join(c.stateDir,'transport-timing.jsonl'))];
  const ids=new Set(events.filter(e=>e.key===key&&e.operation_id).map(e=>e.operation_id));
  for(let previous=-1;previous!==ids.size;){previous=ids.size;for(const e of events)if(ids.has(e.operation_id)&&e.blocker_operation_id)ids.add(e.blocker_operation_id);}
  const selected=events.filter(e=>!key||e.key===key||ids.has(e.operation_id)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const job=(ledger.jobs||{})[key];
  const begin=key?Math.min(...selected.map(e=>Date.parse(e.at)).filter(Number.isFinite),Date.parse(job?.created_at)||Infinity):0;
  const windows=[...readWindows(path.join(c.dataDir,'service-windows.jsonl')),...readWindows(path.join(c.stateDir,'runtime-windows.jsonl')),...(job?.dir?readWindows(path.join(job.dir,'worker-windows.jsonl')):[])].filter(r=>Date.parse(r.window_end)>=begin);
  const ready=events.filter(e=>e.kind==='profiler_ready').at(-1);
  const runtime={windows_enabled:Boolean(ready),powershell_version:/^powershell_[0-9_]+$/.test(ready?.category||'')?ready.category.slice(11).replaceAll('_','.'):null};
  return {schema:'aiconnector.diagnostics.v1',generated_at:new Date().toISOString(),node:c.node,key:key||null,
    retention:'Each timing stream retains the current and previous 2 MiB files; a run export includes the latest 2000 matching events.',
    limitation:'Delivery timing after result.zip creation stays local; export both endpoints to correlate the full handoff.',
    runtime,jobs:Object.values(ledger.jobs||{}).filter(j=>!key||j.key===key).map(j=>({key:j.key,state:j.state,timings:j.timings,delivery_attempts:j.delivery_attempts,claim_attempts:j.claim_attempts,claim_retry_at:j.wait_reason==='CLAIM_RETRY'?j.next_attempt:undefined})),
    channel:{last_poll:snapshot.last_poll,next_poll:snapshot.next_poll,scopes:snapshot.scopes,sync:snapshot.sync},
    windows:windows.slice(-1000),windows_truncated:windows.length>1000,window_scope:'Exclusive wall time per process in ten-second windows, includes other operations blocking this run. CPU belongs to this process only; not an additive wall stage. CPU boundaries interpolate between samples; cpu_sample_max_ms reports resolution. A crash can lose the final partial window.',
    events:selected.slice(-2000),truncated:selected.length>2000};
}

export function deliveryDiagnostics(c,ledger,snapshot,key){
  const value=diagnostics(c,ledger,snapshot,key),job=(ledger.jobs||{})[key];
  const stamps={};
  for(const [name,time]of Object.entries(job?.timings||{})){
    if(/^[a-z_]+_at$/.test(name)&&typeof time==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(time))stamps[name]=time;
    else if(name==='packaging_ms'&&Number.isFinite(time))stamps[name]=time;
  }
  const allowed=new Set([...fields,'schema','at','source','kind','scope','event_id','event_kind','method','endpoint','request_id','http','category','confirmed_at','files_written','events_sent']);
  const events=value.events.map(event=>Object.fromEntries(Object.entries(event).filter(([name,item])=>{
    if(!allowed.has(name))return false;
    if(typeof item==='number')return Number.isFinite(item);
    if(typeof item!=='string')return false;
    if(name==='key')return keyPattern.test(item);
    return /^[a-zA-Z0-9_:/.+-]{1,240}$/.test(item);
  })));
  return {schema:'aiconnector.delivery-diagnostics.v1',key,node:c.node,generated_at:value.generated_at,
    scope:'Windows local clock; Mac receipt already observed. This frozen sidecar predates its own upload. Old frozen sidecars from earlier versions keep their original scope.',
    timings:stamps,delivery_attempts:job?.delivery_attempts||0,claim_attempts:job?.claim_attempts||0,
    events,runtime:value.runtime,windows:value.windows,windows_truncated:value.windows_truncated,window_scope:value.window_scope,truncated:value.truncated,retention:value.retention};
}
