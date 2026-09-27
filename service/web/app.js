const $=id=>document.getElementById(id);
function adoptToken(){const hash=new URLSearchParams(location.hash.slice(1));if(hash.has('token')){sessionStorage.setItem('aic-token',hash.get('token'));history.replaceState(null,'',location.pathname);}}
adoptToken();window.addEventListener('hashchange',()=>{adoptToken();void refresh();});
let state,selected='',rows=[],filter='active',settingsLoaded=false,agentLoaded=false,refreshing;
let detailKey='',detailSignature='';
const labels={task:'已发布',accepted:'接收端已校验',started:'已领取',result:'结果已发布',receipt:'已回执',claiming:'登记领取',launching:'启动执行器',running:'Pi 处理中',delivering:'交付 ZIP 中',submitted:'等待回执',confirmed:'已回执',blocked:'需要处理',unknown:'执行状态未知',conflict:'运行冲突',pending:'等待发布',queued:'已加入发送队列'};
const filterLabels={active:'处理中',error:'需要处理',confirmed:'已回执',all:'全部'};
function timestamp(t){if(t===null||t===undefined||t==='')return 0;const n=typeof t==='number'?(t<1e11?t*1000:t):Date.parse(t);return Number.isFinite(n)?n:0;}
const date=t=>timestamp(t)?new Date(timestamp(t)).toLocaleString('zh-CN',{hour12:false}):'尚未发生';
const el=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
function link(parent,text,url){try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return;const a=el('a',text);a.href=u.href;a.target='_blank';a.rel='noreferrer';parent.append(a);}catch{}}
async function api(url,data){const r=await fetch(url,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+sessionStorage.getItem('aic-token'),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});const value=await r.json();if(!r.ok)throw new Error(value.diagnostic?value.error+'：'+JSON.stringify(value.diagnostic):value.error);return value;}
function notice(s,problem=false){$('notice').textContent=s;$('notice').classList.toggle('problem',problem);if(problem&&$('tools-dialog').open)$('dialog-notice').textContent=s;}
const phase=r=>r.job?.state||r.phase;
const error=r=>Boolean(r.error||r.job?.error||r.result&&r.result.outcome!=='succeeded'||['unknown','blocked','conflict'].includes(phase(r)));
const done=r=>['confirmed','receipt'].includes(phase(r));
const matches=(r,f)=>f==='all'||f==='confirmed'&&done(r)||f==='error'&&error(r)||f==='active'&&!done(r)&&!error(r);
function activityTime(r){
  const j=r.job,w=j?.worker;
  // Poll/observation times and worker heartbeats are not task activity.
  const times=[r.created_at,j?.created_at,j?.claimed_at,j?.submitted_at,j?.confirmed_at,
    w?.agent_started_at,w?.agent_ended_at,w?.execution_started_at,w?.execution_ended_at,w?.ended_at,
    r.result?.agent?.started_at,r.result?.agent?.ended_at,r.result?.execution?.started_at,r.result?.execution?.ended_at];
  for(const e of r.timeline||[])times.push(e.published_at);
  for(const e of w?.events||[])if(e.type!=='heartbeat')times.push(e.at);
  return times.reduce((latest,t)=>Math.max(latest,timestamp(t)),0);
}
function collectRows(){
  const merged=new Map((state.submissions||[]).map(d=>[d.key,{...d,phase:d.state}]));
  for(const r of state.channel.runs||[])merged.set(r.key,{...merged.get(r.key),...r});
  for(const j of state.jobs||[])merged.set(j.key,{...merged.get(j.key),key:j.key,job:j});
  return [...merged.values()].map(r=>({...r,activity_at:activityTime(r)})).sort((a,b)=>b.activity_at-a.activity_at||a.key.localeCompare(b.key));
}
function emptyMessage(text){
  const box=el('div',undefined,'empty');box.append(el('p',text));
  if(filter!=='all'&&rows.length){const b=el('button','查看全部任务','quiet');b.onclick=()=>setFilter('all');box.append(b);}
  return box;
}
function renderRuns(visible){
  const container=$('runs'),top=container.scrollTop,focused=document.activeElement;
  const existing=new Map([...container.querySelectorAll('.run')].map(b=>[b.dataset.key,b]));
  const keys=new Set(visible.map(r=>r.key));
  for(const child of [...container.children])if(!keys.has(child.dataset.key))child.remove();
  if(!visible.length){container.append(emptyMessage('暂无'+filterLabels[filter]+'任务'));return;}
  for(const [i,row]of visible.entries()){
    let b=existing.get(row.key);
    if(!b){b=el('button',undefined,'run');b.type='button';b.dataset.key=row.key;b.onclick=()=>{selected=row.key;render();};}
    const signature=JSON.stringify([row.task?.title,row.key,phase(row),error(row),row.activity_at]);
    if(b._signature!==signature){
      const time=el('time',row.activity_at?date(row.activity_at):'活动时间未知');
      if(row.activity_at)time.dateTime=new Date(row.activity_at).toISOString();
      b.replaceChildren(el('strong',row.task?.title||row.key),el('small',row.key),el('div',labels[phase(row)]||phase(row),'status'+(error(row)?' error':'')),time);
      b.title=(row.task?.title||row.key)+'\n'+row.key;b._signature=signature;
    }
    b.classList.toggle('selected',row.key===selected);b.setAttribute('aria-pressed',String(row.key===selected));
    if(container.children[i]!==b)container.insertBefore(b,container.children[i]||null);
  }
  // Reuse keyed buttons so polling does not remove the focused task.
  if(focused?.isConnected&&document.activeElement!==focused)focused.focus({preventScroll:true});
  container.scrollTop=top;
}
function disclosure(id,title,child){
  const d=el('details');d.dataset.section=id;d.append(el('summary',title),child);return d;
}
function executionEvents(r){
  const events=[],w=r.job?.worker;
  const observed=(w?.execution_time_source||r.result?.execution?.time_source)==='controller_observed';
  for(const [title,at]of [[observed?'服务器提交记录':'子进程开始',w?.execution_started_at||r.result?.execution?.started_at],[observed?'服务器退出确认':'子进程结束',w?.execution_ended_at||r.result?.execution?.ended_at]])if(at)events.push({title,at,meta:observed?'控制器记录时间，非远端精确时间':'仅命令时间，不是 Pi 总运行时间'});
  for(const [title,at]of [['Pi 会话开始',w?.agent_started_at||r.result?.agent?.started_at],['Pi 会话结束',w?.agent_ended_at||r.result?.agent?.ended_at]])if(at)events.push({title,at,meta:'包含模型、工具调用和独立验收'});
  for(const e of w?.events||[])if(['compaction_start','compaction_end','server_task_submitting','server_result_collected','web_fetched'].includes(e.type))events.push({title:({compaction_start:'正在压缩上下文',compaction_end:e.success?'上下文压缩完成':'上下文压缩未完成',server_task_submitting:'提交服务器任务',server_result_collected:'服务器结果已回收',web_fetched:'已读取参考网页'})[e.type],at:e.at,meta:e.id||e.host||e.reason||''});
  return events.sort((a,b)=>timestamp(a.at)-timestamp(b.at));
}
function renderDetail(r){
  const detail=$('detail');
  if(!r){
    if(detailSignature!=='empty:'+filter){detail.replaceChildren(emptyMessage('暂无'+filterLabels[filter]+'任务，可切换上方状态查看其他任务。'));detail.scrollTop=0;}
    detailKey='';detailSignature='empty:'+filter;return;
  }
  const w=r.job?.worker;
  const signature=JSON.stringify([r.key,r.task,r.timeline,r.result,r.issue_url,r.release_url,r.error,phase(r),r.job?.error,r.job?.process_exit,r.job?.process_failure,r.activity_at,matches(r,filter),filter,
    w&&[w.state,w.context,w.compaction,w.server_task,w.events,w.agent_started_at,w.agent_ended_at,w.execution_started_at,w.execution_ended_at,w.execution_time_source]]);
  if(detailKey===r.key&&detailSignature===signature)return;
  const same=detailKey===r.key,top=same?detail.scrollTop:0;
  const disclosureState=new Map([...detail.querySelectorAll('details[data-section]')].map(d=>[d.dataset.section,{open:d.open,scroll:d.querySelector('pre')?.scrollTop||0}]));
  const focusSection=same?document.activeElement?.closest('#detail details')?.dataset.section:null;
  const header=el('div',undefined,'detail-heading');header.append(el('h2',r.task?.title||r.key),el('span',labels[phase(r)]||phase(r),'pill'+(error(r)?' error':'')));
  detail.replaceChildren(header,el('div',r.key,'meta'));
  const links=el('div',undefined,'links');link(links,'任务 Issue ↗',r.issue_url);link(links,'本次 Release ↗',r.release_url);detail.append(links);
  if(!matches(r,filter))detail.append(el('p','当前任务已移出「'+filterLabels[filter]+'」，保留详情供查看。','selection-note'));
  const milestones=el('section',undefined,'milestones');milestones.append(el('h3','关键节点'));
  const list=el('ol',undefined,'timeline');
  for(const [kind,title]of [['task','发布'],['accepted','接收端校验'],['started','领取'],['result','结果发布'],['receipt','回执']]){
    const e=(r.timeline||[]).filter(e=>e.kind===kind).sort((a,b)=>timestamp(b.published_at)-timestamp(a.published_at))[0];
    const li=el('li',undefined,e?'':'pending');li.dataset.kind=kind;
    li.append(el('strong',title+(e?' · 已确认':'')),el('time',e?date(e.published_at):'尚未确认'));
    if(e){li.append(el('span',e.sender||'远端记录','event-meta'));if(e.author)li.append(el('span','GitHub @'+e.author,'event-meta'));link(li,'原始记录 ↗',e.url);}
    else if(kind==='task'&&r.created_at)li.append(el('span','本地排队 '+date(r.created_at),'event-meta'));
    list.append(li);
  }
  milestones.append(list);
  const events=executionEvents(r);
  if(events.length){
    const log=el('ol',undefined,'event-log');
    for(const e of events){const li=el('li');li.append(el('strong',e.title),el('span',date(e.at)+' · '+e.meta));log.append(li);}
    milestones.append(disclosure('execution-events','执行与工具记录 · '+events.length+' 条',log));
  }
  if(r.result?.agent){
    const a=r.result.agent,parts=[a.duration_ms==null?'该历史结果未记录 Pi 总耗时':'Pi 总运行 '+a.duration_ms+' ms'];
    if(a.turns!=null)parts.push(a.turns+' 轮');if(a.continuations!=null)parts.push('继续修复 '+a.continuations+' 次');
    milestones.append(el('p',parts.join(' · '),'duration'));
  }
  detail.append(milestones);
  if(error(r))detail.append(el('p',String(r.error||r.job?.error||'实验未通过，请查看验收与结果。'),'error'));
  if(r.job?.state==='unknown'){
    const b=el('button','核对环境后，将本次登记为未完成');b.onclick=async()=>{if(!confirm('请先核对本机与远端实验进程已停止或已完成。将交付 blocked 结果并解除队列阻塞，原运行不会重跑。确定已核对？'))return;try{await api('/api/resolve-unknown',{key:r.key,remoteChecked:true});await refresh();}catch(e){notice(e.message,true);}};detail.append(b);
  }
  const request=el('section',undefined,'content-section');request.dataset.section='request';
  request.append(el('h3','发送的任务'),el('p',r.task?.objective||'尚未取得任务正文。'));
  if(r.task)request.append(disclosure('task-json','完整任务与验收要求',el('pre',JSON.stringify(r.task,null,2))));
  detail.append(request);
  const result=el('section',undefined,'content-section');result.dataset.section='result';result.append(el('h3','接收的结果'));
  if(r.result){
    result.append(el('p',r.result.summary));
    const artifacts=el('div',undefined,'links');
    for(const a of r.result.artifacts||[])link(artifacts,'下载 '+a.name+' · '+a.bytes+' 字节 ↗',a.url);
    result.append(artifacts);
    result.append(disclosure('result-json','验收、指标与模型用量',el('pre',JSON.stringify({outcome:r.result.outcome,exit_code:r.result.exit_code,actual_revision:r.result.actual_revision,acceptance:r.result.acceptance,停止原因:r.result.agent?.stop_reason,累计模型用量:r.result.agent?.usage,用量范围:r.result.agent?.usage_scope,metrics_source:r.result.metrics_source,metrics:r.result.metrics},null,2))));
    if(r.result.model_report)result.append(disclosure('model-report','模型报告（未独立核对，运行统计以运行器为准）',el('pre',JSON.stringify(r.result.model_report,null,2))));
  }else{
    result.append(el('p','尚未收到结果。后台同步后将在这里更新。'));
    if(w)result.append(disclosure('worker-json','执行器最近记录',el('pre',JSON.stringify({执行器:w.state,记录:w.events?.slice(-5)},null,2))));
  }
  if(r.job?.process_exit?.code||r.job?.process_exit?.signal||r.job?.process_failure)result.append(disclosure('process-failure','执行器退出诊断（不会自动重跑）',el('pre',JSON.stringify({exit:r.job.process_exit,failure:r.job.process_failure},null,2))));
  if(w?.context)result.append(el('p','环境快照 '+w.context.sha256?.slice(0,12)+' · 自动压缩 '+(w.compaction?.enabled?'已开启':'已关闭')+' · 已压缩 '+(w.compaction?.count||0)+' 次','meta'));
  if(w?.server_task)result.append(disclosure('server-task','服务器任务记录',el('pre',JSON.stringify(w.server_task,null,2))));
  detail.append(result);
  if(same)for(const d of detail.querySelectorAll('details[data-section]')){
    const saved=disclosureState.get(d.dataset.section);if(!saved)continue;d.open=saved.open;const pre=d.querySelector('pre');if(pre)pre.scrollTop=saved.scroll;
    if(focusSection===d.dataset.section)d.querySelector('summary').focus({preventScroll:true});
  }
  detail.scrollTop=top;detailKey=r.key;detailSignature=signature;
}
function render(){
  const s=state.service;$('node').textContent=(s.node==='mac-outer'?'Mac · 发送端':'Windows · 执行端')+(s.version?' · v'+s.version:'');$('repo').href='https://github.com/'+s.repository;
  $('capabilities').textContent=JSON.stringify(s.node==='mac-outer'?state.capabilities?.receiver||{error:'尚未收到 Windows 能力公告'}:state.capabilities?.local||{error:'当前服务尚未提供能力公告'},null,2);
  if(!settingsLoaded){if(s.model){$('model-api').value=s.model.api;$('model-base').value=s.model.baseUrl;$('model-id').value=s.model.id;}settingsLoaded=true;}
  if(!agentLoaded&&s.runner){loadAgentForm(s.runner,s.model);agentLoaded=true;}
  rows=collectRows();
  for(const b of document.querySelectorAll('[data-filter]')){
    b.classList.toggle('active',b.dataset.filter===filter);b.setAttribute('aria-pressed',String(b.dataset.filter===filter));
    b.querySelector('[data-count]').textContent=rows.filter(r=>matches(r,b.dataset.filter)).length;
  }
  const problems=[s.last_error,state.channel.last_error,s.runner_error,s.capability_error].filter(Boolean);
  const receiver=s.node==='windows-inner'?state.capabilities?.local:state.capabilities?.receiver?.data;
  if(receiver?.profiles?.length&&!receiver.profiles.some(p=>['probe','experiment','maintenance'].includes(p.mode)))problems.push('Windows 当前只有 CPU 自检能力，请在 Windows 看板「接入服务器」配置真实入口');
  if(!s.github_configured)problems.push('尚未配置 GitHub Token（当前只读）');
  if(s.runner_enabled&&!s.model_configured)problems.push('请在连接设置中配置模型和 API Key');
  notice(problems.join(' · ')||'最近同步 '+date(state.channel.last_poll)+' · 每 '+s.poll_seconds+' 秒轮询',Boolean(problems.length));
  document.querySelector('[data-panel="submit"]').hidden=s.node!=='mac-outer';
  document.querySelector('[data-panel="server-setup"]').hidden=s.node!=='windows-inner';
  document.querySelector('[data-panel="capability-panel"]').hidden=!state.capabilities;
  const visible=rows.filter(r=>matches(r,filter));
  // Keep a task in view when it completes or moves to the error filter.
  if(!rows.some(r=>r.key===selected))selected=visible[0]?.key||'';
  renderRuns(visible);renderDetail(rows.find(r=>r.key===selected));
}
function setFilter(value){filter=value;selected='';$('runs').scrollTop=0;if(state)render();}
function refresh(){
  if(refreshing)return refreshing;
  refreshing=(async()=>{try{state=await api('/api/status');render();}catch(e){notice(e.message==='UNAUTHORIZED'?'请用启动器打开带访问凭据的本机页面。':'连接失败：'+e.message+'。后台恢复后页面会自动重连。',true);}finally{refreshing=null;}})();
  return refreshing;
}
for(const b of document.querySelectorAll('[data-filter]'))b.onclick=()=>setFilter(b.dataset.filter);
for(const b of document.querySelectorAll('[data-panel]'))b.onclick=()=>{
  for(const panel of document.querySelectorAll('.dialog-content>details')){panel.hidden=panel.id!==b.dataset.panel;panel.open=!panel.hidden;}
  $('dialog-title').textContent=$(b.dataset.panel).querySelector('summary').textContent;$('dialog-notice').textContent='';
  $('tools-dialog').showModal();$('tools-dialog').scrollTop=0;
};
$('close-dialog').onclick=()=>$('tools-dialog').close();
$('refresh').onclick=async()=>{const b=$('refresh');b.disabled=true;try{await api('/api/poll',{});await refresh();}catch(e){notice(e.message,true);}finally{b.disabled=false;}};
$('task-json').value=JSON.stringify({task_id:'pi-smoke',revision:1,run_id:'run-'+new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14),title:'Pi 自动实验闭环',objective:'让 Pi 执行内置 CPU 校验，收集指标并返回 ZIP。',requirements:{mode:'smoke',tools:['run_experiment'],checks:['cpu-smoke']},code:{repository:'aiconnector-builtin',revision:'builtin-smoke-v1'},environment:{target:'auto'},invocation:{entry:'auto',arguments:[]},acceptance:['sum=50005000，收到真实执行输出、结果 ZIP 和回执；不涉及 NPU。'],artifacts:[]},null,2);
$('task-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const task=JSON.parse($('task-json').value),file=$('zip').files[0];let zipBase64;if(file){if(file.size>=5242880)throw new Error('ZIP 必须小于 5 MiB');const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=16384)raw+=String.fromCharCode(...bytes.subarray(i,i+16384));zipBase64=btoa(raw);}const r=await api('/api/tasks',{task,...(zipBase64?{zipBase64}:{})});selected=r.key;filter='active';$('tools-dialog').close();await refresh();}catch(e){notice(e.message,true);}finally{button.disabled=false;}};
$('settings-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const model=$('model-id').value?{api:$('model-api').value,baseUrl:$('model-base').value,id:$('model-id').value}:null;await api('/api/settings',{githubToken:$('github-token').value,apiKey:$('api-key').value,model});$('github-token').value='';$('api-key').value='';await refresh();}catch(e){notice(e.message,true);}finally{button.disabled=false;}};
function loadAgentForm(r,m){const a=r.agent,c=a.compaction,w=a.web,s=a.simpleHtmlWatch;
  // A UI-only update can also serve the previous runtime, which lacks these settings.
  $('skills-json').closest('label').hidden=!Object.hasOwn(a,'skills');$('budget-json').closest('label').hidden=!Object.hasOwn(a,'budget');
  $('skills-json').value=JSON.stringify(a.skills||[],null,2);$('budget-json').value=JSON.stringify(a.budget||{},null,2);
  const values={'global-prompt':a.globalPrompt,'context-files':a.contextFiles.join('\n'),'run-timeout':r.timeoutSeconds,'max-turns':r.maxTurns,'watch-base':s.baseUrl,'watch-poll':s.pollSeconds,'profiles-json':JSON.stringify(r.profiles,null,2),'web-transport':w.transport,'web-proxy':w.proxy,'web-timeout':w.timeoutSeconds,'web-hosts':w.allowedHosts.join('\n'),'web-search':w.searchUrl,'context-window':m?.contextWindow||32768,'max-tokens':m?.maxTokens||4096,'compact-reserve':c.reserveTokens,'compact-recent':c.keepRecentTokens};
  for(const [id,value]of Object.entries(values))$(id).value=value;
  for(const [id,value]of Object.entries({'runner-enabled':r.enabled,'watch-enabled':s.enabled,'web-enabled':w.enabled,'compact-enabled':c.enabled}))$(id).checked=value;
}
const lines=id=>$(id).value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),num=id=>Number($(id).value);
$('agent-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{
  const previous=state.service.runner.agent;
  await api('/api/agent-settings',{enabled:$('runner-enabled').checked,timeoutSeconds:num('run-timeout'),maxTurns:num('max-turns'),profiles:JSON.parse($('profiles-json').value),modelLimits:{contextWindow:num('context-window'),maxTokens:num('max-tokens')},agent:{...previous,skills:JSON.parse($('skills-json').value),budget:JSON.parse($('budget-json').value),globalPrompt:$('global-prompt').value,contextFiles:lines('context-files'),
    simpleHtmlWatch:{...previous.simpleHtmlWatch,enabled:$('watch-enabled').checked,baseUrl:$('watch-base').value,pollSeconds:num('watch-poll')},
    web:{...previous.web,enabled:$('web-enabled').checked,transport:$('web-transport').value,proxy:$('web-proxy').value,timeoutSeconds:num('web-timeout'),allowedHosts:lines('web-hosts'),searchUrl:$('web-search').value},
    compaction:{enabled:$('compact-enabled').checked,reserveTokens:num('compact-reserve'),keepRecentTokens:num('compact-recent')}}});
  $('agent-notice').textContent='已保存。新配置用于下一次领取的任务；模型地址和密钥保留。';agentLoaded=false;await refresh();
}catch(err){$('agent-notice').textContent=err.message;}finally{b.disabled=false;}};
$('watch-example').onclick=()=>{try{const profiles=JSON.parse($('profiles-json').value);if(profiles['npu-example'])throw new Error('npu-example 已存在，请编辑现有入口。');profiles['npu-example']={kind:'simplehtmlwatch',entry:'experiment',repository:'my-project',machineId:'替换为机器ID',revisionCommand:'git -C /home/your-user/project rev-parse HEAD',shell:'python3 /home/your-user/project/experiment.py --output "$SHW_RESULTS_DIR/metrics.json"',outputs:['metrics.json'],verification:[{id:'correctness',kind:'output-json',file:'metrics.json',pointer:'/correct',equals:true}]};$('profiles-json').value=JSON.stringify(profiles,null,2);}catch(e){$('agent-notice').textContent=e.message;}};
$('check-agent').onclick=async()=>{const b=$('check-agent');b.disabled=true;$('check-result').textContent='正在检查…';try{$('check-result').textContent=JSON.stringify(await api('/api/agent-check',{webUrl:$('check-url').value}),null,2);}catch(e){$('check-result').textContent=e.message;}finally{b.disabled=false;}};
void refresh();setInterval(refresh,3000);

