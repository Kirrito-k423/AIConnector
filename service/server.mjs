import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {ROOT,now,id,sha,read,save,atomic,need,loadConfig,lock,cleanError} from './common.mjs';
import {Connector} from './connector.mjs';
import {Runner} from './runner.mjs';
import {loadSecrets,storeSecrets} from './vault.mjs';

const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const publicJob=j=>({key:j.key,state:j.state,error:j.error,created_at:j.created_at,claimed_at:j.claimed_at,submitted_at:j.submitted_at,confirmed_at:j.confirmed_at,worker:j.worker,artifact:j.artifact});
async function body(req) {
  let chunks=[],size=0;for await(const b of req){size+=b.length;need(size<=8*1024*1024,'REQUEST_TOO_LARGE');chunks.push(b);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function start(configFile,{secrets:givenSecrets}={}) {
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
  const connector=new Connector(c,secrets),runner=new Runner(c,connector,ledger,persist,secrets);
  let snapshot={runs:[],outbox:[]},busy=false,stopping=false,lastTick=0,nextPoll=0;
  const activity={started_at:now(),node:c.node,busy:false,last_error:''};
  async function tick() {
    if(busy||stopping)return;busy=true;activity.busy=true;
    try {
      if(Date.now()>=nextPoll) {
        nextPoll=Date.now()+c.tickSeconds*1000;
        try {snapshot=await connector.call('Poll');activity.last_error='';}
        catch(e){activity.last_error=cleanError(e);try{snapshot=await connector.call('Status');}catch{}}
      }
      if(stopping)return;
      if(Date.now()-lastTick>=c.tickSeconds*1000) {
        lastTick=Date.now();
        for(const draft of Object.values(ledger.submissions)) {
          if(draft.state==='queued')continue;
          try {
            if(draft.zipFile&&!draft.artifact){draft.artifact=await connector.call('Upload',{key:draft.key,file:draft.zipFile});persist();}
            await connector.call('Submit',{data:{...draft.task,artifacts:draft.artifact?[draft.artifact]:draft.task.artifacts}});
            draft.state='queued';draft.error='';persist();
          } catch(e){draft.error=cleanError(e);persist();}
        }
        await runner.tick(snapshot);persist();
      }
    }catch(e){activity.last_error=cleanError(e);}
    finally{busy=false;activity.busy=false;}
  }
  function status() {
    return {schema:'aiconnector.dashboard.v1',service:{...activity,transport:connector.activity,runner_enabled:c.runner.enabled,runner_error:ledger.runner_error||'',poll_seconds:c.tickSeconds,repository:c.connector.repository,
      github_configured:Boolean(secrets.githubToken),model_configured:Boolean(c.runner.model&&secrets.apiKey),model:c.runner.model||null},
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
      if(req.method==='GET'&&url.pathname==='/api/status'){reply(200,status());return;}
      if(req.method==='GET'&&url.pathname==='/api/result') {
        const job=ledger.jobs[url.searchParams.get('key')];need(job,'RESULT_NOT_FOUND');
        const file=path.join(job.dir,'result.zip');need(fs.existsSync(file),'RESULT_NOT_FOUND');
        res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="result.zip"'});res.end(fs.readFileSync(file));return;
      }
      need(req.method==='POST'&&req.headers['content-type']==='application/json','INVALID_REQUEST');
      const data=await body(req);
      if(url.pathname==='/api/shutdown') {reply(202,{stopping:true});setImmediate(()=>void close());return;}
      if(url.pathname==='/api/tasks') {
        need(c.node==='mac-outer','SENDER_ONLY');const task=data.task;
        need(task&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(task.task_id)&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(task.run_id)&&Number.isInteger(task.revision)&&task.revision>0,'INVALID_TASK_ID');
        need(task.title&&task.objective&&task.code?.revision&&task.code?.repository&&task.environment?.target&&task.invocation?.entry&&Array.isArray(task.invocation.arguments)&&Array.isArray(task.acceptance)&&task.acceptance.length>0&&Array.isArray(task.artifacts),'INVALID_TASK');
        need(task.artifacts.length===0,'USE_INPUT_ZIP_UPLOAD');
        const key=`${task.task_id}/${task.revision}/${task.run_id}`;
        const digest=sha(JSON.stringify(data));const existing=ledger.submissions[key];
        if(existing){need(existing.digest===digest,'RUN_IS_IMMUTABLE');reply(200,{key,state:existing.state});return;}
        let zipFile;
        if(data.zipBase64) {
          const bytes=Buffer.from(data.zipBase64,'base64');need(bytes.length>4&&bytes.length<5242880&&bytes.subarray(0,2).toString()==='PK','INVALID_INPUT_ZIP');
          zipFile=path.join(c.dataDir,'submissions',sha(key)+'.zip');atomic(zipFile,bytes);
        }
        ledger.submissions[key]={key,digest,task,zipFile,state:'pending',error:'',created_at:now()};persist();lastTick=0;void tick();reply(202,{key,state:'pending'});return;
      }
      if(url.pathname==='/api/settings') {
        need(typeof data.githubToken==='string'&&typeof data.apiKey==='string','INVALID_CREDENTIALS');
        const updated={...secrets};if(data.githubToken)updated.githubToken=data.githubToken;if(data.apiKey)updated.apiKey=data.apiKey;
        const disk=JSON.parse(fs.readFileSync(c.file,'utf8'));disk.runner??={enabled:false,profiles:{}};disk.runner.model=data.model||disk.runner.model;
        // Validate a non-secret candidate before touching the active config or vault.
        const tmp=c.file+'.candidate.local.json';atomic(tmp,JSON.stringify(disk));try{loadConfig(tmp);}finally{fs.unlinkSync(tmp);}
        await storeSecrets(c,updated);atomic(c.file,JSON.stringify(disk,null,2)+'\n');c.runner.model=disk.runner.model;
        Object.assign(secrets,updated);lastTick=0;nextPoll=0;reply(200,{saved:true});return;
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
    }catch(e){reply(['UNAUTHORIZED','INVALID_HOST','INVALID_ORIGIN'].includes(e.message)?403:400,{error:cleanError(e)});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.port,'127.0.0.1',resolve);});
  atomic(path.join(c.dataDir,'service-info.json'),JSON.stringify({pid:process.pid,url:origin,started_at:now()}));
  const interval=setInterval(()=>void tick(),1000);void tick();
  let closePromise;
  const close=()=>closePromise??=(async()=>{
    stopping=true;clearInterval(interval);await new Promise(resolve=>server.close(resolve));
    // An in-flight tick may enqueue more transport work after its current call.
    // Keep ownership until that entire tick and its subprocesses have drained.
    while(busy)await new Promise(resolve=>setTimeout(resolve,25));
    await connector.tail;unlock();
  })();
  return {server,close,status,token,url:origin,config:c};
}
