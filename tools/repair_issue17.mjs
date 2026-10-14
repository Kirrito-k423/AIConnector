import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';

const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const need=(ok,code)=>{if(!ok)throw new Error(code);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const packageDir=path.dirname(fileURLToPath(import.meta.url));

export function parseActiveService(record){
  const match=record.CommandLine?.match(/(?:"([^"\r\n]*[\\/]cli\.mjs)"|([^\s"\r\n]*[\\/]cli\.mjs))\s+start\s+--config\s+(?:"([^"\r\n]+)"|([^\s"\r\n]+))/i);
  if(!match||!record.ExecutablePath)return null;
  const cli=match[1]||match[2],config=match[3]||match[4];
  if(!path.win32.isAbsolute(cli)||!path.win32.isAbsolute(config)||!/node\.exe$/i.test(record.ExecutablePath))return null;
  return {cli,config,pid:record.ProcessId};
}

export function patchConnector(root,replacement,allowedSha,atomic){
  const target=path.join(root,'Connector.ps1'),manifestFile=path.join(root,'package-manifest.json');
  const original=fs.readFileSync(target),originalSha=digest(original),patchedSha=digest(replacement);
  const manifestBytes=fs.existsSync(manifestFile)?fs.readFileSync(manifestFile):null;
  const manifest=manifestBytes?JSON.parse(manifestBytes):null;
  if(originalSha===patchedSha){
    if(manifest)need(manifest.sha256?.['Connector.ps1']===patchedSha,'PACKAGE_MANIFEST_MISMATCH');
    return {already_patched:true,patched_sha256:patchedSha};
  }
  need((Array.isArray(allowedSha)?allowedSha:[allowedSha]).includes(originalSha),'UNSUPPORTED_CONNECTOR_VERSION');
  if(manifest)need(manifest.sha256?.['Connector.ps1']===originalSha,'PACKAGE_MANIFEST_MISMATCH');
  const backup=path.join(root,'issue17-backup-'+Date.now());
  fs.mkdirSync(backup);fs.writeFileSync(path.join(backup,'Connector.ps1'),original,{flag:'wx'});
  if(manifestBytes)fs.writeFileSync(path.join(backup,'package-manifest.json'),manifestBytes,{flag:'wx'});
  try{
    atomic(target,replacement);
    need(digest(fs.readFileSync(target))===patchedSha,'PATCH_VERIFICATION_FAILED');
    if(manifest){
      manifest.sha256['Connector.ps1']=patchedSha;
      manifest.local_patches=[...(manifest.local_patches||[]),{id:'issue17',applied_at:new Date().toISOString(),original_sha256:originalSha,patched_sha256:patchedSha}];
      atomic(manifestFile,JSON.stringify(manifest,null,2)+'\n');
    }
    return {already_patched:false,patched_sha256:patchedSha,backup_created:true};
  }catch(error){
    try{atomic(target,original);if(manifestBytes)atomic(manifestFile,manifestBytes);}
    catch{throw new Error('PATCH_ROLLBACK_FAILED_BACKUP_PRESERVED');}
    throw error;
  }
}

async function discover(){
  need(process.platform==='win32','WINDOWS_ONLY');
  const command="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $env:PSModulePath=$PSHOME+'\\Modules'; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'cli\\.mjs\"?\\s+start\\s+--config' } | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress";
  const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:20000});
  need(run.status===0,'RECEIVER_DISCOVERY_FAILED');
  const records=JSON.parse(run.stdout.trim()||'[]'),candidates=[],seen=new Set();
  for(const record of Array.isArray(records)?records:[records]){
    const active=parseActiveService(record);if(!active)continue;
    let disk;try{disk=JSON.parse(fs.readFileSync(active.config,'utf8').replace(/^\uFEFF/,''));}catch{continue;}
    if(disk.schema!=='aiconnector.service.v1'||disk.node!=='windows-inner')continue;
    const stat=fs.statSync(active.config,{bigint:true}),key=stat.dev+':'+stat.ino;
    if(!seen.has(key)){seen.add(key);candidates.push(active);}
  }
  need(candidates.length===1,candidates.length?'MULTIPLE_RECEIVERS':'RECEIVER_NOT_RUNNING');
  return candidates[0];
}

export function summarizeState(state={}){
  const summarize=rows=>{
    const counts={};for(const row of Object.values(rows||{})){const key=String(row.status||'unknown')+':'+Number(row.http||0);counts[key]=(counts[key]||0)+1;}return counts;
  };
  return {uploads:summarize(state.uploads),provisions:summarize(state.provisions),pending_capability_at:state.capabilities_pending?.generated_at||null};
}

