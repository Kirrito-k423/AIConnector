import {Outputs} from './outputs.mjs';
import {need} from './common.mjs';
export function groupCompletion(spec,dir){
  const p=spec.profile;if(!p.machineIds)return null;
  const {bytes,info}=new Outputs(dir,p.outputs).file(p.groupCompletionOutput);
  need(bytes.length<=262144,'GROUP_COMPLETION_TOO_LARGE');
  const data=JSON.parse(bytes.toString('utf8'));
  need(data.schema==='aiconnector.group-completion.v1'&&data.run_key===spec.key&&Array.isArray(data.members)&&data.members.length===p.machineIds.length,'GROUP_COMPLETION_INVALID');
  const machines=new Set(),ranks=new Set();
  for(const m of data.members){
    need(p.machineIds.includes(m.machine_id)&&!machines.has(m.machine_id)&&Array.isArray(m.ranks)&&m.ranks.length===p.groupRanksPerMachine,'GROUP_COMPLETION_MEMBERS_INVALID');machines.add(m.machine_id);
    for(const r of m.ranks){need(Number.isInteger(r.rank)&&r.rank>=0&&!ranks.has(r.rank)&&Number.isInteger(r.exit_code)&&typeof r.process_id==='string'&&r.process_id.length>0&&r.process_id.length<=128,'GROUP_PROCESS_EXIT_MISSING');ranks.add(r.rank);}
  }
  need([...ranks].every(r=>r<p.machineIds.length*p.groupRanksPerMachine),'GROUP_RANKS_INVALID');
  return {verified:true,evidence_sha256:info.sha256,machine_count:machines.size,rank_count:ranks.size};
}
