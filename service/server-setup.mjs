import fs from 'node:fs';
import path from 'node:path';
import {sha,atomic,need,loadConfig,json} from './common.mjs';
import {validateRegistry} from './server-registry.mjs';
import {profileDefinitions} from './profile-data.mjs';
import {WatchClient} from './watch.mjs';
import {snapshotAgent} from './agent-config.mjs';

export function probeProfile(machineId){
  return {kind:'simplehtmlwatch',mode:'probe',entry:'server-probe',repository:'aiconnector-server-probe',revision:'server-probe-v1',machineId,
    revisionCommand:'printf server-probe-v1',shell:`python3 - <<'AIC_PROBE'
import datetime, json, os, pathlib, subprocess
boot = next(int(line.split()[1]) for line in pathlib.Path('/proc/stat').read_text().splitlines() if line.startswith('btime '))
try:
    p = subprocess.run(['npu-smi', 'info'], capture_output=True, text=True, timeout=20)
    npu = dict(exit_code=p.returncode, stdout=p.stdout[-12000:], stderr=p.stderr[-2000:])
except Exception as e:
    npu = dict(exit_code=-1, error=type(e).__name__)
value = dict(schema='aiconnector.server-probe.v1', ssh_executed=True, boot_time_utc=datetime.datetime.fromtimestamp(boot, datetime.timezone.utc).isoformat(), observed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), npu_smi=npu, npu_workload_executed=False)
pathlib.Path(os.environ['SHW_RESULTS_DIR'], 'server-probe.json').write_text(json.dumps(value, ensure_ascii=False), encoding='utf8')
AIC_PROBE`,outputs:['server-probe.json'],verification:[
      {id:'ssh-probe',kind:'output-json',file:'server-probe.json',pointer:'/ssh_executed',equals:true},
      {id:'boot-time',kind:'output-json',file:'server-probe.json',pointer:'/boot_time_utc',exists:true},
      {id:'npu-info',kind:'output-json',file:'server-probe.json',pointer:'/npu_smi/exit_code',equals:0}]};
}
const registryPath=c=>path.join(c.dataDir,'server-profiles.local.json');
export function setupDigest(c){return sha(fs.readFileSync(c.file)+'\n'+(fs.existsSync(registryPath(c))?fs.readFileSync(registryPath(c),'utf8'):''));}
export async function serverCatalog(c){
  need(c.node==='windows-inner','RECEIVER_ONLY');need(c.runner.agent.simpleHtmlWatch.enabled,'WATCH_NOT_ENABLED');
  const env=await new WatchClient(c.runner.agent.simpleHtmlWatch).environment();
  need(Array.isArray(env.ready),'INVALID_WATCH_CATALOG');
  // Only list explicit IDs reported by the controller; names do not prove hardware type.
  const machines=env.ready.map(m=>({id:m.id,name:m.name||m.id,group:m.group||'',updated_at:m.updatedAt}));
  need(machines.every(m=>typeof m.id==='string'&&m.id.length>0),'INVALID_WATCH_CATALOG');
  return {config_sha256:setupDigest(c),observed_at:env.observed_at,machines,selected:c.runner.serverRegistry?json(c.runner.serverRegistry).machineIds:[],ready_is_not_npu_idle:true};
}
export function serverReadiness(c){
  let disk,valid=false;
  try{disk=validateRegistry(json(c.runner.serverRegistry));valid=true;}catch{}
  const current=valid&&c.runner.serverRegistrySha===sha(JSON.stringify(disk));
  return {registry_valid:valid,reloaded:current,experiment_entry_configured:current&&Object.values(disk.profiles).some(p=>p.mode==='experiment'),
    probe_profiles:Object.entries(c.runner.profiles).filter(([,p])=>p.kind==='simplehtmlwatch'&&p.mode==='probe').map(([id])=>id),
    experiment_profiles:Object.entries(c.runner.profiles).filter(([,p])=>p.kind==='simplehtmlwatch'&&p.mode!=='probe').map(([id])=>id),
    loaded_profiles:profileDefinitions(Object.fromEntries(Object.entries(c.runner.profiles).filter(([,p])=>p.kind==='simplehtmlwatch'))),
    hardware_execution_verified:false,scope:'入口配置与热加载检查；SSH、芯片型号和实验结果须逐次执行验证'};
}
function maintenanceProfile(c,file){
  const baseUrl=`http://127.0.0.1:${c.port}`,tokenFile=path.join(c.dataDir,'dashboard.token');
  return {kind:'maintenance',entry:'server-registry',repository:'aiconnector-server-registry',revision:'server-registry-v1',outputs:[],maintenance:{enabled:true,
    files:{'server-registry':{path:file,format:'server-registry',write:true,pointers:['/profiles']}},
    apis:{reload:{baseUrl,route:'/api/reload-agent',method:'POST',body:{},readOnly:false,auth:'dashboard',tokenFile},
      readiness:{baseUrl,route:'/api/server-readiness',method:'GET',readOnly:true,auth:'dashboard',tokenFile}}},
    verification:[{id:'experiment-entry-configured',kind:'local-api',api:'readiness',pointer:'/experiment_entry_configured',equals:true}]};
}
export async function setupServers(c,data){
  need(typeof data.allowMaintenance==='boolean','MAINTENANCE_CHOICE_REQUIRED');
  const catalog=await serverCatalog(c);
  need(data.config_sha256===catalog.config_sha256,'SERVER_SETUP_CHANGED');
  need(Array.isArray(data.machineIds)&&data.machineIds.length>0&&data.machineIds.every(id=>catalog.machines.some(m=>m.id===id)),'SELECT_READY_SERVER');
  const file=registryPath(c),disk=json(c.file),old=c.runner.serverRegistry?validateRegistry(json(c.runner.serverRegistry)):null;
  disk.runner??={};disk.runner.profiles??={};
  need(!c.runner.serverRegistry||path.resolve(c.runner.serverRegistry)===file,'SERVER_REGISTRY_PATH_CONFLICT');
  need(!disk.runner.profiles['server-maintenance']||disk.runner.profiles['server-maintenance'].maintenance?.files?.['server-registry']?.path===file,'SERVER_PROFILE_CONFLICT');
  const registry={schema:'aiconnector.server-registry.v1',machineIds:data.machineIds,profiles:{...old?.profiles}};
  for(const machine of data.machineIds){const id='server-probe-'+sha(machine).slice(0,12);if(!registry.profiles[id])registry.profiles[id]=probeProfile(machine);}
  validateRegistry(registry);
  for(const id of Object.keys(registry.profiles))need(!Object.hasOwn(disk.runner.profiles,id),'SERVER_PROFILE_CONFLICT');
  disk.runner.serverRegistry=file;
  if(data.allowMaintenance)disk.runner.profiles['server-maintenance']=maintenanceProfile(c,file);
  else delete disk.runner.profiles['server-maintenance'];
  const contextFile=path.join(c.dataDir,'SERVER_CONTEXT.md');disk.runner.agent??={};
  disk.runner.agent.contextFiles=[...new Set([...(disk.runner.agent.contextFiles||[]),contextFile])];
  const context=`# 已接入的服务器工作流\n由本机所有者选择的机器 ID：${data.machineIds.map(x=>JSON.stringify(x)).join(', ')}。使用 server_status 获取当前信息；ready 不代表 NPU 空闲或 A5 身份。\n先执行 server-probe 取得启动时间与 npu-smi 原始信息。不要把 CPU smoke 作为服务器实验。\n维护任务只能修改 server-registry 文件的 /profiles 清单（保留已有条目），再调用 reload 并检查 readiness。新条目必须为 simplehtmlwatch，machineId 属于本机选择范围，mode 为 experiment 或 probe，固定 repository/revision/entry/revisionCommand/shell/outputs/verification。不可设置 group、allowAnyMachine 或 allowTaskArguments。\n请从输入文件中读取请求的实验入口定义。需要真实仓库路径和固定 revision；未知时报告缺少信息，不发明路径。shell 在远端执行，产物写入 $SHW_RESULTS_DIR，命令与版本检查合计不超过 3800 字节。输入 ZIP 只在 Windows 供模型读取，并不会自动传到服务器。\n维护验收只证明至少一个实验入口已配置并加载。实际 SSH、NPU 与实验正确性由下一项实验任务及其 output-json 检查验收。命令退出、模型总结与发送端回执含义不同；运行统计以 agent 字段为准。\n`;
  const changes=[[file,JSON.stringify(registry,null,2)+'\n'],[contextFile,context],[c.file,JSON.stringify(disk,null,2)+'\n']];
  const before=changes.map(([f])=>fs.existsSync(f)?fs.readFileSync(f):null);
  const backup=path.join(c.dataDir,'setup-backups',Date.now()+'-'+sha(data.config_sha256).slice(0,8));
  for(let i=0;i<changes.length;i++)if(before[i])atomic(path.join(backup,path.basename(changes[i][0])),before[i]);
  // No awaits between recheck, writes, validation and rollback.
  need(setupDigest(c)===catalog.config_sha256,'SERVER_SETUP_CHANGED');
  try{
    for(const [f,value]of changes)atomic(f,value);
    const candidate=loadConfig(c.file);snapshotAgent(candidate.runner.agent,path.dirname(c.file));
    c.runner=candidate.runner;
  }catch(e){for(let i=changes.length-1;i>=0;i--){if(before[i])atomic(changes[i][0],before[i]);else if(fs.existsSync(changes[i][0]))fs.unlinkSync(changes[i][0]);}throw e;}
  return {saved:true,profiles:Object.keys(registry.profiles),maintenance_enabled:data.allowMaintenance,readiness:serverReadiness(c),backup,
    next:'等待能力公告同步；先投递 probe，再用维护入口登记真实实验。此操作没有执行 SSH 或 NPU。'};
}
