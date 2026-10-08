import fs from 'node:fs';
import path from 'node:path';

const fields=new Set(['operation_id','action','key','queue_wait_ms','elapsed_ms','total_ms','queue_depth','code','attempt','retry_at','bytes']);
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

export function diagnostics(c,ledger,snapshot,key='') {
  if(key&&!keyPattern.test(key))throw new Error('INVALID_RUN_ID');
  const events=[...readTiming(path.join(c.dataDir,'service-timing.jsonl')),...readTiming(path.join(c.stateDir,'transport-timing.jsonl'))];
  const ids=new Set(events.filter(e=>e.key===key&&e.operation_id).map(e=>e.operation_id));
  const selected=events.filter(e=>!key||e.key===key||ids.has(e.operation_id)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  return {schema:'aiconnector.diagnostics.v1',generated_at:new Date().toISOString(),node:c.node,key:key||null,
    retention:'Each timing stream retains the current and previous 2 MiB files; a run export includes the latest 2000 matching events.',
    limitation:'Delivery timing after result.zip creation stays local; export both endpoints to correlate the full handoff.',
    jobs:Object.values(ledger.jobs||{}).filter(j=>!key||j.key===key).map(j=>({key:j.key,state:j.state,timings:j.timings,delivery_attempts:j.delivery_attempts,claim_attempts:j.claim_attempts,claim_retry_at:j.wait_reason==='CLAIM_RETRY'?j.next_attempt:undefined})),
    channel:{last_poll:snapshot.last_poll,next_poll:snapshot.next_poll,scopes:snapshot.scopes,sync:snapshot.sync},
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
    scope:'Windows local clock; result publication already observed. This frozen sidecar predates its own upload and may predate Mac receipt.',
    timings:stamps,delivery_attempts:job?.delivery_attempts||0,claim_attempts:job?.claim_attempts||0,
    events,truncated:value.truncated,retention:value.retention};
}
