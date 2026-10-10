import {need,sha} from './common.mjs';

// Stable definition identity, independent of JSON field order. No source bodies
// or machine addresses are exposed by readiness or the public workflow journal.
export function definitionSha(value){
  const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
  return sha(JSON.stringify(sorted(value)));
}
export function profileDefinitions(profiles){
  return Object.entries(profiles).map(([id,p])=>({id,revision:p.revision,entry:p.entry,repository:p.repository,mode:p.mode,definition_sha256:definitionSha(p)}));
}
export function profileWorkflowGranted(p,file){
  const m=p?.maintenance,f=m?.files?.[file];
  return p?.kind==='maintenance'&&m?.enabled===true&&f?.format==='server-registry'&&f.write===true&&JSON.stringify(f.pointers)===JSON.stringify(['/profiles'])&&
    m.apis?.reload?.route==='/api/reload-agent'&&m.apis.reload.method==='POST'&&m.apis.reload.readOnly===false&&
    m.apis?.readiness?.route==='/api/server-readiness'&&(m.apis.readiness.method||'GET')==='GET'&&m.apis.readiness.readOnly===true&&
    m.apis.reload.baseUrl===m.apis.readiness.baseUrl;
}
export const canConfigureProfiles=p=>Object.keys(p?.maintenance?.files||{}).some(id=>profileWorkflowGranted(p,id));

// JSON.parse silently accepts duplicate keys. Scan the bounded input first so
// ambiguous or prototype-sensitive data cannot reach the merge operation.
export function parseProfileInput(bytes){
  need(bytes.length>0&&bytes.length<=65536,'PROFILE_INPUT_TOO_LARGE');
  let s;try{s=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('INVALID_PROFILE_UTF8');}
  let i=0;const ws=()=>{while(/[\t\n\r ]/.test(s[i]||'\0'))i++;};
  const string=()=>{need(s[i]==='"','INVALID_PROFILE_JSON');const start=i++;while(i<s.length){if(s[i]==='\\'){i+=2;continue;}if(s[i++]==='"')return JSON.parse(s.slice(start,i));}throw new Error('INVALID_PROFILE_JSON');};
  const value=depth=>{
    need(depth<=64,'PROFILE_JSON_TOO_DEEP');ws();
    if(s[i]==='{'){
      i++;ws();const keys=new Set();if(s[i]==='}'){i++;return;}
      for(;;){const k=string();need(!keys.has(k),'DUPLICATE_PROFILE_KEY');keys.add(k);need(!['__proto__','constructor','prototype'].includes(k),'UNSAFE_PROFILE_KEY');ws();need(s[i++]===':','INVALID_PROFILE_JSON');value(depth+1);ws();const c=s[i++];if(c==='}')return;need(c===',','INVALID_PROFILE_JSON');ws();}
    }
    if(s[i]==='['){i++;ws();if(s[i]===']'){i++;return;}for(;;){value(depth+1);ws();const c=s[i++];if(c===']')return;need(c===',','INVALID_PROFILE_JSON');}}
    if(s[i]==='"'){string();return;}
    const m=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(s.slice(i));need(m,'INVALID_PROFILE_JSON');i+=m[0].length;
  };
  value(0);ws();need(i===s.length,'INVALID_PROFILE_JSON');
  const profiles=JSON.parse(s);need(profiles&&typeof profiles==='object'&&!Array.isArray(profiles)&&Object.keys(profiles).length>0&&Object.keys(profiles).length<=24,'INVALID_SERVER_PROFILES');
  return profiles;
}
