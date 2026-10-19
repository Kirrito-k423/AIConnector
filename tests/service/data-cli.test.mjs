import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function entryTest(script){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aic-data-cli-entry-'));
  try{
    const identity=path.join(dir,'identity.txt'),recipient=path.join(dir,'recipient.txt');
    const r=spawnSync(process.execPath,[script,'init-key','--identity',identity,'--recipient',recipient],{encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr);assert.ok(r.stdout.trim(),'successful CLI exit must include a result');
    const result=JSON.parse(r.stdout);assert.equal(result.private_key_saved,true);
    assert.match(fs.readFileSync(identity,'utf8'),/^AGE-SECRET-KEY-/);
    assert.equal(fs.readFileSync(recipient,'utf8').trim(),result.recipient);
    assert.doesNotMatch(r.stdout,/AGE-SECRET-KEY-/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('real data CLI executes from its direct filename',()=>entryTest(path.join(root,'service/data-cli.mjs')));
test('real data CLI executes through a directory alias instead of silently exiting zero',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aic-data-cli-alias-'));
  try{
    const alias=path.join(dir,'package-alias');fs.symlinkSync(root,alias,process.platform==='win32'?'junction':'dir');
    entryTest(path.join(alias,'service/data-cli.mjs'));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Windows data CLI executes through case-insensitive path spelling',{skip:process.platform!=='win32'},()=>entryTest(path.join(root,'service').toUpperCase()+path.sep+'DATA-CLI.mjs'));
test('importing data CLI has no command side effects',()=>{
  const r=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(root,'service/data-cli.mjs')).href)}); console.log('IMPORTED');`],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'IMPORTED');assert.equal(r.stderr,'');
});
