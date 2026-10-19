import {spawn} from 'node:child_process';
import path from 'node:path';
import {ROOT,need} from './common.mjs';
import {timing} from './telemetry.mjs';

// One resident process owns the ledger and its HTTP pool. A lost reply is never
// replayed here: callers reconcile their durable intent using the original ID.
export class Transport {
  constructor(config,spawnProcess=spawn){this.c=config;this.spawn=spawnProcess;this.child=null;this.pending=null;this.starting=null;}
  async open(env){
    if(this.starting)return this.starting;
    const started=Date.now();
    this.starting=new Promise((resolve,reject)=>{
      const args=['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(ROOT,'Connector.ps1'),'-Action','Serve','-Node',this.c.node,'-Config',this.c.connectorConfig,'-StateDir',this.c.stateDir,'-Proxy',this.c.proxy,'-TimeoutSeconds',String(this.c.httpTimeoutSeconds??30)];
      if(this.c.tickSeconds!==undefined)args.push('-PollSeconds',String(this.c.tickSeconds));
      const child=this.spawn(this.c.powershell,args,{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
      this.child=child;let buffer='',ready=false,failed=false;
      const fail=code=>{if(failed)return;failed=true;const error=new Error(code);reject(error);this.pending?.reject(error);this.pending=null;child.kill();};
      child.stdout.setEncoding('utf8');child.stderr.resume();
      child.stdout.on('data',chunk=>{
        buffer+=chunk;
        if(Buffer.byteLength(buffer)>32*1024*1024)return fail('CONNECTOR_REPLY_TOO_LARGE');
        for(let newline;(newline=buffer.indexOf('\n'))>=0;){
          const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(!line)continue;
          let reply;try{reply=JSON.parse(line);}catch{return fail('CONNECTOR_INVALID_REPLY');}
          if(!ready){
            if(reply.schema!=='aiconnector.transport.v1'||reply.ready!==true)return fail(/^[A-Z][A-Z0-9_:-]{0,120}$/.test(reply.code||'')?reply.code:'CONNECTOR_NOT_READY');
            ready=true;timing(this.c.dataDir,'runtime_ready',{elapsed_ms:Date.now()-started});resolve();continue;
          }
          if(!this.pending||reply.id!==this.pending.id)return fail('CONNECTOR_REPLY_MISMATCH');
          const pending=this.pending;this.pending=null;
          if(reply.ok===true)pending.resolve({code:0,out:JSON.stringify(reply.value)});
          else pending.resolve({code:1,out:JSON.stringify(reply.error)});
        }
      });
      child.on('error',()=>fail('CONNECTOR_SPAWN_FAILED'));
      child.stdin.on('error',()=>fail('CONNECTOR_CHANNEL_CLOSED'));
      child.once('close',()=>{
        if(!ready)reject(new Error('CONNECTOR_CHANNEL_CLOSED'));
        this.pending?.reject(new Error('CONNECTOR_CHANNEL_CLOSED'));this.pending=null;
        if(this.child===child){this.child=null;this.starting=null;}
      });
    });
    return this.starting;
  }
  async call(action,request,env){
    await this.open(env);need(!this.pending,'CONNECTOR_CONCURRENT_REQUEST');
    return new Promise((resolve,reject)=>{
      this.pending={id:request.operation_id,resolve,reject};
      this.child.stdin.write(JSON.stringify({...request,action})+'\n');
    });
  }
  async close(){
    if(!this.child)return;
    const child=this.child;const exited=new Promise(resolve=>child.once('close',resolve));
    child.stdin.end();await exited;
  }
}
