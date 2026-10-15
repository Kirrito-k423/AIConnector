import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WatchClient} from '../../service/watch.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sha,save,read,run,ROOT} from '../../service/common.mjs';
import {catalogProfile} from '../../service/watch-catalog.mjs';
import {probeProfile} from '../../service/server-setup.mjs';
import {agentConfig,snapshotAgent} from '../../service/agent-config.mjs';
import {unzipSync,strFromU8} from 'fflate';
import {Resources} from '../../service/resources.mjs';
import {capabilities,checkRequirements,preflight} from '../../service/capabilities.mjs';

const machine=(id,host,patch={})=>({id,host,name:'PRIVATE_NAME',group:'PRIVATE_GROUP',resourceKey:'ssh:'+host+':22',enabled:true,status:'online',ready:true,reason:'ready',updatedAt:new Date().toISOString(),taskIds:[],reservationIds:[],continuationIds:[],...patch});

test('catalog reads do not clear or wait on busy/unknown experiment resources or claim an NPU lease',async()=>{
  const old={key:'original',state:'unknown',resources:{state:'unknown',keys:['*'],remote:{id:'original-reservation'}}},job={key:'catalog-new'};
  const ledger={jobs:{original:old,'catalog-new':job}},before=JSON.stringify(old);
  const manager=new Resources({runner:{agent:{},maxConcurrentRuns:4}},ledger,()=>{});
  assert.equal(await manager.acquire(job,catalogProfile(null),{}),true);assert.equal(JSON.stringify(old),before);assert.equal(job.resources.read_only,true);assert.equal(job.resources.remote,undefined);
});
test('catalog capability is explicitly read-only and refuses workload resources or old receiver contracts',()=>{
  const profile=catalogProfile(null),task={requirements:{mode:'probe',execution_mode:'direct',tools:[],checks:['catalog-complete','catalog-requested-hosts'],catalog_hosts:[sha('192.0.2.1')]},code:{repository:profile.repository,revision:profile.revision},environment:{target:'watch-catalog'},invocation:{entry:profile.entry,arguments:[]}};
  const c={node:'windows-inner',connector:{namespace:'fixture'},runner:{enabled:true,profiles:{'watch-catalog':profile},agent:{simpleHtmlWatch:{enabled:true}}}};
  const cap=capabilities(c,{});assert.equal(cap.profiles[0].resources.machine_count,0);assert.equal(preflight(task,cap).ok,true);
  assert.throws(()=>checkRequirements({...task,requirements:{...task.requirements,resources:{machine_count:8,atomic_group:true}}},profile),/RESOURCE_REQUIREMENTS_MISMATCH/);
  assert.throws(()=>preflight(task,{...cap,profiles:[{...cap.profiles[0],catalog:undefined}]}),/CAPABILITY_MISMATCH/);
});
async function fixture({rows=[machine('m1','192.0.2.1')],homepage,failRoute,invalidJson=false,oversized=false}={}){
  const seen=[];
  const server=http.createServer((req,res)=>{
    const route=new URL(req.url,'http://127.0.0.1').pathname;seen.push(route);
    if(route==='/'){res.end(homepage??'<meta name="watch-token" content="fixture-token">');return;}
    if(route==='/healthz'){res.end(JSON.stringify({serviceId:'fixture-service',runId:'fixture-run'}));return;}
    if(req.headers['x-watch-token']!=='fixture-token'){res.writeHead(403);res.end('{}');return;}
    if(route===failRoute){res.writeHead(404);res.end('{}');return;}
    if(route==='/api/tasks/machines'){res.end(oversized?'x'.repeat(262145):invalidJson?'invalid JSON':JSON.stringify(rows));return;}
    if(route==='/api/status'){res.end(JSON.stringify({private:'x'.repeat(1048576)}));return;}
    if(route==='/api/tasks/ready'){res.end('[]');return;}
    res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,seen,close:()=>new Promise(resolve=>server.close(resolve))};
}

test('small machine inventory remains available when optional monitoring exceeds 1 MiB',async()=>{
  const seen=[];
  const server=http.createServer((req,res)=>{
    const route=new URL(req.url,'http://127.0.0.1').pathname;seen.push(route);
    if(route==='/'){res.end('<meta name="watch-token" content="fixture-token">');return;}
    if(route==='/healthz'){res.end(JSON.stringify({serviceId:'fixture-service',runId:'fixture-run'}));return;}
    if(route==='/api/status'){res.end(JSON.stringify({large:'x'.repeat(1048576)}));return;}
    if(route==='/api/tasks/ready'){res.end('[]');return;}
    if(route==='/api/tasks/machines'){res.end(JSON.stringify([{id:'busy-machine',name:'A5',host:'192.0.2.1',resourceKey:'ssh:192.0.2.1:22',enabled:true,status:'online',ready:false,reason:'任务占用',updatedAt:new Date().toISOString(),taskIds:['existing-task'],reservationIds:[],continuationIds:[]}]));return;}
    res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const env=await new WatchClient({baseUrl:`http://127.0.0.1:${server.address().port}`}).environment();
    assert.equal(env.catalog.machines[0].id,'busy-machine');
    assert.ok(seen.includes('/api/tasks/machines'));
    assert.equal(env.query_complete,true);assert.equal(env.monitor,null);
    assert.deepEqual(env.errors,[{code:'HTTP_RESPONSE_TOO_LARGE',route:'/api/status',phase:'request'}]);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('large UI token discovery reads a bounded complete prefix once, including concurrent callers',async()=>{
  const f=await fixture({homepage:'<meta name="watch-token" content="fixture-token">'+'x'.repeat(1048576)});
  try{const env=await new WatchClient({baseUrl:f.url}).environment();assert.equal(env.catalog.query_complete,true);assert.equal(f.seen.filter(r=>r==='/').length,1);}
  finally{await f.close();}
});
test('oversized token prefix is attributed to the homepage and does not declare missing machines',async()=>{
  const f=await fixture({homepage:'x'.repeat(65537)+'<meta name="watch-token" content="fixture-token">'});
  try{const c=await new WatchClient({baseUrl:f.url}).catalog({hosts:[sha('192.0.2.1')]});assert.equal(c.query_complete,false);assert.equal(c.mappings[0].state,'unknown');assert.equal(c.total_machines,null);assert.deepEqual(c.errors,[{code:'HTTP_RESPONSE_TOO_LARGE',route:'/',phase:'token'}]);assert.ok(!f.seen.includes('/api/tasks/machines'));}
  finally{await f.close();}
});
for(const options of [{failRoute:'/api/tasks/machines',code:'WATCH_HTTP_404'},{invalidJson:true,code:'INVALID_WATCH_JSON'},{oversized:true,code:'HTTP_RESPONSE_TOO_LARGE'}])test('catalog route errors remain incomplete: '+options.code,async()=>{
  const f=await fixture(options);
  try{const c=await new WatchClient({baseUrl:f.url}).catalog({hosts:[sha('192.0.2.1')]});assert.equal(c.query_complete,false);assert.equal(c.requested_hosts_complete,false);assert.equal(c.mappings[0].state,'unknown');assert.deepEqual(c.errors,[{code:options.code,route:'/api/tasks/machines',phase:'request'}]);}
  finally{await f.close();}
});
test('inventory retains busy, offline, disabled, stale, unknown and aliases without exposing addresses or occupancy IDs',async()=>{
  const rows=[machine('busy','192.0.2.1',{ready:false,reason:'任务占用',taskIds:['PRIVATE_TASK_ID']}),machine('offline','192.0.2.2',{status:'offline',ready:false,reason:'监控未在线'}),machine('disabled','192.0.2.3',{enabled:false,ready:false,reason:'已停用'}),machine('stale','192.0.2.4',{updatedAt:'2020-01-01T00:00:00Z',ready:false,reason:'监控状态已过期'}),machine('unknown','192.0.2.5',{status:undefined,ready:undefined,updatedAt:undefined}),machine('alias','192.0.2.1')];
  const f=await fixture({rows});
  try{const c=await new WatchClient({baseUrl:f.url}).catalog({authorizedMachineIds:['busy'],hosts:[sha('192.0.2.1'),sha('192.0.2.2')]});
    assert.equal(c.query_complete,true);assert.equal(c.requested_hosts_complete,true);assert.equal(c.all_requested_authorized,false);assert.equal(c.mappings[0].machine_id,'busy');assert.equal(c.mappings[0].alias_count,2);assert.equal(c.mappings[0].ready,false);assert.equal(c.mappings[1].authorized,false);
    const all=await new WatchClient({baseUrl:f.url}).catalog();assert.equal(all.machines.length,6);assert.equal(all.machines.find(m=>m.id==='disabled').enabled,false);assert.equal(all.machines.find(m=>m.id==='unknown').status,'unknown');assert.equal(all.machines.find(m=>m.id==='unknown').ready,null);assert.equal(all.machines.find(m=>m.id==='unknown').updated_at,null);assert.equal(all.machines.find(m=>m.id==='stale').updated_at,'2020-01-01T00:00:00Z');
    assert.doesNotMatch(JSON.stringify(c),/192\.0\.2\.|PRIVATE_|fixture-token/);
  }finally{await f.close();}
});
test('ambiguous physical aliases and duplicate resources cannot prove a complete unique group',async()=>{
  const f=await fixture({rows:[machine('m1','192.0.2.1'),machine('alias','192.0.2.1')]});
  try{const c=await new WatchClient({baseUrl:f.url}).catalog({authorizedMachineIds:['m1','alias'],hosts:[sha('192.0.2.1')]});assert.equal(c.query_complete,true);assert.equal(c.requested_hosts_complete,false);assert.equal(c.mappings[0].state,'ambiguous');assert.equal(c.requested_resources_unique,null);assert.equal(c.all_requested_authorized,null);}
  finally{await f.close();}
});

test('two distinct directory addresses sharing a physical resource are explicitly non-unique',async()=>{
  const f=await fixture({rows:[machine('m1','192.0.2.1'),machine('m2','192.0.2.2',{resourceKey:'ssh:192.0.2.1:22'})]});
  try{const c=await new WatchClient({baseUrl:f.url}).catalog({authorizedMachineIds:['m1','m2'],hosts:[sha('192.0.2.1'),sha('192.0.2.2')]});assert.equal(c.requested_hosts_complete,true);assert.equal(c.all_requested_authorized,true);assert.equal(c.requested_resources_unique,false);}
  finally{await f.close();}
});
test('directory paging and omitted requested hosts are explicit, not an empty healthy fleet',async()=>{
  const f=await fixture({rows:Array.from({length:14},(_,i)=>machine('m'+i,'192.0.2.'+(i+1)))});
  try{const client=new WatchClient({baseUrl:f.url}),first=await client.catalog(),next=await client.catalog({offset:12});assert.equal(first.total_machines,14);assert.equal(first.machines.length,12);assert.equal(first.has_more,true);assert.equal(next.machines.length,2);assert.equal(next.has_more,false);
    const missing=await client.catalog({hosts:[sha('192.0.2.200')]});assert.equal(missing.query_complete,true);assert.equal(missing.requested_hosts_complete,false);assert.equal(missing.mappings[0].state,'not_found');}
  finally{await f.close();}
});
for(const absent of [false,true])test('real direct worker verifies inventory with zero model or SSH calls; missing API='+absent,async()=>{
  const f=await fixture({failRoute:absent?'/api/tasks/machines':undefined}),dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC catalog '));
  try{
    const registry={schema:'aiconnector.server-registry.v1',machineIds:['m1'],profiles:{probe:probeProfile('m1')}};
    const registryFile=path.join(dir,'registry.json');fs.writeFileSync(registryFile,JSON.stringify(registry));
    const profile={...catalogProfile(registry.machineIds),authorizationRegistry:registryFile,authorizationSha256:sha(JSON.stringify(registry))};
    const spec={key:'catalog/1/fixture',profile,agent:snapshotAgent(agentConfig({simpleHtmlWatch:{enabled:true,baseUrl:f.url}}),dir),task:{requirements:{mode:'probe',execution_mode:'direct',tools:[],checks:['catalog-complete','catalog-requested-hosts'],catalog_hosts:[sha('192.0.2.1')]},code:{repository:profile.repository,revision:profile.revision},environment:{target:'watch-catalog'},invocation:{entry:profile.entry,arguments:[]},artifacts:[]},timeoutSeconds:10,maxTurns:2};
    save(path.join(dir,'spec.json'),spec);
    const child=await run(process.execPath,[path.join(ROOT,'service/worker.mjs'),'--work',dir],{input:'{}'});assert.equal(child.code,0,child.err);
    const result=read(path.join(dir,'result.json')),zip=unzipSync(fs.readFileSync(path.join(dir,'result.zip'))),catalog=JSON.parse(strFromU8(zip['server-catalog.json'])),timing=JSON.parse(strFromU8(zip['model-timing.json']));
    assert.equal(timing.requests_started,0);assert.equal(result.agent.turns,0);assert.equal(result.agent.duration_ms,0);assert.equal(result.execution.server_task_id,null);assert.equal(result.execution.unknown,false);assert.equal(catalog.ssh_executed,false);assert.equal(catalog.npu_workload_executed,false);assert.equal(catalog.all_nodes_reserved,false);
    assert.equal(catalog.query_complete,!absent);assert.equal(result.outcome,absent?'blocked':'succeeded',JSON.stringify(result));assert.equal(result.acceptance.status,absent?'incomplete':'passed');
    if(absent){assert.equal(result.metrics.catalog_error,'WATCH_HTTP_404',JSON.stringify(result));assert.equal(result.metrics.catalog_error_route,'/api/tasks/machines');assert.ok(result.acceptance.checks.every(c=>!c.ok));}
    else{assert.equal(catalog.authorization_sha256,profile.authorizationSha256);assert.equal(catalog.all_requested_authorized,true);}
    assert.ok(!f.seen.some(route=>['/api/status','/api/tasks/ready','/api/tasks/reservations','/api/tasks'].includes(route)));
  }finally{await f.close();fs.rmSync(dir,{recursive:true,force:true});}
});
