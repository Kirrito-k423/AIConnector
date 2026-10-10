import fs from 'node:fs';
import path from 'node:path';
import {loadConfig,json,need,sha,atomic,read,alive} from './common.mjs';
import {agentConfig,snapshotAgent} from './agent-config.mjs';
import {validateProfile,VERSION} from './capabilities.mjs';

// Side-by-side upgrade: the new executable uses the original config/data/vault.
// No credential copying and no migration of task IDs or running worker snapshots.
export function prepareUpgrade(file,policyFile){
  need(fs.existsSync(file),'EXISTING_CONFIG_REQUIRED');const c=loadConfig(file),before=fs.readFileSync(file),disk=json(file);
  const ledger=read(path.join(c.dataDir,'service.json'),{jobs:{}});
  for(const job of Object.values(ledger.jobs)){
    const worker=read(path.join(job.dir,'worker.json'),{});
    need(!['reserving','claiming','launching','running'].includes(job.state)&&!alive(worker.pid||job.pid),'UPGRADE_ACTIVE_WORKER');
  }
  disk.runner??={};disk.runner.profiles??={};disk.runner.agent=agentConfig(disk.runner.agent,disk.runner.model);
  // Scheduling is a service preference, outside the durable channel identity.
  // Keep the original connector JSON and ledger binding intact on upgrade.
  disk.pollSeconds??=10;
  if(policyFile){
    const policy=json(policyFile);need(policy.profileId&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(policy.profileId),'INVALID_PROFILE_ID');
    need(policy.profile?.kind==='maintenance','MAINTENANCE_PROFILE_REQUIRED');validateProfile(policy.profile);
    disk.runner.profiles[policy.profileId]=policy.profile;
    // Explicit local paths are necessary; a task cannot load additional Skills.
    if(policy.contextFiles)disk.runner.agent.contextFiles=policy.contextFiles;
    if(policy.skills)disk.runner.agent.skills=policy.skills;
    disk.runner.agent=agentConfig(disk.runner.agent,disk.runner.model);
  }
  snapshotAgent(disk.runner.agent,path.dirname(c.file));
  return {c,before,disk,report:{version:VERSION,node:c.node,poll_seconds:disk.pollSeconds,config_sha256_before:sha(before),profiles:Object.keys(disk.runner.profiles),maintenance_activated:Boolean(policyFile),preserves:['node','connector','dataDir','credentials','existing profiles','task/run IDs'],requires_os_service_rebind:true}};
}
export function applyUpgrade(plan){
  need(sha(fs.readFileSync(plan.c.file))===sha(plan.before),'CONFIG_CHANGED_DURING_UPGRADE');
  const backup=plan.c.file+'.pre-'+VERSION+'-'+Date.now()+'.local.json';atomic(backup,plan.before);
  atomic(plan.c.file,JSON.stringify(plan.disk,null,2)+'\n');return backup;
}
