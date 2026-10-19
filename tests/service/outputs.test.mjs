import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Outputs} from '../../service/outputs.mjs';

function exercise(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC outputs 中文 '));fs.mkdirSync(path.join(dir,'work'));try{fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}

test('outputs expose only declared current-run files with hashes and bounded UTF-8 pages',()=>exercise(dir=>{
 const text=JSON.stringify({boot_time_utc:'2026-09-24T08:18:04+00:00',npu:'Ascend950DT',text:'证据\n'.repeat(12000)});
 fs.writeFileSync(path.join(dir,'work/server-probe.json'),text);fs.writeFileSync(path.join(dir,'work/private.txt'),'private');
 const o=new Outputs(dir,['server-probe.json','missing.json']),page=o.list();assert.equal(page.files.length,2);assert.equal(page.files[1].available,false);
 let offset=0,joined='';do{const p=o.read('server-probe.json',offset,8192,page.files[0].sha256);joined+=p.content;assert.ok(JSON.stringify(p).length<14000);offset=p.next_offset;}while(offset!==null);
 assert.equal(joined,text);assert.throws(()=>o.read('private.txt'),/OUTPUT_NOT_ALLOWED/);assert.throws(()=>o.read('../private.txt'),/OUTPUT_NOT_ALLOWED/);
 assert.throws(()=>o.read('server-probe.json',0,8193),/INVALID_READ_RANGE/);
 fs.appendFileSync(path.join(dir,'work/server-probe.json'),' ');assert.throws(()=>o.read('server-probe.json',0,100,page.files[0].sha256),/OUTPUT_HASH_MISMATCH/);
}));

test('binary output is listed and exported but not decoded as text; known credentials are rejected',()=>exercise(dir=>{
 fs.writeFileSync(path.join(dir,'work/data.bin'),Buffer.from([255,254,0]));fs.writeFileSync(path.join(dir,'work/secret.txt'),'fixture-secret');
 const o=new Outputs(dir,['data.bin','secret.txt'],['fixture-secret']);assert.equal(o.list().files[0].available,true);
 assert.throws(()=>o.read('data.bin'),/OUTPUT_NOT_UTF8/);assert.throws(()=>o.read('secret.txt'),/SECRET_IN_OUTPUT/);
 assert.throws(()=>o.complete(),/SECRET_IN_OUTPUT/);
}));

test('output folders and oversized files are not readable',()=>exercise(dir=>{
 fs.mkdirSync(path.join(dir,'work/folder'));const f=path.join(dir,'work/large.bin'),fd=fs.openSync(f,'w');fs.ftruncateSync(fd,4*1024*1024);fs.closeSync(fd);
 const o=new Outputs(dir,['folder','large.bin']);assert.throws(()=>o.read('folder'),/UNSAFE_OUTPUT_FILE/);assert.throws(()=>o.read('large.bin'),/OUTPUT_TOO_LARGE/);
}));

test('output symlinks do not expose files outside the run',{skip:process.platform==='win32'},()=>exercise(dir=>{
 fs.writeFileSync(path.join(dir,'outside'),'private');fs.symlinkSync(path.join(dir,'outside'),path.join(dir,'work/link'));
 assert.throws(()=>new Outputs(dir,['link']).read('link'),/UNSAFE_OUTPUT_FILE/);
}));
