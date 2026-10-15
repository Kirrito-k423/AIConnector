// Opt-in: synthetic PUBLIC GitHub run; both node services are local to this Mac.
import fs from 'node:fs';
import path from 'node:path';
import {start} from '../service/server.mjs';
import {ROOT,atomic,run,need,now,sha} from '../service/common.mjs';
import {modelFixture} from '../tests/service/model_fixture.mjs';
need(process.argv.includes('--write-synthetic'),'EXPLICIT_SYNTHETIC_WRITE_REQUIRED');
const out=path.join(ROOT,'reports','service-live-'+Date.now());fs.mkdirSync(out,{recursive:true});
const fixture=await modelFixture(),services=[];
try {
  const auth=await run('gh',['auth','token'],{env:process.env});need(auth.code===0&&auth.out.trim(),'GITHUB_AUTH_REQUIRED');
  const githubToken=auth.out.trim();const relay=JSON.parse(fs.readFileSync(path.join(ROOT,'connector.config.json')));
  relay.poll_seconds=15;const configPath=path.join(out,'connector.json');atomic(configPath,JSON.stringify(relay));
  for(const [i,node]of ['mac-outer','windows-inner'].entries()){
    const c={schema:'aiconnector.service.v1',node,port:43210+i,connectorConfig:configPath,dataDir:path.join(out,node),powershell:process.env.PWSH||'pwsh',proxy:process.env.HTTPS_PROXY||'system',
      runner:{enabled:node==='windows-inner',proxy:'direct',timeoutSeconds:120,maxTurns:6,model:{api:'openai-completions',baseUrl:fixture.url,id:'fixture',compat:{supportsDeveloperRole:false}},profiles:{'local-smoke':{kind:'builtin-smoke',repository:'aiconnector-builtin',entry:'smoke',outputs:['metrics.json']}}}};
    const file=path.join(out,node+'.local.json');atomic(file,JSON.stringify(c));services.push(await start(file,{secrets:{githubToken,apiKey:'LOCAL_FIXTURE_KEY'}}));
  }
  const runId='run-'+now().replace(/[-:.TZ]/g,'').slice(0,14),key=`service-pi-smoke/1/${runId}`;
  const task={task_id:'service-pi-smoke',revision:1,run_id:runId,title:'后台服务与 Pi 自动实验闭环验收',objective:'两个服务运行于同一 Mac，通过真实 GitHub 通道自动交接。真实 Pi 调用本地受控测试 API，运行实际 CPU 校验，返回 ZIP。不是用户内网、商业模型或 NPU 测试。',code:{repository:'aiconnector-builtin',revision:'builtin-smoke-v1'},environment:{target:'local-smoke'},invocation:{entry:'smoke',arguments:[]},acceptance:['sum=50005000；五阶段事件齐全；输出 ZIP 校验一致；轮询不重复执行。'],artifacts:[]};
  const response=await fetch(services[0].url+'/api/tasks',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+services[0].token},body:JSON.stringify({task})});need(response.ok,'SUBMIT_FAILED');
  console.log(JSON.stringify({state:'running',key,evidence:out,dashboard:services[0].url}));
  for(let i=0;i<180;i++) {
    await new Promise(r=>setTimeout(r,3000));
    const mac=services[0].status(),win=services[1].status();
    const row=mac.channel.runs.find(r=>r.key===key);const job=win.jobs.find(j=>j.key===key);
    if(row?.phase==='receipt'&&job?.state==='confirmed'){
      need(row.result.outcome==='succeeded'&&fixture.requests===3,'LIVE_RESULT_INVALID');
      const resultZip=path.join(out,'windows-inner','jobs',sha(key),'result.zip');
      const evidence={key,issue:row.issue_url,release:row.release_url,timeline:row.timeline,execution:row.result.execution,artifact:row.result.artifacts[0],zip_sha256:sha(fs.readFileSync(resultZip)),model_requests:fixture.requests,real_github:true,real_pi:true,real_cpu:true,two_services_same_mac:true,fixture_model:true,user_windows:false,npu:false,completed_at:now()};
      atomic(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
      if(process.argv.includes('--keep'))await new Promise(()=>{});
      break;
    }
    if(i===179)throw new Error('LIVE_TIMEOUT');
  }
}finally{for(const service of services)await service.close();await fixture.close();}
