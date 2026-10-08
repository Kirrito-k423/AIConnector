import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {zipSync,strToU8} from 'fflate';
import {ROOT,sha,now,id,save,read,atomic,alive,need,safeEnv,cleanError} from './common.mjs';
import {agentConfig,snapshotAgent} from './agent-config.mjs';
import {validateWatchProfile} from './watch.mjs';
import {Resources} from './resources.mjs';
import {checkRequirements,capabilities,VERSION} from './capabilities.mjs';
import {timing,deliveryDiagnostics} from './telemetry.mjs';

export class Runner {
  constructor(config,connector,ledger,persist,secrets) {Object.assign(this,{c:config,connector,ledger,persist,secrets});this.resources=new Resources(config,ledger,persist);this.pending=new Map();
    for(const job of Object.values(ledger.jobs))if(!job.resources&&['claiming','launching','running','unknown'].includes(job.state)){job.resources={keys:['*'],state:'unknown',error:'LEGACY_EXECUTION_SCOPE_UNKNOWN'};persist();}
  }
  schedule(id,work){if(this.pending.has(id))return;const promise=Promise.resolve().then(work).catch(e=>{this.ledger.runner_error=cleanError(e);this.persist();}).finally(()=>this.pending.delete(id));this.pending.set(id,promise);}
  async idle(){while(this.pending.size)await Promise.allSettled([...this.pending.values()]);}
  slots(){return Object.values(this.jobs).filter(j=>['reserving','claiming','launching','running'].includes(j.state)||j.state==='unknown'&&alive(j.worker?.pid||j.pid)).length;}
  get jobs(){return this.ledger.jobs;}
  unlaunched(job){
    return !job.claimed_at&&!job.pid&&!job.worker&&!job.process_exit&&!job.process_failure&&
      !['spec.json','worker.json','worker-exit.json','worker-failure.json','execution-intent.json','execution.json','watch-task.json','result.json','result.zip'].some(f=>fs.existsSync(path.join(job.dir,f)));
  }
  retryableClaim(job){return /^[a-f0-9]{48}$/.test(job.claim_owner||'')&&!job.claim_rejected&&this.unlaunched(job);}
  blocked(job,reason){
    const result={outcome:'blocked',exit_code:-1,actual_revision:'not-executed',summary:`任务未执行：${reason}。请匹配接收端实际能力后创建新运行。`,metrics:{runner_error:reason},artifacts:[],acceptance:{status:'blocked',reason,checks:[]},execution:{started_at:null,ended_at:null,executed:false},agent:{version:VERSION,started_at:null,ended_at:now(),duration_ms:0,turns:0,tool_steps:0,tools:[],stop_reason:reason}};
    atomic(path.join(job.dir,'result.zip'),zipSync({'result.json':strToU8(JSON.stringify(result))}));save(path.join(job.dir,'result.json'),result);
    save(path.join(job.dir,'worker.json'),{state:'ready',ended_at:now(),error:reason,events:[]});job.state='delivering';this.persist();
  }
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
    if(p.kind==='simplehtmlwatch'){need(this.c.runner.agent?.simpleHtmlWatch.enabled,'WATCH_DISABLED');validateWatchProfile(p);}
    need(task.invocation.arguments.length===0||p.allowTaskArguments===true,'TASK_ARGUMENTS_DISABLED');return p;
  }
  async tick(snapshot) {
    for(const job of Object.values(this.jobs)){await this.reconcile(job,snapshot);this.exportDiagnostics(job,snapshot);}
    if(!this.c.runner.enabled||this.c.node!=='windows-inner')return;
    if(!(this.secrets.githubToken||process.env[this.c.connector.token_env])){this.ledger.runner_error='GITHUB_CREDENTIAL_REQUIRED';return;}
    // Stable admission time controls scheduling; dashboard activity sorting is separate.
    for(const row of snapshot.runs||[]){
      if(row.phase!=='accepted'||row.error||this.jobs[row.key])continue;
      const admitted=now();
      this.jobs[row.key]={key:row.key,dir:path.join(this.c.dataDir,'jobs',sha(row.key)),state:'waiting',created_at:admitted,diagnostics_enabled:true,timings:{accepted_observed_at:admitted,admitted_at:admitted},sequence:this.ledger.next_sequence=(this.ledger.next_sequence||0)+1,error:''};
      timing(this.c.dataDir,'run_admitted',{key:row.key});this.persist();
    }
    for(const job of Object.values(this.jobs).filter(j=>j.state==='waiting').sort((a,b)=>(a.sequence||0)-(b.sequence||0))){
      if(this.slots()>=(this.c.runner.maxConcurrentRuns??1)){this.waiting(job,'CAPACITY_BUSY');continue;}
      if((job.next_attempt||0)>Date.now()||this.pending.has('start:'+job.key))continue;
      if(job.claim_owner&&!this.retryableClaim(job)){job.state='unknown';job.error='CLAIM_LAUNCH_STATE_UNKNOWN';this.persist();continue;}
      const row=(snapshot.runs||[]).find(r=>r.key===job.key&&!r.error&&(r.phase==='accepted'||r.phase==='started'&&this.retryableClaim(job)));if(!row)continue;
      const profile=this.c.runner.profiles[row.task.environment.target];
      const conflict=this.resources.conflict(job,this.resources.keys(profile||{},job.key));
      if(conflict){this.waiting(job,'RESOURCE_BUSY',conflict.key);continue;}
      job.state='reserving';job.resources??={keys:this.resources.keys(profile||{},job.key),state:'reserving'};this.persist();this.schedule('start:'+job.key,()=>this.launch(job,row));
    }
  }
  waiting(job,reason,owner){
    if(job.wait_reason===reason&&job.wait_owner===owner)return;
    job.wait_reason=reason;job.wait_owner=owner;job.timings??={};job.timings.wait_changed_at=now();
    timing(this.c.dataDir,'scheduler_wait',{key:job.key,code:reason});this.persist();
  }
  exportDiagnostics(job,snapshot){
    // Only runs admitted by this version opt in. Never backfill history or
    // modify the immutable result ZIP; this low-priority sidecar follows result.
    const row=(snapshot.runs||[]).find(r=>r.key===job.key);
    if(!job.diagnostics_enabled||!['result','receipt'].includes(row?.phase)||row.error||job.delivery_diagnostics?.artifact||this.pending.has('diagnostics:'+job.key)||Date.now()<(job.delivery_diagnostics?.retry_at||0))return;
    if([...this.pending.keys()].some(k=>k.startsWith('diagnostics:')))return;
    this.schedule('diagnostics:'+job.key,async()=>{
      job.timings??={};job.timings.result_published_observed_at??=now();
      const file=path.join(job.dir,'delivery-diagnostics.zip');
      job.delivery_diagnostics??={};job.delivery_diagnostics.state='uploading';this.persist();
      try{
        // Freeze bytes before upload, so lost replies/restarts reconcile one SHA.
        if(!fs.existsSync(file))atomic(file,zipSync({'delivery-diagnostics.json':strToU8(JSON.stringify(deliveryDiagnostics(this.c,this.ledger,snapshot,job.key),null,2))}));
        job.delivery_diagnostics.artifact=await this.connector.call('UploadDiagnostics',{key:job.key,file});job.delivery_diagnostics.state='published';job.delivery_diagnostics.published_at=now();delete job.delivery_diagnostics.error;this.persist();
      }
      catch(e){job.delivery_diagnostics.state='retrying';job.delivery_diagnostics.error=cleanError(e);job.delivery_diagnostics.retry_at=Math.max(Date.now()+60000,e.retryAt||0);this.persist();}
    });
  }
  async launch(job,row) {
      let profile,agent,preflightError='';
      try{
        profile=this.profile(row.task);agent=snapshotAgent(agentConfig(this.c.runner.agent,this.c.runner.model),path.dirname(this.c.file));
        checkRequirements(row.task,profile,agent);
        need(!row.task.receiver_config_sha256||row.task.receiver_config_sha256===capabilities(this.c,this.secrets,agent).config_sha256,'RECEIVER_CONFIG_CHANGED');
        need(this.c.runner.model&&this.secrets.apiKey,'MODEL_CREDENTIAL_REQUIRED');
      }catch(e){preflightError=cleanError(e);}
      const dir=job.dir;
      try{
        job.timings??={};job.timings.resource_acquire_started_at=now();timing(this.c.dataDir,'resource_acquire_started',{key:job.key});this.persist();
        if(!preflightError&&!await this.resources.acquire(job,profile)){
          job.state='waiting';job.next_attempt=Date.now()+5000;this.waiting(job,'RESOURCE_BUSY');this.persist();return;
        }
        if(!preflightError){job.timings.resource_acquired_at=now();timing(this.c.dataDir,'resource_acquired',{key:job.key});}
      }catch(e){preflightError=cleanError(e);}
      // Persist the owner before contacting the transport. Reuse it across
      // lost replies/restarts; a fresh owner cannot take over an existing claim.
      job.claim_owner??=id();job.claim_attempts=(job.claim_attempts||0)+1;
      job.state='claiming';delete job.wait_reason;delete job.wait_owner;this.persist();
      try {
        job.timings.claim_queued_at=now();timing(this.c.dataDir,'claim_queued',{key:job.key});this.persist();
        // The durable transport must revalidate ownership on every retry.
        const claim=await this.connector.call('Claim',{key:row.key,claimOwner:job.claim_owner});
        if(!claim.execute||claim.claim_owner!==job.claim_owner){job.claim_rejected=true;job.state='unknown';job.error='CLAIM_OWNERSHIP_UNKNOWN';this.persist();return;}
        job.claimed_at=now();job.claim_event_id=claim.claim_event_id;job.error='';delete job.next_attempt;this.persist();
        job.timings.claim_confirmed_at=job.claimed_at;timing(this.c.dataDir,'claim_confirmed',{key:job.key});
        if(preflightError){this.blocked(job,preflightError);return;}
        fs.mkdirSync(path.join(dir,'inputs'),{recursive:true,mode:0o700});
        for(const artifact of claim.task.artifacts) {
          const src=path.join(this.c.stateDir,'artifacts',artifact.sha256+'.zip'), bytes=fs.readFileSync(src);
          need(bytes.length===artifact.bytes&&sha(bytes)===artifact.sha256,'INPUT_HASH_MISMATCH');atomic(path.join(dir,'inputs',artifact.name),bytes);
        }
        save(path.join(dir,'spec.json'),{key:row.key,task:claim.task,profile,agent,startupTimings:job.timings,reservation:job.resources?.remote,model:this.c.runner.model,timeoutSeconds:this.c.runner.timeoutSeconds,maxTurns:this.c.runner.maxTurns});
        job.state='launching';job.claimed_at=now();this.persist();
        const proxy=this.c.runner.proxy||'system';const modelEnv={};
        if(proxy!=='direct')for(const name of ['HTTP_PROXY','HTTPS_PROXY'])if(proxy!=='system'||process.env[name])modelEnv[name]=proxy==='system'?process.env[name]:proxy;
        modelEnv.NO_PROXY=['127.0.0.1','localhost',process.env.NO_PROXY].filter(Boolean).join(',');modelEnv.NODE_USE_ENV_PROXY='1';
        // Preserve the web channel's system proxy separately from model.proxy.
        modelEnv.AIC_WEB_ENV_CAPTURED='1';
        for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])if(process.env[key])modelEnv['AIC_WEB_'+key]=process.env[key];
        const child=spawn(process.execPath,[path.join(ROOT,'service','worker.mjs'),'--work',dir],{detached:true,windowsHide:true,stdio:['pipe','ignore','pipe'],env:safeEnv(modelEnv)});
        let stderr='';child.stderr.setEncoding('utf8');
        child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>65536)stderr=stderr.slice(-65536).split('\n').slice(1).join('\n');});
        child.stderr.unref?.();
        child.once('close',(code,signal)=>{
          const sensitive=Object.values(this.secrets).filter(v=>typeof v==='string'&&v.length>3);
          const text=sensitive.reduce((s,v)=>s.split(v).join('[REDACTED]'),stderr).slice(-8192);
          try{save(path.join(dir,'worker-exit.json'),{code,signal,at:now(),stderr:text});}catch{}
        });
        child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({apiKey:this.secrets.apiKey,githubToken:this.secrets.githubToken||process.env[this.c.connector.token_env]||''}));
        child.on('error',()=>{job.state='unknown';job.error='WORKER_SPAWN_FAILED';this.persist();});
        job.pid=child.pid;job.state='running';job.timings.worker_spawned_at=now();timing(this.c.dataDir,'worker_spawned',{key:job.key});this.persist();child.unref();this.ledger.runner_error='';return;
      }catch(e){job.diagnostic=e.diagnostic;if(job.claimed_at&&job.state==='claiming'){this.blocked(job,cleanError(e));return;}job.state='unknown';job.error=cleanError(e);job.next_attempt=Math.max(job.next_attempt||0,e.retryAt||0);this.persist();return;}
  }
  async reconcile(job,snapshot) {
    if(this.pending.has('start:'+job.key))return;
    if(job.state==='reserving'){job.state='waiting';this.persist();}
    const finished=read(path.join(job.dir,'worker.json'))?.state==='ready';
    if(finished&&job.resources&&!['released','waiting'].includes(job.resources.state)&&Date.now()>=(job.resource_check_at||0)){
      job.resource_check_at=Date.now()+5000;this.schedule('release:'+job.key,()=>this.resources.release(job));
    }
    if(['confirmed','blocked'].includes(job.state))return;
    const row=(snapshot.runs||[]).find(x=>x.key===job.key);
    if(row?.phase==='conflict'){job.state='blocked';job.error='RUN_CONFLICT';this.persist();return;}
    if(row?.phase==='receipt'){job.state='confirmed';job.confirmed_at=now();job.timings??={};job.timings.receipt_observed_at=job.confirmed_at;job.error='';timing(this.c.dataDir,'receipt_observed',{key:job.key});this.persist();return;}
    const worker=read(path.join(job.dir,'worker.json'));
    if(worker)job.worker=worker;
    job.process_exit=read(path.join(job.dir,'worker-exit.json'))??job.process_exit;
    job.process_failure=read(path.join(job.dir,'worker-failure.json'))??job.process_failure;
    // Only a persisted owner + absence of ALL launch evidence permits asking
    // Claim again. Claim itself decides ownership; age/TTL grants no authority.
    if(['claiming','unknown'].includes(job.state)&&this.retryableClaim(job)&&
      row&&['accepted','started'].includes(row.phase)&&!row.error){
      const delay=Math.min(60000,1000*2**Math.min(6,Math.max(0,(job.claim_attempts||1)-1)));
      job.recovery={kind:'claim-retry-before-launch',at:now(),previous_error:job.error};
      job.state='waiting';job.next_attempt=Math.max(job.next_attempt||0,Date.now()+delay);job.wait_reason='CLAIM_RETRY';
      timing(this.c.dataDir,'claim_retry',{key:job.key,attempt:job.claim_attempts||1,retry_at:job.next_attempt});this.persist();return;
    }
    // Legacy claims have no owner and cannot safely be upgraded into a replay.
    if(['claiming','unknown'].includes(job.state)&&!job.claim_owner&&this.unlaunched(job)&&
      row?.claimed&&['accepted','started'].includes(row.phase)&&!row.error){
      job.recovery={kind:'claim-reconciled-before-launch',at:now(),previous_error:job.error};
      this.blocked(job,'CLAIM_RECONCILED_NOT_EXECUTED');return;
    }
    if(worker?.state==='blocked'){job.state='blocked';job.error=worker.error;this.persist();return;}
    if(worker?.state==='ready'&& !['submitted','confirmed'].includes(job.state)) {
      job.timings??={};
      for(const name of ['started_at','agent_started_at','agent_ended_at','packaging_started_at','packaging_ended_at','packaging_ms'])if(worker[name]!==undefined)job.timings[name==='started_at'?'worker_started_at':name]=worker[name];
      if(!job.timings.ready_observed_at){job.timings.ready_observed_at=now();job.timings.result_ready_at=worker.ended_at||null;timing(this.c.dataDir,'result_ready_observed',{key:job.key});}
      job.state='delivering';this.persist();
      // Admit a bounded set of independent durable deliveries. The transport
      // still serializes API writes; one route's retry window does not own a gate.
      if(!this.pending.has('delivery:'+job.key)&&[...this.pending.keys()].filter(k=>k.startsWith('delivery:')).length<4&&Date.now()>=(job.delivery_retry_at||0)){this.schedule('delivery:'+job.key,async()=>{
      try {
        job.delivery_attempts=(job.delivery_attempts||0)+1;job.timings.delivery_attempt_at=now();this.persist();
        timing(this.c.dataDir,'delivery_attempt',{key:job.key,attempt:job.delivery_attempts});
        const result=read(path.join(job.dir,'result.json'));need(result,'RESULT_MISSING');
        if(!job.artifact){job.timings.upload_queued_at??=now();this.persist();job.artifact=await this.connector.call('Upload',{key:job.key,file:path.join(job.dir,'result.zip')});job.timings.upload_confirmed_at=now();timing(this.c.dataDir,'upload_confirmed',{key:job.key,bytes:job.artifact.bytes});this.persist();}
        const completed={...result,artifacts:[job.artifact]};
        await this.connector.call('Complete',{key:job.key,data:completed});job.state='submitted';job.submitted_at=now();job.timings.result_queued_at=job.submitted_at;job.error='';timing(this.c.dataDir,'result_queued',{key:job.key});this.persist();
      }catch(e){job.error=cleanError(e);job.diagnostic=e.diagnostic;job.delivery_retry_at=Math.max(Date.now()+10000,e.retryAt||0);timing(this.c.dataDir,'delivery_retry',{key:job.key,code:job.error,retry_at:job.delivery_retry_at});this.persist();}
      });}
      return;
    }
    if(['claiming','launching','running'].includes(job.state)) {
      if(!alive(worker?.pid||job.pid)){job.state='unknown';job.error='WORKER_EXIT_UNKNOWN';this.persist();}
      else if(worker?.heartbeat&&Date.now()-Date.parse(worker.heartbeat)>60000){job.error='WORKER_HEARTBEAT_STALE';this.persist();}
    }
  }
}
