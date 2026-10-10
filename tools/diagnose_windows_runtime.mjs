import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run,safeEnv,ROOT} from '../service/common.mjs';
if(process.platform==='win32') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC startup '));
  for(const [name,env]of [['minimal',safeEnv()],['native',{...process.env,PSModulePath:''}]]){
    for(const [action,args]of [['version',['-Command','[Console]::WriteLine($PSVersionTable.PSVersion.ToString())']],['status',['-File',path.join(ROOT,'Connector.ps1'),'-Action','Status','-StateDir',path.join(dir,name)]]]){
      const start=Date.now();
      try {const r=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive',...args],{env,signal:AbortSignal.timeout(30000),cap:2048});console.log(JSON.stringify({name,action,milliseconds:Date.now()-start,code:r.code,out:r.out,err:r.err}));}
      catch(e){console.log(JSON.stringify({name,action,milliseconds:Date.now()-start,error:e.message}));}
    }
  }
  fs.rmSync(dir,{recursive:true,force:true});
}
