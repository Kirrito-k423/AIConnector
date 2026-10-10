import {WindowWriter} from './window-writer.mjs';

// Observe the pinned SDK's outer event stream, including .result() consumers
// used by compaction. No prompt, token text, URL or credential is retained.
// Provider hooks mark request readiness/response headers, not TCP send time.
export class ModelTiming {
  constructor(file,key,{clock=()=>performance.now(),wall=()=>new Date().toISOString(),phase=()=>({kind:'agent',turn:0}),writer=new WindowWriter(file,{limit:64}),limit=256}={}){
    Object.assign(this,{key,clock,wall,phase,writer,limit,rows:[],started:0,dropped:0,active:new Map()});
  }
  install(runtime){
    const original=runtime.streamSimple.bind(runtime);
    runtime.streamSimple=(model,context,options={})=>{
      const row={request:++this.started,...this.phase(),...(options.maxTokens===1?{kind:'cache-warm'}:{}),started_at:this.wall(),state:'active',request_ready_at:null,response_headers_at:null,first_output_at:null,ended_at:null,ready_ms:null,headers_ms:null,first_output_ms:null,duration_ms:null,output_stream_ms:null,stop_reason:null,sdk_usage:null};
      const start=this.clock();this.active.set(row.request,{row,start});
      if(this.rows.length>=this.limit){const index=this.rows.findIndex(r=>r.state!=='active');if(index>=0){this.rows.splice(index,1);this.dropped++;}}
      if(this.rows.length<this.limit)this.rows.push(row);else this.dropped++;
      const mark=(name)=>{if(row[name+'_at']===null){row[name+'_at']=this.wall();row[name==='request_ready'?'ready_ms':name==='response_headers'?'headers_ms':'first_output_ms']=this.clock()-start;this.emit(row,name);}};
      this.emit(row,'start');
      const wrapped={...options,onPayload:async(...args)=>{const value=await options.onPayload?.(...args);mark('request_ready');return value;},onResponse:async(...args)=>{mark('response_headers');return options.onResponse?.(...args);}};
      let stream;try{stream=original(model,context,wrapped);}catch(e){this.finish(row,start,'exception');throw e;}
      const push=stream.push.bind(stream);
      stream.push=e=>{
        if(row.state==='active'){
          if(row.first_output_at===null&&(e.type==='text_delta'||e.type==='thinking_delta'||e.type==='toolcall_delta')&&typeof e.delta==='string'&&e.delta.length)mark('first_output');
          if(e.type==='done'||e.type==='error'){
            const m=e.message||e.error,u=m?.usage;
            // SDK uses zeroes for missing provider usage; preserve that boundary.
            if(u&&u.totalTokens>0)row.sdk_usage=Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].map(k=>[k,u[k]??null]));
            this.finish(row,start,m?.stopReason||e.reason||e.type);
          }
        }
        return push(e);
      };
      return stream;
    };
  }
  emit(row,event){this.writer.append({schema:'aiconnector.model-request-event.v1',key:this.key,event,...row});}
  finish(row,start,reason){if(row.state!=='active')return;row.state='ended';row.ended_at=this.wall();row.duration_ms=this.clock()-start;row.output_stream_ms=row.first_output_ms===null?null:row.duration_ms-row.first_output_ms;row.stop_reason=reason;this.active.delete(row.request);this.emit(row,'end');}
  snapshot(){return {schema:'aiconnector.model-timing.v1',key:this.key,runner_stop_reason:this.stopReason||null,requests_started:this.started,dropped_requests:this.dropped,dropped_events:this.writer.dropped,local_log_pending_events:this.writer.rows?.length||0,local_log_draining:Boolean(this.writer.draining),scope:'SDK call through provider request-ready, response-header and first nonempty text/thinking/tool delta to completion. Aborted SDK calls can stop before request readiness. Not DNS, TCP or server compute profiling; SDK zero usage means unmeasured. ZIP requests come from memory; local log flushing is independent of result readiness.',requests:this.rows};}
  stop(reason){this.stopReason=reason;for(const {row,start}of this.active.values())this.finish(row,start,reason||'runner_stopped');}
  async close(reason){this.stop(reason);await this.writer.close();}
}
