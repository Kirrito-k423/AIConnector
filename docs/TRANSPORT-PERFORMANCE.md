# 0.7.2 交付性能与分段诊断

0.7.1 的七次 A5 只读探测中，Pi 平均约 103 秒，但从本地提交到回执平均约 29.6 分钟。执行结束到 ZIP 创建约占 32.6%，ZIP 创建到结果评论约占 14.3%。ZIP 每份仅约 6–7 KiB。历史数据没有逐请求计时，不能把上述等待全部归因于带宽、GitHub 或 TLS。

## 本次修复

| 问题 | 0.7.2 行为 | 保留的恢复保证 |
|---|---|---|
| 每次评论写入后重读全仓评论 | POST 有明确评论 ID 时，独立 GET 该评论并核对 Issue、正文与协议；模糊响应只完整读取当前任务 Issue | 未确认写入仍需独立缺失读回及恢复窗口；不凭 POST 成功就确认交付 |
| 后台 Poll 先于已有 ZIP，单个 delivery 占住全局门 | 上传优先于后台轮询，Complete / Flush 优先收尾；最多允许 4 项独立交付进入队列，按任务持久化重试时间 | HTTP 通道依然串行、有写入间隔和队列老化；已经开始的请求不被强行打断 |
| 单个历史 Issue / ZIP 临时失败令所有交付冷却 | poll、audit、artifact、upload、delivery 分开退避；单路 5xx / TLS 不阻塞无关任务 | 真实 429、明确限流、401 及多个独立通道的网络故障仍全局暂停；不绕过 Retry-After |

后台轮询使用仓库评论增量接口，持久化更新时间游标并保留至少 120 秒重叠区间；分页不完整不提交游标。每次轮询额外审计一个历史任务，轮转发现旧评论的修改、删除。审计检测延迟上限随任务数和轮询间隔增长；网络中断会继续推迟。Issue 路由元数据仍全量分页校验，新的评论量仍会增加读取页数。本版没有把 PowerShell 改成长驻进程，也没有消除所有平台延迟。

同一个 PowerShell 操作内复用 HttpClient，减少重复连接建立。机器预留、未知执行的阻断、不可变 event_id 和 ZIP 哈希语义不变。交付失败只恢复原运行的结果，不重新启动 Pi 或 SSH。

## 可复现的请求数量对比

测试使用真实 PowerShell 子进程、本地合成 GitHub API；每个 GET 人为增加 25 ms，每个配置重复 3 次，取中位数。目标任务额外计入 Issue 数。该测试不访问公网或 A5。

| 历史 Issue 数 | 消息交付 GET：0.7.1 → 0.7.2 | 稳定轮询 GET：0.7.1 → 0.7.2 | 消息交付耗时 ms：0.7.1 → 0.7.2 |
|---:|---:|---:|---:|
| 0 | 7 → 6 | 3 → 4 | 1107 → 1049 |
| 16 | 23 → 6 | 19 → 4 | 1870 → 1257 |
| 100 | 110 → 8 | 104 → 5 | 6014 → 2734 |

空历史时轮询多一次增量接口读取；收益集中在历史任务增多后的重复评论扫描。100 个历史 Issue 时仍需要额外的路由分页，不能声称总请求数永远恒定。耗时受本地文件系统、PowerShell 启动和机器负载影响，不能作为内网提速倍数。

原始样本见 [transport-072-benchmark.json](evidence/transport-072-benchmark.json)。复现：

```sh
git show 5a3aaf4:Connector.ps1 > /tmp/aic071-Connector.ps1
PWSH=/absolute/path/to/pwsh python3 tools/benchmark_transport.py \
  --baseline /tmp/aic071-Connector.ps1 --output /tmp/transport-comparison.json
```

## 计时和诊断导出

两端自动记录队列等待、操作实际开始/结束、HTTP 分类/状态/耗时/字节数、冷却及重试、评论观察与独立确认。Windows 额外记录 Pi 开始/结束、打包开始/结束/单调时钟耗时、结果就绪、上传入队/确认和结果入队；Mac 记录下载校验与回执。

看板任务关键节点下显示“发布后等待执行”“执行结束至结果发布”“结果发布至回执”。点击 **导出本次交付诊断** 保存当前端的 JSON；也可以离线运行：

```text
runtime/node[.exe] service/cli.mjs diagnostics --config "原配置绝对路径" --key task-id/1/run-id --output delivery-diagnostics.json
```

不提供 `--key` 时导出所有运行的近期计时。API 为经过本机凭据鉴权的 `GET /api/diagnostics?key=...`。文件位于：

```text
<dataDir>/service-timing.jsonl
<stateDir>/transport-timing.jsonl
```

每个流保留当前及前一份约 2 MiB 文件，单次导出最多最近 2000 条匹配事件，超出时标记 `truncated`。仅记录结构化字段，不记录请求头、查询字符串、正文、凭据或模型会话。诊断写入失败不改变执行或交付决定。事件的 `operation_id` 将服务队列和 PowerShell HTTP 串起来；同一次 Poll 的 HTTP 可能覆盖多个运行，不应全算给其中一个任务。

结果 ZIP 增加 `worker-timing.json`。ZIP 创建后发生的上传、下载、确认无法事先写进不可变 ZIP，因此这些信息保留在两端本地诊断。定位完整回传路径时收集 **Mac 和 Windows 同一 run key 的诊断**。跨机时间戳受时钟偏差影响；HTTP 和打包的本地 duration 更适合精确测量。历史运行不会凭空补齐新字段。

## 升级与 Windows 验收

两端都需升级。新包解压至固定新目录；保留原配置、密钥、任务账本和机器预留。先执行预检，再应用：

```text
runtime/node.exe service/cli.mjs upgrade --config "原 service-windows-inner.local.json 的绝对路径"
runtime/node.exe service/cli.mjs upgrade --config "原 service-windows-inner.local.json 的绝对路径" --apply
```

Mac 将 `runtime/node.exe` 换成 `runtime/node`。本次不需要修改 Pi 轮数、机器入口或授权范围。不要以清空状态方式重试。

发布门禁运行 Windows PowerShell 5.1 Relay 回归、从实际 ZIP 解压后的 Node/Pi 集成测试、断网与重启恢复、丢失评论/ZIP 响应恢复、Windows 启动器检查、看板浏览器回归、6 次维护续跑及 32 次并行回归。门禁通过才发布其测试过的 Windows ZIP。

内网升级后验收：确认两端版本 0.7.2；发送多个已授权的只读探测，要求均有 ZIP 和 Mac 回执；导出同一批运行两端诊断，分别汇总排队、Pi、打包、HTTP、重试和回执发现时间。测试通道临时失败应保留原 run / event / ZIP 身份，其他正常任务继续交付。自动测试使用合成网络和模型，不代表真实内网代理、模型或 A5 NPU 性能验收。
