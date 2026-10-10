import path from 'node:path';
import {need,read,save,sha,now} from './common.mjs';
import {validateRegistry} from './server-registry.mjs';
import {parseProfileInput,profileWorkflowGranted,profileDefinitions,definitionSha} from './profile-data.mjs';

const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export class ProfileWorkflow {
  constructor(maintenance,inputs){this.maintenance=maintenance;this.inputs=inputs;this.file=path.join(maintenance.dir,'profile-workflows.json');this.rows=read(this.file,{});}
  persist(){save(this.file,this.rows);}
  publicRows(){return Object.values(this.rows).map(r=>({action_id:r.action_id,input_id:r.input_id,input_sha256:r.input_sha256,file:r.file,requested:r.requested,before_sha256:r.expected_sha256,after_sha256:r.after_sha256,started_at:r.started_at,verified_at:r.verified_at,phases:Object.fromEntries(['write','reload','readiness'].map(k=>[k,this.maintenance.actions[r[k+'_action']]?.state||'not-started']))}));}
  async configure({action_id,file,input_id,input_sha256,expected_sha256}){
    const m=this.maintenance;need(idPattern.test(action_id),'INVALID_ACTION_ID');need(profileWorkflowGranted(m.spec.profile,file),'PROFILE_WORKFLOW_NOT_AUTHORIZED');
    const request={key:m.spec.key,file,input_id,input_sha256,expected_sha256},digest=sha(JSON.stringify(request));let row=this.rows[action_id];
    if(row)need(row.digest===digest,'ACTION_ID_CONFLICT');
    // Even an idempotent continuation must still have the original verified input.
    const incoming=parseProfileInput(this.inputs.verifiedBytes(input_id,input_sha256));
    const current=m.fileInfo(file),registry=validateRegistry(JSON.parse(current.bytes.toString('utf8').replace(/^\uFEFF/,'')));
    const merged={...registry.profiles,...incoming};validateRegistry({...registry,profiles:merged});
    const requested=profileDefinitions(incoming);
    const pinned=m.spec.task.requirements.server_profiles;
    if(pinned)need(pinned.length===requested.length&&pinned.every(p=>requested.some(r=>r.id===p.id&&r.revision===p.revision&&(!p.definition_sha256||r.definition_sha256===p.definition_sha256))),'REQUESTED_PROFILE_MISMATCH');
    if(!row){
      need(current.digest===expected_sha256,'FILE_CHANGED');need(Object.keys(this.rows).length<8,'PROFILE_WORKFLOW_BUDGET');
      const prefix='profiles-'+sha(m.spec.key+'/'+action_id).slice(0,32);
      row=this.rows[action_id]={action_id,digest,...request,requested,started_at:now(),write_action:prefix+'-write',reload_action:prefix+'-reload',readiness_attempt:0};this.persist();
    }
    const write=m.actions[row.write_action];
    if(write){
      need(write.state==='done','ACTION_UNKNOWN');need(write.file_id===file&&write.before_sha256===expected_sha256,'ACTION_ID_CONFLICT');
      need(current.digest===write.after_sha256,'FILE_CHANGED');
      need(row.requested.every(p=>definitionSha(registry.profiles[p.id])===p.definition_sha256),'REQUESTED_PROFILE_MISMATCH');
      row.after_sha256=write.after_sha256;this.persist();
    }else{
      const r=await m.writeFile(row.write_action,file,expected_sha256,undefined,[{pointer:'/profiles',value:merged}]);
      row.after_sha256=r.after_sha256;this.persist();
    }
    // A completed write is retained if the deadline/process stops here. Resume
    // this same ID to load it, but never replay an unknown write or reload.
    need(!m.signal?.aborted,'RUN_STOPPED');await m.api(row.reload_action,'reload');
    need(!m.signal?.aborted,'RUN_STOPPED');
    row.readiness_action='profiles-'+sha(m.spec.key+'/'+action_id).slice(0,32)+'-ready-'+(++row.readiness_attempt);this.persist();
    const r=await m.api(row.readiness_action,'readiness',{verification:true});
    const check=this.check(r.value);need(check.ok,check.error);row.verified_at=now();this.persist();
    return {...this.publicRows().find(r=>r.action_id===action_id),verified:true,hardware_execution_verified:false};
  }
  check(readiness){
    const rows=Object.values(this.rows);if(!rows.length)return {ok:false,error:'PROFILE_CONFIGURATION_REQUIRED'};
    if(!readiness?.reloaded)return {ok:false,error:'REGISTRY_NOT_RELOADED'};
    for(const row of rows){
      if(this.maintenance.actions[row.write_action]?.state!=='done'||this.maintenance.actions[row.reload_action]?.state!=='done')return {ok:false,error:'PROFILE_WORKFLOW_INCOMPLETE'};
      const current=this.maintenance.fileInfo(row.file);if(current.digest!==row.after_sha256)return {ok:false,error:'FILE_CHANGED'};
      if(!row.requested.every(p=>readiness.loaded_profiles?.some(r=>r.id===p.id&&r.revision===p.revision&&r.definition_sha256===p.definition_sha256)))return {ok:false,error:'REQUESTED_PROFILE_NOT_LOADED'};
    }
    return {ok:true,evidence_sha256:sha(JSON.stringify({requested:rows.map(r=>r.requested),readiness}))};
  }
}
