# 0.7.8：本地采集与 E2E 后诊断回传

10 秒是本地时间窗口，不是 GitHub 上传频率。每个阶段变化更新内存累计，默认每秒采样进程 CPU，汇总为 10 秒窗口；等待主控制操作的队列也每 10 秒写一条本地 blocker 记录。实验过程中没有由窗口触发的 Issue 评论、Release 上传或远程查询。

## 采集路径

PowerShell 使用一个常驻 .NET 后台线程格式化并写入窗口，阶段锁只负责累计和复制有限的窗口快照。磁盘写入不持有阶段锁。Node 的服务与 Worker 窗口使用串行异步文件写入，采样回调不再执行同步文件 IO。

阶段边界不再另外写 stage_finished：窗口已经记录同一阶段的独占时长，避免重复 Stopwatch、两次额外 CPU 查询和日志写入。周期 action_wait 独立异步写入 queue-wait-timing.jsonl。既有低频控制事件及持久化协议仍沿用原路径，本版不宣称全部文件 IO 都已异步化。

写入队列最多 16 个窗口；等待写入的同一 session/window 只保留最新快照。持续慢磁盘或 IO 失败时可丢弃观测数据，`dropped_windows` 计数会出现在后续记录与 CSV 中，必须按证据缺失处理。不得为等待日志写入而停止 Claim、修改资源所有权、重放 SSH 或改变实验结果。

`dropped_windows` 统计被丢弃或写失败的窗口记录，包括可能被后续完整窗口覆盖的部分记录，不是去重后的缺失窗口数。周期排队流最多缓存 64 条事件，丢弃记录通过 dropped_events 显示。日志轮转仍可能删除更早历史，分析应同时检查实际时间覆盖。

阶段累计、时钟读取、CPU 查询和有限快照复制仍有 CPU 开销，不能宣称零成本。阶段内的普通循环没有加入逐元素计时，Canonical 的递归实现直接调用内部函数；每个主要函数边界记录一次阶段。Node 正常关闭等待本地写入完成；PowerShell 仅在进程退出时最多等待后台写入 1 秒，正常业务动作不等待磁盘。

## 回传顺序

```text
实验及 Pi 完成 → 结果 ZIP → result 发布 → Mac 校验并发布 receipt
→ Windows 观察 receipt → 当前任务/前台控制队列空闲
→ 冻结 delivery-diagnostics.zip → 低优先级 UploadDiagnostics
```

诊断 ZIP 包含 Windows 本地记录与 receipt_observed_at。首次冻结后重试使用完全相同的字节与 SHA；老版本已冻结的诊断 ZIP 不改写。没有 receipt 时不自动上传，可在本地看板/CLI 导出排障数据。

诊断仍复用既有串行传输和限流恢复协议。一旦闲时诊断请求已经开始，之后到来的新前台操作仍需等待它结束；本版没有创建独立网络连接来规避总限流，也不能宣称后续任务绝不会被正在执行的后台 HTTP 阻塞。

窗口缺口、计时器建立前的启动区间、Node 迟到采样、CPU 与墙钟的口径，沿用 [0.7.7 说明](TRANSPORT-077.md)。由于后台写入和日志保留限制，读取时仍须检查覆盖范围与 dropped_windows。跨机器时钟未校准时，E2E 应使用 Mac 发布到收到 receipt 的同一时钟口径；Windows 本地阶段时长独立分析。

## 可重跑的开销检查

基线为 0.7.7-rc.1 的源码提交 `36fe6eeb65ccaf2bca95bdc153803d339e1a389e`。基准只创建临时本地日志，使用 off / baseline / candidate 三个对照，交错顺序，保存原始样本、CPU、日志字节、校验和与 250 ms 慢磁盘注入结果。

```powershell
git show 36fe6eeb65ccaf2bca95bdc153803d339e1a389e:service/runtime-profiler.cs | Set-Content -Encoding utf8 baseline.cs
python tools/benchmark_profiler.py --baseline baseline.cs --output overhead.json --powershell powershell.exe
```

第一组三个对照为预热，后六组用于统计。`stages` 为 10000 次双层阶段、共 40002 次累计调用；`actions` 为 100 次短控制操作，包含动作结束快照。二者为局部压力测试，不是实际业务频率或 Windows 内网 E2E。

Windows 发布增加 PowerShell 5.1 开销检查门禁。通过日志正确性、慢 IO 隔离和包回归，不能自动证明真实内网性能；升级后仍需收集实际运行账本再判断占比。
