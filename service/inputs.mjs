import fs from 'node:fs';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {need,sha,save,read,atomic,now} from './common.mjs';

export class Inputs {
  constructor(dir,artifacts=[]) {
    this.dir=dir;this.artifacts=artifacts;this.file=path.join(dir,'input-state.json');this.state=read(this.file,{files:[],archives:[]});
    if(this.state.complete)return;
    const files=[],archives=[];let count=0,total=0;
    for(const a of artifacts) {
      need(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}\.zip$/.test(a.name),'INVALID_INPUT_NAME');
      const bytes=fs.readFileSync(path.join(dir,'inputs',a.name));need(bytes.length===a.bytes&&sha(bytes)===a.sha256,'INPUT_HASH_MISMATCH');
      const names=new Set();
      // Validate central directory modes before decompressing; never materialize links.
      let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
      need(end>=0,'INVALID_INPUT_ZIP');let offset=bytes.readUInt32LE(end+16);
      for(let i=0;i<bytes.readUInt16LE(end+10);i++){
        need(offset+46<=bytes.length&&bytes.readUInt32LE(offset)===0x02014b50,'INVALID_INPUT_ZIP');
        need(((bytes.readUInt32LE(offset+38)>>>16)&0xf000)!==0xa000,'INPUT_LINK_FORBIDDEN');
        offset+=46+bytes.readUInt16LE(offset+28)+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32);
      }
      const decoded=unzipSync(bytes,{filter:f=>{
        const parts=f.name.split('/');need(!f.name.includes('\\')&&!f.name.includes(':')&&!f.name.startsWith('/')&&f.name.length<=256&&
          parts.every((p,i)=>p!=='.'&&p!=='..'&&!/[. ]$/.test(p)&&(!(!p&&i<parts.length-1))&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)),'UNSAFE_INPUT_PATH');
        const key=f.name.toLowerCase();need(!names.has(key),'DUPLICATE_INPUT_FILE');names.add(key);
        total+=f.originalSize;need(++count<=512&&total<=16*1024*1024,'INPUT_EXPANSION_TOO_LARGE');return !f.name.endsWith('/');
      }});
      for(const [name,data] of Object.entries(decoded)){
        const id=sha(a.sha256+'/'+name).slice(0,32),destination=path.join(dir,'input-files',id);
        atomic(destination,Buffer.from(data));files.push({id,name,bytes:data.length,sha256:sha(data),archive_sha256:a.sha256,staged:true,exposed_to_model:false,read_by_agent:false,uploaded_to_server:false});
      }
      archives.push({sha256:a.sha256,bytes:a.bytes,downloaded:true,staged:true});
    }
    this.state={complete:true,files,archives};this.persist();
  }
  persist(){save(this.file,this.state);}
  verifiedBytes(id,expected,maxBytes=65536){
    need(/^[a-f0-9]{32}$/.test(id),'INVALID_INPUT_ID');
    const item=this.state.files.find(f=>f.id===id);need(item&&item.staged,'INPUT_NOT_FOUND');
    need(item.id===sha(item.archive_sha256+'/'+item.name).slice(0,32)&&this.state.archives.some(a=>a.sha256===item.archive_sha256&&a.staged)&&this.artifacts.some(a=>a.sha256===item.archive_sha256),'INPUT_BINDING_MISMATCH');
    need(item.sha256===expected,'INPUT_HASH_MISMATCH');
    const file=path.join(fs.realpathSync(this.dir),'input-files',id),stat=fs.lstatSync(file);
    const norm=p=>process.platform==='win32'?p.toLowerCase():p;
    need(stat.isFile()&&!stat.isSymbolicLink()&&norm(fs.realpathSync(file))===norm(file),'INPUT_LINK_FORBIDDEN');
    need(stat.size===item.bytes&&stat.size<=maxBytes,'PROFILE_INPUT_TOO_LARGE');
    const bytes=fs.readFileSync(file);need(bytes.length===item.bytes&&sha(bytes)===expected,'INPUT_HASH_MISMATCH');
    item.read_by_agent=true;item.read_at=now();this.persist();return bytes;
  }
  list(offset=0,limit=32){
    need(Number.isInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>=1&&limit<=32,'INVALID_INPUT_PAGE');
    const files=this.state.files.slice(offset,offset+limit);for(const f of files)f.exposed_to_model=true;this.persist();
    return {archives:this.state.archives,files,total:this.state.files.length,next_offset:offset+limit<this.state.files.length?offset+limit:null};
  }
  read(id,offset=0,length=8192){
    const item=this.state.files.find(f=>f.id===id);need(item,'INPUT_NOT_FOUND');need(Number.isInteger(offset)&&offset>=0&&Number.isInteger(length)&&length>0&&length<=16000,'INVALID_READ_RANGE');
    const bytes=fs.readFileSync(path.join(this.dir,'input-files',id));need(sha(bytes)===item.sha256,'INPUT_HASH_MISMATCH');
    item.read_by_agent=true;item.read_at=now();this.persist();
    return {...item,offset,content:bytes.subarray(offset,offset+length).toString('utf8'),truncated:offset+length<bytes.length};
  }
}
