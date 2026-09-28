import fs from 'node:fs';
import path from 'node:path';
import {ROOT, run, atomic, id, need,now,safeDiagnostic} from './common.mjs';

export class Connector {
  constructor(config,secrets={}) {this.c=config;this.secrets=secrets;this.queue=[];this.running=false;this.waiters=[];}
  get tail(){return !this.running&&!this.queue.length?Promise.resolve():new Promise(resolve=>this.waiters.push(resolve));}
  async drain(){
    if(this.running)return;this.running=true;
    try{while(this.queue.length){
      const rank=x=>x.priority-Math.floor((Date.now()-x.at)/10000);
      this.queue.sort((a,b)=>rank(a)-rank(b)||a.at-b.at);
      const next=this.queue.shift();try{next.resolve(await next.execute());}catch(e){next.reject(e);}
    }}finally{this.running=false;for(const resolve of this.waiters.splice(0))resolve();}
  }
  call(action,{key,file,data}={}) {
    const execute=async()=>{
      const started=Date.now();this.activity={action,key,started_at:now(),running:true};
      let temporary;
      if(data) {temporary=path.join(this.c.dataDir,'requests',id()+'.json'); atomic(temporary,JSON.stringify(data));file=temporary;}
      const args=['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(ROOT,'Connector.ps1'),'-Action',action,'-Node',this.c.node,'-Config',this.c.connectorConfig,'-StateDir',this.c.stateDir,'-Proxy',this.c.proxy,'-TimeoutSeconds',String(this.c.httpTimeoutSeconds??30)];
      if(key)args.push('-Key',key); if(file)args.push('-File',file);
      try {
        const token=this.secrets.githubToken||process.env[this.c.connector.token_env]||'';
        // PowerShell/.NET needs the native Windows environment (e.g. windir and
        // ProgramData). This is our trusted transport, not an experiment tool.
        const env={...process.env,[this.c.connector.token_env]:token};delete env.PSModulePath;
        const result=await run(this.c.powershell,args,{env});
        const values=result.out.split(/\r?\n/).filter(x=>x.startsWith('{')).map(x=>JSON.parse(x));
        const value=values.at(-1);
        need(value,'CONNECTOR_NO_JSON');
        if(result.code!==0){const error=new Error(value.error||value.code||'CONNECTOR_FAILED');error.diagnostic=safeDiagnostic({...value.diagnostic,code:value.code,action,line:value.line});this.activity.diagnostic=error.diagnostic;throw error;}
        return value;
      } finally {if(['Claim','Complete','Submit'].includes(action))this.dirty=true;this.activity={...this.activity,running:false,milliseconds:Date.now()-started};if(temporary)fs.unlinkSync(temporary);}
    };
    return new Promise((resolve,reject)=>{
      const priority={Claim:0,Status:1,Complete:2,Submit:3,Flush:4,Poll:5,Advertise:6,Upload:7}[action]??8;
      this.queue.push({execute,resolve,reject,priority,at:Date.now()});void this.drain();
    });
  }
}
