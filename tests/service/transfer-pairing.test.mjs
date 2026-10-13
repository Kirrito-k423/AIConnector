import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseServiceProcess,enableOwnedTransfer} from '../../tools/enable_owned_transfer.mjs';
import {ROOT,loadConfig,sha,save,read} from '../../service/common.mjs';
import {newExportIdentity} from '../../service/file-export.mjs';
import {ownedTransferProfile} from '../../service/file-transfer.mjs';
import {storeSecrets,loadSecrets} from '../../service/vault.mjs';
import {start} from '../../service/server.mjs';

test('pairing discovers only absolute receiver start commands, including case and spaces',()=>{
  const p={ProcessId:42,ExecutablePath:'C:\\Program Files\\AIC\\runtime\\node.exe',CommandLine:'"C:\\Program Files\\AIC\\runtime\\node.exe" "c:\\Program Files\\AIC\\service\\CLI.MJS" start --config "C:\\original path\\service.json"'};
  assert.deepEqual(parseServiceProcess(p),{pid:42,cli:'c:\\Program Files\\AIC\\service\\CLI.MJS',config:'C:\\original path\\service.json'});
  assert.equal(parseServiceProcess({...p,CommandLine:'node.exe worker.mjs --work run'}),null);
  assert.equal(parseServiceProcess({...p,CommandLine:'node.exe service/cli.mjs start --config service.json'}),null);
  assert.equal(parseServiceProcess({...p,ExecutablePath:null}),null);
});
test('missing or ambiguous receivers never enable or replace a profile',async()=>{
  const key=await newExportIdentity();await assert.rejects(enableOwnedTransfer(key.recipient,{processes:[]}),/RECEIVER_NOT_RUNNING/);
  await assert.rejects(enableOwnedTransfer('bad',{processes:[]}),/INVALID_EXPORT_RECIPIENT/);
});
test('activation succeeds with a dashboard history over 1 MiB without fetching that history',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC large history '));let service;
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const config=path.join(dir,'original.json'),connectorFile=path.join(dir,'connector.json');
  const mac=await newExportIdentity(),windows=await newExportIdentity();
  fs.writeFileSync(connectorFile,JSON.stringify({api_base:'http://127.0.0.1',poll_seconds:1,token_env:'AICONNECTOR_FIXTURE',repository:'fixture/relay'}));
  fs.writeFileSync(config,JSON.stringify({schema:'aiconnector.service.v1',node:'windows-inner',port,dataDir:'data',connectorConfig:connectorFile,runner:{enabled:true,profiles:{'owned-files':ownedTransferProfile(mac.recipient,windows.recipient)}}}));
  const runs=Array.from({length:120},(_,i)=>({key:`history-${i}/1/complete`,phase:'receipt',task:{objective:'H'.repeat(16384)}}));
  const connector={call:async()=>({runs,outbox:[]}),close:async()=>{}},requests=[];
  try{
    service=await start(config,{secrets:{fileTransferIdentity:windows.identity,fileTransferRecipient:windows.recipient},connector});
    await new Promise(r=>setImmediate(r));
    assert.ok(Buffer.byteLength(JSON.stringify(service.status()))>1048576,'fixture must reproduce the old response ceiling');
    service.server.on('request',req=>requests.push(req.url));
    const result=await enableOwnedTransfer(mac.recipient,{processes:[{cli:path.join(ROOT,'service/cli.mjs'),config,pid:process.pid}],parse:p=>p});
    assert.equal(result.ready,true);assert.equal(result.already_enabled,true);
    assert.ok(!requests.includes('/api/status'),'activation must not retrieve unrelated dashboard history');
    assert.deepEqual(requests,['/api/capabilities','/api/reload-agent','/api/capabilities']);
  }finally{await service?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Windows double-click launcher exits clearly when no receiver is running and has valid PowerShell quoting',{skip:process.platform!=='win32'},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC pairing launcher '));
  try{
    const key=await newExportIdentity(),launcher=path.join(dir,'Enable-file-transfer.cmd');
    fs.copyFileSync(path.join(ROOT,'tools/enable_owned_transfer.cmd'),launcher);fs.copyFileSync(path.join(ROOT,'tools/enable_owned_transfer.mjs'),path.join(dir,'enable_owned_transfer.mjs'));fs.writeFileSync(path.join(dir,'mac-recipient.txt'),key.recipient+'\n');
    const r=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c',launcher],{encoding:'utf8',timeout:30000,env:{...process.env,AICONNECTOR_ENABLE_NO_PAUSE:'1'}});
    assert.equal(r.status,1,r.stderr);assert.match(r.stdout,/Please open the AIConnector Windows dashboard first/);assert.equal(r.stderr,'');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Windows pairing calls the real installed library, reloads live secrets, preserves credentials and safely repeats',{skip:process.platform!=='win32'},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC live pairing '));let service;
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const config=path.join(dir,'original.json'),connectorFile=path.join(dir,'connector.json'),dataDir=path.join(dir,'data');fs.mkdirSync(dataDir);
  fs.writeFileSync(connectorFile,JSON.stringify({schema:'aiconnector.config.v2',layout:'task-issues-run-releases-v1',namespace:'fixture',api_base:'http://127.0.0.1',poll_seconds:1,token_env:'AICONNECTOR_FIXTURE',repository:'fixture/relay'}));
  const smoke={kind:'builtin-smoke',entry:'smoke',repository:'aiconnector-builtin',outputs:['metrics.json']};
  fs.writeFileSync(config,JSON.stringify({schema:'aiconnector.service.v1',node:'windows-inner',port,dataDir,connectorConfig:connectorFile,powershell:'powershell.exe',runner:{enabled:true,profiles:{smoke}}}));
  const c=loadConfig(config),old={githubToken:'SYNTHETIC_PAIR_GITHUB',apiKey:'SYNTHETIC_PAIR_MODEL'},key=await newExportIdentity();await storeSecrets(c,old);
  const connector={call:async(action,args)=>action==='Advertise'?{confirmed:true,data:args.data}:{runs:[],outbox:[]},close:async()=>{}};
  try{
    service=await start(config,{secrets:await loadSecrets(c),connector});
    const processes=[{ProcessId:process.pid,ExecutablePath:process.execPath,CommandLine:`"${process.execPath}" "${path.join(ROOT,'service/cli.mjs')}" start --config "${config}"`}];
    const first=await enableOwnedTransfer(key.recipient,{processes});assert.equal(first.ready,true);assert.equal(first.already_enabled,false);
    const after=await loadSecrets(c);assert.equal(after.githubToken,old.githubToken);assert.equal(after.apiKey,old.apiKey);assert.match(after.fileTransferIdentity,/^AGE-SECRET-KEY-/);
    const bytes=fs.readFileSync(config);assert.deepEqual(JSON.parse(bytes).runner.profiles.smoke,smoke);assert.doesNotMatch(bytes.toString(),/AGE-SECRET-KEY|SYNTHETIC_PAIR/);
    const repeat=await enableOwnedTransfer(key.recipient,{processes});assert.equal(repeat.already_enabled,true);assert.deepEqual(fs.readFileSync(config),bytes);assert.equal((await loadSecrets(c)).fileTransferIdentity,after.fileTransferIdentity);
    const other=await newExportIdentity();await assert.rejects(enableOwnedTransfer(other.recipient,{processes}),/EXPORT_RECIPIENT_MISMATCH/);assert.deepEqual(fs.readFileSync(config),bytes);
  }finally{await service?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Windows double-click discovers the real CLI via CIM and enables an existing package with large history',{skip:process.platform!=='win32',timeout:120000},async t=>{
  const installed=process.env.AIC_PAIRING_INSTALL_ROOT||ROOT;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC original package pairing '));let child,token;
  const socket=http.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const config=path.join(dir,'original service.json'),connectorFile=path.join(dir,'connector.json'),dataDir=path.join(dir,'original data'),launcher=path.join(dir,'Enable-file-transfer.cmd');fs.mkdirSync(dataDir);
  const bundledNode=path.join(installed,'runtime','node.exe'),bundledPwsh=path.join(installed,'runtime','pwsh','pwsh.exe');
  const node=fs.existsSync(bundledNode)?bundledNode:process.execPath,powershell=fs.existsSync(bundledPwsh)?bundledPwsh:'pwsh.exe';
  // No external service or real credentials: the unchanged installed CLI and
  // resident transport run against an unconnected loopback fixture address.
  fs.writeFileSync(connectorFile,JSON.stringify({schema:'aiconnector.config.v2',layout:'task-issues-run-releases-v1',namespace:'fixture',api_base:'http://127.0.0.1:9',poll_seconds:10,token_env:'AICONNECTOR_PAIRING_FIXTURE',repository:'fixture/relay'}));
  const smoke={kind:'builtin-smoke',entry:'smoke',repository:'aiconnector-builtin',outputs:['metrics.json']};
  fs.writeFileSync(config,JSON.stringify({schema:'aiconnector.service.v1',node:'windows-inner',port,dataDir,connectorConfig:connectorFile,powershell,runner:{enabled:true,profiles:{smoke}}}));
  const c=loadConfig(config),old={apiKey:'SYNTHETIC_PAIR_MODEL'},mac=await newExportIdentity();await storeSecrets(c,old);
  const submissions=Object.fromEntries(Array.from({length:120},(_,i)=>{const key=`history-${i}/1/complete`;return [key,{key,state:'queued',task:{objective:'H'.repeat(16384)}}];}));
  save(path.join(dataDir,'service.json'),{binding:sha(JSON.stringify({node:c.node,connector:c.connector})),jobs:{},submissions});
  fs.copyFileSync(path.join(ROOT,'tools/enable_owned_transfer.cmd'),launcher);fs.copyFileSync(path.join(ROOT,'tools/enable_owned_transfer.mjs'),path.join(dir,'enable_owned_transfer.mjs'));fs.writeFileSync(path.join(dir,'mac-recipient.txt'),mac.recipient+'\n');
  const request=async(route,body)=>{
    const r=await fetch(`http://127.0.0.1:${port}${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(3000)});assert.equal(r.status,200);return r;
  };
  try{
    let serviceError='';
    child=spawn(node,[path.join(installed,'service','cli.mjs'),'start','--config',config],{stdio:['ignore','ignore','pipe'],windowsHide:true});
    child.stderr.setEncoding('utf8');child.stderr.on('data',b=>{serviceError=(serviceError+b).slice(-4096);});
    let ready=false;
    for(let i=0;i<150;i++){
      assert.equal(child.exitCode,null,'original service must remain running: '+serviceError);
      try{token=fs.readFileSync(path.join(dataDir,'dashboard.token'),'utf8');const cap=await(await request('/api/capabilities')).json();if(cap.local.node==='windows-inner'){ready=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(ready,true,'original service must start');
    const historyBytes=(await(await request('/api/status')).arrayBuffer()).byteLength;assert.ok(historyBytes>1048576);
    const r=await promisify(execFile)(process.env.ComSpec||'cmd.exe',['/d','/c',launcher],{encoding:'utf8',timeout:60000,env:{...process.env,AICONNECTOR_ENABLE_NO_PAUSE:'1'}});
    assert.match(r.stdout,/文件读取已启用并核验/);assert.equal(r.stderr,'');
    const first=(await(await request('/api/capabilities')).json()).local.profiles.find(p=>p.id==='owned-files');assert.equal(first.ready,true);assert.equal(first.execution_mode,'direct');
    assert.equal(first.data_export.recipient_sha256,sha(mac.recipient));
    const secrets=await loadSecrets(c);assert.equal(secrets.apiKey,old.apiKey);assert.match(secrets.fileTransferIdentity,/^AGE-SECRET-KEY-/);
    const before=fs.readFileSync(config),again=await enableOwnedTransfer(mac.recipient);assert.equal(again.already_enabled,true);assert.deepEqual(fs.readFileSync(config),before);
    assert.equal((await loadSecrets(c)).fileTransferIdentity,secrets.fileTransferIdentity);
    const state=read(path.join(dataDir,'service.json'));assert.equal(Object.keys(state.submissions).length,120);assert.deepEqual(state.jobs,{});assert.deepEqual(JSON.parse(before).runner.profiles.smoke,smoke);
    assert.doesNotMatch(r.stdout+r.stderr,/AGE-SECRET-KEY-|SYNTHETIC_PAIR_MODEL/);
    const manifest=path.join(installed,'package-manifest.json');t.diagnostic(JSON.stringify({history_bytes:historyBytes,installed_source:fs.existsSync(manifest)?JSON.parse(fs.readFileSync(manifest)).source_revision:'checkout',actual_cim:true,actual_double_click:true}));
  }finally{
    if(child&&child.exitCode===null){try{await(await request('/api/shutdown',{})).json();}catch{}for(let i=0;i<100&&child.exitCode===null;i++)await new Promise(r=>setTimeout(r,100));if(child.exitCode===null)child.kill();}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
