import fs from 'node:fs';
import path from 'node:path';
import {ROOT, atomic, id, need,now,safeDiagnostic} from './common.mjs';
import {timing} from './telemetry.mjs';
import {Transport} from './transport.mjs';

export class Connector {
  constructor(config,secrets={},invoke) {this.c=config;this.secrets=secrets;this.invoke=invoke;this.transport=invoke?null:new Transport(config);this.queue=[];this.running=false;this.waiters=[];}
  async close(){await this.tail;await this.transport?.close();}
  get tail(){return !this.running&&!this.queue.length?Promise.resolve():new Promise(resolve=>this.waiters.push(resolve));}
  async drain(){
    if(this.running)return;this.running=true;
    try{while(this.queue.length){
      // Discovery ages against controls; maintenance/diagnostic work remains
      // below foreground work and runs when the queue has no foreground item.
      const rank=x=>x.background?8:x.priority-Math.floor((Date.now()-x.at)/10000);
      this.queue.sort((a,b)=>rank(a)-rank(b)||a.at-b.at);
      const next=this.queue.shift();try{next.resolve(await next.execute());}catch(e){next.reject(e);}
    }}finally{this.running=false;for(const resolve of this.waiters.splice(0))resolve();}
  }
  call(action,{key,file,data,claimOwner}={}) {
    const queued=Date.now(),operation=id();
    key??=data?.task_id&&data?.revision&&data?.run_id?`${data.task_id}/${data.revision}/${data.run_id}`:undefined;
    timing(this.c.dataDir,'action_queued',{operation_id:operation,action,key,queue_depth:this.queue.length+Number(this.running),blocker_operation_id:this.activity?.running?this.activity.operation_id:undefined,blocker_action:this.activity?.running?this.activity.action:undefined});
    const execute=async()=>{
      const started=Date.now();this.activity={action,key,operation_id:operation,queued_at:new Date(queued).toISOString(),queue_wait_ms:started-queued,started_at:now(),running:true};
      timing(this.c.dataDir,'action_dispatched',{operation_id:operation,action,key,queue_wait_ms:started-queued});
      let temporary;
      if(data) {temporary=path.join(this.c.dataDir,'requests',id()+'.json'); atomic(temporary,JSON.stringify(data));file=temporary;}
      const args=['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(ROOT,'Connector.ps1'),'-Action',action,'-OperationId',operation,'-Node',this.c.node,'-Config',this.c.connectorConfig,'-StateDir',this.c.stateDir,'-Proxy',this.c.proxy,'-TimeoutSeconds',String(this.c.httpTimeoutSeconds??30)];
      if(key)args.push('-Key',key); if(file)args.push('-File',file);
      if(claimOwner)args.push('-ClaimOwner',claimOwner);
      if(this.c.tickSeconds!==undefined)args.push('-PollSeconds',String(this.c.tickSeconds));
      try {
        const token=this.secrets.githubToken||process.env[this.c.connector.token_env]||'';
        // PowerShell/.NET needs the native Windows environment (e.g. windir and
        // ProgramData). This is our trusted transport, not an experiment tool.
        const env={...process.env,[this.c.connector.token_env]:token};delete env.PSModulePath;
        const result=this.transport?await this.transport.call(action,{operation_id:operation,key:key||'',file:file||'',claim_owner:claimOwner||'',token},env):await this.invoke(this.c.powershell,args,{env});
        const values=result.out.split(/\r?\n/).filter(x=>x.startsWith('{')).map(x=>JSON.parse(x));
        const value=values.at(-1);
        need(value,'CONNECTOR_NO_JSON');
        if(result.code!==0){const error=new Error(value.error||value.code||'CONNECTOR_FAILED');error.diagnostic=safeDiagnostic({...value.diagnostic,code:value.code,action,line:value.line});error.retryAt=Number(value.retry_at||0)*1000;this.activity.diagnostic=error.diagnostic;timing(this.c.dataDir,'action_failed',{operation_id:operation,action,key,code:error.diagnostic.code,retry_at:error.retryAt});throw error;}
        return value;
      } finally {if(['Claim','Complete','Submit'].includes(action))this.dirty=true;this.activity={...this.activity,running:false,milliseconds:Date.now()-started};timing(this.c.dataDir,'action_finished',{operation_id:operation,action,key,elapsed_ms:Date.now()-started,total_ms:Date.now()-queued});if(temporary)fs.unlinkSync(temporary);}
    };
    return new Promise((resolve,reject)=>{
      // Claims and completion parents first; a ready ZIP precedes a fresh scan.
      // Discovery ages within foreground work. Background diagnostics/audit
      // are best effort. No active HTTP request is preempted or replayed.
      const priority={Status:0,Complete:0,Claim:0,Flush:0,Upload:1,Submit:2,Poll:3,Advertise:6,Audit:8,UploadDiagnostics:8}[action]??8;
      const waitTimer=setInterval(()=>timing(this.c.dataDir,'action_wait',{operation_id:operation,action,key,queue_wait_ms:Date.now()-queued,blocker_operation_id:this.activity?.running?this.activity.operation_id:undefined,blocker_action:this.activity?.running?this.activity.action:undefined}),10000);waitTimer.unref();
      this.queue.push({execute:async()=>{clearInterval(waitTimer);return execute();},resolve,reject,priority,background:['Audit','Advertise','UploadDiagnostics'].includes(action),at:queued});void this.drain();
    });
  }
}
