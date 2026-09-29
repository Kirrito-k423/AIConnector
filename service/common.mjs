import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {agentConfig} from './agent-config.mjs';
import {validateRegistry} from './server-registry.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const now = () => new Date().toISOString();
export const sha = data => crypto.createHash('sha256').update(data).digest('hex');
export const id = () => crypto.randomBytes(24).toString('hex');
export function need(ok, code) { if (!ok) throw new Error(code); }
export function replaceAtomicFile(source,target,{platform=process.platform,rename=fs.renameSync,wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}) {
  for(let attempt=0;;attempt++){
    try{return rename(source,target);}
    catch(e){
      // Windows readers/security scanners can briefly deny replacement. Keep
      // the original visible and retry the same rename; never unlink it.
      if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=7)throw e;
      wait(Math.min(100,10*2**attempt));
    }
  }
}
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const tmp = `${file}.${id()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { replaceAtomicFile(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function save(file, data) {
  const body = JSON.stringify(data);
  atomic(file, JSON.stringify({schema:'aiconnector.service-store.v1', sha256:sha(body), data:body}));
}
export function read(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  need(fs.statSync(file).size <= 16*1024*1024, 'STORE_TOO_LARGE');
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  need(row.schema === 'aiconnector.service-store.v1' && sha(row.data) === row.sha256, 'STORE_CORRUPT');
  return JSON.parse(row.data);
}
export function json(file) { return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); }
export function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid,0); return true; } catch(e) { return e.code !== 'ESRCH'; }
}
// Locks are conservative: an ambiguous/live PID is never reclaimed.
export function lock(file) {
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  try { const fd=fs.openSync(file,'wx',0o600); fs.writeFileSync(fd, JSON.stringify({pid:process.pid})); fs.fsyncSync(fd); fs.closeSync(fd); }
  catch(e) {
    if(e.code!=='EEXIST') throw e;
    const old=json(file);
    need(!alive(old.pid),'ALREADY_RUNNING');
    // Serialize recovery. A crashed recovery requires inspection, never a guess.
    const recovery=file+'.recovery'; const fd=fs.openSync(recovery,'wx',0o600);
    try {
      const current=json(file); need(current.pid===old.pid && !alive(current.pid),'ALREADY_RUNNING');
      fs.unlinkSync(file);
      const owned=fs.openSync(file,'wx',0o600); fs.writeFileSync(owned,JSON.stringify({pid:process.pid})); fs.fsyncSync(owned); fs.closeSync(owned);
    } finally { fs.closeSync(fd); fs.unlinkSync(recovery); }
  }
  return () => { if(fs.existsSync(file) && json(file).pid===process.pid) fs.unlinkSync(file); };
}
export function run(command,args=[],options={}) {
  return new Promise((resolve,reject)=>{
    let out='',err='',settled=false;
    const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],...options});
    const cap=options.cap??1024*1024;
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',b=>{out=(out+b).slice(-cap);});
    child.stderr.on('data',b=>{err=(err+b).slice(-cap);});
    child.on('error',e=>{settled=true;reject(new Error(e.code||'SPAWN_FAILED'));});
    child.on('close',(code,signal)=>{if(!settled) resolve({code,signal,out,err});});
    child.stdin.on('error',()=>{});
    child.stdin.end(options.input??'');
  });
}
export function cleanError(e) {
  if(/^[A-Z][A-Z0-9_:-]{0,120}$/.test(e?.message||''))return e.message;
  // Inspect structured causes, never return raw messages, URLs, headers or bodies.
  const queue=[e],seen=new Set();
  while(queue.length&&seen.size<16){
    const cause=queue.shift();if(!cause||seen.has(cause))continue;seen.add(cause);
    const code=String(cause.code||'');
    if(code==='ECONNREFUSED')return 'CONNECTION_REFUSED';
    if(['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code)||cause.name==='TimeoutError')return 'HTTP_TIMEOUT';
    if(['ENOTFOUND','EAI_AGAIN'].includes(code))return 'DNS_ERROR';
    if(['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(code))return 'CONNECTION_RESET';
    if(/^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/.test(code))return 'TLS_ERROR';
    if(cause.cause)queue.push(cause.cause);if(Array.isArray(cause.errors))queue.push(...cause.errors.slice(0,8));
  }
  return e?.name==='AbortError'?'REQUEST_ABORTED':'SERVICE_ERROR';
}
export function safeDiagnostic(value={}) {
  const out={};
  for(const key of ['code','action','category'])if(/^[A-Za-z][A-Za-z0-9_:-]{0,120}$/.test(value[key]||''))out[key]=value[key];
  for(const key of ['line','http'])if(Number.isInteger(value[key])&&value[key]>=0&&value[key]<=1000000)out[key]=value[key];
  return out;
}
export function safeEnv(extra={}) {
  const env={};
  // Keep OS runtime discovery intact without inheriting API/cloud credentials.
  const keys=['PATH','Path','HOME','USERPROFILE','SystemRoot','SYSTEMROOT','TEMP','TMP','TMPDIR','COMSPEC','ComSpec','LOCALAPPDATA','APPDATA','PATHEXT','SSH_AUTH_SOCK','LANG',
    'windir','WINDIR','SystemDrive','ALLUSERSPROFILE','ProgramData','ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles','CommonProgramFiles(x86)','CommonProgramW6432',
    'COMPUTERNAME','USERNAME','USERDOMAIN','USERDOMAIN_ROAMINGPROFILE','HOMEDRIVE','HOMEPATH','OS','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','PROCESSOR_LEVEL','PROCESSOR_REVISION','NUMBER_OF_PROCESSORS','PUBLIC','SESSIONNAME'];
  for(const key of keys)if(process.env[key])env[key]=process.env[key];
  return {...env,...extra};
}
export function loadConfig(file) {
  file=path.resolve(file); const c=json(file), base=path.dirname(file);
  need(c.schema==='aiconnector.service.v1','INVALID_SERVICE_CONFIG');
  need(['mac-outer','windows-inner'].includes(c.node),'INVALID_NODE');
  need(Number.isInteger(c.port) && c.port>=1024 && c.port<=65535,'INVALID_PORT');
  c.file=file; c.dataDir=path.resolve(base,c.dataDir); c.connectorConfig=path.resolve(base,c.connectorConfig);
  c.connector=json(c.connectorConfig); c.stateDir=path.join(c.dataDir,'connector');
  c.powershell=c.powershell || (process.platform==='win32'?'powershell.exe':'pwsh');
  c.proxy=c.proxy||'system'; c.tickSeconds=c.pollSeconds??c.connector.poll_seconds;
  const loopback=['127.0.0.1','localhost','[::1]'].includes(new URL(c.connector.api_base||'http://127.0.0.1').hostname);
  need(Number.isInteger(c.tickSeconds)&&c.tickSeconds>=(loopback?1:10)&&c.tickSeconds<=3600,'INVALID_POLL_INTERVAL');
  c.runner??={enabled:false,profiles:{}}; c.runner.profiles??={};
  if(c.runner.serverRegistry){
    c.runner.serverRegistry=path.resolve(base,c.runner.serverRegistry);
    const registry=validateRegistry(json(c.runner.serverRegistry));
    for(const id of Object.keys(registry.profiles))need(!Object.hasOwn(c.runner.profiles,id),'SERVER_PROFILE_CONFLICT');
    c.runner.profiles={...c.runner.profiles,...registry.profiles};c.runner.serverRegistrySha=sha(JSON.stringify(registry));
  }
  c.runner.timeoutSeconds??=600; c.runner.maxTurns??=8;
  c.runner.maxConcurrentRuns??=1;
  need(Number.isInteger(c.runner.maxConcurrentRuns)&&c.runner.maxConcurrentRuns>=1&&c.runner.maxConcurrentRuns<=8,'INVALID_RUN_CONCURRENCY');
  need(Number.isInteger(c.runner.timeoutSeconds)&&c.runner.timeoutSeconds>=5&&c.runner.timeoutSeconds<=86400,'INVALID_RUN_TIMEOUT');
  need(Number.isInteger(c.runner.maxTurns)&&c.runner.maxTurns>=1&&c.runner.maxTurns<=100,'INVALID_TURN_LIMIT');
  if(c.runner.model) {
    const m=c.runner.model, u=new URL(m.baseUrl);
    need(['openai-completions','openai-responses','anthropic-messages'].includes(m.api),'INVALID_MODEL_API');
    need(u.protocol==='https:' || (u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)), 'INSECURE_MODEL_URL');
    need(!u.username&&!u.password&&!u.search&&!u.hash,'INVALID_MODEL_URL');
    need(typeof m.id==='string'&&m.id.length>0,'INVALID_MODEL_ID');
  }
  c.runner.agent=agentConfig(c.runner.agent,c.runner.model);
  return c;
}
