import test from 'node:test';
import assert from 'node:assert/strict';
import {TransferPool,mapTransfers} from '../../service/transfer-pool.mjs';

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
