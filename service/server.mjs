import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {ROOT,now,id,sha,read,save,atomic,need,loadConfig,lock,cleanError} from './common.mjs';
import {Connector} from './connector.mjs';
import {Runner} from './runner.mjs';
import {loadSecrets,storeSecrets} from './vault.mjs';
import {snapshotAgent} from './agent-config.mjs';
import {WatchClient,validateWatchProfile} from './watch.mjs';
import {webTools} from './web-tools.mjs';
import {capabilities,preflight,validateProfile,VERSION} from './capabilities.mjs';
import {WindowProfiler} from './window-profiler.mjs';
import {timing,diagnostics} from './telemetry.mjs';

import {serverCatalog,setupServers,serverReadiness} from './server-setup.mjs';

const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const publicJob=j=>({key:j.key,state:j.state,error:j.error,diagnostic:j.diagnostic,recovery:j.recovery,resources:j.resources,wait_reason:j.wait_reason,wait_owner:j.wait_owner,created_at:j.created_at,claimed_at:j.claimed_at,submitted_at:j.submitted_at,confirmed_at:j.confirmed_at,worker:j.worker,process_exit:j.process_exit,process_failure:j.process_failure,artifact:j.artifact,timings:j.timings,delivery_attempts:j.delivery_attempts,delivery_diagnostics:j.delivery_diagnostics});
async function body(req) {
  let chunks=[],size=0;for await(const b of req){size+=b.length;need(size<=8*1024*1024,'REQUEST_TOO_LARGE');chunks.push(b);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function start(configFile,{secrets:givenSecrets,connector:givenConnector}={}) {
  const c=loadConfig(configFile);fs.mkdirSync(c.dataDir,{recursive:true,mode:0o700});
  const unlock=lock(path.join(c.dataDir,'service.lock'));
  const ledgerFile=path.join(c.dataDir,'service.json');
  const binding=sha(JSON.stringify({node:c.node,connector:c.connector}));
  const ledger=read(ledgerFile,{binding,jobs:{},submissions:{},created_at:now()});
  need(ledger.binding===binding,'SERVICE_CONFIG_BINDING_MISMATCH');
  const persist=()=>save(ledgerFile,ledger);
  let secrets=givenSecrets??await loadSecrets(c);
  secrets={...secrets,githubToken:process.env[c.connector.token_env]||secrets.githubToken,apiKey:process.env.AICONNECTOR_AI_API_KEY||secrets.apiKey};
  const authFile=path.join(c.dataDir,'dashboard.token');
  if(!fs.existsSync(authFile))atomic(authFile,id());
  const token=fs.readFileSync(authFile,'utf8');
  const connector=givenConnector??new Connector(c,secrets),runner=new Runner(c,connector,ledger,persist,secrets);
  let snapshot={runs:[],outbox:[]},busy=false,auditing=false,advertising=false,submitting=false,supervising=false,flushing=false,flushNeeded=false,stopping=false,lastTick=0,nextPoll=0,nextFlush=0,nextAdvertise=0,nextAudit=0;
  const activity={started_at:now(),node:c.node,busy:false,last_error:''};
  const localCapabilities=()=>{try{return capabilities(c,secrets,snapshotAgent(c.runner.agent,path.dirname(c.file)));}catch(e){const value={...capabilities(c,secrets),enabled:false,error:cleanError(e)};value.digest=sha(JSON.stringify({...value,generated_at:undefined,digest:undefined}));return value;}};
  async function tick() {
    // Drain eligible outbound controls before adding another discovery scan.
    // A pending Flush/Claim/Complete is already serialized by the connector.
    if(busy||stopping||flushing||Date.now()<nextPoll||connector.queue?.some(x=>!x.background&&x.priority<=1)||[...runner.pending.keys()].some(k=>k.startsWith('start:')||k.startsWith('delivery:')))return;busy=true;activity.busy=true;
    try {
      if(Date.now()>=nextPoll) {
        nextPoll=Infinity;
        try {snapshot=await connector.call('Poll');activity.last_error='';activity.diagnostic=null;}
        catch(e){activity.last_error=cleanError(e);activity.diagnostic=e.diagnostic;try{snapshot=await connector.call('Status');}catch{}}
      }
    }catch(e){activity.last_error=cleanError(e);}
    finally{busy=false;activity.busy=false;nextPoll=Date.now()+c.tickSeconds*1000;}
  }
  async function audit(){
    if(auditing||stopping||Date.now()<nextAudit||busy||flushing||connector.dirty||connector.running||connector.queue?.length)return;
    nextAudit=Date.now()+60000;auditing=true;
    try{snapshot=await connector.call('Audit');}catch(e){activity.audit_error=cleanError(e);}finally{auditing=false;}
  }
  async function advertise(){
    if(advertising||stopping||Date.now()<nextAdvertise||c.node!=='windows-inner'||c.connector.layout!=='task-issues-run-releases-v1')return;
    nextAdvertise=Date.now()+30000;
    const current=localCapabilities();
    if(ledger.capability_digest===current.digest&&Date.now()-(ledger.capability_at||0)<=1800000)return;
    advertising=true;
    try{const r=await connector.call('Advertise',{data:current});if(r.confirmed&&r.data?.digest===current.digest){ledger.capability_digest=current.digest;ledger.capability_at=Date.now();persist();activity.capability_state='confirmed';}else activity.capability_state='pending';activity.capability_error='';activity.capability_diagnostic=null;}
    catch(e){activity.capability_error=cleanError(e);activity.capability_diagnostic=e.diagnostic;activity.capability_state='retrying';nextAdvertise=Math.max(nextAdvertise,e.retryAt||0);}
    finally{advertising=false;}
  }
  async function submit(){
    if(submitting||stopping)return;submitting=true;
    try{
      if(Date.now()-lastTick>=c.tickSeconds*1000) {
        lastTick=Date.now();
        for(const draft of Object.values(ledger.submissions)) {
          if(['queued','rejected'].includes(draft.state))continue;
          try {
            if(draft.zipFile&&!draft.artifact){draft.artifact=await connector.call('Upload',{key:draft.key,file:draft.zipFile});persist();}
            await connector.call('Submit',{data:{...draft.task,artifacts:draft.artifact?[draft.artifact]:draft.task.artifacts}});
            flushNeeded=true;
            draft.state='queued';draft.error='';persist();
          } catch(e){
            draft.error=cleanError(e);
            if(['RUN_IS_IMMUTABLE','REVISION_IS_IMMUTABLE'].includes(draft.error))draft.state='rejected';
            persist();
          }
        }
        persist();
      }
    }catch(e){activity.last_error=cleanError(e);}
    finally{submitting=false;}
  }
  async function supervise(){
    if(supervising||stopping)return;supervising=true;
    try{await runner.tick(snapshot);persist();}catch(e){ledger.runner_error=cleanError(e);}finally{supervising=false;}
  }
  async function flush(){
    if(flushing||stopping||Date.now()<nextFlush||Date.now()<(snapshot.next_poll||0)*1000)return;
    const eligible=(snapshot.outbox||[]).some(e=>{
      if((snapshot.scopes?.['delivery:'+e.key.split('/')[0]]?.next_attempt||0)*1000>Date.now())return false;
      return ['pending','rate_limited'].includes(e.status)||e.status==='uncertain'&&(!e.recovery||Date.now()/1000-e.recovery.last_absent_at>=c.tickSeconds);
    });
    if(!flushNeeded&&!connector.dirty&&!eligible)return;
    flushing=true;nextFlush=Date.now()+Math.max(1,c.connector.write_interval_seconds||1)*1000;
    try{snapshot=await connector.call('Flush');flushNeeded=false;connector.dirty=false;}catch(e){activity.last_error=cleanError(e);activity.diagnostic=e.diagnostic;nextFlush=Date.now()+10000;}finally{flushing=false;}
  }
  function status() {
    return {schema:'aiconnector.dashboard.v1',capabilities:{local:localCapabilities(),receiver:snapshot.receiver_capabilities||null},service:{...activity,version:VERSION,transport:connector.activity,runner_enabled:c.runner.enabled,runner_error:ledger.runner_error||'',poll_seconds:c.tickSeconds,repository:c.connector.repository,
      github_configured:Boolean(secrets.githubToken),model_configured:Boolean(c.runner.model&&secrets.apiKey),model:c.runner.model||null,
      runner:{agent:c.runner.agent,profiles:c.runner.profiles,enabled:c.runner.enabled,timeoutSeconds:c.runner.timeoutSeconds,maxTurns:c.runner.maxTurns,maxConcurrentRuns:c.runner.maxConcurrentRuns,activeRuns:runner.slots(),proxy:c.runner.proxy||'system'}},
      channel:snapshot,jobs:Object.values(ledger.jobs).map(publicJob),submissions:Object.values(ledger.submissions).map(d=>({key:d.key,task:d.task,state:d.state,error:d.error,created_at:d.created_at}))};
  }
  const origin=`http://127.0.0.1:${c.port}`;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
    const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    try {
      need(req.headers.host===`127.0.0.1:${c.port}`,'INVALID_HOST');
      need(!req.headers.origin||req.headers.origin===origin,'INVALID_ORIGIN');
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&files[url.pathname]) {const [file,mime]=files[url.pathname];res.writeHead(200,{'Content-Type':mime});res.end(fs.readFileSync(path.join(ROOT,'service','web',file)));return;}
      need(req.headers.authorization===`Bearer ${token}`,'UNAUTHORIZED');
      if(req.method==='GET'&&url.pathname==='/api/server-readiness'){reply(200,serverReadiness(c));return;}
      if(req.method==='GET'&&url.pathname==='/api/server-catalog'){reply(200,await serverCatalog(c));return;}
      if(req.method==='GET'&&url.pathname==='/api/status'){reply(200,status());return;}
      if(req.method==='GET'&&url.pathname==='/api/diagnostics'){reply(200,diagnostics(c,ledger,snapshot,url.searchParams.get('key')||''));return;}
      if(req.method==='GET'&&url.pathname==='/api/capabilities'){reply(200,{local:localCapabilities(),receiver:snapshot.receiver_capabilities||null});return;}
      if(req.method==='GET'&&url.pathname==='/api/result') {
        const job=ledger.jobs[url.searchParams.get('key')];need(job,'RESULT_NOT_FOUND');
        const file=path.join(job.dir,'result.zip');need(fs.existsSync(file),'RESULT_NOT_FOUND');
        res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="result.zip"'});res.end(fs.readFileSync(file));return;
      }
      need(req.method==='POST'&&req.headers['content-type']==='application/json','INVALID_REQUEST');
      const data=await body(req);
      if(url.pathname==='/api/server-setup'){const value=await setupServers(c,data);activity.capability_state='pending';lastTick=0;nextPoll=0;reply(200,{...value,saved:true,publication:{state:'pending',background:true}});return;}
      if(url.pathname==='/api/preflight'){reply(200,preflight(data.task,snapshot.receiver_capabilities?.data));return;}
      if(url.pathname==='/api/shutdown') {reply(202,{stopping:true});setImmediate(()=>void close());return;}
      if(url.pathname==='/api/tasks') {
        need(c.node==='mac-outer','SENDER_ONLY');const task=data.task;
        need(task&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(task.task_id)&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(task.run_id)&&Number.isInteger(task.revision)&&task.revision>0,'INVALID_TASK_ID');
        need(task.title&&task.objective&&task.code?.revision&&task.code?.repository&&task.environment?.target&&task.invocation?.entry&&Array.isArray(task.invocation.arguments)&&Array.isArray(task.acceptance)&&task.acceptance.length>0&&Array.isArray(task.artifacts),'INVALID_TASK');
        need(task.artifacts.length===0,'USE_INPUT_ZIP_UPLOAD');
        const key=`${task.task_id}/${task.revision}/${task.run_id}`;
        const digest=sha(JSON.stringify(data));const existing=ledger.submissions[key];
        if(existing){need(existing.digest===digest,'RUN_IS_IMMUTABLE');reply(200,{key,state:existing.state});return;}
        const checked=preflight(task,snapshot.receiver_capabilities?.data);
        task.environment.target=checked.profile.id;task.invocation.entry=checked.profile.entry;
        task.receiver_config_sha256=checked.config_sha256;
        let zipFile;
        if(data.zipBase64) {
          const bytes=Buffer.from(data.zipBase64,'base64');need(bytes.length>4&&bytes.length<5242880&&bytes.subarray(0,2).toString()==='PK','INVALID_INPUT_ZIP');
          zipFile=path.join(c.dataDir,'submissions',sha(key)+'.zip');atomic(zipFile,bytes);
        }
        ledger.submissions[key]={key,digest,task,zipFile,state:'pending',error:'',created_at:now()};persist();timing(c.dataDir,'task_submitted',{key});lastTick=0;void submit();reply(202,{key,state:'pending'});return;
      }
      if(url.pathname==='/api/settings') {
        need(typeof data.githubToken==='string'&&typeof data.apiKey==='string','INVALID_CREDENTIALS');
        const updated={...secrets};if(data.githubToken)updated.githubToken=data.githubToken;if(data.apiKey)updated.apiKey=data.apiKey;
        const disk=JSON.parse(fs.readFileSync(c.file,'utf8'));disk.runner??={enabled:false,profiles:{}};if(data.model)disk.runner.model={...disk.runner.model,...data.model};
        // Validate a non-secret candidate before touching the active config or vault.
        const tmp=c.file+'.candidate.local.json';atomic(tmp,JSON.stringify(disk));try{loadConfig(tmp);}finally{fs.unlinkSync(tmp);}
        await storeSecrets(c,updated);atomic(c.file,JSON.stringify(disk,null,2)+'\n');c.runner.model=disk.runner.model;
        Object.assign(secrets,updated);lastTick=0;nextPoll=0;reply(200,{saved:true});return;
      }
      if(url.pathname==='/api/agent-settings') {
        const disk=JSON.parse(fs.readFileSync(c.file,'utf8'));disk.runner??={};
        need(data.agent&&typeof data.enabled==='boolean'&&data.profiles&&typeof data.profiles==='object'&&!Array.isArray(data.profiles),'INVALID_AGENT_SETTINGS');
        disk.runner={...disk.runner,agent:data.agent,enabled:data.enabled,profiles:data.profiles,timeoutSeconds:data.timeoutSeconds,maxTurns:data.maxTurns,...(data.maxConcurrentRuns!==undefined?{maxConcurrentRuns:data.maxConcurrentRuns}:{})};
        if(disk.runner.model&&data.modelLimits)disk.runner.model={...disk.runner.model,...data.modelLimits};
        if(disk.runner.serverRegistry){
          const registry=JSON.parse(fs.readFileSync(c.runner.serverRegistry,'utf8'));
          for(const id of Object.keys(registry.profiles)){need(JSON.stringify(disk.runner.profiles[id])===JSON.stringify(registry.profiles[id]),'EDIT_SERVER_REGISTRY_SEPARATELY');delete disk.runner.profiles[id];}
        }
        for(const p of Object.values(disk.runner.profiles))validateProfile(p);
        const tmp=c.file+'.candidate.local.json';let candidate;
        atomic(tmp,JSON.stringify(disk));try{candidate=loadConfig(tmp);snapshotAgent(candidate.runner.agent,path.dirname(c.file));}finally{fs.unlinkSync(tmp);}
        atomic(c.file,JSON.stringify(disk,null,2)+'\n');c.runner=candidate.runner;lastTick=0;nextPoll=0;reply(200,{saved:true,applies_to:'next_claim'});return;
      }
      if(url.pathname==='/api/agent-check') {
        const checks={};
        try{const a=snapshotAgent(c.runner.agent,path.dirname(c.file));checks.context={ok:true,sha256:a.contextDigest,files:a.contexts.map(f=>f.name)};}catch(e){checks.context={ok:false,error:cleanError(e)};}
        if(c.runner.agent.simpleHtmlWatch.enabled) {
          try{const env=await new WatchClient(c.runner.agent.simpleHtmlWatch).environment();checks.simpleHtmlWatch={ok:true,baseUrl:c.runner.agent.simpleHtmlWatch.baseUrl,observed_at:env.observed_at,ready:env.ready,ready_is_not_npu_idle:true};}catch(e){checks.simpleHtmlWatch={ok:false,baseUrl:c.runner.agent.simpleHtmlWatch.baseUrl,error:cleanError(e)};}
        }else checks.simpleHtmlWatch={enabled:false};
        if(c.runner.agent.simpleHtmlWatch.enabled&&(c.runner.maxConcurrentRuns??1)>1){
          try{const r=await new WatchClient(c.runner.agent.simpleHtmlWatch).call('/api/tasks/reservations');need(r.schema==='simplehtmlwatch.reservations.v1','WATCH_RESERVATIONS_REQUIRED');checks.reservations={ok:true,baseUrl:c.runner.agent.simpleHtmlWatch.baseUrl};}
          catch(e){checks.reservations={ok:false,baseUrl:c.runner.agent.simpleHtmlWatch.baseUrl,error:cleanError(e),hint:'并行 SSH 需要支持 reservations.v1 的 simpleHtmlWatch；旧控制器请先升级。'};}
        }
        if(data.webUrl&&c.runner.agent.web.enabled){try{const tools=webTools(c.runner.agent.web);const value=await tools[0].execute('',{url:data.webUrl});checks.web={ok:true,result:JSON.parse(value.content[0].text)};}catch(e){checks.web={ok:false,error:cleanError(e)};}}
        else checks.web={enabled:c.runner.agent.web.enabled,tested:false};
        reply(200,{checked_at:now(),configuration:'saved',hint:'检查使用已保存配置；修改表单后请先保存。',checks});return;
      }
      if(url.pathname==='/api/reload-agent'){
        const candidate=loadConfig(c.file);need(sha(JSON.stringify({node:candidate.node,connector:candidate.connector}))===binding&&candidate.dataDir===c.dataDir&&candidate.port===c.port,'RELOAD_IDENTITY_CHANGED');
        for(const p of Object.values(candidate.runner.profiles))validateProfile(p);
        snapshotAgent(candidate.runner.agent,path.dirname(c.file));c.runner=candidate.runner;nextPoll=0;lastTick=0;reply(200,{reloaded:true,applies_to:'next_claim',version:VERSION});return;
      }
      if(url.pathname==='/api/resolve-unknown') {
        need(c.node==='windows-inner'&&data.remoteChecked===true,'EXECUTION_CHECK_REQUIRED');
        // resolveUnknown is synchronous and only touches unknown jobs, which no
        // pending transport operation can be delivering. Do not reject UI clicks
        // just because an unrelated poll is awaiting its HTTP response.
        runner.resolveUnknown(data.key);lastTick=0;reply(200,{resolved:true});return;
      }
      if(url.pathname==='/api/poll') {
        // Wake the local scheduler; Connector still enforces its persisted cooldown.
        need(Date.now()-(activity.last_manual_poll||0)>=15000,'POLL_TOO_FREQUENT');activity.last_manual_poll=Date.now();nextPoll=0;lastTick=0;void tick();reply(202,{queued:true});return;
      }
      reply(404,{error:'NOT_FOUND'});
    }catch(e){reply(['UNAUTHORIZED','INVALID_HOST','INVALID_ORIGIN'].includes(e.message)?403:400,{error:cleanError(e),...(e.diagnostic?{diagnostic:e.diagnostic}:{})});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.port,'127.0.0.1',resolve);});
  atomic(path.join(c.dataDir,'service-info.json'),JSON.stringify({pid:process.pid,url:origin,started_at:now()}));
  const profiler=new WindowProfiler(path.join(c.dataDir,'service-windows.jsonl'),'',{source:'service',initialStage:'service.event_loop'});
  const interval=setInterval(()=>{void submit();void supervise();void flush();void tick();void advertise();void audit();},1000);void submit();void tick();void supervise();
  let closePromise;
  const close=()=>closePromise??=(async()=>{
    stopping=true;clearInterval(interval);await new Promise(resolve=>server.close(resolve));
    // An in-flight tick may enqueue more transport work after its current call.
    // Keep ownership until that entire tick and its subprocesses have drained.
    while(busy||auditing||advertising||submitting||supervising||flushing)await new Promise(resolve=>setTimeout(resolve,25));
    await runner.idle();await connector.close();profiler.close();unlock();
  })();
  return {server,close,status,token,url:origin,config:c};
}
