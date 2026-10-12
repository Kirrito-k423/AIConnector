// Standalone repair for existing 0.7.15 installs. Import the installed library
// directly so case differences and path aliases cannot skip the CLI entry.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const need=(ok,code)=>{if(!ok)throw new Error(code);};
export function parseServiceProcess(p){
  const match=p.CommandLine?.match(/(?:"([^"\r\n]*[\\/]cli\.mjs)"|([^\s"\r\n]*[\\/]cli\.mjs))\s+start\s+--config\s+(?:"([^"\r\n]+)"|([^\s"\r\n]+))/i);
  if(!match||!p.ExecutablePath)return null;
  const cli=match[1]||match[2],config=match[3]||match[4];
  if(!path.win32.isAbsolute(cli)||!path.win32.isAbsolute(config)||!/node\.exe$/i.test(p.ExecutablePath))return null;
  return {cli,config,pid:p.ProcessId};
}
export async function enableOwnedTransfer(recipient,{processes,parse=parseServiceProcess}={}){
  need(/^age1[a-z0-9]{58}$/.test(recipient||''),'INVALID_EXPORT_RECIPIENT');
  if(processes===undefined){
    need(process.platform==='win32','WINDOWS_ONLY');
    const command="$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'cli\\.mjs\"?\\s+start\\s+--config' } | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress";
    const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:20000});
    need(r.status===0,'RECEIVER_DISCOVERY_FAILED');processes=JSON.parse(r.stdout.trim()||'[]');
  }
  const candidates=[],seen=new Set();
  for(const record of Array.isArray(processes)?processes:[processes]){
    const p=parse(record);if(!p)continue;
    let disk;try{disk=JSON.parse(fs.readFileSync(p.config,'utf8').replace(/^\uFEFF/,''));}catch{continue;}
    if(disk.schema!=='aiconnector.service.v1'||disk.node!=='windows-inner')continue;
    const stat=fs.statSync(p.config,{bigint:true}),id=stat.dev+':'+stat.ino;if(seen.has(id))continue;seen.add(id);
    candidates.push(p);
  }
  need(candidates.length===1,candidates.length?'MULTIPLE_RECEIVERS':'RECEIVER_NOT_RUNNING');
  const active=candidates[0],serviceDir=path.dirname(active.cli),load=filename=>import(pathToFileURL(path.join(serviceDir,filename)).href);
  need(fs.existsSync(path.join(serviceDir,'data-cli.mjs')),'FILE_TRANSFER_UPGRADE_REQUIRED');
  const {loadConfig,sha}=await load('common.mjs'),{localRequest}=await load('http.mjs'),{dataCli}=await load('data-cli.mjs'),{validateOwnedProfile}=await load('file-transfer.mjs');
  const c=loadConfig(active.config),token=fs.readFileSync(path.join(c.dataDir,'dashboard.token'),'utf8');
  const request=async(route,body)=>{
    const r=await localRequest(`http://127.0.0.1:${c.port}${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),timeoutSeconds:15});
    need(r.status===200,'RECEIVER_API_FAILED');return JSON.parse(r.body);
  };
  const status=await request('/api/status');need(status.schema==='aiconnector.dashboard.v1'&&status.service?.node==='windows-inner','WRONG_RECEIVER');
  const existing=c.runner.profiles['owned-files'];
  if(existing){
    validateOwnedProfile(existing);need(existing.delivery.recipient===recipient,'EXPORT_RECIPIENT_MISMATCH');
    need((await request('/api/reload-agent',{})).reloaded===true,'EXPORT_RELOAD_REQUIRED');
  }else await dataCli(['authorize-owned','--config',active.config,'--profile','owned-files','--recipient-text',recipient,'--allow-public-ciphertext','--reload']);
  const cap=(await request('/api/capabilities')).local,p=cap?.profiles?.find(p=>p.id==='owned-files');
  need(cap.enabled===true&&p?.ready===true&&p.data_export?.recipient_sha256===sha(recipient)&&p.data_export?.scope==='owned-filesystem','TRANSFER_NOT_READY');
  return {ok:true,ready:true,profile:'owned-files',scope:'owned-filesystem',recipient_sha256:sha(recipient),already_enabled:Boolean(existing),message:'文件读取已启用并核验。返回 Mac 后即可继续加密取件。'};
}
if(import.meta.main){
  const args=process.argv.slice(2),i=args.indexOf('--recipient-text');
  try{console.log(JSON.stringify(await enableOwnedTransfer(i<0?'':args[i+1]),null,2));}
  catch(e){const code=/^[A-Z0-9_]+$/.test(e.message||'')?e.message:'ENABLE_TRANSFER_FAILED';
    const messages={RECEIVER_NOT_RUNNING:'请先打开 Windows AIConnector 看板，再双击本程序。',MULTIPLE_RECEIVERS:'检测到多个 Windows 接收服务，未修改任何配置。',FILE_TRANSFER_UPGRADE_REQUIRED:'请先升级 Windows AIConnector 到 0.7.15-rc.2。',EXPORT_RECIPIENT_MISMATCH:'现有入口绑定了另一台 Mac，未更换接收人。'};
    console.error(JSON.stringify({ok:false,error:code,message:messages[code]||'启用未完成。请把这一行结果发给 Mac 侧，勿提供私钥或凭据。'}));process.exitCode=1;
  }
}
