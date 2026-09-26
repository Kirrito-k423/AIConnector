import fs from 'node:fs';
import path from 'node:path';
import {ROOT, run, atomic, id, need, safeEnv,now} from './common.mjs';

export class Connector {
  constructor(config,secrets={}) {this.c=config;this.secrets=secrets;this.tail=Promise.resolve();}
  call(action,{key,file,data}={}) {
    const execute=async()=>{
      const started=Date.now();this.activity={action,key,started_at:now(),running:true};
      let temporary;
      if(data) {temporary=path.join(this.c.dataDir,'requests',id()+'.json'); atomic(temporary,JSON.stringify(data));file=temporary;}
      const args=['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(ROOT,'Connector.ps1'),'-Action',action,'-Node',this.c.node,'-Config',this.c.connectorConfig,'-StateDir',this.c.stateDir,'-Proxy',this.c.proxy,'-TimeoutSeconds',String(this.c.httpTimeoutSeconds??30)];
      if(key)args.push('-Key',key); if(file)args.push('-File',file);
      try {
        const token=this.secrets.githubToken||process.env[this.c.connector.token_env]||'';
        const result=await run(this.c.powershell,args,{env:safeEnv({[this.c.connector.token_env]:token})});
        const values=result.out.split(/\r?\n/).filter(x=>x.startsWith('{')).map(x=>JSON.parse(x));
        const value=values.at(-1);
        need(value,'CONNECTOR_NO_JSON');
        if(result.code!==0) throw new Error(value.error||value.code||'CONNECTOR_FAILED');
        return value;
      } finally {this.activity={...this.activity,running:false,milliseconds:Date.now()-started};if(temporary)fs.unlinkSync(temporary);}
    };
    const pending=this.tail.then(execute); this.tail=pending.catch(()=>{}); return pending;
  }
}
