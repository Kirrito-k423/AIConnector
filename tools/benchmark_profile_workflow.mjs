// Host-only work/argument-size check. No network, filesystem write, model or NPU
// speed is inferred from these CPU samples. Run with the packaged Node version.
import {parseProfileInput,definitionSha} from '../service/profile-data.mjs';
import {validateRegistry} from '../service/server-registry.mjs';

const base={kind:'simplehtmlwatch',mode:'experiment',machineId:'approved',entry:'experiment',repository:'fixture',revision:'v1',revisionCommand:'printf v1',shell:'x'.repeat(1800),outputs:['metrics.json'],verification:[{id:'exit',kind:'execution',equals:0}]};
const input=Buffer.from(JSON.stringify({device:{...base,revision:'v2'}}));
const cases=[];
for(const count of [1,12,24]){
  const registry={schema:'aiconnector.server-registry.v1',machineIds:['approved'],profiles:Object.fromEntries(Array.from({length:count},(_,i)=>[i?'retained-'+i:'device',{...base}]))};
  const newArgs={action_id:'configure-v2',file:'server-registry',input_id:'1'.repeat(32),input_sha256:'2'.repeat(64),expected_sha256:'3'.repeat(64)};
  const merged={...registry.profiles,...JSON.parse(input)};
  const oldArgs={action_id:'write-v2',file:'server-registry',expected_sha256:'3'.repeat(64),changes:[{pointer:'/profiles',value:merged}]};
  const merge=()=>{
    const desired=parseProfileInput(input),next=validateRegistry({...registry,profiles:{...registry.profiles,...desired}});
    const bytes=Buffer.from(JSON.stringify(next,null,2)+'\n');
    if(next.profiles.device.revision!=='v2'||Object.entries(registry.profiles).some(([id,p])=>id!=='device'&&definitionSha(next.profiles[id])!==definitionSha(p)))throw new Error('PRESERVATION_FAILED');
    return bytes.length;
  };
  for(let i=0;i<20;i++)merge();
  const samples=[];let bytes;
  for(let i=0;i<100;i++){const start=performance.now();bytes=merge();samples.push(performance.now()-start);}
  const sorted=[...samples].sort((a,b)=>a-b);
  cases.push({profiles:count,input_bytes:input.length,model_arguments_before_bytes:Buffer.byteLength(JSON.stringify(oldArgs)),model_arguments_after_bytes:Buffer.byteLength(JSON.stringify(newArgs)),serialized_registry_bytes:bytes,merge_validation_preservation_ms:{median:sorted[50],p95:sorted[94],max:sorted.at(-1),samples},correctness:true});
}
process.stdout.write(JSON.stringify({schema:'aiconnector.profile-work-host.v1',node:process.version,platform:process.platform,arch:process.arch,scope:'Argument bytes and host merge+validation+serialization+preservation checks; excludes disk, HTTP, model generation, scheduling and NPU. No E2E speedup claim.',cases},null,2)+'\n');
