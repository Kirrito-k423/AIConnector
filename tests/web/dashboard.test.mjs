// Run with an installed Playwright (or AIC_PLAYWRIGHT_MODULE=/absolute/path/index.mjs).
// All API responses are synthetic; this suite never publishes or executes a Relay task.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const {chromium}=await import(process.env.AIC_PLAYWRIGHT_MODULE?pathToFileURL(process.env.AIC_PLAYWRIGHT_MODULE).href:'playwright');
const web=process.env.AIC_WEB_ROOT||fileURLToPath(new URL('../../service/web/',import.meta.url));
const day='2026-09-27T';
const at=time=>day+time+':00Z';
function row(key,time,phase='started'){
  const kinds=['task','accepted','started','result','receipt'];
  return {key,phase,task:{title:'实验 · '+key,objective:'核对服务器状态并回传可复核结果。\n'.repeat(8),acceptance:['指标正确；产物完整'],artifacts:[]},
    issue_url:'https://github.com/example/relay/issues/1',release_url:'https://github.com/example/relay/releases/tag/test',
    timeline:kinds.slice(0,kinds.indexOf(phase)+1).map((kind,i)=>({kind,published_at:i===kinds.indexOf(phase)?time:at('01:0'+i),sender:kind==='task'?'mac-outer':'windows-inner',author:'fixture',url:'https://github.com/example/relay/issues/1#issuecomment-'+i})),
    ...(['result','receipt'].includes(phase)?{result:{summary:'已完成测试，等待核对产物。',outcome:'succeeded',metrics:{correct:true},artifacts:[{name:'result.zip',bytes:2048,url:'https://github.com/example/relay/releases/download/test/result.zip'}],agent:{duration_ms:12000,turns:3,continuations:1,started_at:at('01:00'),ended_at:time},execution:{started_at:at('01:01'),ended_at:at('01:02')}}}:{})};
}
function fixture(){return {service:{node:'mac-outer',version:'0.6.0',repository:'example/relay',github_configured:true,model_configured:true,poll_seconds:60},channel:{last_poll:1790460000,runs:[row('z-older/1/run',at('09:00')),row('a-recent/1/run',at('12:00')),row('b-receipt/1/run',at('13:00'),'receipt'),{...row('c-error/1/run',at('11:00')),error:'FIXTURE_ERROR'}]},jobs:[],submissions:[]};}
let browser;
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.AIC_BROWSER_EXECUTABLE?{executablePath:process.env.AIC_BROWSER_EXECUTABLE}:{})});});
after(async()=>{await browser?.close();});
async function dashboard(t,data=fixture(),viewport={width:1440,height:900},routes={}){
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'");
    const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
    if(files[req.url]){const [file,mime]=files[req.url];res.setHeader('Content-Type',mime);res.end(fs.readFileSync(path.join(web,file)));return;}
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({method:req.method,url:req.url,body:body?JSON.parse(body):undefined});res.setHeader('Content-Type','application/json');
    if(req.method==='GET'&&req.url==='/api/status'){res.end(JSON.stringify(data));return;}
    if(routes[req.url]){res.end(JSON.stringify(routes[req.url](body?JSON.parse(body):undefined)));return;}
    if(req.method==='POST'&&req.url==='/api/poll'){res.end('{}');return;}
    res.writeHead(404);res.end('{"error":"NO_MUTATIONS_IN_UI_TEST"}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  t.after(async()=>{await context.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.method==='GET'||r.url==='/api/poll'||Object.hasOwn(routes,r.url)));});
  await page.goto('http://127.0.0.1:'+server.address().port+'/#token=synthetic');
  await page.waitForFunction(()=>document.querySelector('#node').textContent.includes('发送端')||document.querySelector('#node').textContent.includes('执行端'));
  return {page,data,requests,poll:()=>page.evaluate(()=>refresh())};
}
const keys=page=>page.locator('#runs .run').evaluateAll(nodes=>nodes.map(n=>n.dataset.key));

test('task diagnostics downloads JSON and milestones show delivery segments',async t=>{
  const key='b-receipt/1/run',url='/api/diagnostics?key='+encodeURIComponent(key);
  const expected={schema:'aiconnector.diagnostics.v1',key,events:[{kind:'upload_confirmed'}]};
  const data=fixture();data.channel.runs[2].result.agent.ended_at=at('01:02');
  const {page,requests}=await dashboard(t,data,{width:1440,height:900},{[url]:()=>expected});
  await page.locator('[data-filter="confirmed"]').click();
  assert.match(await page.locator('.milestones').textContent(),/执行结束至结果发布/);
  const downloading=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出本次交付诊断'}).click();
  const download=await downloading;
  assert.equal(download.suggestedFilename(),'aiconnector-diagnostics-b-receipt-1-run.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(await download.path(),'utf8')),expected);
  assert.ok(requests.some(r=>r.method==='GET'&&r.url===url));
});

test('diagnostic retry/expiry status refreshes without changing the completed task',async t=>{
  const data=fixture(),key='b-receipt/1/run';
  data.jobs=[{key,state:'confirmed',delivery_diagnostics:{state:'queued',attempts:1}}];
  const {page,poll}=await dashboard(t,data);
  await page.locator('[data-filter="confirmed"]').click();
  assert.match(await page.locator('.milestones').textContent(),/诊断回传：等待发送 · 尝试 1 次/);
  data.jobs[0].delivery_diagnostics={state:'expired',attempts:12,error:'DIAGNOSTICS_RETRY_EXHAUSTED'};
  await poll();
  assert.match(await page.locator('.milestones').textContent(),/已停止自动重试.*DIAGNOSTICS_RETRY_EXHAUSTED/);
  assert.equal(await page.locator('.detail-heading .pill').textContent(),'已回执');
  data.jobs[0].delivery_diagnostics={state:'published',attempts:2,artifact:{url:'https://github.com/example/relay/releases/download/test/diagnostics.zip'}};
  await poll();assert.equal(await page.getByRole('link',{name:'下载诊断 ZIP ↗'}).getAttribute('href'),data.jobs[0].delivery_diagnostics.artifact.url);
});

test('default active filter, recent event sorting, compact 20% sidebar and milestones above content',async t=>{
  const {page}=await dashboard(t);
  assert.equal(await page.locator('[data-filter="active"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(await keys(page),['a-recent/1/run','z-older/1/run']);
  assert.equal(await page.locator('[data-count="all"]').textContent(),'4');
  const boxes=await page.evaluate(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {workspace:rect('.workspace'),sidebar:rect('.queue'),milestones:rect('.milestones'),request:rect('[data-section="request"]'),overflow:document.documentElement.scrollHeight>innerHeight};});
  assert.ok(boxes.workspace.y<160);assert.ok(Math.abs(boxes.sidebar.width/boxes.workspace.width-.2)<.01);
  assert.ok(boxes.milestones.y<boxes.request.y);assert.equal(boxes.overflow,false);
  assert.equal(await page.locator('.timeline li').count(),5);
  assert.equal(await page.locator('.timeline li.pending').count(),2);
  await page.locator('[data-filter="error"]').click();assert.deepEqual(await keys(page),['c-error/1/run']);
  await page.locator('[data-filter="confirmed"]').click();
  assert.deepEqual(await keys(page),['b-receipt/1/run']);
  assert.match(await page.locator('.milestones').textContent(),/Pi 总运行 12000 ms/);
  assert.equal(await page.locator('[data-section="result"] a').getAttribute('href'),'https://github.com/example/relay/releases/download/test/result.zip');
});

test('queued submissions, job events and numeric seconds sort by activity; polls and heartbeats do not',async t=>{
  const data=fixture();data.submissions=[{key:'local/1/run',created_at:Date.parse(at('14:00'))/1000,state:'pending',task:{title:'本地等待发布'}}];
  data.jobs=[{key:'z-older/1/run',state:'running',created_at:at('09:00'),worker:{heartbeat:at('23:00'),events:[{type:'web_fetched',at:at('15:00')}]}}];
  const {page,poll}=await dashboard(t,data);
  assert.deepEqual(await keys(page),['z-older/1/run','local/1/run','a-recent/1/run']);
  data.jobs[0].worker.events=[];data.channel.last_poll=Date.parse(at('23:59'))/1000;
  data.channel.runs[1].observed_at=at('23:58');data.channel.runs[1].updated_at=at('23:58');
  await poll();assert.deepEqual(await keys(page),['local/1/run','a-recent/1/run','z-older/1/run']);
  // A remote row must retain its original local queue time when first seen without a published event.
  data.channel.runs.push({key:'local/1/run',phase:'task',task:{title:'本地等待发布'},timeline:[]});
  await poll();assert.equal((await keys(page))[0],'local/1/run');
});

test('task selection keeps list position and focus; polling preserves detail scroll, expanded sections and selection',async t=>{
  const data=fixture();data.channel.runs=Array.from({length:30},(_,i)=>row('task-'+String(i).padStart(2,'0'),at('10:'+String(29-i).padStart(2,'0'))));
  const {page,poll}=await dashboard(t,data);
  const target=page.locator('.run[data-key="task-12"]');await target.scrollIntoViewIfNeeded();
  const listTop=await page.locator('#runs').evaluate(e=>e.scrollTop);
  await target.click();assert.equal(await page.evaluate(()=>window.scrollY),0);
  assert.equal(await page.locator('#runs').evaluate(e=>e.scrollTop),listTop);
  assert.match(await page.locator('.detail-heading').textContent(),/task-12/);
  await page.locator('[data-section="task-json"] summary').click();
  await page.locator('#detail').evaluate(e=>e.scrollTop=220);
  const top=await page.locator('#detail').evaluate(e=>e.scrollTop);
  await page.evaluate(()=>{window.savedTaskButton=document.querySelector('.run[data-key="task-12"]');window.savedDetailHeading=document.querySelector('.detail-heading');});
  await poll();
  assert.equal(await page.evaluate(()=>window.savedTaskButton===document.querySelector('.run[data-key="task-12"]')),true);
  assert.equal(await page.evaluate(()=>window.savedDetailHeading===document.querySelector('.detail-heading')),true);
  assert.equal(await page.locator('#detail').evaluate(e=>e.scrollTop),top);
  // Real incoming result changes content without replacing the task currently being read.
  data.channel.runs[12]=row('task-12',at('15:00'),'receipt');await poll();
  assert.match(await page.locator('.detail-heading').textContent(),/task-12/);
  assert.match(await page.locator('.selection-note').textContent(),/保留详情/);
  assert.equal(await page.locator('[data-section="task-json"]').evaluate(e=>e.open),true);
  assert.equal(await page.locator('#detail').evaluate(e=>e.scrollTop),top);
  assert.equal(await page.evaluate(()=>window.scrollY),0);
});

test('background updates reorder rows without stealing the selected task or keyboard focus',async t=>{
  const {page,data,poll}=await dashboard(t);
  await page.locator('.run[data-key="a-recent/1/run"]').focus();
  data.channel.runs[0].timeline.at(-1).published_at=at('16:00');await poll();
  assert.equal((await keys(page))[0],'z-older/1/run');
  assert.match(await page.locator('.detail-heading').textContent(),/a-recent/);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.key),'a-recent/1/run');
  data.channel.last_poll=Date.parse(at('20:00'))/1000;
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes(new Date(Date.parse('2026-09-27T20:00:00Z')).toLocaleString('zh-CN',{hour12:false})));
  assert.match(await page.locator('.detail-heading').textContent(),/a-recent/);
});

