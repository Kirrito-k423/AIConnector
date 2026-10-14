import {sha,now} from './common.mjs';

export const healthPolicy=p=>p.npuHealthPolicy||'allow-warning-alarm';
// Health is an observation, not proof of an idle device or successful compute.
// Keep only table facts; never export monitor addresses, commands or stderr.
export function healthSample(state,policy='allow-warning-alarm'){
  const sample=state?.results?.findLast(r=>r.commandId==='npu');
  const devices=[];let column=-1;
  for(const line of (sample?.stdout||'').split('\n')){
    const cells=line.split('|').slice(1,-1).map(s=>s.trim());
    if(cells.some(c=>c==='Health')){column=cells.indexOf('Health');continue;}
    if(column<0||!/^\d+(?:\s|$)/.test(cells[0]||''))continue;
    // Continuation metric rows can also start with a numeric chip ID. Only a
    // hardware-name row supplies Health; preserve unknown values on that row.
    if(!cells.some(c=>/Ascend\w*/.test(c)))continue;
    const status=cells[column];
    devices.push({device:cells[0].split(/\s+/)[0],status:['OK','Warning','Alarm'].includes(status)?status:'unknown'});
  }
  const sampled_at=sample?.endedAt||null;
  const known=sample?.exitCode===0&&!sample.error&&!sample.warning&&!sample.truncated&&devices.length>0&&devices.every(d=>d.status!=='unknown')&&new Set(devices.map(d=>d.device)).size===devices.length;
  const fresh=known&&Number.isFinite(Date.parse(sampled_at))&&Date.now()-Date.parse(sampled_at)>=-5000&&Date.now()-Date.parse(sampled_at)<=120000;
  return {policy,observed_at:now(),sampled_at,known:Boolean(known),fresh:Boolean(fresh),
    devices:devices.slice(0,128),has_warning:devices.some(d=>d.status==='Warning'),has_alarm:devices.some(d=>d.status==='Alarm'),
    source_sha256:sample?sha(sample.stdout||''):null,scope:'Existing monitoring sample; not NPU availability, workload or communication verification.'};
}
export function healthEvidence(states,ids,policy){
  return ids.map(machine_id=>({machine_id,...healthSample(states?.[machine_id],policy)}));
}
