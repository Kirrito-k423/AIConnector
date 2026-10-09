import fs from 'node:fs';
import {randomBytes} from 'node:crypto';

// Worker lane. CPU is sampled process-wide, separately from exclusive wall time.
export class WindowProfiler {
  constructor(file,key,{clock=()=>performance.now(),cpu=()=>{const v=process.cpuUsage();return (v.user+v.system)/1000;},origin=Date.now(),timer=true,source='worker',initialStage='worker.setup'}={}){
    Object.assign(this,{file,key,clock,cpu,origin,session:randomBytes(16).toString('hex'),source,stage:initialStage,bucket:0,parts:new Map(),cpuMs:0,sampleMax:0});
    this.anchor=clock();this.last=0;this.lastCpu=cpu();
    if(timer){this.timer=setInterval(()=>this.sample(),1000);this.timer.unref();}
  }
  sample(){
    try{
      const t=this.clock()-this.anchor,cpu=this.cpu(),length=t-this.last,delta=Math.max(0,cpu-this.lastCpu);
      while(t>this.last){
        const end=Math.min(t,(this.bucket+1)*10000),elapsed=end-this.last;
        this.parts.set(this.stage,(this.parts.get(this.stage)||0)+elapsed);
        this.cpuMs+=length>0?delta*elapsed/length:0;this.sampleMax=Math.max(this.sampleMax,length);this.last=end;
        if(end>=(this.bucket+1)*10000){this.emit(10000,false);this.bucket++;this.parts.clear();this.cpuMs=0;this.sampleMax=0;}
      }
      this.lastCpu=cpu;
    }catch{}
  }
  set(stage){this.sample();if(/^[a-zA-Z0-9_.-]{1,80}$/.test(stage))this.stage=stage;}
  emit(elapsed,partial){
    try{
      if(fs.existsSync(this.file)&&fs.statSync(this.file).size>=2*1024*1024){fs.rmSync(this.file+'.1',{force:true});fs.renameSync(this.file,this.file+'.1');}
      fs.appendFileSync(this.file,JSON.stringify({schema:'aiconnector.runtime-window.v1',source:this.source,session:this.session,pid:process.pid,window:this.bucket,window_start:new Date(this.origin+this.bucket*10000).toISOString(),window_end:new Date(this.origin+this.bucket*10000+elapsed).toISOString(),elapsed_ms:elapsed,cpu_ms:this.cpuMs,cpu_sample_max_ms:this.sampleMax,partial,segments:[...this.parts].map(([stage,wall_ms])=>({stage,wall_ms,operation_id:'',action:this.source==='service'?'Service':'Pi',key:this.key}))})+'\n',{mode:0o600});
    }catch{}
  }
  close(){clearInterval(this.timer);this.sample();const elapsed=this.last-this.bucket*10000;if(elapsed>0)this.emit(elapsed,true);}
}
