import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const now = () => new Date().toISOString();
export const sha = data => crypto.createHash('sha256').update(data).digest('hex');
export const id = () => crypto.randomBytes(24).toString('hex');
export function need(ok, code) { if (!ok) throw new Error(code); }
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const tmp = `${file}.${id()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
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
    child.stdout.on('data',b=>{out=(out+b.toString('utf8')).slice(-cap);});
    child.stderr.on('data',b=>{err=(err+b.toString('utf8')).slice(-cap);});
    child.on('error',e=>{settled=true;reject(new Error(e.code||'SPAWN_FAILED'));});
    child.on('close',(code,signal)=>{if(!settled) resolve({code,signal,out,err});});
    child.stdin.on('error',()=>{});
    child.stdin.end(options.input??'');
  });
}
export function cleanError(e) {
  return /^[A-Z][A-Z0-9_:-]{0,120}$/.test(e.message||'') ? e.message : 'SERVICE_ERROR';
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
  c.proxy=c.proxy||'system'; c.tickSeconds=c.connector.poll_seconds;
  need(c.tickSeconds>=1 && c.tickSeconds<=3600,'INVALID_POLL_INTERVAL');
  c.runner??={enabled:false,profiles:{}}; c.runner.profiles??={};
  c.runner.timeoutSeconds??=600; c.runner.maxTurns??=8;
  need(Number.isInteger(c.runner.timeoutSeconds)&&c.runner.timeoutSeconds>=5&&c.runner.timeoutSeconds<=86400,'INVALID_RUN_TIMEOUT');
  need(Number.isInteger(c.runner.maxTurns)&&c.runner.maxTurns>=1&&c.runner.maxTurns<=100,'INVALID_TURN_LIMIT');
  if(c.runner.model) {
    const m=c.runner.model, u=new URL(m.baseUrl);
    need(['openai-completions','openai-responses','anthropic-messages'].includes(m.api),'INVALID_MODEL_API');
    need(u.protocol==='https:' || (u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)), 'INSECURE_MODEL_URL');
    need(!u.username&&!u.password&&!u.search&&!u.hash,'INVALID_MODEL_URL');
    need(typeof m.id==='string'&&m.id.length>0,'INVALID_MODEL_ID');
  }
  return c;
}
