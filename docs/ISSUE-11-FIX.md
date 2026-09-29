# Issue #11：领取冲突与返回丢失的自动恢复（0.7.4）

当 Connector 已经保存 Claim，而主服务未拿到返回结果就中断，旧版重启后会交付 `CLAIM_RECONCILED_NOT_EXECUTED`，Pi 没有启动。0.7.4 对新领取自动恢复原运行。

## 原因与改动

Claim 是本地 PowerShell 账本操作；它把领取和 started 事件一起保存，再生成状态及返回 JSON。GitHub 评论由后续发送队列发布，不是四个并发 Claim POST。提交成功但返回丢失，会让服务账本没有 `claimed_at`，而 Connector 已经拒绝第二次领取。旧 reconcile 因此把尚未启动的任务直接结案。

现在先在服务账本写入随机 `claim_owner`，再把它传给 Claim。相同身份可以重取同一领取事件及任务，其他身份不能接管。主服务恢复时逐项确认没有任何启动证据，以原身份重试，并重新通过 Connector 校验所有权。重试使用持久化的 1、2、4、8、16、32、60 秒退避；正常服务调度周期仍影响实际时间。资源预留保持原 ID，同机任务继续排队，其他机器仍可执行。

Claim 重取不创建新任务、不重复 started 事件、不再调用已经启动的 Pi。取得返回后，主服务先保存 `claimed_at`，再写 spec、启动进程；任何这些记录都阻止自动重新启动。进程正在等待 Claim 返回时不会被恢复器同时处理。

## 自动恢复边界

| 情况 | 行为 |
| --- | --- |
| 同一 owner，Claim 未提交或返回丢失，无启动证据 | 退避后自动重试原 Claim，再执行原 run |
| 其他 owner 已领取、旧版领取没有 owner | 不接管；旧版无启动证据可沿用 blocked 交付 |
| 已有 claimed_at、PID、spec、worker、实验意图、退出或结果文件 | 不自动重新启动，保留现场 |
| 同一 run 的协议内容真正冲突 | 保留 RUN_CONFLICT，不能用重试掩盖内容冲突 |
| 仅机器预留冲突 | 沿用资源排队；不领取、不调用模型 |
| 旧版已经发布 blocked 或已回执 | 历史不可变，需创建新 run_id 才能重新实验 |

这里没有用 lease TTL 判断实验结束。超时不能证明 SSH/NPU 停止，不能据此解除机器锁。不要删账本、复制活跃状态目录到多个服务，或为了重试手改运行身份。

## 升级与 Windows 一次验收

这是接收端程序修复，无需修改 Pi prompt、模型配置或增加轮数。将 Windows 新包解压到固定新目录，使用 `Upgrade-Windows.cmd` 或新包 `runtime/node.exe service/cli.mjs upgrade --config "原配置绝对路径" --apply`。保留原配置、密钥和完整状态目录。Mac 0.7.3 与新版协议兼容；两端可同步使用 0.7.4。

自动验收包括：

1. 真实 PowerShell 提交 Claim 后丢弃返回；从已持久化身份重启服务，原运行经真正 Pi/CPU 执行、结果 ZIP 和 Mac receipt 完成。再次重启不增加模型请求，started 事件仍只有一条。
2. 同一身份重取、多身份竞争、无身份旧领取和结果提交后的拒绝；Claim 调用本身没有评论 POST。
3. 多次失败的退避、服务重启后身份不变、已有启动文件与真实协议冲突不重跑。
4. 四个真实 Pi 并行、同机冲突排队、资源预留返回丢失、独立交付；延续完整 Windows 解压包和 32 次并行回归。

CI 使用 Windows PowerShell 5.1、包内 Node/Pi、本地模型与 Relay fixture。通过这些检查证明故障恢复逻辑，不等于已复测公司代理或真实 A5。内网升级后用新 run 复测，并从诊断导出中查看 `claim_retry`；历史 blocked 运行不会被自动改写。
