const $=id=>document.getElementById(id);
const hash=new URLSearchParams(location.hash.slice(1));
if(hash.has('token')){sessionStorage.setItem('aic-token',hash.get('token'));history.replaceState(null,'',location.pathname);}
let state,selected='',rows=[];
const labels={task:'已发布',accepted:'接收端已校验',started:'已领取',result:'结果已发布',receipt:'已回执',claiming:'登记领取',launching:'启动执行器',running:'Pi 处理中',delivering:'交付 ZIP 中',submitted:'等待回执',confirmed:'已回执',blocked:'需要处理',unknown:'执行状态未知',pending:'等待发布',queued:'已加入发送队列'};
const date=t=>t?new Date(typeof t==='number'?t*1000:t).toLocaleString('zh-CN',{hour12:false}):'尚未发生';
const el=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
function link(parent,text,url){try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return;const a=el('a',text);a.href=u.href;a.target='_blank';a.rel='noreferrer';parent.append(a);}catch{}}
async function api(url,data){const r=await fetch(url,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+sessionStorage.getItem('aic-token'),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});const value=await r.json();if(!r.ok)throw new Error(value.error);return value;}
function notice(s){$('notice').textContent=s;}
function render(){
  const s=state.service;$('node').textContent=s.node==='mac-outer'?'Mac · 发送端':'Windows · 执行端';$('repo').href='https://github.com/'+s.repository;
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
  if(!selected&&visible[0])selected=visible[0].key;
  for(const row of visible){const b=el('button',undefined,'run'+(row.key===selected?' selected':''));b.append(el('strong',row.task?.title||row.key),el('small',row.key),el('div',labels[phase(row)]||phase(row),'status'+(error(row)?' error':'')));b.onclick=()=>{selected=row.key;render();};$('runs').append(b);}
  const r=rows.find(r=>r.key===selected);if(!r)return;
  const detail=$('detail');detail.replaceChildren(el('h2',r.task?.title||r.key),el('div',r.key,'meta'),el('p',r.task?.objective||''));
  const links=el('div',undefined,'links');link(links,'任务 Issue ↗',r.issue_url);link(links,'本次 Release ↗',r.release_url);detail.append(links);
  const list=el('ol',undefined,'timeline');
  for(const e of r.timeline||[]){const li=el('li');li.append(el('strong',labels[e.kind]||e.kind),el('span',`${date(e.published_at)} · ${e.sender} · GitHub @${e.author||'未知'}`));link(li,'查看原始记录',e.url);list.append(li);}
  for(const [name,time]of [['实际开始执行',r.job?.worker?.execution_started_at||r.result?.execution?.started_at],['实际执行结束',r.job?.worker?.execution_ended_at||r.result?.execution?.ended_at]])if(time){const li=el('li');li.append(el('strong',name),el('span',date(time)));list.append(li);}
  if(!(r.timeline||[]).length)list.append(el('li','本地已排队，远端发布时间尚未确认。'));
  detail.append(list);
  if(error(r))detail.append(el('p',String(r.error||r.job?.error||'需要检查执行状态'),'error'));
  if(r.job?.state==='unknown'){const b=el('button','核对环境后，将本次登记为未完成');b.onclick=async()=>{if(!confirm('请先核对本机与远端实验进程已停止或已完成。将交付 blocked 结果并解除队列阻塞，原运行不会重跑。确定已核对？'))return;try{await api('/api/resolve-unknown',{key:r.key,remoteChecked:true});await refresh();}catch(e){notice(e.message);}};detail.append(b);}
  if(r.result){detail.append(el('h2','实验结果'),el('p',r.result.summary),el('pre',JSON.stringify({outcome:r.result.outcome,exit_code:r.result.exit_code,actual_revision:r.result.actual_revision,metrics:r.result.metrics},null,2)));for(const a of r.result.artifacts||[])link(detail,`下载 ${a.name} · ${a.bytes} 字节 ↗`,a.url);}
  else if(r.job?.worker)detail.append(el('pre',JSON.stringify({执行器:r.job.worker.state,记录:r.job.worker.events?.slice(-5)},null,2)));
}
async function refresh(){try{state=await api('/api/status');render();}catch(e){notice(e.message==='UNAUTHORIZED'?'请用启动器打开带访问凭据的本机页面。':`连接失败：${e.message}。后台恢复后页面会自动重连。`);}}
$('filter').onchange=render;$('refresh').onclick=async()=>{try{await api('/api/poll',{});await refresh();}catch(e){notice(e.message);}};
$('task-json').value=JSON.stringify({task_id:'pi-smoke',revision:1,run_id:'run-'+new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14),title:'Pi 自动实验闭环',objective:'让 Pi 执行内置 CPU 校验，收集指标并返回 ZIP。',code:{repository:'aiconnector-builtin',revision:'builtin-smoke-v1'},environment:{target:'local-smoke'},invocation:{entry:'smoke',arguments:[]},acceptance:['sum=50005000，收到真实执行输出、结果 ZIP 和回执；不涉及 NPU。'],artifacts:[]},null,2);
$('task-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const task=JSON.parse($('task-json').value),file=$('zip').files[0];let zipBase64;if(file){if(file.size>=5242880)throw new Error('ZIP 必须小于 5 MiB');const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=16384)raw+=String.fromCharCode(...bytes.subarray(i,i+16384));zipBase64=btoa(raw);}const r=await api('/api/tasks',{task,...(zipBase64?{zipBase64}:{})});selected=r.key;await refresh();}catch(e){notice(e.message);}finally{button.disabled=false;}};
$('settings-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const model=$('model-id').value?{api:$('model-api').value,baseUrl:$('model-base').value,id:$('model-id').value}:null;await api('/api/settings',{githubToken:$('github-token').value,apiKey:$('api-key').value,model});$('github-token').value='';$('api-key').value='';await refresh();}catch(e){notice(e.message);}finally{button.disabled=false;}};
void refresh();setInterval(refresh,3000);
