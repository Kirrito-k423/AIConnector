import fs from 'node:fs';
import path from 'node:path';
import {need,sha,now,cleanError} from './common.mjs';
import {pointer} from './maintenance.mjs';
import {modeOf} from './capabilities.mjs';

export async function verifyTask(spec,dir,{execution,maintenance,report,pass=0}={}) {
  const definitions=spec.profile.kind==='builtin-smoke'?[{id:'cpu-smoke',kind:'output-json',file:'metrics.json',pointer:'/sum',equals:50005000}]:(spec.profile.verification||[]);
  const checks=[];
  for(const check of definitions){
    const row={id:check.id,ok:false};
    try{
      need(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(check.id),'INVALID_CHECK_ID');
      let actual;
      if(check.kind==='output-json'){
        need(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(check.file),'INVALID_CHECK_FILE');
        const file=path.join(dir,'work',check.file);need(!fs.lstatSync(file).isSymbolicLink()&&fs.statSync(file).size<=262144,'INVALID_CHECK_FILE');
        const bytes=fs.readFileSync(file);row.evidence_sha256=sha(bytes);actual=pointer(JSON.parse(bytes),check.pointer);
      }else if(check.kind==='local-json'){
        const {bytes}=maintenance.fileInfo(check.file);row.evidence_sha256=sha(bytes);actual=pointer(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),check.pointer);
      }else if(check.kind==='command'){
        const r=await maintenance.command(`v-${pass}-${check.id}`,check.command,{verification:true});row.evidence_sha256=sha(JSON.stringify(r));actual=r.exit_code;
      }else if(check.kind==='local-api'){
        const r=await maintenance.api(`v-${pass}-${check.id}`,check.api,{verification:true});row.evidence_sha256=sha(JSON.stringify(r));actual=pointer(r.value,check.pointer);
      }else if(check.kind==='execution'){actual=execution?.exit_code;row.evidence_sha256=execution?sha(JSON.stringify(execution)):null;}
      else throw new Error('INVALID_CHECK_KIND');
      row.ok=Object.hasOwn(check,'equals')?JSON.stringify(actual)===JSON.stringify(check.equals):check.exists===true&&actual!==undefined;
      if(!row.ok)row.error='CHECK_NOT_SATISFIED';
    }catch(e){row.error=cleanError(e);}
    checks.push(row);
  }
  // Not running a compute workload is expected for a locally configured probe,
  // CPU smoke or maintenance entry. Task text cannot change the local mode.
  const noWorkloadRequired=['probe','smoke','maintenance'].includes(modeOf(spec.profile));
  const falseClaims=Object.entries(report?.metrics||{}).filter(([k,v])=>v===false&&
    !(k==='npu_workload_executed'&&noWorkloadRequired)&&
    (/(?:_completed|_validated|_executed|_loaded)$/.test(k)||k==='query_complete')).map(([k])=>k);
  const unknown=execution?.unknown||!execution&&(fs.existsSync(path.join(dir,'execution-intent.json'))||fs.existsSync(path.join(dir,'watch-task.json')))||Object.values(maintenance?.actions||{}).some(a=>a.state==='unknown'||a.state==='intent'||a.result?.unknown);
  const executionOK=spec.profile.kind==='maintenance'||Boolean(execution&&execution.exit_code===0&&!execution.revision_mismatch);
  return {schema:'aiconnector.acceptance.v1',status:!unknown&&executionOK&&checks.length>0&&checks.every(c=>c.ok)&&falseClaims.length===0?'passed':'incomplete',
    checked_at:now(),checks,reported_incomplete:falseClaims.slice(0,16).map(k=>k.slice(0,128)),reported_incomplete_count:falseClaims.length,execution_ok:executionOK,unknown:Boolean(unknown),
    scope:'本地配置的独立检查；用户仍可复核文字验收与证据'};
}
