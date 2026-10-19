import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TransferPool,mapTransfers} from '../../service/transfer-pool.mjs';
import {loadConfig} from '../../service/common.mjs';
import {Connector} from '../../service/connector.mjs';

test('default upload pool admits eight, queues the ninth and preserves explicit lower limits',async()=>{
 const pool=new TransferPool();assert.equal(pool.limit,8);
 assert.equal(new Connector({runner:{}},{},async()=>{}).parts.limit,8);
 for(const limit of [1,2,4,8])assert.equal(new TransferPool(limit).limit,limit);
 for(const limit of [0,9,1.5,'8'])assert.throws(()=>new TransferPool(limit),/INVALID_TRANSFER_CONCURRENCY/);
 let release,active=0,peak=0,started=0;const gate=new Promise(r=>release=r);
 const work=async()=>{started++;peak=Math.max(peak,++active);await gate;active--;};
 const tasks=Array.from({length:9},(_,i)=>pool.run('part-'+i,work));
 try{await new Promise(r=>setImmediate(r));assert.equal(started,8);assert.equal(pool.queue.length,1);assert.equal(peak,8);}
 finally{release();await Promise.all(tasks);await pool.idle();}
 assert.equal(started,9);assert.equal(pool.active,0);
});

test('service config defaults to eight uploads and keeps an explicit choice',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC transfer config '));
 try{
  const relay=path.join(dir,'relay.json'),config=path.join(dir,'service.json');fs.writeFileSync(relay,JSON.stringify({api_base:'http://127.0.0.1',poll_seconds:1}));
  const c={schema:'aiconnector.service.v1',node:'windows-inner',port:43111,dataDir:dir,connectorConfig:relay,runner:{enabled:false,profiles:{}}};
  fs.writeFileSync(config,JSON.stringify(c));assert.equal(loadConfig(config).runner.transferConcurrency,8);
  for(const limit of [1,2,4,8]){c.runner.transferConcurrency=limit;fs.writeFileSync(config,JSON.stringify(c));assert.equal(loadConfig(config).runner.transferConcurrency,limit);}
  c.runner.transferConcurrency=9;fs.writeFileSync(config,JSON.stringify(c));assert.throws(()=>loadConfig(config),/INVALID_TRANSFER_CONCURRENCY/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('one global pool bounds multiple runs, deduplicates in-flight work and releases failed slots',async()=>{
 const pool=new TransferPool(2);let active=0,peak=0,calls=0;
 const work=async()=>{calls++;peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;return calls;};
 const original=pool.run('a',work);assert.equal(pool.run('a',work),original);
 await Promise.all([original,...Array.from({length:8},(_,i)=>pool.run('run-'+i,work))]);await pool.idle();assert.equal(peak,2);assert.equal(calls,9);
 await assert.rejects(pool.run('failure',async()=>{throw new Error('NETWORK_DOWN');}),/NETWORK_DOWN/);await pool.idle();assert.equal(await pool.run('failure',async()=>42),42);await pool.idle();assert.equal(pool.active,0);
});

test('a rejected part stops new admissions but waits for its in-flight sibling checkpoint',async()=>{
 let release,checkpoint=false,settled=false;const gate=new Promise(r=>release=r),started=[];
 const result=mapTransfers([0,1,2,3],2,async item=>{started.push(item);if(item===0)throw new Error('RATE_LIMITED');await gate;checkpoint=true;});
 const failure=assert.rejects(result,/RATE_LIMITED/).then(()=>settled=true);
 await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.deepEqual(started,[0,1]);
 release();await failure;assert.equal(checkpoint,true);assert.deepEqual(started,[0,1]);
});