test('empty active view stays empty until explicitly switching; missing times and unsafe text are handled',async t=>{
  const data=fixture();data.channel.runs=[row('completed',at('13:00'),'receipt')];
  const {page,data:live,poll}=await dashboard(t,data);
  assert.deepEqual(await keys(page),[]);assert.match(await page.locator('#detail').textContent(),/暂无处理中/);
  await page.locator('#detail button').click();assert.deepEqual(await keys(page),['completed']);
  live.channel.runs.push({key:'no-time',phase:'started',task:{title:'<img src=x onerror=alert(1)>',objective:'<script>window.bad=true</script>'},timeline:[]});await poll();
  await page.locator('.run[data-key="no-time"]').click();
  assert.equal(await page.locator('#detail img, #detail script').count(),0);
  assert.match(await page.locator('.run[data-key="no-time"] time').textContent(),/时间未知/);
  assert.equal(await page.locator('.timeline .pending').count(),5);
});

test('settings remain reachable in a modal and edits survive polling; Escape restores focus',async t=>{
  const {page,poll}=await dashboard(t);
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#model-id').fill('unsaved-model');await poll();
  assert.equal(await page.locator('#model-id').inputValue(),'unsaved-model');
  assert.equal(await page.locator('#tools-dialog').evaluate(e=>e.open),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#tools-dialog').evaluate(e=>e.open),false);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.panel),'settings');
  await page.locator('[data-panel="submit"]').click();assert.equal(await page.locator('#task-json').isVisible(),true);
  await page.locator('#close-dialog').click();
});

test('mobile and Windows layouts retain access to lists, details and settings without horizontal overflow',async t=>{
  const data=fixture();data.service.node='windows-inner';
  const {page}=await dashboard(t,data,{width:390,height:844});
  assert.equal(await page.locator('[data-panel="submit"]').isVisible(),false);
  assert.ok(await page.locator('.run').first().isVisible());assert.ok(await page.locator('.detail-heading').isVisible());
  const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight}));
  assert.ok(size.scroll<=size.width);assert.ok(size.scrollHeight<=size.height);
  await page.locator('[data-panel="agent-settings"]').click();
  assert.equal(await page.locator('#global-prompt').isVisible(),true);
  assert.ok(await page.locator('#tools-dialog').evaluate(e=>e.scrollHeight>e.clientHeight));
});