let serverCatalog;
$('discover-servers').onclick=async()=>{
  const b=$('discover-servers');b.disabled=true;$('save-servers').disabled=true;$('server-setup-notice').textContent='正在读取本机 simpleHtmlWatch…';
  try{serverCatalog=await api('/api/server-catalog');$('server-machines').replaceChildren();
    for(const m of serverCatalog.machines){const label=el('label',undefined,'check'),box=el('input');box.type='checkbox';box.value=m.id;box.checked=serverCatalog.selected.includes(m.id);label.append(box,document.createTextNode(m.name+' · '+m.id+(m.group?' · '+m.group:'')));$('server-machines').append(label);}
    $('server-maintenance').checked=Boolean(state.service.runner?.profiles?.['server-maintenance']);
    $('server-setup-notice').textContent=serverCatalog.machines.length?'选择需要接入的机器。保存不会自动启动服务器任务。':'当前没有可调度机器，请先检查 simpleHtmlWatch 的连接、队列与主机信任状态。';
    $('save-servers').disabled=!serverCatalog.machines.length;
  }catch(e){$('server-setup-notice').textContent=e.message==='WATCH_NOT_ENABLED'?'先在 Pi 配置中启用 simpleHtmlWatch 并填写本机地址，再读取列表。':e.message;}finally{b.disabled=false;}
};
$('server-setup-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;
  try{const machineIds=[...$('server-machines').querySelectorAll('input:checked')].map(x=>x.value);
    const result=await api('/api/server-setup',{config_sha256:serverCatalog.config_sha256,machineIds,allowMaintenance:$('server-maintenance').checked});
    $('server-setup-result').textContent=JSON.stringify(result,null,2);$('server-setup-notice').textContent='已保存，后台将在下一轮公布能力。请先投递探测任务，再配置真实实验。';agentLoaded=false;await refresh();serverCatalog=undefined;
  }catch(err){$('server-setup-notice').textContent=err.message;b.disabled=false;}
};
