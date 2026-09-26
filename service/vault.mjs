import fs from 'node:fs';
import path from 'node:path';
import {sha,run,need,atomic,safeEnv} from './common.mjs';

function item(c) {return 'AIConnector.'+sha(c.dataDir).slice(0,24);}
export async function storeSecrets(c,value) {
  const body=JSON.stringify(value); need(body.length<16384,'CREDENTIAL_TOO_LONG');
  if(process.platform==='win32') {
    const r=await run(c.powershell,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; $s=[Console]::In.ReadToEnd() | ConvertTo-SecureString -AsPlainText -Force; [Console]::Write(($s | ConvertFrom-SecureString))"],{input:body,env:safeEnv()});
    need(r.code===0 && r.out.trim(),'VAULT_WRITE_FAILED'); atomic(path.join(c.dataDir,'credentials.dpapi'),r.out.trim());
  } else if(process.platform==='darwin') {
    // Interactive security input keeps the credential out of process arguments.
    const command=`add-generic-password -U -a aiconnector -s ${item(c)} -w ${Buffer.from(body).toString('base64')}\n`;
    const r=await run('/usr/bin/security',['-i'],{input:command}); need(r.code===0&&!/Error:|SecKeychain.*:/i.test(r.err),'VAULT_WRITE_FAILED');
  } else throw new Error('VAULT_UNSUPPORTED_USE_ENV');
}
export async function loadSecrets(c) {
  let body;
  if(process.platform==='win32') {
    const file=path.join(c.dataDir,'credentials.dpapi'); if(!fs.existsSync(file))return {};
    const r=await run(c.powershell,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; $s=ConvertTo-SecureString ([Console]::In.ReadToEnd()); [Console]::Write(([System.Net.NetworkCredential]::new('', $s)).Password)"],{input:fs.readFileSync(file,'utf8'),env:safeEnv()});
    need(r.code===0,'VAULT_READ_FAILED');body=r.out;
  } else if(process.platform==='darwin') {
    const r=await run('/usr/bin/security',['find-generic-password','-a','aiconnector','-s',item(c),'-w']);
    if(r.code===44)return {}; need(r.code===0,'VAULT_READ_FAILED');body=Buffer.from(r.out.trim(),'base64').toString('utf8');
  } else return {};
  return JSON.parse(body);
}
