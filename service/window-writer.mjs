import fs from 'node:fs';

// One bounded local writer per process. A slow filesystem never applies
// backpressure to agent/control callbacks; gaps are explicit in later rows.
export class WindowWriter {
  constructor(file,{io=fs.promises,limit=16}={}){Object.assign(this,{file,io,limit,rows:[],dropped:0,bytes:null,draining:null});}
  append(row){
    const at=row.session?this.rows.findIndex(r=>r.session===row.session&&r.window===row.window):-1;
    if(at>=0)this.rows[at]=row;
    else{if(this.rows.length>=this.limit){this.rows.shift();this.dropped++;}this.rows.push(row);}
    if(!this.draining)this.draining=Promise.resolve().then(()=>this.drain());
  }
  async drain(){
    try{while(this.rows.length){
      const row=this.rows.shift();
      try{
        if(this.bytes===null){try{this.bytes=(await this.io.stat(this.file)).size;}catch(e){if(e.code!=='ENOENT')throw e;this.bytes=0;}}
        if(this.bytes>=2*1024*1024){await this.io.rm(this.file+'.1',{force:true});await this.io.rename(this.file,this.file+'.1');this.bytes=0;}
        const text=JSON.stringify({...row,[row.schema==='aiconnector.runtime-window.v1'?'dropped_windows':'dropped_events']:this.dropped})+'\n';
        await this.io.appendFile(this.file,text,{mode:0o600});this.bytes+=Buffer.byteLength(text);
      }catch{this.dropped++;this.bytes=null;}
    }}finally{this.draining=null;}
  }
  async close(){await this.draining;}
}
