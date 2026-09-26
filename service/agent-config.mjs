import fs from 'node:fs';
import path from 'node:path';
import {need,sha,now} from './common.mjs';

const integer=(n,min,max,code)=>need(Number.isInteger(n)&&n>=min&&n<=max,code);
export function agentConfig(value={},model={}) {
  need(value&&typeof value==='object'&&!Array.isArray(value),'INVALID_AGENT_CONFIG');
  const window=model.contextWindow??32768, maxTokens=model.maxTokens??4096;
  integer(window,4096,2097152,'INVALID_CONTEXT_WINDOW');integer(maxTokens,256,window-1024,'INVALID_MAX_TOKENS');
  const a={...value,globalPrompt:value.globalPrompt??'',contextFiles:value.contextFiles??[],
    compaction:{enabled:true,reserveTokens:Math.max(maxTokens,Math.min(4096,Math.floor(window/4))),keepRecentTokens:Math.min(8192,Math.floor(window/4)),...value.compaction},
    simpleHtmlWatch:{enabled:false,baseUrl:'http://127.0.0.1:8765',pollSeconds:5,...value.simpleHtmlWatch},
    web:{enabled:false,transport:process.platform==='win32'?'curl':'node',proxy:'system',allowedHosts:[],searchUrl:'',timeoutSeconds:30,maxBytes:262144,...value.web}};
  need(typeof a.globalPrompt==='string'&&Buffer.byteLength(a.globalPrompt)<=32768,'GLOBAL_PROMPT_TOO_LARGE');
  need(Array.isArray(a.contextFiles)&&a.contextFiles.length<=8&&a.contextFiles.every(f=>typeof f==='string'&&f.length>0&&f.length<=1024),'INVALID_CONTEXT_FILES');
  const c=a.compaction,w=a.web,s=a.simpleHtmlWatch;
  need(typeof c.enabled==='boolean'&&typeof w.enabled==='boolean'&&typeof s.enabled==='boolean','INVALID_AGENT_SWITCH');
  integer(c.reserveTokens,256,window-1024,'INVALID_COMPACTION_RESERVE');integer(c.keepRecentTokens,256,window-1024,'INVALID_COMPACTION_RECENT');
  need(!c.enabled||(c.reserveTokens>=maxTokens&&c.keepRecentTokens+c.reserveTokens<window),'INVALID_COMPACTION_BUDGET');
  const local=new URL(s.baseUrl);
  need(local.protocol==='http:'&&local.hostname==='127.0.0.1'&&!local.username&&!local.password&&!local.search&&!local.hash&&local.pathname==='/','INVALID_WATCH_URL');
  s.baseUrl=local.origin;integer(s.pollSeconds,1,60,'INVALID_WATCH_POLL');
  need(['node','curl'].includes(w.transport),'INVALID_WEB_TRANSPORT');
  need(typeof w.proxy==='string','INVALID_WEB_PROXY');
  if(!['system','direct'].includes(w.proxy)){const p=new URL(w.proxy);need(['http:','https:'].includes(p.protocol)&&!p.username&&!p.password&&!p.search&&!p.hash&&p.pathname==='/','INVALID_WEB_PROXY');}
  need(Array.isArray(w.allowedHosts)&&w.allowedHosts.length<=64&&w.allowedHosts.every(h=>typeof h==='string'&&/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(h)),'INVALID_WEB_HOSTS');
  w.allowedHosts=w.allowedHosts.map(h=>h.toLowerCase());
  need(!w.enabled||w.allowedHosts.length>0,'WEB_HOSTS_REQUIRED');
  integer(w.timeoutSeconds,1,120,'INVALID_WEB_TIMEOUT');integer(w.maxBytes,1024,1048576,'INVALID_WEB_SIZE');
  need(typeof w.searchUrl==='string'&&w.searchUrl.length<=2048,'INVALID_SEARCH_URL');
  if(w.searchUrl){need(w.searchUrl.includes('{query}'),'SEARCH_QUERY_PLACEHOLDER_REQUIRED');const u=new URL(w.searchUrl.replaceAll('{query}','test'));checkWebURL(u,w);}
  return a;
}

export function checkWebURL(value,web) {
  const u=new URL(value);
  need(!u.username&&!u.password&&!u.hash&&['https:','http:'].includes(u.protocol),'INVALID_WEB_URL');
  // Exact host:port grants also cover local enterprise documentation when explicitly configured.
  need(web.allowedHosts.includes(u.host.toLowerCase()),'WEB_HOST_NOT_ALLOWED');
  return u;
}

export function snapshotAgent(config,baseDir) {
  let bytes=Buffer.byteLength(config.globalPrompt);
  const contexts=config.contextFiles.map(file=>{
    const resolved=path.resolve(baseDir,file);let stat;
    try{stat=fs.statSync(resolved);}catch{throw new Error('CONTEXT_FILE_UNREADABLE');}
    need(stat.isFile()&&stat.size<=65536,'CONTEXT_FILE_TOO_LARGE');
    const content=fs.readFileSync(resolved,'utf8');bytes+=Buffer.byteLength(content);need(bytes<=65536,'CONTEXT_TOO_LARGE');
    return {name:path.basename(file),content,sha256:sha(content)};
  });
  return {...config,contexts,contextDigest:sha(JSON.stringify([config.globalPrompt,contexts])),capturedAt:now()};
}