export async function repair({diagnoseOnly=false}={}){
  const active=await discover(),serviceDir=path.dirname(active.cli),root=path.dirname(serviceDir);
  const load=file=>import(pathToFileURL(path.join(serviceDir,file)).href);
  const {loadConfig,atomic}=await load('common.mjs');
  const {localRequest}=await load('http.mjs'),{prepareUpgrade}=await load('upgrade.mjs');
  const c=loadConfig(active.config),token=fs.readFileSync(path.join(c.dataDir,'dashboard.token'),'utf8');
  const api=async(route,body)=>{
    const response=await localRequest(`http://127.0.0.1:${c.port}${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),timeoutSeconds:15,maxBytes:1048576});
    need(response.status>=200&&response.status<300,'RECEIVER_API_FAILED');return JSON.parse(response.body);
  };
  const cap=(await api('/api/capabilities')).local;
  need(cap?.node==='windows-inner','WRONG_RECEIVER');
  const state=readConnectorState(path.join(c.stateDir,'state.json'));
  const faults=[];
  for(const suffix of ['.1','']){
    const file=path.join(c.stateDir,'transport-timing.jsonl'+suffix);
    if(!fs.existsSync(file)||fs.statSync(file).size>3*1024*1024)continue;
    for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
      let row;try{row=JSON.parse(line);}catch{continue;}
      if(row.kind!=='stage_failed')continue;
      const out={};for(const name of ['at','action','stage','category','exception_type','native_code','line'])if(row[name]!==undefined)out[name]=row[name];
      faults.push(out);
    }
  }
  const report={schema:'aiconnector.issue17-diagnostic.v1',checked_at:new Date().toISOString(),version:cap.version,...summarizeState(state),faults:faults.slice(-30),repaired:false};
  const reportFile=path.join(packageDir,'issue17-diagnostic.json');
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
  if(diagnoseOnly)return report;
  // Reuse the normal upgrade's worker gate before shutdown and again after it.
  // Unknown execution records remain untouched; no process is force-killed.
  prepareUpgrade(active.config);
  const replacement=fs.readFileSync(path.join(packageDir,'Connector.ps1'));
  const binding=JSON.parse(fs.readFileSync(path.join(packageDir,'repair-manifest.json'),'utf8'));
  need(digest(replacement)===binding.patched_sha256,'REPAIR_PACKAGE_HASH_MISMATCH');
  const originalSha=digest(fs.readFileSync(path.join(root,'Connector.ps1')));
  const allowedSha=binding.original_sha256_variants||[binding.original_sha256];
  need([...allowedSha,binding.patched_sha256].includes(originalSha),'UNSUPPORTED_CONNECTOR_VERSION');
  let stopped=false;
  try{
    await api('/api/shutdown',{});
    for(let i=0;i<180&&fs.existsSync(path.join(c.dataDir,'service.lock'));i++)await sleep(250);
    need(!fs.existsSync(path.join(c.dataDir,'service.lock')),'SERVICE_STOP_TIMEOUT');stopped=true;
    prepareUpgrade(active.config);
    report.patch=patchConnector(root,replacement,allowedSha,atomic);report.repaired=true;
  }finally{
    if(stopped){
      const log=fs.openSync(path.join(c.dataDir,'service.log'),'a');
      try{const child=spawn(process.execPath,[active.cli,'start','--config',active.config],{detached:true,windowsHide:true,stdio:['ignore',log,log]});child.unref();}finally{fs.closeSync(log);}
    }
    fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
  }
  let ready=false;for(let i=0;i<60&&!ready;i++){await sleep(250);try{ready=(await api('/api/capabilities')).local?.node==='windows-inner';}catch{}}
  need(ready,'RECEIVER_RESTART_NOT_CONFIRMED');
  report.local_api_ready=true;report.remote_advertisement_verified=false;
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');return report;
}

function readConnectorState(file){
  need(fs.statSync(file).size<=16777216,'CONNECTOR_STATE_TOO_LARGE');
  const wrapper=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),bytes=Buffer.from(wrapper.data_base64||'','base64');
  need(wrapper.schema==='aiconnector.store.v1'&&digest(bytes)===wrapper.sha256,'CONNECTOR_STATE_CORRUPT');return JSON.parse(bytes.toString('utf8'));
}

if(import.meta.main){
  try{
    const report=await repair({diagnoseOnly:process.argv.includes('--diagnose-only')});
    console.log(report.repaired?'修补已安装，本机服务已恢复；请等待 Mac 核验新公告与实际取件。':'只读诊断已保存为 issue17-diagnostic.json。');
  }catch(error){
    const code=/^[A-Z0-9_]+$/.test(error.message||'')?error.message:'REPAIR_FAILED';
    console.error('未确认修补完成 ('+code+')。请保留 issue17-diagnostic.json 与原数据目录。');process.exitCode=1;
  }
}
