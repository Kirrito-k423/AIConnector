# Issue #13：receipt 后诊断回传被全局空闲条件饿死

0.7.8 要求 connector 不运行、不 dirty、队列为空，而且所有运行都不处于 waiting/running/delivering/submitted，才生成并上传诊断。多任务和后台公告重试会持续关闭放行条件。任务结果已经完成 receipt，诊断仍可能从未入队。它不是一次性窗口：旧代码会继续检查，Windows 本次重启后补传成功也证明已有数据能恢复；缺陷是没有进度保证且长期延迟可能造成保留日志被截断。

## 0.7.9 行为

- 单项任务观察到 receipt 后即可申请诊断上传，只等待该任务自己的 start/delivery 完成，不等待其他任务、dirty 或公告队列清空。保留原有 diagnostics_enabled 标志；升级前已启用的任务也可补传，不为没有启用的历史任务生成新诊断。
- 同时至多一个诊断上传请求；它进入既有低优先级队列。Claim/Complete/Flush/结果 ZIP 等前台操作保持优先；不并发修改 PowerShell 状态，也不抢占已经运行的 HTTP。
- 首次符合条件后持久化 24 小时期限和尝试次数，最多 12 次尝试。失败至少等 60 秒并尊重通道 retry_at，重启不重置预算。超限记为 expired，保留错误码与本地文件，看板显示停止原因。
- 尚未调度的诊断请求到期会从内存队列移除；已经启动的上传不会被中断，仍按既有不可变 SHA 对账。结果 ZIP、receipt、Claim 和机器锁不受诊断失败影响。
- 诊断 ZIP 首次生成即冻结，丢回复/重启重试继续使用相同字节和 SHA；每十秒窗口只写本地文件，不触发周期网络上传。
- receipt 已闭环、没有冲突、且在可信事件账本中确认一致的 outbox confirmed 条目会被清理。完整 events/comments/claims 继续保留。Queue 同时检查事件账本防止重投。pending/uncertain/rejected、未闭环或冲突运行的簿记不删除；rejected 仍供人工 RetryRejected 使用。

## 验证

本轮 Windows 实测及此前615秒结论的修订见 [回传数据分析](ISSUE-13-DATA.md)。

新增真实队列和持久化回归覆盖：busy/dirty/后台队列/另一任务等待时仍入队、单项 handoff 互斥、单个诊断请求上限、低优先级、不抢占当前 Poll、排队期限、重启重试预算及冻结 SHA。PowerShell 本地 HTTP fixture 覆盖完整 receipt 后清理、事件和领取证据保留、重复 Submit/Complete 不再次写入、升级遗留确认条目的清理，以及未决状态不被清理。

这些检查验证程序机制，不代表公司代理网络或真实 A5 E2E 的新性能。Windows 升级后验收应使用现有配置和状态，确认一项已 receipt 的诊断能在另一项仍 waiting/running 或 Advertise 退避时入队并回传；不得为验收清锁或重放原有未知实验。
