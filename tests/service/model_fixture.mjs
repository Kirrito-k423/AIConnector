import http from 'node:http';
export async function modelFixture({delay=0,fail=false,repeat=false,handler}={}) {
  let requests=0;const calls=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const b of req)body+=b;
    const data=JSON.parse(body);requests++;calls.push(data);
    if(fail){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture API rejected',type:'authentication_error'}}));return;}
    if(delay)await new Promise(r=>setTimeout(r,delay));
    const results=data.messages.filter(m=>m.role==='tool');
    const chosen=handler?await handler(data,requests):{};
    const tool=handler?chosen.tool:results.length===0||repeat&&results.length===1?'run_experiment':results.length===(repeat?2:1)?'submit_summary':null;
    const args=chosen.args??(tool==='submit_summary'?{summary:'真实 CPU 校验完成：sum=50005000。模型回复来自测试 API，不代表真实模型推理或 NPU 实验。',metrics:{sum:50005000,fixture_model:true,npu:false}}:{});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const base={id:'chatcmpl-fixture',object:'chat.completion.chunk',created:1,model:data.model,...(chosen.usage?{usage:chosen.usage}:{})};
    const send=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    send({role:'assistant'});
    if(tool&&chosen.content)send({content:chosen.content});
    if(tool){send({tool_calls:[{index:0,id:`call-${results.length}`,type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]});send({},'tool_calls');}
    else {send({content:chosen.content||'实验完成，结果已经提交。'});send({},'stop');}
    if(chosen.usage)res.write(`data: ${JSON.stringify({...base,choices:[],usage:chosen.usage})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}/v1`,calls,get requests(){return requests;},close:()=>new Promise(r=>server.close(r))};
}