test('previous runtime settings and historical results do not invent new capabilities or Pi durations',async t=>{
  const data=fixture();delete data.service.version;
  data.service.runner={enabled:false,timeoutSeconds:1800,maxTurns:32,profiles:{},agent:{globalPrompt:'本机网络说明',contextFiles:[],compaction:{enabled:true,reserveTokens:2048,keepRecentTokens:4096},simpleHtmlWatch:{enabled:false,baseUrl:'http://127.0.0.1:8765',pollSeconds:5},web:{enabled:false,transport:'curl',proxy:'system',timeoutSeconds:20,allowedHosts:[],searchUrl:''}}};
  data.channel.runs[2].result.agent={name:'pi'};data.channel.runs[2].result.metrics={duration_ms:64};
  const {page}=await dashboard(t,data);
  await page.locator('[data-filter="confirmed"]').click();
  assert.match(await page.locator('.duration').textContent(),/未记录 Pi 总耗时/);
  assert.doesNotMatch(await page.locator('.duration').textContent(),/64|0 轮/);
  assert.equal(await page.locator('[data-panel="capability-panel"]').isVisible(),false);
  await page.locator('[data-panel="agent-settings"]').click();
  assert.equal(await page.locator('#global-prompt').inputValue(),'本机网络说明');
  assert.equal(await page.locator('#skills-json').isVisible(),false);
  assert.equal(await page.locator('#budget-json').isVisible(),false);
});


