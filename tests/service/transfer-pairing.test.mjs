import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {parseServiceProcess,enableOwnedTransfer} from '../../tools/enable_owned_transfer.mjs';
import {ROOT,loadConfig} from '../../service/common.mjs';
import {newExportIdentity} from '../../service/file-export.mjs';
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
