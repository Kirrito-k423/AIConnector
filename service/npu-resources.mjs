// Shared-node admission from existing npu-smi samples. No extra SSH, resets,
// process termination or workload execution; the entry rechecks before launch.
const need=(ok,code)=>{if(!ok)throw new Error(code);};
export function validateNpuResources(r){
  need(r&&typeof r.model==='string'&&/^Ascend[A-Za-z0-9]+$/.test(r.model)&&Number.isInteger(r.devicesPerMachine)&&r.devicesPerMachine>=1&&r.devicesPerMachine<=128&&Number.isSafeInteger(r.minFreeHbmMB)&&r.minFreeHbmMB>=0&&Number.isFinite(r.maxUtilization)&&r.maxUtilization>=0&&r.maxUtilization<=100&&Number.isInteger(r.maxSampleAgeSeconds)&&r.maxSampleAgeSeconds>=1&&r.maxSampleAgeSeconds<=300,'INVALID_NPU_RESOURCES');
}
export function npuAdmission(state,r,policy='allow-warning-alarm'){
  validateNpuResources(r);const sample=state?.results?.findLast(x=>x.commandId==='npu');
  const result={allowed:false,reason:'NPU_SAMPLE_UNKNOWN',sampled_at:sample?.endedAt||null};
  if(!sample||sample.exitCode!==0||sample.error||sample.warning||sample.truncated||typeof sample.stdout!=='string'||sample.stdout.length>262144)return result;
  const age=Date.now()-Date.parse(sample.endedAt);if(!Number.isFinite(age)||age<0||age>r.maxSampleAgeSeconds*1000)return {...result,reason:'NPU_SAMPLE_STALE'};
  let board=null,utilColumn=-1,processes=false,empty=false,busy=false,unparsedProcess=false;
  const models=new Map(),health=new Map(),devices=[],seen=new Set(),emptyBoards=new Set();
  for(const line of sample.stdout.split('\n')){
    const cells=line.split('|').slice(1,-1).map(s=>s.trim());
    if(/process id/i.test(line)){processes=true;continue;}
    if(processes){
      if(/no running process/i.test(line)){empty=true;const m=/NPU\s+(\d+)/i.exec(line);if(m)emptyBoards.add(m[1]);}
      else if(cells.length&&cells.some(s=>/^\d+$/.test(s)))busy=true;
      else if(cells.length&&cells.some(s=>s.length>0))unparsedProcess=true;
      continue;
    }
    const header=cells.findIndex(c=>/NPU Util\(%\)|AICore\(%\)/.test(c));if(header>=0){utilColumn=header;continue;}
    const model=/\bAscend[A-Za-z0-9]+\b/.exec(line),id=/^(\d+)(?:\s|$)/.exec(cells[0]||'');
    if(model&&id){board=id[1];models.set(board,model[0]);const h=cells.find(c=>['OK','Warning','Alarm'].includes(c));health.set(board,h||'unknown');continue;}
    if(board===null||utilColumn<0||cells.length<=utilColumn)continue;
    const memory=[...line.matchAll(/(\d+)\s*\/\s*(\d+)/g)];if(!memory.length)continue;
    const last=memory.at(-1),util=/^\s*(\d+(?:\.\d+)?)(?:\s|$)/.exec(cells[utilColumn]);
    if(!util||!/HBM-Usage\(MB\)/.test(sample.stdout))return result;
    const key=/^\d+\s+\d+$/.test(cells[0]||'')?cells[0].split(/\s+/).join(':'):board;
    if(seen.has(key))return result;seen.add(key);
    const used=Number(last[1]),total=Number(last[2]);if(!Number.isSafeInteger(used)||!Number.isSafeInteger(total)||total<=0||used>total)return result;
    devices.push({board,model:models.get(board),util:Number(util[1]),free_hbm_mb:total-used});
  }
  if(busy)return {...result,reason:'NPU_PROCESS_BUSY'};
  if(!processes||!empty||unparsedProcess||emptyBoards.size&&[...models.keys()].some(id=>!emptyBoards.has(id)))return {...result,reason:'NPU_PROCESS_UNKNOWN'};
  if(!devices.length||devices.length>128||[...health.values()].some(s=>s==='unknown')||[...models.keys()].some(board=>!devices.some(d=>d.board===board)))return result;
  if(policy==='strict'&&[...health.values()].some(s=>s!=='OK'))return {...result,reason:'NPU_HEALTH_GATE'};
  if(devices.some(d=>d.model!==r.model))return {...result,reason:'NPU_MODEL_MISMATCH'};
  if(devices.some(d=>d.util>r.maxUtilization))return {...result,reason:'NPU_UTILIZATION_BUSY'};
  const fitting=devices.filter(d=>d.free_hbm_mb>=r.minFreeHbmMB).length;
  if(fitting<r.devicesPerMachine)return {...result,reason:'NPU_CAPACITY_INSUFFICIENT',available_devices:fitting};
  return {...result,allowed:true,reason:'ready',available_devices:fitting,has_warning:[...health.values()].includes('Warning'),has_alarm:[...health.values()].includes('Alarm'),scope:'Whole-machine reservation; cached capacity observation, not a compute test or lock on external SSH users.'};
}
