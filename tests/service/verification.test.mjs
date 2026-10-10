import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyTask} from '../../service/verification.mjs';
import {probeProfile} from '../../service/server-setup.mjs';

async function probe({mode='probe',metrics={npu_workload_executed:false},exitCode=0,unknown=false,npuExit=0}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC probe verification '));
  try{
    fs.mkdirSync(path.join(dir,'work'));
    fs.writeFileSync(path.join(dir,'work/server-probe.json'),JSON.stringify({ssh_executed:true,boot_time_utc:'2026-09-24T08:18:04+00:00',npu_smi:{exit_code:npuExit},npu_workload_executed:false}));
    return await verifyTask({profile:{...probeProfile('fixture-machine'),mode},task:{requirements:{mode:'probe'}}},dir,
      {execution:{exit_code:exitCode,unknown},report:{summary:'Read-only probe finished; no NPU workload requested.',metrics}});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

test('read-only probe can finish while honestly reporting no NPU workload',async()=>{
  const r=await probe();assert.equal(r.status,'passed',JSON.stringify(r));assert.equal(r.checks.length,3);assert.deepEqual(r.reported_incomplete,[]);
});
test('experiment still blocks on a missing NPU workload regardless of task mode text',async()=>{
  const r=await probe({mode:'experiment'});assert.equal(r.status,'incomplete');assert.deepEqual(r.reported_incomplete,['npu_workload_executed']);
});
test('probe still honors explicit incomplete goals and missing SSH execution',async()=>{
  for(const name of ['query_complete','repair_completed','config_validated','ssh_executed']){
    const r=await probe({metrics:{npu_workload_executed:false,[name]:false}});
    assert.equal(r.status,'incomplete');assert.deepEqual(r.reported_incomplete,[name]);
  }
});
test('a probe without a workload cannot bypass independent failures or unknown execution',async()=>{
  for(const option of [{exitCode:1},{unknown:true},{npuExit:1}])assert.equal((await probe(option)).status,'incomplete');
});

for(const kind of ['builtin-smoke','maintenance'])test(`${kind} does not demand NPU work but still blocks an incomplete goal`,async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'AIC non-compute verification '));
  try{
    fs.mkdirSync(path.join(dir,'work'));fs.writeFileSync(path.join(dir,'work/metrics.json'),JSON.stringify({sum:50005000}));
    const spec={profile:{kind,verification:[{id:'execution',kind:'execution',equals:0}]},task:{requirements:{mode:'experiment'}}};
    const state={execution:{exit_code:0},report:{metrics:{npu_workload_executed:false}}};
    assert.equal((await verifyTask(spec,dir,state)).status,'passed');
    state.report.metrics.query_complete=false;
    assert.equal((await verifyTask(spec,dir,state)).status,'incomplete');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
