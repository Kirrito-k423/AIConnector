import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {need,safeEnv} from './common.mjs';

function webProxyEnv(key) {return process.env.AIC_WEB_ENV_CAPTURED==='1'?(process.env['AIC_WEB_'+key]||''):(process.env[key]||'');}

// Deliberately bypass ambient proxy variables for local service APIs.
export function localRequest(url,{method='GET',headers={},body,signal,maxBytes=1048576,timeoutSeconds=15}={}) {
  const u=new URL(url);need(u.protocol==='http:'&&u.hostname==='127.0.0.1','LOCAL_URL_REQUIRED');
  signal=AbortSignal.any([AbortSignal.timeout(timeoutSeconds*1000),...(signal?[signal]:[])]);
  return new Promise((resolve,reject)=>{
    const req=http.request(u,{method,headers,signal},res=>{
      let size=0;const chunks=[];
      res.on('data',b=>{size+=b.length;if(size>maxBytes)res.destroy(new Error('HTTP_RESPONSE_TOO_LARGE'));else chunks.push(b);});
      res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.setTimeout(timeoutSeconds*1000,()=>req.destroy(new Error('HTTP_TIMEOUT')));req.on('error',reject);req.end(body);
  });
}

export async function curlRequest(url,{proxy='system',signal,maxBytes=262144,timeoutSeconds=30}={}) {
  // -q disables user curlrc; never invoke a shell, follow redirects, or disable TLS checks.
  const executable=process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','curl.exe'):'curl';
  const args=['-q','--silent','--show-error','--suppress-connect-headers','--include','--max-time',String(timeoutSeconds),'--connect-timeout',String(Math.min(timeoutSeconds,15)),
    '--max-filesize',String(maxBytes),'--proto','=http,https','--user-agent','AIConnector/0.5'];
  if(proxy==='direct')args.push('--noproxy','*');else if(proxy!=='system')args.push('--proxy',proxy,'--noproxy','');
  args.push('--url',url);
  const env=safeEnv();if(proxy==='system')for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])if(webProxyEnv(key))env[key]=webProxyEnv(key);
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal});
    const chunks=[];let size=0,error;
    child.stdout.on('data',b=>{size+=b.length;if(size>maxBytes+65536){error=new Error('HTTP_RESPONSE_TOO_LARGE');child.kill();}else chunks.push(b);});
    child.stderr.resume();child.on('error',()=>{error??=new Error('CURL_UNAVAILABLE');});
    child.on('close',code=>{
      if(error)return reject(error);if(code!==0)return reject(new Error(code===28?'HTTP_TIMEOUT':code===63?'HTTP_RESPONSE_TOO_LARGE':'CURL_REQUEST_FAILED'));
      let bytes=Buffer.concat(chunks),status,headers;
      do {
        const end=bytes.indexOf('\r\n\r\n');if(end<0)return reject(new Error('INVALID_HTTP_RESPONSE'));
        const lines=bytes.subarray(0,end).toString('utf8').split('\r\n');status=Number(lines.shift().split(' ')[1]);headers={};
        for(const line of lines){const colon=line.indexOf(':');if(colon>0)headers[line.slice(0,colon).toLowerCase()]=line.slice(colon+1).trim();}
        bytes=bytes.subarray(end+4);
      }while(status>=100&&status<200);
      if(bytes.length>maxBytes)return reject(new Error('HTTP_RESPONSE_TOO_LARGE'));
      resolve({status,headers,body:bytes});
    });
  });
}

export async function webRequest(url,options={}) {
  if(options.transport==='curl')return curlRequest(url,options);
  // Native fetch uses the explicitly supplied dispatcher instead of the model's proxy setting.
  const {Agent,ProxyAgent,EnvHttpProxyAgent,fetch}=await import('undici');
  const dispatcher=options.proxy==='direct'?new Agent():options.proxy&&options.proxy!=='system'?new ProxyAgent(options.proxy):new EnvHttpProxyAgent({httpProxy:webProxyEnv('http_proxy')||webProxyEnv('HTTP_PROXY'),httpsProxy:webProxyEnv('https_proxy')||webProxyEnv('HTTPS_PROXY'),noProxy:webProxyEnv('no_proxy')||webProxyEnv('NO_PROXY')});
  const signals=[AbortSignal.timeout((options.timeoutSeconds??30)*1000)];if(options.signal)signals.push(options.signal);
  try {
    const r=await fetch(url,{redirect:'manual',dispatcher,signal:AbortSignal.any(signals),headers:{'User-Agent':'AIConnector/0.5'}});
    const chunks=[];let size=0;for await(const b of r.body){size+=b.length;need(size<=(options.maxBytes??262144),'HTTP_RESPONSE_TOO_LARGE');chunks.push(b);}
    return {status:r.status,headers:Object.fromEntries(r.headers),body:Buffer.concat(chunks)};
  }finally{await dispatcher.close();}
}
