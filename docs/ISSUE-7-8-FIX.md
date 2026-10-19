# 0.6.5：检查可诊断性与领取异常恢复

对应 [Issue #7](https://github.com/Kirrito-k423/AIConnector/issues/7) 和 [Issue #8](https://github.com/Kirrito-k423/AIConnector/issues/8)。此修复先于并行调度改造，保持原配置和运行身份。

## 检查和保存

`/api/agent-check` 在成功、失败时都返回实际保存的 simpleHtmlWatch 地址，并明确提示检查不保存表单。错误归并为连接拒绝、连接重置、DNS、TLS、超时或取消等受控类别；不回传可能含凭据的原始异常文本。

PowerShell 错误保留程序行号和有限的传输类别/HTTP 状态，Node 只允许规定字段进入诊断信息。服务器配置保存后立即返回 `saved:true` 与独立的后台公告状态；公告失败不会把成功保存显示成失败。

## 领取响应丢失

Claim 首先持久化本地领取记录和 started 待发事件，再返回执行许可。现有 Claim 本身不直接 POST started 评论；评论由轮询发送。因而 GitHub 上出现 started 不能证明 Pi 已经启动，也不能作为重新执行的许可。

对 `claiming/unknown` 任务，只有以下证据同时成立时才自动收尾：

- 已校验的本地 Connector 快照确认该 run 已领取，且没有冲突或异常。
- 服务账本没有 `claimed_at` 或 PID。
- 运行目录没有 worker、进程退出/失败、spec、实验意图或 simpleHtmlWatch task 记录。

此时交付 `outcome=blocked`、`CLAIM_RECONCILED_NOT_EXECUTED`、`executed=false`、Pi 轮次 0 的结果，并继续后续队列。不再次调用 Claim，不启动原任务，不假装已完成用户目标。确需执行原目标时仍需另建运行。

存在任意启动证据，或只有公开 started 而没有本地领取记录时，保持 unknown；时间久远不是解除占用的依据。本次修复不将真实远端执行未知降级为空闲。

## 验收范围

新增回归覆盖：拒绝连接及嵌套网络原因、诊断不泄漏原始文本、保存与公告提示分离、领取异常自动生成失败 ZIP，以及不同启动证据下禁止自动解除 unknown。

完整测试使用实际 PowerShell 提交 Claim，模拟服务未收到返回值，重启两端服务，验证原 run 的 blocked ZIP 和 receipt，然后以新任务版本验证下一项能够完整执行。模型与 Relay 为受控本地服务，不代表真实 Windows 代理或 A5 硬件已经验收。Windows 工作流从新 ZIP 解压后运行相同测试。
