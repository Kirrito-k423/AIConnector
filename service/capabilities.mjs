import fs from 'node:fs';
import path from 'node:path';
import {ROOT,sha,now,need} from './common.mjs';
import {validateMaintenance} from './maintenance.mjs';
import {validateWatchProfile} from './watch.mjs';

export const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'))).version;
export const modeOf=p=>p.kind==='builtin-smoke'?'smoke':p.kind==='maintenance'?'maintenance':p.mode||'experiment';
export function toolsFor(p,agent={}) {
  const names=['submit_summary','get_run_state','verify_task','list_inputs','read_input','list_outputs','read_output'];
  if(p.kind==='maintenance')names.push('read_local_file','write_local_file','patch_local_json','restore_local_file','run_maintenance_command','call_local_api');
  else names.push('run_experiment');
  if(agent.simpleHtmlWatch?.enabled)names.push('server_status');
  if(p.kind==='simplehtmlwatch'&&agent.simpleHtmlWatch?.enabled)names.push('submit_server_task','server_task_status','server_task_logs','collect_server_result');
  if(agent.web?.enabled){names.push('web_fetch');if(agent.web.searchUrl)names.push('web_search');}
  return names;
}
export function checkRequirements(task,p,agent={}) {
  validateRequirements(task);
  validateProfile(p);
  need(modeOf(p)===task.requirements.mode,'CAPABILITY_MODE_MISMATCH');
  const required=task.requirements.tools||[];
  need(Array.isArray(required)&&required.every(x=>typeof x==='string'),'INVALID_REQUIRED_TOOLS');
  const available=toolsFor(p,agent);
  need(required.every(x=>available.includes(x)),'CAPABILITY_TOOL_MISSING');
  const checks=task.requirements.checks||[];
  need(Array.isArray(checks)&&checks.every(x=>typeof x==='string'),'INVALID_REQUIRED_CHECKS');
  const ids=p.kind==='builtin-smoke'?['cpu-smoke']:(p.verification||[]).map(x=>x.id);
  need(ids.length>0,'ACCEPTANCE_CHECKS_NOT_CONFIGURED');
  need(checks.every(x=>ids.includes(x)),'CAPABILITY_CHECK_MISSING');
  for(const s of agent.skills||[])need((s.requiredTools||[]).every(t=>available.includes(t)),'SKILL_TOOL_MISSING');
  return available;
}
export function validateRequirements(task){
  const r=task?.requirements;
  need(r&&['smoke','probe','maintenance','experiment'].includes(r.mode),'TASK_REQUIREMENTS_REQUIRED');
  need(Array.isArray(r.tools||[])&&(r.tools||[]).length<=32&&(r.tools||[]).every(t=>typeof t==='string'&&t.length<=64),'INVALID_REQUIRED_TOOLS');
  need(Array.isArray(r.checks)&&r.checks.length>0&&r.checks.length<=16&&r.checks.every(t=>typeof t==='string'&&t.length<=40),'INVALID_REQUIRED_CHECKS');
}
export function validateProfile(p){
  need(['builtin-smoke','maintenance','command','simplehtmlwatch'].includes(p.kind),'INVALID_PROFILE');
  if(p.kind==='builtin-smoke')return;
  if(p.kind==='maintenance')validateMaintenance(p);
  if(p.kind==='simplehtmlwatch')validateWatchProfile(p);
  need(Array.isArray(p.verification)&&p.verification.length>0&&p.verification.length<=16,'ACCEPTANCE_CHECKS_NOT_CONFIGURED');
  const ids=new Set();for(const c of p.verification){
    need(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(c.id)&&!ids.has(c.id),'INVALID_CHECK_ID');ids.add(c.id);
    need(['output-json','local-json','command','local-api','execution'].includes(c.kind)&&(Object.hasOwn(c,'equals')||c.exists===true),'INVALID_CHECK');
    if(['local-json','command','local-api'].includes(c.kind))need(p.kind==='maintenance','MAINTENANCE_CHECK_REQUIRED');
    if(c.kind==='command')need(p.maintenance.commands?.[c.command]?.readOnly===true,'VERIFIER_MUST_BE_READ_ONLY');
    if(c.kind==='local-api')need(p.maintenance.apis?.[c.api]?.readOnly===true,'VERIFIER_MUST_BE_READ_ONLY');
  }
}
export function capabilities(c,secrets={},snapshot) {
  const profiles=Object.entries(c.runner.profiles).map(([id,p])=>{let error='';try{validateProfile(p);if(p.kind==='simplehtmlwatch')need(c.runner.agent.simpleHtmlWatch?.enabled,'WATCH_NOT_ENABLED');for(const s of snapshot?.skills||[])need((s.requiredTools||[]).every(t=>toolsFor(p,c.runner.agent).includes(t)),'SKILL_TOOL_MISSING');}catch(e){error=e.message;}
    return {id,mode:modeOf(p),entry:p.entry,repository:p.repository,ready:!error,error,
    tools:toolsFor(p,c.runner.agent),checks:p.kind==='builtin-smoke'?['cpu-smoke']:(p.verification||[]).map(x=>x.id),
    ...(p.revision?{revision:p.revision}:{}),
    ...(p.kind==='builtin-smoke'?{revision:'builtin-smoke-v1'}:{}),
    arguments_allowed:p.allowTaskArguments===true};});
  // Paths, commands, host addresses, context bodies and credentials stay local.
  const context=snapshot?{sha256:snapshot.contextDigest,files:snapshot.contexts.map(f=>({name:f.name,sha256:f.sha256})),skills:(snapshot.skills||[]).map(s=>({name:s.name,sha256:s.sha256,requiredTools:s.requiredTools}))}:{loaded:false};
  const body={schema:'aiconnector.capabilities.v1',node:c.node,namespace:c.connector.namespace,version:VERSION,
    enabled:c.runner.enabled===true,model_configured:Boolean(c.runner.model&&secrets.apiKey),profiles,context,
    config_sha256:sha(JSON.stringify({runner:c.runner,version:VERSION,context_sha256:snapshot?.contextDigest||null}))};
  return {...body,digest:sha(JSON.stringify(body)),generated_at:now()};
}
export function preflight(task,remote) {
  need(remote?.schema==='aiconnector.capabilities.v1'&&remote.node==='windows-inner','RECEIVER_CAPABILITIES_UNKNOWN');
  need(Date.now()-Date.parse(remote.generated_at)<7200000&&Date.parse(remote.generated_at)<=Date.now()+300000,'RECEIVER_CAPABILITIES_STALE');
  need(remote.enabled&&remote.model_configured,'RECEIVER_NOT_READY');
  validateRequirements(task);
  const match=p=>p.ready!==false&&p.mode===task.requirements.mode&&(task.requirements.tools||[]).every(t=>p.tools.includes(t))&&
    (task.requirements.checks||[]).every(t=>p.checks.includes(t))&&p.repository===task.code.repository;
  const candidates=remote.profiles.filter(match);
  const selected=task.environment.target==='auto'?candidates.length===1?candidates[0]:null:remote.profiles.find(p=>p.id===task.environment.target);
  if(!selected||!match(selected)){
    const e=new Error(selected?'CAPABILITY_MISMATCH':'RECEIVER_PROFILE_NOT_FOUND_OR_AMBIGUOUS');
    e.diagnostic={requested:{mode:task.requirements.mode,repository:task.code.repository,target:task.environment.target,tools:task.requirements.tools,checks:task.requirements.checks},
      available:remote.profiles.map(p=>({id:p.id,mode:p.mode,ready:p.ready,checks:p.checks})),
      next:remote.profiles.some(p=>p.mode==='maintenance')?'可先用接收端已授权的维护入口登记真实实验，再重新投递。':'在 Windows 看板打开「接入服务器」，选择真实机器并启用入口维护；升级软件不会自动新增服务器权限。'};throw e;
  }
  need(selected.checks.length>0,'ACCEPTANCE_CHECKS_NOT_CONFIGURED');
  need(task.invocation.entry==='auto'||selected.entry===task.invocation.entry,'CAPABILITY_ENTRY_MISMATCH');
  need(!selected.revision||task.code.revision===selected.revision,'CODE_REVISION_MISMATCH');
  need(!task.invocation.arguments.length||selected.arguments_allowed,'TASK_ARGUMENTS_DISABLED');
  return {ok:true,profile:selected,config_sha256:remote.config_sha256,version:remote.version,observed_at:remote.generated_at};
}
