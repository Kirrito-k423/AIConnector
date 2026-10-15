import test from 'node:test';
import assert from 'node:assert/strict';
import {Progress} from '../../service/progress.mjs';
test('repeated overlapping evidence is idle, new page coverage is progress',()=>{
 const p=new Progress(2),read=(offset,content)=>p.observe('read_output',{name:'x'},{sha256:'fixed',offset,content});
 read(0,'abcd');assert.equal(p.endTurn(),true);read(1,'bc');assert.equal(p.endTurn(),true);
 read(4,'efgh');assert.equal(p.endTurn(),true);read(0,'abcdefgh');assert.equal(p.endTurn(),true);
 read(0,'abcdefgh');assert.equal(p.endTurn(),false);
});
test('verification clocks and rewritten summaries do not reset the idle budget',()=>{
 const p=new Progress(2);
 for(let i=0;i<3;i++){
  p.observe('submit_summary',{}, {summary:'rewritten '+i});
  p.observe('verify_task',{}, {checked_at:String(i),status:'incomplete',checks:[{id:'missing',ok:false,evidence_sha256:String(i)}]});
  assert.equal(p.endTurn(),i<2);
 }
});
test('new action IDs for no-op writes are not new repair progress',()=>{
 const p=new Progress(2);
 for(let i=0;i<3;i++){p.observe('write_local_file',{file:'config',action_id:'new-'+i},{after_sha256:'fixed',backup_action:'new-'+i});assert.equal(p.endTurn(),i<2);}
});
test('different rejected writes cannot reset the no-progress budget',()=>{
 const p=new Progress(2);
 p.observe('patch_local_json',{file:'registry',action_id:'first'},{error:'JSON_POINTER_NOT_AUTHORIZED'});assert.equal(p.endTurn(),true);
 p.observe('patch_local_json',{file:'registry',action_id:'different'},{error:'SERVER_PROFILE_SCOPE'});assert.equal(p.endTurn(),false);
});
