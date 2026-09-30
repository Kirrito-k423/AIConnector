# 0.7.1：交付写入 uncertain 的恢复

对应 [Issue #9](https://github.com/Kirrito-k423/AIConnector/issues/9)。修复的是结果 ZIP 和协议评论的投递；不改变 Claim、Pi 或服务器命令的执行权限。

## 原因和语义

旧逻辑只有“读回找到 → confirmed”的恢复分支，`uncertain` 被重发筛选永久排除。请求没有落地时，轮询再多也无法交付。`http=0` 只说明客户端没有收到 HTTP 响应，不能证明 GitHub 未收到请求。

现在以原 `event_id`、原正文、原运行和原 ZIP 字节继续投递。评论是至少一次投递；若原请求迟到，可能出现两个相同事件的评论，接收端按事件 ID 去重，持久化 Claim 不会再次授权执行。不能把它描述成网络写入 exactly-once。

## 恢复条件

1. 从原配置、原状态目录升级，不需重置或改写历史状态。旧 `uncertain` 缺少时间字段时，从首次升级后的完整读取开始观察。
2. 评论必须完整读取全部所需路由和评论页；ZIP 必须完整读取原 Release 的全部资产页。失败、限流、无效列表和分页超限不算缺失证据，并清空缺失计数。
3. 至少两次完整的缺失观察，相隔至少 `poll_seconds`。同时必须到达持久化退避截止时间。基准等待为 `max(2 × HTTP 超时, 2 × poll_seconds, write_interval_seconds)`；连续发送不确定时按尝试次数指数增加，最长一小时。默认 60 秒轮询、30 秒请求超时时，基准等待为 120 秒。它不是到时直接重发的 TTL。
4. 符合条件后重新排队；保留原内容与身份，继续遵守全局写入间隔和限流冷却。不能读取远端时不重传；其他可发送任务仍可推进。
5. 找到原评论即确认。找到原 ZIP 必须检查状态、大小、名字，并重新下载核对 SHA-256；同名冲突或内容不同不覆盖、不删除。重传遇到 422 时先读回查证迟到上传。

[GitHub 的上传接口](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset) 对同名文件返回 422。此约束用于防止重复文件，最终内容仍由实际下载的摘要验证。

`status.json` 的 outbox 与 uploads 保留 attempts、recoveries 和 recovery（缺失读次数、最近读回时间、退避截止时间）。`UPLOAD_RECONCILE_PENDING` 表示仍等待观察或退避结束；服务继续自动处理。无需新增 Windows 配置，也不需要人工上传 ZIP 来解锁。`RetryRejected` 仍只处理明确拒绝；不提供跳过读取验证的强制 uncertain 重置。

范围只包括协议事件和内容寻址 ZIP；创建 Issue / Release、能力公告等 provisions 保持原先的保守策略。远端执行 unknown 的机器锁也不会被投递恢复解除。

## 验收

新增真实 PowerShell 回归覆盖发送前丢弃、发送后丢响应、旧状态恢复、分页失败、延迟评论去重、同名 422 竞争、下载内容冲突和队列继续推进。

端到端测试同时丢弃 started 评论、结果 ZIP、result 评论各一次；ZIP 写入 uncertain 后重启 Windows 服务，最终要求 Mac 收到 ZIP 与 receipt、Windows confirmed，并确认 Pi 的模型调用次数没有增加。测试使用真实 Node / PowerShell / Pi 进程和受控 Relay、模型服务；内网公司代理实测需升级后观察，不以 fixture 代替。

Windows 安装包验收还复现了独立的文件共享问题：监督器读取 `worker.json` 时，原子替换可能短暂返回 EPERM；事件回调异常会被 Pi SDK 归为 MODEL_REQUEST_FAILED。现对 Windows 的 EPERM / EACCES / EBUSY 最多尝试 8 次，总等待不超过 450 ms，只重试同一个原子替换，不删除目标或重启模型。持续权限错误仍失败并保留原文件。专项从实际解压包重复并行进程用例，另用注入式文件系统测试验证旧文件在整个重试期间可读。