test('Windows server onboarding uses actual machine IDs and retains selections during background polling',async t=>{
  const data=fixture();data.service.node='windows-inner';let saved;
  const {page,poll}=await dashboard(t,data,{width:1440,height:900},{
    '/api/server-catalog':()=>({config_sha256:'fixture-config-sha',machines:[{id:'actual-id',name:'服务器 · 测试',group:'内网'}],selected:[]}),
    '/api/server-setup':body=>{saved=body;return {saved:true,maintenance_enabled:body.allowMaintenance,next:'等待能力公告'};}
  });
  await page.locator('[data-panel="server-setup"]').click();
  assert.equal(await page.locator('#save-servers').isDisabled(),true);
  await page.locator('#discover-servers').click();await page.locator('#server-machines input').waitFor();
  assert.equal(await page.locator('#server-maintenance').isChecked(),false);
  await page.locator('#server-machines input').check();await page.locator('#server-maintenance').check();await poll();
  assert.equal(await page.locator('#server-machines input').isChecked(),true);
  await page.locator('#save-servers').click();await page.waitForFunction(()=>document.querySelector('#server-setup-result').textContent.includes('"saved": true'));
  assert.deepEqual(saved,{config_sha256:'fixture-config-sha',machineIds:['actual-id'],allowMaintenance:true});
  assert.equal(await page.locator('#save-servers').isDisabled(),true);
  assert.match(await page.locator('#server-setup-notice').textContent(),/先投递探测任务/);
  data.service.capability_error='TLS_ERROR';data.service.capability_diagnostic={action:'Advertise',line:123,http:0};await poll();
  assert.match(await page.locator('#notice').textContent(),/本地配置已生效.*后台将继续/);
  assert.equal(await page.locator('#notice').evaluate(e=>e.classList.contains('problem')),false);
  assert.equal(await page.locator('#dialog-notice').textContent(),'');
  assert.match(await page.locator('#server-setup-notice').textContent(),/已保存/);
});
