// Operational facts come from the runner; model prose and estimates are separate claims.
const reserved=/^(?:(?:agent|pi|session|runtime|receipt|runner)(?:[._-]|$)|duration_ms$|turns$|continuations$|stop_reason$|tool_steps$|compactions$|usage$|started_at$|ended_at$)/i;
export function authoritativeReport({report,agent,acceptance,failure,profile}) {
  const metrics={},discarded=[];
  for(const [key,value]of Object.entries(report?.metrics||{})){
    if(reserved.test(key))discarded.push(key);else metrics[key]=value;
  }
  if(profile.kind==='builtin-smoke')metrics.npu=false;
  if(failure)metrics.runner_error=failure;
  const passed=(acceptance?.checks||[]).filter(c=>c.ok).length,total=acceptance?.checks?.length||0;
  const summary=[failure?'任务未完成：'+failure+'。':'本地独立检查通过。',
    '检查 '+passed+'/'+total+'；Pi 总运行 '+agent.duration_ms+' ms、'+agent.turns+' 轮、继续修复 '+agent.continuations+' 次；停止原因 '+agent.stop_reason+'。',
    profile.kind==='builtin-smoke'?'本任务仅配置 CPU 自检入口，不包含 SSH/NPU 或服务器入口维护。':'验收范围以所配置的独立检查和原始产物为准。',
    '发送端回执请查看通道时间线，执行端不代为确认。'].join('\n');
  return {summary,metrics,metrics_source:'model_report; builtin-smoke npu and runner_error are runner-controlled',
    model_report:{verified:false,summary:(report?.summary||'').slice(0,1200),discarded_runtime_fields:discarded.slice(0,32)}};
}
