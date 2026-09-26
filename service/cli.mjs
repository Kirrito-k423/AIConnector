import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {ROOT,loadConfig,atomic,run,need,sha,read,alive,cleanError} from './common.mjs';

const args=process.argv.slice(2),command=args.shift()||'open';
const option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
const node=option('node',process.platform==='win32'?'windows-inner':'mac-outer');
const file=path.resolve(option('config',path.join(ROOT,`service-${node}.local.json`)));
const cli=path.join(ROOT,'service','cli.mjs');
function init(){
  if(fs.existsSync(file))return;
  const bundled=path.join(ROOT,'runtime','pwsh',process.platform==='win32'?'pwsh.exe':'pwsh');
  atomic(file,JSON.stringify({schema:'aiconnector.service.v1',node,port:node==='mac-outer'?43110:43111,
    connectorConfig:path.join(ROOT,'connector.config.json'),dataDir:path.join(ROOT,'service-data',node),
    powershell:fs.existsSync(bundled)?bundled:process.platform==='win32'?'powershell.exe':'pwsh',proxy:'system',
    runner:{enabled:node==='windows-inner',timeoutSeconds:600,maxTurns:8,profiles:{'local-smoke':{kind:'builtin-smoke',entry:'smoke',repository:'aiconnector-builtin',outputs:['metrics.json']}}}
  },null,2)+'\n');
}
function tag(c){return 'AIConnector-'+sha(c.dataDir).slice(0,12);}
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
async function install(c){
  // Transfer an existing foreground/background instance to the OS supervisor.
  if(await health(c)) {
    await shutdown(c);
    for(let i=0;i<180&&fs.existsSync(path.join(c.dataDir,'service.lock'));i++)await new Promise(r=>setTimeout(r,250));
    need(!fs.existsSync(path.join(c.dataDir,'service.lock')),'SERVICE_STOP_TIMEOUT');
  }
  if(process.platform==='win32'){
    const r=await run(c.powershell,['-NoProfile','-NonInteractive','-File',path.join(ROOT,'service','install-windows.ps1'),'-NodeExe',process.execPath,'-Cli',cli,'-Config',file,'-Name',tag(c)]);
    need(r.code===0,'SERVICE_INSTALL_FAILED');
  }else if(process.platform==='darwin'){
    const plist=path.join(os.homedir(),'Library','LaunchAgents',`local.${tag(c)}.plist`);fs.mkdirSync(c.dataDir,{recursive:true,mode:0o700});
    const body=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>local.${tag(c)}</string><key>ProgramArguments</key><array>${[process.execPath,cli,'start','--config',file].map(s=>`<string>${xml(s)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>${xml(path.join(c.dataDir,'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(c.dataDir,'service.log'))}</string></dict></plist>`;
    atomic(plist,body);await run('/bin/launchctl',['bootout',`gui/${process.getuid()}`,plist]);
    const r=await run('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,plist]);need(r.code===0,'SERVICE_INSTALL_FAILED');
  }else throw new Error('SERVICE_INSTALL_UNSUPPORTED');
  console.log('已安装当前用户登录时启动的后台服务。');
}
async function health(c) {
  try {
    const token=fs.readFileSync(path.join(c.dataDir,'dashboard.token'),'utf8');
    const response=await fetch(`http://127.0.0.1:${c.port}/api/status`,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(1500)});
    if(!response.ok)return false;const value=await response.json();return value.schema==='aiconnector.dashboard.v1'&&value.service.node===c.node;
  }catch{return false;}
}
async function shutdown(c) {
  const token=fs.readFileSync(path.join(c.dataDir,'dashboard.token'),'utf8');
  const response=await fetch(`http://127.0.0.1:${c.port}/api/shutdown`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)});
  need(response.ok,'SERVICE_STOP_FAILED');
}
async function background(c){
  const infoFile=path.join(c.dataDir,'service-info.json');
  if(await health(c))return;
  fs.mkdirSync(c.dataDir,{recursive:true,mode:0o700});const log=fs.openSync(path.join(c.dataDir,'service.log'),'a',0o600);
  const child=spawn(process.execPath,[cli,'start','--config',file],{detached:true,windowsHide:true,stdio:['ignore',log,log]});child.unref();fs.closeSync(log);
  for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));if(fs.existsSync(infoFile)&&JSON.parse(fs.readFileSync(infoFile)).pid===child.pid)return;if(!alive(child.pid))break;}
  throw new Error('SERVICE_START_FAILED');
}
try {
  init();const c=loadConfig(file);
  if(command==='init')console.log(file);
  else if(command==='start'){
    const {start}=await import('./server.mjs');const service=await start(file);
    console.log(`AIConnector ${c.node} 已启动：${service.url}；使用启动器打开页面。`);
    let closing=false;const stop=async()=>{if(closing)return;closing=true;await service.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  }else if(command==='install')await install(c);
  else if(command==='uninstall'){
    if(process.platform==='win32'){const r=await run('schtasks.exe',['/Delete','/TN',tag(c),'/F']);need(r.code===0,'SERVICE_UNINSTALL_FAILED');}
    else if(process.platform==='darwin'){const plist=path.join(os.homedir(),'Library','LaunchAgents',`local.${tag(c)}.plist`);await run('/bin/launchctl',['bootout',`gui/${process.getuid()}`,plist]);if(fs.existsSync(plist))fs.unlinkSync(plist);}
    console.log('已取消登录自启；任务数据和密钥保留。');
  }else if(command==='status'){
    const info=fs.existsSync(path.join(c.dataDir,'service-info.json'))?JSON.parse(fs.readFileSync(path.join(c.dataDir,'service-info.json'))):{};
    console.log(JSON.stringify({node:c.node,running:await health(c),url:info.url,jobs:Object.keys(read(path.join(c.dataDir,'service.json'),{jobs:{}}).jobs).length}));
  }else if(command==='stop'){
    if(await health(c))await shutdown(c);console.log('已请求退出。已派出的实验继续执行；安装了自启时系统会重启服务。');
  }else if(command==='open'||command==='background'){
    await background(c);
    if(command==='open'&&!args.includes('--no-browser')){
      const token=fs.readFileSync(path.join(c.dataDir,'dashboard.token'),'utf8');const url=`http://127.0.0.1:${c.port}/#token=${token}`;
      if(process.platform==='win32')await run('rundll32.exe',['url.dll,FileProtocolHandler',url]);else if(process.platform==='darwin')await run('/usr/bin/open',[url]);else console.log('服务已启动。访问凭据位于本地 dashboard.token。');
    }
  }else throw new Error('UNKNOWN_COMMAND');
}catch(e){
  const code=cleanError(e);console.error(code);
  try {const c=loadConfig(file);fs.mkdirSync(c.dataDir,{recursive:true});fs.appendFileSync(path.join(c.dataDir,'service.log'),new Date().toISOString()+' '+code+'\n',{mode:0o600});}catch{}
  process.exitCode=1;
}
