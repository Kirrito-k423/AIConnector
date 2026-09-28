import http from 'node:http';
import {gzipSync} from 'node:zlib';

export function tarBundle(files,kind='0') {
  const chunks=[];
  for(const [name,content]of Object.entries(files)){
    const b=Buffer.from(content),h=Buffer.alloc(512);
    h.write(name,0,100);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);
    h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(kind,156);h.write('ustar\0',257);h.write('00',263);
    h.write([...h].reduce((n,v)=>n+v,0).toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(h,b,Buffer.alloc((512-b.length%512)%512));
  }
  return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}

export async function watchFixture({losePost=false,loseReserve=false,revision='fixture-rev',status='succeeded',exitCode=0,archivePending=false}={}) {
  let posts=0,reads=0,token='watch-one',job;const requests=[];
  const reservations={};
  const archive=tarBundle({'stdout.log':'fixture server result\n','stderr.log':'','results/aiconnector-revision.txt':revision+'\n','results/metrics.json':'{"fixture":true,"sum":7}','results/not-exported.txt':'PRIVATE_OTHER_FILE'});
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const b of req)body+=b;requests.push({url:req.url,body,headers:req.headers});
    const u=new URL(req.url,'http://127.0.0.1');
    const reply=(value,code=200)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(u.pathname==='/'){res.end(`<meta name="watch-token" content="${token}">`);return;}
    if(req.headers['x-watch-token']!==token)return reply({error:'token'},403);
    if(u.pathname==='/api/tasks/reservations'){
      if(req.method==='GET')return reply({schema:'simplehtmlwatch.reservations.v1',reservations});
      const data=JSON.parse(body),old=reservations[data.id];if(old)return reply(old,old.releasedAt?410:200);
      if(Object.values(reservations).some(r=>r.machineId===data.machineId&&!r.releasedAt))return reply({error:'busy'},409);
      const r=reservations[data.id]={...data,resourceKey:'machine:'+data.machineId,createdAt:new Date().toISOString()};
      if(loseReserve){loseReserve=false;req.socket.destroy();return;}return reply(r,201);
    }
    if(u.pathname==='/api/tasks/reservations/release'){
      const data=JSON.parse(body),r=reservations[data.id];if(!r)return reply({},404);
      if(job?.reservationId===data.id&&['running','unknown'].includes(job.status))return reply({error:'live task'},409);
      r.releasedAt=new Date().toISOString();return reply(r);
    }
    if(u.pathname==='/api/status')return reply({updatedAt:new Date().toISOString(),machines:[{id:'fixture-machine',status:'online'}]});
    if(u.pathname==='/api/tasks/ready')return reply([{id:'fixture-machine',name:'CPU fixture',updatedAt:new Date().toISOString()}]);
    if(u.pathname==='/api/tasks'&&req.method==='POST') {
      posts++;const data=JSON.parse(body);job={...data,status,exitCode,selectedMachineId:'fixture-machine',createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),archiveReady:!archivePending};
      if(losePost){req.socket.destroy();return;}return reply(job,202);
    }
    if(u.pathname==='/api/tasks'){reads++;if(archivePending&&reads>=3&&job)job.archiveReady=true;return reply(job||{error:'missing'},job?200:404);}
    if(u.pathname==='/api/tasks/collect')return reply({error:'结果包正在回收'},502);
    if(u.pathname==='/api/tasks/logs')return reply({stdout:'fixture logs',stderr:''});
    if(u.pathname==='/api/tasks/archive'){res.writeHead(200,{'Content-Type':'application/gzip'});res.end(archive);return;}
    reply({},404);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}`,requests,get posts(){return posts;},get reads(){return reads;},rotate(){token='watch-two';},tamper(patch){Object.assign(job,patch);},close:()=>new Promise(r=>server.close(r))};
}
