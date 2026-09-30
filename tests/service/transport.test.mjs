import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {Transport} from '../../service/transport.mjs';

const fixture=`
const rl=require('node:readline').createInterface({input:process.stdin});
console.log(JSON.stringify({schema:'aiconnector.transport.v1',ready:true}));
rl.on('line',line=>{const r=JSON.parse(line);
 if(r.action==='Crash'){process.exit(2);return;}
 const id=r.action==='WrongReply'?'wrong':r.operation_id;
 console.log(JSON.stringify({id,ok:true,value:{pid:process.pid,key:r.key,token:r.token}}));
});`;
const c={node:'windows-inner',tickSeconds:10,proxy:'direct',connectorConfig:'fixture',stateDir:'fixture'};

test('resident runtime reuses one process and accepts refreshed credentials and UTF-8',async()=>{
 let starts=0;const t=new Transport(c,(_exe,_args,options)=>{starts++;return spawn(process.execPath,['-e',fixture],options);});
 try{
  const first=JSON.parse((await t.call('Status',{operation_id:'a',key:'中文任务',token:'old'},process.env)).out);
  const second=JSON.parse((await t.call('Status',{operation_id:'b',key:'second',token:'new'},process.env)).out);
  assert.equal(starts,1);assert.equal(first.pid,second.pid);assert.equal(first.key,'中文任务');assert.equal(second.token,'new');
 }finally{await t.close();}
 assert.equal(t.child,null);
});

test('lost resident response rejects without replay; next independent request can restart',async()=>{
 let starts=0;const t=new Transport(c,(_exe,_args,options)=>{starts++;return spawn(process.execPath,['-e',fixture],options);});
 try{
  await assert.rejects(t.call('Crash',{operation_id:'original'},process.env),/CONNECTOR_CHANNEL_CLOSED/);
  assert.equal(starts,1);
  const reply=JSON.parse((await t.call('Status',{operation_id:'next'},process.env)).out);
  assert.ok(reply.pid);assert.equal(starts,2);
 }finally{await t.close();}
});

test('mismatched response cannot grant execution permission',async()=>{
 const t=new Transport(c,(_exe,_args,options)=>spawn(process.execPath,['-e',fixture],options));
 try{await assert.rejects(t.call('WrongReply',{operation_id:'claim'},process.env),/CONNECTOR_REPLY_MISMATCH/);}
 finally{await t.close();}
});
