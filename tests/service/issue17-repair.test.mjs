import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {patchConnector,parseActiveService,summarizeState} from '../../tools/repair_issue17.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const atomic=(file,bytes)=>{const temp=file+'.fixture';fs.writeFileSync(temp,bytes);fs.renameSync(temp,file);};
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'AIC issue17 ')),original=Buffer.from('original connector');
  fs.writeFileSync(path.join(root,'Connector.ps1'),original);
  fs.writeFileSync(path.join(root,'package-manifest.json'),JSON.stringify({version:'0.7.15',sha256:{'Connector.ps1':sha(original),'service/common.mjs':'unchanged'}}));
  fs.mkdirSync(path.join(root,'service-data'));fs.writeFileSync(path.join(root,'service-data','ledger'),'existing task records');
  return {root,original,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('patch preserves task data, backs up the two changed files and keeps package hashes consistent',()=>{
  const f=fixture();try{
    const replacement=Buffer.from('patched connector'),result=patchConnector(f.root,replacement,sha(f.original),atomic);
    assert.equal(result.backup_created,true);
    assert.equal(fs.readFileSync(path.join(f.root,'Connector.ps1'),'utf8'),'patched connector');
    const manifest=JSON.parse(fs.readFileSync(path.join(f.root,'package-manifest.json'),'utf8'));
    assert.equal(manifest.sha256['Connector.ps1'],sha(replacement));assert.equal(manifest.sha256['service/common.mjs'],'unchanged');
    assert.equal(fs.readFileSync(path.join(f.root,'service-data','ledger'),'utf8'),'existing task records');
    const backup=fs.readdirSync(f.root).find(x=>x.startsWith('issue17-backup-'));
    assert.deepEqual(fs.readFileSync(path.join(f.root,backup,'Connector.ps1')),f.original);
    assert.equal(patchConnector(f.root,replacement,sha(f.original),atomic).already_patched,true);
    assert.equal(fs.readdirSync(f.root).filter(x=>x.startsWith('issue17-backup-')).length,1);
  }finally{f.cleanup();}
});

test('unsupported source is rejected before any modification',()=>{
  const f=fixture();try{
    assert.throws(()=>patchConnector(f.root,Buffer.from('replacement'),'0'.repeat(64),atomic),/UNSUPPORTED_CONNECTOR_VERSION/);
    assert.deepEqual(fs.readFileSync(path.join(f.root,'Connector.ps1')),f.original);
    assert.equal(fs.readdirSync(f.root).some(x=>x.startsWith('issue17-backup-')),false);
  }finally{f.cleanup();}
});

test('a manifest-write failure restores both original files and retains backups',()=>{
  const f=fixture();try{
    const manifest=fs.readFileSync(path.join(f.root,'package-manifest.json'));let calls=0;
    const failSecondWrite=(file,bytes)=>{if(++calls===2)throw new Error('FIXTURE_DISK_ERROR');atomic(file,bytes);};
    assert.throws(()=>patchConnector(f.root,Buffer.from('replacement'),sha(f.original),failSecondWrite),/FIXTURE_DISK_ERROR/);
    assert.deepEqual(fs.readFileSync(path.join(f.root,'Connector.ps1')),f.original);
    assert.deepEqual(fs.readFileSync(path.join(f.root,'package-manifest.json')),manifest);
    assert.equal(fs.readdirSync(f.root).filter(x=>x.startsWith('issue17-backup-')).length,1);
  }finally{f.cleanup();}
});

test('Unicode and spaced CIM paths are parsed without shell interpolation',()=>{
  const record={ExecutablePath:'C:\\工具\\AIConnector\\runtime\\node.exe',ProcessId:12,CommandLine:'"C:\\工具\\AIConnector\\runtime\\node.exe" "C:\\工具\\AIConnector\\service\\cli.mjs" start --config "C:\\Users\\测试 用户\\service-windows-inner.local.json"'};
  assert.deepEqual(parseActiveService(record),{cli:'C:\\工具\\AIConnector\\service\\cli.mjs',config:'C:\\Users\\测试 用户\\service-windows-inner.local.json',pid:12});
});

test('diagnostic state output exposes counts and HTTP codes without payloads or file paths',()=>{
  const output=summarizeState({uploads:{private:{status:'rejected',http:403,path:'C:\\secret'}},provisions:{private:{status:'uncertain',http:0,body:'token-secret'}},capabilities_pending:{generated_at:'2026-10-14T05:21:20Z',profiles:['private']}});
  assert.deepEqual(output,{uploads:{'rejected:403':1},provisions:{'uncertain:0':1},pending_capability_at:'2026-10-14T05:21:20Z'});
  assert.equal(JSON.stringify(output).includes('secret'),false);
});
