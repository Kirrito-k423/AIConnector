import {sha} from './common.mjs';

// Keep proof hashes in the result, but exclude observation clocks and model
// prose from the scheduling decision. An unchanged observation is not work.
const volatile=/^(?:summary|report|checked_at|observed_at|generated_at|heartbeat|updatedAt|updated_at|read_at|exposed_to_model|read_by_agent|pass|usage)$/;
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!volatile.test(k)).map(k=>[k,stable(value[k])]));
  return value;
}
export class Progress {
  constructor(limit){this.limit=limit;this.seen=new Set();this.ranges=new Map();this.changed=false;this.stalled=0;this.recoveryEpoch=0;}
  mark(key){if(this.seen.has(key))return;this.seen.add(key);this.changed=true;}
  observe(name,args,value){
    if(name==='submit_summary'){this.mark('summary-recorded');return;}
    if(name==='get_run_state'){this.mark('state-recovered:'+this.recoveryEpoch);return;}
    if(name==='call_local_api')value=value?.value||value;
    if(['write_local_file','patch_local_json','restore_local_file'].includes(name))value={file:args.file||value?.file_id,sha256:value?.after_sha256||value?.sha256,error:value?.error};
    if(['read_input','read_output','read_local_file'].includes(name)&&typeof value?.content==='string'){
      const key=name+':'+(args.name||args.id||args.file)+':'+value.sha256;
      const start=value.offset??args.offset??0,end=start+value.content.length;
      const ranges=this.ranges.get(key)||[];
      if(end>start&&!ranges.some(([a,b])=>a<=start&&b>=end)){
        this.changed=true;ranges.push([start,end]);ranges.sort((a,b)=>a[0]-b[0]);
        const merged=[];for(const [a,b]of ranges){const last=merged.at(-1);if(last&&a<=last[1])last[1]=Math.max(last[1],b);else merged.push([a,b]);}
        this.ranges.set(key,merged);
      }
      return;
    }
    // Local API action IDs and wrapper clocks are not progress. Independent
    // checks count a change of verdict, not a fresh timestamp in the evidence.
    if(name==='verify_task')value={status:value?.status,unknown:value?.unknown,execution_ok:value?.execution_ok,
      checks:value?.checks?.map(c=>({id:c.id,ok:c.ok,error:c.error})),reported_incomplete:value?.reported_incomplete};
    if(name==='server_status')value={ready:value?.ready,monitor_status:value?.monitor?.status};
    this.mark(name+':'+sha(JSON.stringify(stable(value))));
  }
  endTurn(){this.stalled=this.changed?0:this.stalled+1;this.changed=false;return this.stalled<this.limit;}
}
