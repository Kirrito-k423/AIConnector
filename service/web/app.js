const $=id=>document.getElementById(id);
function adoptToken(){const hash=new URLSearchParams(location.hash.slice(1));if(hash.has('token')){sessionStorage.setItem('aic-token',hash.get('token'));history.replaceState(null,'',location.pathname);}}
adoptToken();window.addEventListener('hashchange',()=>{adoptToken();void refresh();});
let state,selected='',rows=[],settingsLoaded=false,agentLoaded=false;
const labels={task:'已发布',accepted:'接收端已校验',started:'已领取',result:'结果已发布',receipt:'已回执',claiming:'登记领取',launching:'启动执行器',running:'Pi 处理中',delivering:'交付 ZIP 中',submitted:'等待回执',confirmed:'已回执',blocked:'需要处理',unknown:'执行状态未知',pending:'等待发布',queued:'已加入发送队列'};
const date=t=>t?new Date(typeof t==='number'?t*1000:t).toLocaleString('zh-CN',{hour12:false}):'尚未发生';
const el=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
function link(parent,text,url){try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return;const a=el('a',text);a.href=u.href;a.target='_blank';a.rel='noreferrer';parent.append(a);}catch{}}
async function api(url,data){const r=await fetch(url,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+sessionStorage.getItem('aic-token'),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});const value=await r.json();if(!r.ok)throw new Error(value.error);return value;}
function notice(s){$('notice').textContent=s;}
function render(){
  const s=state.service;$('node').textContent=s.node==='mac-outer'?'Mac · 发送端':'Windows · 执行端';$('repo').href='https://github.com/'+s.repository;
  if(!settingsLoaded){if(s.model){$('model-api').value=s.model.api;$('model-base').value=s.model.baseUrl;$('model-id').value=s.model.id;}settingsLoaded=true;}
  if(!agentLoaded&&s.runner){loadAgentForm(s.runner,s.model);agentLoaded=true;}
  const jobs=new Map(state.jobs.map(j=>[j.key,j]));rows=state.channel.runs.map(r=>({...r,job:jobs.get(r.key)}));
  for(const d of state.submissions)if(!rows.some(r=>r.key===d.key))rows.push({...d,phase:d.state});
  rows.sort((a,b)=>b.key.localeCompare(a.key));
  const phase=r=>r.job?.state||r.phase;
  const error=r=>r.error||r.job?.error||['unknown','blocked','conflict'].includes(phase(r));
  const done=r=>['confirmed','receipt'].includes(phase(r));
  $('stats').replaceChildren();for(const [title,n]of [['全部运行',rows.length],['处理中',rows.filter(r=>!done(r)&&!error(r)).length],['已回执',rows.filter(done).length],['需要处理',rows.filter(error).length]]){const d=el('div',undefined,'stat');d.append(el('strong',String(n)),el('span',title));$('stats').append(d);}
  const problems=[s.last_error,state.channel.last_error,s.runner_error].filter(Boolean);if(!s.github_configured)problems.push('尚未配置 GitHub Token（当前只读）');if(s.runner_enabled&&!s.model_configured)problems.push('请在连接设置中配置模型和 API Key');
  notice(problems.join(' · ')||`最近同步 ${date(state.channel.last_poll)} · 每 ${s.poll_seconds} 秒轮询`);
  $('submit').hidden=s.node!=='mac-outer';$('runs').replaceChildren();
  const filter=$('filter').value,visible=rows.filter(r=>filter==='all'||filter==='confirmed'&&done(r)||filter==='error'&&error(r)||filter==='active'&&!done(r)&&!error(r));
  if(!visible.length)$('runs').append(el('p','还没有符合条件的任务。','empty'));
  if(!visible.some(r=>r.key===selected))selected=visible[0]?.key||'';
  for(const row of visible){const b=el('button',undefined,'run'+(row.key===selected?' selected':''));b.append(el('strong',row.task?.title||row.key),el('small',row.key),el('div',labels[phase(row)]||phase(row),'status'+(error(row)?' error':'')));b.onclick=()=>{selected=row.key;render();};$('runs').append(b);}
  const r=rows.find(r=>r.key===selected);if(!r){$('detail').replaceChildren(el('p','选择一个运行，查看时间线和交付件。','empty'));return;}
  const detail=$('detail');detail.replaceChildren(el('h2',r.task?.title||r.key),el('div',r.key,'meta'),el('p',r.task?.objective||''));
  const links=el('div',undefined,'links');link(links,'任务 Issue ↗',r.issue_url);link(links,'本次 Release ↗',r.release_url);detail.append(links);
  const list=el('ol',undefined,'timeline');
  const events=(r.timeline||[]).map(e=>({at:e.published_at,title:(labels[e.kind]||e.kind)+' · 远端记录',meta:`${e.sender} · GitHub @${e.author||'未知'}`,url:e.url}));
  for(const [title,at]of [['实际开始执行',r.job?.worker?.execution_started_at||r.result?.execution?.started_at],['实际执行结束',r.job?.worker?.execution_ended_at||r.result?.execution?.ended_at]])if(at)events.push({title,at,meta:'执行器本机时间'});
  for(const e of r.job?.worker?.events||[])if(['compaction_start','compaction_end','server_task_submitting','server_result_collected','web_fetched'].includes(e.type))events.push({title:({compaction_start:'正在压缩上下文',compaction_end:e.success?'上下文压缩完成':'上下文压缩未完成',server_task_submitting:'提交服务器任务',server_result_collected:'服务器结果已回收',web_fetched:'已读取参考网页'})[e.type],at:e.at,meta:e.id||e.host||e.reason||''});
  events.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  for(const e of events){const li=el('li');li.append(el('strong',e.title),el('span',`${date(e.at)} · ${e.meta}`));if(e.url)link(li,'查看原始记录',e.url);list.append(li);}
  if(!(r.timeline||[]).length)list.append(el('li','本地已排队，远端发布时间尚未确认。'));
  detail.append(list);
  if(r.job?.worker?.context)detail.append(el('p',`环境快照 ${r.job.worker.context.sha256?.slice(0,12)} · 自动压缩 ${r.job.worker.compaction?.enabled?'已开启':'已关闭'} · 已压缩 ${r.job.worker.compaction?.count||0} 次`,'meta'));
  if(r.job?.worker?.server_task)detail.append(el('pre',JSON.stringify({服务器任务:r.job.worker.server_task},null,2)));
  if(error(r))detail.append(el('p',String(r.error||r.job?.error||'需要检查执行状态'),'error'));
  if(r.job?.state==='unknown'){const b=el('button','核对环境后，将本次登记为未完成');b.onclick=async()=>{if(!confirm('请先核对本机与远端实验进程已停止或已完成。将交付 blocked 结果并解除队列阻塞，原运行不会重跑。确定已核对？'))return;try{await api('/api/resolve-unknown',{key:r.key,remoteChecked:true});await refresh();}catch(e){notice(e.message);}};detail.append(b);}
  if(r.result){detail.append(el('h2','实验结果'),el('p',r.result.summary),el('pre',JSON.stringify({outcome:r.result.outcome,exit_code:r.result.exit_code,actual_revision:r.result.actual_revision,metrics:r.result.metrics},null,2)));for(const a of r.result.artifacts||[])link(detail,`下载 ${a.name} · ${a.bytes} 字节 ↗`,a.url);}
  else if(r.job?.worker)detail.append(el('pre',JSON.stringify({执行器:r.job.worker.state,记录:r.job.worker.events?.slice(-5)},null,2)));
}
async function refresh(){try{state=await api('/api/status');render();}catch(e){notice(e.message==='UNAUTHORIZED'?'请用启动器打开带访问凭据的本机页面。':`连接失败：${e.message}。后台恢复后页面会自动重连。`);}}
$('filter').onchange=render;$('refresh').onclick=async()=>{try{await api('/api/poll',{});await refresh();}catch(e){notice(e.message);}};
$('task-json').value=JSON.stringify({task_id:'pi-smoke',revision:1,run_id:'run-'+new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14),title:'Pi 自动实验闭环',objective:'让 Pi 执行内置 CPU 校验，收集指标并返回 ZIP。',code:{repository:'aiconnector-builtin',revision:'builtin-smoke-v1'},environment:{target:'local-smoke'},invocation:{entry:'smoke',arguments:[]},acceptance:['sum=50005000，收到真实执行输出、结果 ZIP 和回执；不涉及 NPU。'],artifacts:[]},null,2);
$('task-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const task=JSON.parse($('task-json').value),file=$('zip').files[0];let zipBase64;if(file){if(file.size>=5242880)throw new Error('ZIP 必须小于 5 MiB');const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=16384)raw+=String.fromCharCode(...bytes.subarray(i,i+16384));zipBase64=btoa(raw);}const r=await api('/api/tasks',{task,...(zipBase64?{zipBase64}:{})});selected=r.key;$('filter').value='all';await refresh();}catch(e){notice(e.message);}finally{button.disabled=false;}};
$('settings-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const model=$('model-id').value?{api:$('model-api').value,baseUrl:$('model-base').value,id:$('model-id').value}:null;await api('/api/settings',{githubToken:$('github-token').value,apiKey:$('api-key').value,model});$('github-token').value='';$('api-key').value='';await refresh();}catch(e){notice(e.message);}finally{button.disabled=false;}};
function loadAgentForm(r,m){const a=r.agent,c=a.compaction,w=a.web,s=a.simpleHtmlWatch;
  const values={'global-prompt':a.globalPrompt,'context-files':a.contextFiles.join('\n'),'run-timeout':r.timeoutSeconds,'max-turns':r.maxTurns,'watch-base':s.baseUrl,'watch-poll':s.pollSeconds,'profiles-json':JSON.stringify(r.profiles,null,2),'web-transport':w.transport,'web-proxy':w.proxy,'web-timeout':w.timeoutSeconds,'web-hosts':w.allowedHosts.join('\n'),'web-search':w.searchUrl,'context-window':m?.contextWindow||32768,'max-tokens':m?.maxTokens||4096,'compact-reserve':c.reserveTokens,'compact-recent':c.keepRecentTokens};
  for(const [id,value]of Object.entries(values))$(id).value=value;
  for(const [id,value]of Object.entries({'runner-enabled':r.enabled,'watch-enabled':s.enabled,'web-enabled':w.enabled,'compact-enabled':c.enabled}))$(id).checked=value;
}
const lines=id=>$(id).value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),num=id=>Number($(id).value);
$('agent-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{
  const previous=state.service.runner.agent;
  await api('/api/agent-settings',{enabled:$('runner-enabled').checked,timeoutSeconds:num('run-timeout'),maxTurns:num('max-turns'),profiles:JSON.parse($('profiles-json').value),modelLimits:{contextWindow:num('context-window'),maxTokens:num('max-tokens')},agent:{...previous,globalPrompt:$('global-prompt').value,contextFiles:lines('context-files'),
    simpleHtmlWatch:{...previous.simpleHtmlWatch,enabled:$('watch-enabled').checked,baseUrl:$('watch-base').value,pollSeconds:num('watch-poll')},
    web:{...previous.web,enabled:$('web-enabled').checked,transport:$('web-transport').value,proxy:$('web-proxy').value,timeoutSeconds:num('web-timeout'),allowedHosts:lines('web-hosts'),searchUrl:$('web-search').value},
    compaction:{enabled:$('compact-enabled').checked,reserveTokens:num('compact-reserve'),keepRecentTokens:num('compact-recent')}}});
  $('agent-notice').textContent='已保存。新配置用于下一次领取的任务；模型地址和密钥保留。';agentLoaded=false;await refresh();
}catch(err){$('agent-notice').textContent=err.message;}finally{b.disabled=false;}};
$('watch-example').onclick=()=>{try{const profiles=JSON.parse($('profiles-json').value);if(profiles['npu-example'])throw new Error('npu-example 已存在，请编辑现有入口。');profiles['npu-example']={kind:'simplehtmlwatch',entry:'experiment',repository:'my-project',machineId:'替换为机器ID',revisionCommand:'git -C /home/your-user/project rev-parse HEAD',shell:'python3 /home/your-user/project/experiment.py --output "$SHW_RESULTS_DIR/metrics.json"',outputs:['metrics.json']};$('profiles-json').value=JSON.stringify(profiles,null,2);}catch(e){$('agent-notice').textContent=e.message;}};
$('check-agent').onclick=async()=>{const b=$('check-agent');b.disabled=true;$('check-result').textContent='正在检查…';try{$('check-result').textContent=JSON.stringify(await api('/api/agent-check',{webUrl:$('check-url').value}),null,2);}catch(e){$('check-result').textContent=e.message;}finally{b.disabled=false;}};
void refresh();setInterval(refresh,3000);
