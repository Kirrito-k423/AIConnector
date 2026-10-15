// Operational facts come from the runner; model prose and estimates are separate claims.
const reserved=/^(?:(?:agent|pi|session|runtime|receipt|runner)(?:[._-]|$)|duration_ms$|turns$|continuations$|stop_reason$|tool_steps$|compactions$|usage$|started_at$|ended_at$)/i;
export function authoritativeReport({report,agent,acceptance,failure,profile,engine}) {
  const metrics={},discarded=[];
  for(const [key,value]of Object.entries(report?.metrics||{})){
    if(reserved.test(key))discarded.push(key);else metrics[key]=value;
  }
  if(profile.kind==='builtin-smoke')metrics.npu=false;
  if(failure)metrics.runner_error=failure;
  if(agent.budget)Object.assign(metrics,{runner_turns:agent.turns,runner_turn_limit:agent.budget.limits.maxTurns,
    runner_actions:agent.tool_steps,runner_action_limit:agent.budget.limits.maxActions,runner_maintenance_actions:agent.budget.used.maintenanceActions,
    runner_total_tokens:agent.usage.totalTokens,runner_token_limit:agent.budget.limits.maxTotalTokens,
    runner_cache_read_tokens:agent.usage.cacheRead,runner_output_tokens:agent.usage.output,
    runner_usage_observed:agent.budget.sdk_usage_observed});
  const noModel=profile.executionMode==='direct'||engine==='profile-workflow';
  const passed=(acceptance?.checks||[]).filter(c=>c.ok).length,total=acceptance?.checks?.length||0;
  const summary=[failure?'任务未完成：'+failure+'。':'本地独立检查通过。',
    noModel?'检查 '+passed+'/'+total+'；'+(engine==='profile-workflow'?'入口定义合并':'固定入口')+'直接执行，模型调用 0 次；停止原因 '+agent.stop_reason+'。':'检查 '+passed+'/'+total+'；Pi 总运行 '+agent.duration_ms+' ms、'+agent.turns+' 轮、继续修复 '+agent.continuations+' 次；停止原因 '+agent.stop_reason+'。',
    profile.kind==='builtin-smoke'?'本任务仅配置 CPU 自检入口，不包含 SSH/NPU 或服务器入口维护。':['file-export','file-transfer'].includes(profile.kind)?'本次仅确认文件已加密封装；发送端仍须解密并逐文件核验，通道回执不能代替取件成功。':'验收范围以所配置的独立检查和原始产物为准。',
    '发送端回执请查看通道时间线，执行端不代为确认。'].join('\n');
  return {summary,metrics,metrics_source:noModel?'executor; independently configured checks and runner budget facts':'model_report; builtin-smoke npu and runner budget facts are runner-controlled',
    model_report:noModel?null:{verified:false,summary:(report?.summary||'').slice(0,1200),discarded_runtime_fields:discarded.slice(0,32)}};
}
