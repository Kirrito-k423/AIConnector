import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {zipSync,strToU8} from 'fflate';
import {ROOT,sha,now,save,read,atomic,alive,need,safeEnv,cleanError} from './common.mjs';

export class Runner {
  constructor(config,connector,ledger,persist,secrets) {Object.assign(this,{c:config,connector,ledger,persist,secrets});}
  get jobs(){return this.ledger.jobs;}
  resolveUnknown(key) {
    const job=this.jobs[key];need(job?.state==='unknown','RUN_NOT_UNKNOWN');
    const worker=read(path.join(job.dir,'worker.json'));
    need(!alive(worker?.pid||job.pid),'WORKER_STILL_ALIVE');
    const result={outcome:'blocked',exit_code:-1,actual_revision:'unknown',summary:'操作者已核对执行环境；本次运行未取得可确认的完整结果，不自动重跑。',metrics:{manually_resolved_unknown:true},artifacts:[]};
    atomic(path.join(job.dir,'result.zip'),zipSync({'result.json':strToU8(JSON.stringify(result)), 'recovery.json':strToU8(JSON.stringify({key,checked_at:now(),previous_error:job.error}))}));
    save(path.join(job.dir,'result.json'),result);save(path.join(job.dir,'worker.json'),{state:'ready',ended_at:now(),error:'MANUALLY_RESOLVED_UNKNOWN',events:[]});
    job.state='delivering';job.error='';this.persist();
  }
  profile(task) {
    const p=this.c.runner.profiles[task.environment.target];
    need(p&&p.entry===task.invocation.entry,'PROFILE_NOT_ALLOWED');
    need(p.repository===task.code.repository,'PROFILE_REPOSITORY_MISMATCH');
    need(task.invocation.arguments.length===0||p.allowTaskArguments===true,'TASK_ARGUMENTS_DISABLED');return p;
  }
  async tick(snapshot) {
    for(const job of Object.values(this.jobs))await this.reconcile(job,snapshot);
    if(!this.c.runner.enabled||this.c.node!=='windows-inner')return;
    if(!this.c.runner.model||!this.secrets.apiKey||!(this.secrets.githubToken||process.env[this.c.connector.token_env])){this.ledger.runner_error='MODEL_OR_GITHUB_CREDENTIAL_REQUIRED';return;}
    if(Object.values(this.jobs).some(j=>['launching','running','claiming','unknown'].includes(j.state)))return;
    for(const row of snapshot.runs||[]) {
      if(row.phase!=='accepted'||row.error||this.jobs[row.key])continue;
      let profile;
      try{profile=this.profile(row.task);}catch(e){this.ledger.runner_error=cleanError(e);continue;}
      const dir=path.join(this.c.dataDir,'jobs',sha(row.key));
      const job={key:row.key,dir,state:'claiming',created_at:now(),error:''};this.jobs[row.key]=job;this.persist();
      try {
        // A persisted claim intent never authorizes execution on recovery by itself.
        const claim=await this.connector.call('Claim',{key:row.key});
        if(!claim.execute){job.state='unknown';job.error='CLAIM_OWNERSHIP_UNKNOWN';this.persist();return;}
        fs.mkdirSync(path.join(dir,'inputs'),{recursive:true,mode:0o700});
        for(const artifact of claim.task.artifacts) {
          const src=path.join(this.c.stateDir,'artifacts',artifact.sha256+'.zip'), bytes=fs.readFileSync(src);
          need(bytes.length===artifact.bytes&&sha(bytes)===artifact.sha256,'INPUT_HASH_MISMATCH');atomic(path.join(dir,'inputs',artifact.name),bytes);
        }
        save(path.join(dir,'spec.json'),{key:row.key,task:claim.task,profile,model:this.c.runner.model,timeoutSeconds:this.c.runner.timeoutSeconds,maxTurns:this.c.runner.maxTurns});
        job.state='launching';job.claimed_at=now();this.persist();
        const proxy=this.c.runner.proxy||'system';const modelEnv={};
        if(proxy!=='direct')for(const name of ['HTTP_PROXY','HTTPS_PROXY'])if(proxy!=='system'||process.env[name])modelEnv[name]=proxy==='system'?process.env[name]:proxy;
        modelEnv.NO_PROXY=process.env.NO_PROXY||'127.0.0.1,localhost';modelEnv.NODE_USE_ENV_PROXY='1';
        const child=spawn(process.execPath,[path.join(ROOT,'service','worker.mjs'),'--work',dir],{detached:true,windowsHide:true,stdio:['pipe','ignore','ignore'],env:safeEnv(modelEnv)});
        child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({apiKey:this.secrets.apiKey,githubToken:this.secrets.githubToken||process.env[this.c.connector.token_env]||''}));
        child.on('error',()=>{job.state='unknown';job.error='WORKER_SPAWN_FAILED';this.persist();});
        job.pid=child.pid;job.state='running';this.persist();child.unref();this.ledger.runner_error='';return;
      }catch(e){job.state='unknown';job.error=cleanError(e);this.persist();return;}
    }
  }
  async reconcile(job,snapshot) {
    if(['confirmed','blocked'].includes(job.state))return;
    const row=(snapshot.runs||[]).find(x=>x.key===job.key);
    if(row?.phase==='conflict'){job.state='blocked';job.error='RUN_CONFLICT';this.persist();return;}
    if(row?.phase==='receipt'){job.state='confirmed';job.confirmed_at=now();job.error='';this.persist();return;}
    const worker=read(path.join(job.dir,'worker.json'));
    if(worker)job.worker=worker;
    if(worker?.state==='blocked'){job.state='blocked';job.error=worker.error;this.persist();return;}
    if(worker?.state==='ready'&& !['submitted','confirmed'].includes(job.state)) {
      job.state='delivering';this.persist();
      try {
        const result=read(path.join(job.dir,'result.json'));need(result,'RESULT_MISSING');
        if(!job.artifact){job.artifact=await this.connector.call('Upload',{key:job.key,file:path.join(job.dir,'result.zip')});this.persist();}
        const completed={...result,artifacts:[job.artifact]};
        await this.connector.call('Complete',{key:job.key,data:completed});job.state='submitted';job.submitted_at=now();job.error='';this.persist();
      }catch(e){job.error=cleanError(e);this.persist();}
      return;
    }
    if(['claiming','launching','running'].includes(job.state)) {
      if(!alive(worker?.pid||job.pid)){job.state='unknown';job.error='WORKER_EXIT_UNKNOWN';this.persist();}
      else if(worker?.heartbeat&&Date.now()-Date.parse(worker.heartbeat)>60000){job.error='WORKER_HEARTBEAT_STALE';this.persist();}
    }
  }
}
