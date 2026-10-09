# 0.7.7：Windows 十秒时间账本与交付调度

本版首先补证据。没有把非 HTTP 时间等同于 JSON/磁盘，也不承诺 Windows 内网耗时降低某个百分比。

## 每 10 秒记录什么

常驻 PowerShell 启动独立 .NET 计时器；PowerShell 主线程正在执行长 cmdlet、HTTP、序列化或阻塞管道时，它也能写入 `runtime-windows.jsonl`。文件只记录阶段、操作 ID、运行 ID、数值与时间，不含参数、命令、URL、私有路径、模型输出或凭据。

每个窗口包含：

- `window_start/end`、`elapsed_ms`，通常为 10000；进程结束/动作完成时也保留当前部分窗口。
- `segments`：阶段、直接父阶段、operation_id、action、运行 key、独占 `wall_ms`。子阶段占用从父阶段扣除，所有条目之和应等于窗口长度，不能把嵌套 stage_finished 再相加。
- `cpu_ms`：这个 PowerShell 进程的 CPU 时间，**单独的指标，不是另一个可相加的墙钟阶段，也不包括 Pi/SSH/NPU 的 CPU**。跨采样边界按比例分摊，`cpu_sample_max_ms` 给出实际最大间隔；默认每秒采样，延迟会如实显示，不能当作精确的函数 CPU 分布。
- `source/session/pid/window`：区分进程重启，禁止把多个进程的墙钟窗口相加当任务耗时。

阶段包含 `canonical`、`json.parse`、`json.serialize`、`runs.project`、`snapshot.build`、`state.open`、`state.save`、`state.hash`、`state.write`、`projection.write`、`artifact.verify`、`relay.routes`、`poll.import`、`poll.audit`、`transition.prepare`、`outbox.send`、`http`、`reply.serialize/pipe`。例如 `canonical` 的父阶段 `state.save` 与 `runs.project` 能区分状态保存和运行投影。未细分处理保留 `control.other`，等待请求时为 `idle`；不会把空缺归给网络。

每次 action 完成保存当前部分窗口；之后同一窗口继续累积。导出按 session/window 去重，保留最新最完整记录。强制杀进程可能丢失尚未保存的最后部分窗口，不伪造它。

Pi Worker 也有独立 `worker-windows.jsonl`，分开记录 `worker.setup`、`model.wait`、`tool.<工具名>`、`agent.verify`、`result.package`。`model.wait` 是 SDK 请求/响应及相邻代理处理区间，不是提供方服务端推理时间；不能据此计算模型速度。Node 事件循环长时间阻塞时采样可能迟到，`cpu_sample_max_ms` 会暴露这种低分辨率，不声称已精确细分阻塞内部。

Node 服务进程另有 `service-windows.jsonl`，记录自己的 CPU 和采样延迟，墙钟阶段明确标为 `service.event_loop`，其中包含异步等待，尚未归因到具体异步回调。它可以检验 Supervisor 本身是否繁忙，不能把等待算成 CPU。

服务的排队动作每 10 秒写 `action_wait`，包含 `blocker_operation_id/action`；原始入队和 dispatch 保留准确等待区间。按运行导出会纳入实际 blocker，及该运行时间范围内整个控制进程的窗口，以看清“别的操作正在阻塞我”。这些窗口不是这个任务独占的 CPU 或执行时间。

诊断同时记录实际 PowerShell 版本及计时器是否启动。编译/日志故障不改变 Claim、重试或实验权限；如果计时器不可用，会记录 profiler_unavailable，不能声称观测已启用。

## 如何读取

Windows 看板的“导出诊断”、CLI diagnostics 和完成后的独立 `diagnostics--windows-inner--SHA256.zip` 均包含 `windows` 数组。不可变的主结果 ZIP 不被更改，诊断仍在结果发布后单独上传。

离线转为 CSV：

```powershell
python tools/report_windows.py delivery-diagnostics.zip --output windows-time.csv
```

CSV 每行一个进程的一段 10 秒窗口，列出阶段毫秒、CPU 毫秒、完整性、采样间隔和操作 ID。`unaccounted_ms` 应接近 0；允许小数四舍五入误差。旧版诊断没有 windows，导出 0 行，不能回填估算。

日志当前/上一文件各限约 2 MiB；侧车最多 1000 个窗口、2000 条关联事件，分别标记截断。长运行超出保留范围时必须认定证据不完整。

## 调度改变及保留的约束

1. outbox 恢复 `started/result/receipt` 优先，其它 accepted/task 之后；仍检查 parent、路由退避、冲突、全局限流及不可变事件。时间老化不再把整批旧 accepted 排到已执行任务的 started 前面。
2. ready Upload 回到新 Poll 前，Claim/Complete/Flush 保持高优先级。Audit、公告与诊断不会因长等待抢在新的控制操作之前；它们是后台尽力处理，不承诺繁忙时的等待上限。
3. nextPoll 从上一次 Poll 完成后算，定时器先推进 ready job/outbox 再考虑下一次 Poll，避免长 Poll 刚完成立刻再开始 Poll、抢占待发的 Flush。错误退避期间仍允许 Poll 核对不确定写入，未将 dirty 标志变成永久阻塞门。
4. resident 的历史审计移到独立低优先级 Audit，只在执行器空闲时每分钟尝试；单独 CLI Poll/Watch 的历史检查仍保留。已经开始的 Audit/HTTP 仍不可抢占，新任务可能等它结束。
5. 已有同一 parent 的不可变 accepted/receipt 在 outbox 时，Auto-Transitions 不重复准备；Claim 仍校验实际输入字节，接收端 receipt 仍独立验证结果。失败/未知动作仍不得重放 SSH，不自动释放未知资源锁。

## 本地和 Windows 验收

需要覆盖实际 resident transport 与 service 队列，不只直接调用 PS 的准入基准：

- PowerShell 主线程阻塞超过 10 秒，独立计时窗口仍落盘；独占阶段和等于窗口长度，CPU 不重复相加。
- 窗口跨阶段、跨边界、部分窗口去重、重启 session、延迟采样和脱敏。
- 6 项连续任务中，已有 started 的父事件已确认时不被整批 accepted 压住；父事件未确认时 result 仍不能发送。
- 连续 Poll 不重复验证已入队接收；原有附件损坏、冲突、限流、掉线和所有权恢复测试不退化。
- 真正的服务队列中，完成交付/Claim 优于后台任务；正在运行的请求不会被错误取消或重放。
- 全链路 `task → accepted → started → result → receipt`，真实 Pi CPU 自检、进程重启、掉线、重复并发 Worker，使用最终 Windows 包与 PowerShell 5.1。

真实内网下一轮先检查 runtime.windows_enabled、PowerShell 版本、窗口覆盖/截断、每个排队 blocker，再比较启动与结果发布。包通过不代表真实 A5/WAN 性能已通过。
