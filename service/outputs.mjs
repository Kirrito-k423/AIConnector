import fs from 'node:fs';
import path from 'node:path';
import {need,sha,cleanError} from './common.mjs';

// Only explicit exports from this run are visible. Never resolve model supplied paths.
export class Outputs {
  constructor(dir,names=[],secrets=[]){this.root=path.join(dir,'work');this.names=[...new Set(names)];this.secrets=secrets;}
  file(name){
    need(this.names.includes(name)&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(name),'OUTPUT_NOT_ALLOWED');
    const root=fs.lstatSync(this.root);need(root.isDirectory()&&!root.isSymbolicLink(),'UNSAFE_OUTPUT_FILE');
    const file=path.join(this.root,name),before=fs.lstatSync(file);
    need(before.isFile()&&!before.isSymbolicLink(),'UNSAFE_OUTPUT_FILE');
    need(before.size<4*1024*1024,'OUTPUT_TOO_LARGE');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{
      const stat=fs.fstatSync(fd);need(stat.isFile()&&stat.ino===before.ino&&stat.dev===before.dev&&stat.size<4*1024*1024,'UNSAFE_OUTPUT_FILE');
      const bytes=Buffer.alloc(stat.size+1),size=fs.readSync(fd,bytes,0,bytes.length,0);
      need(size===stat.size&&fs.fstatSync(fd).size===stat.size,'OUTPUT_CHANGED');
      const data=bytes.subarray(0,size);
      need(!this.secrets.some(s=>data.includes(Buffer.from(s))),'SECRET_IN_OUTPUT');
      return {bytes:data,info:{name,bytes:size,sha256:sha(data)}};
    }finally{fs.closeSync(fd);}
  }
  list(offset=0,limit=16){
    need(Number.isInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>=1&&limit<=16,'INVALID_OUTPUT_PAGE');
    return {files:this.names.slice(offset,offset+limit).map(name=>{try{return {...this.file(name).info,available:true};}catch(e){return {name,available:false,error:cleanError(e)};}}),
      total:this.names.length,next_offset:offset+limit<this.names.length?offset+limit:null};
  }
  read(name,offset=0,length=8192,expectedSha){
    need(Number.isInteger(offset)&&offset>=0&&Number.isInteger(length)&&length>0&&length<=8192,'INVALID_READ_RANGE');
    const {bytes,info}=this.file(name);if(expectedSha!==undefined)need(expectedSha===info.sha256,'OUTPUT_HASH_MISMATCH');
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('OUTPUT_NOT_UTF8');}
    let content=text.slice(offset,offset+length);
    while(JSON.stringify(content).length>12000)content=content.slice(0,Math.floor(content.length/2));
    const end=offset+content.length,truncated=end<text.length;
    return {...info,offset,offset_unit:'utf16-code-units',content,truncated,next_offset:truncated?end:null};
  }
  complete(){let total=0;return this.names.map(name=>{const {info}=this.file(name);total+=info.bytes;need(total<4*1024*1024,'OUTPUT_TOO_LARGE');return info;});}
}
