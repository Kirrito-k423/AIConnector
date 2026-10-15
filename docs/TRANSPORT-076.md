# 0.7.6：缩短任务发现到 Pi 启动的等待

2026-10-08 的真实 0.7.5 复测：6/6 只读运行完成；对应历史成功组的 5 次运行，发布到 Pi 启动平均 826.4 秒，占完整闭环 59.9%。配置允许 4 个 Pi，实际峰值 2；SSH 查询约 9 秒。这个结果不能解释为 NPU 算力不足或并发上限已满，也不能将整个 826 秒归因于某一条网络请求。

## 源码确认的依赖与本版改动

依赖仍为：任务观察 → 输入校验 → accepted 入队 → 远端 POST/读回确认 → 本地调度/机器预留 → 原 owner Claim → Pi 进程。尚未确认的 accepted 不授予执行权限。

| 路径 | 原有额外等待 | 0.7.6 行为 | 正确性约束 |
|---|---|---|---|
| Node 动作队列 | Claim、Poll 排在待上传 ZIP 后 | Claim 与 Complete/Status 同档；Poll 在 Upload 前；10 秒一级老化使低优先级动作最终可推进 | 不抢占、取消或重放已经发出的请求；一名持久状态写入者 |
| 常驻 Poll | 发现后执行评论发送，再返回快照 | 返回发现和 accepted 入队状态，评论由独立 Flush 驱动 | 独立 CLI Poll/Watch 保留自动发送语义 |
| 常驻 Flush | 一次最多 4 条，占住整个控制回合 | 一条评论 POST/读回完成后返回，可在下一秒监督与调度 | POST 仍遵守持久化间隔、全局限流与父事件顺序；独立 CLI 批次仍最多 4 条 |
| 事件队列 | result/receipt/started 高于 accepted | accepted 与 started 优先，其他事件低一级；30 秒一级老化 | 父事件未确认不发送子事件；不能重放未知 SSH/Claim |
| 元数据 | 每条评论重新读 manifest、全量 Issue 目录及 Release 身份 | 成功验证后复用至多 30 秒、128 项、仅内存的缓存；命中不延长 TTL | credential 变化、错误响应、异常或进程重启清空；目录刷新仍完整读取；不缓存否定结果；Upload 的 Release/资产清单仍新读 |
| 能力公告 | Advertise 在同一 tick 的 Poll 前等待 | 独立低优先级动作；失败不阻止后续 tick 入队 | 同一个传输资源仍可能被正在执行的公告 HTTP 占用；30 秒重试间隔和 Retry-After 保留 |

短缓存允许验证结果在有效期内复用；远端元数据改动不会承诺瞬时发现，最多等缓存失效或原有周期审计。它不缓存执行权限、模型凭据、资产字节或机器占用。

本版没有把并发上限从 4 改大。增加名额不能解除发现/状态交付依赖；每台机器的预留和本地冲突锁继续有效。

## 自动诊断资产

本版新接收的运行记录以下本机时间：`admitted_at`、资源等待原因 `CAPACITY_BUSY/RESOURCE_BUSY`、`resource_acquire_started_at/resource_acquired_at`、`claim_queued_at/claim_confirmed_at`、`worker_spawned_at`，以及已有的 Pi、打包、Upload、Complete 与结果发布观察时间。接收前段的 `event_observed/event_queued/event_confirmed` 通过原 operation_id 与 HTTP 串联。`startup_timings` 写入主结果 ZIP 的 `worker-timing.json`。

主结果已经远端发布后，Windows 自动生成一次独立、不可变的 `delivery-diagnostics.zip`，Release 名称为 `diagnostics--windows-inner--SHA256.zip`，内含 `delivery-diagnostics.json`。它不进入任务 result 的 artifacts，不修改原 ZIP 或协议评论，不延迟 Mac 校验/receipt；低优先级上传最多一项在途，失败至少等 60 秒。已经发出的上传仍不可抢占，因此这不是零开销。

诊断仅导出本 run 最近最多 2000 条关联事件、受限时间/类别/计数；不导出配置、模型报告、命令、路径、URL、请求体或凭据。诊断在自己的上传之前冻结，不能包含自身完整上传耗时，可能早于 Mac receipt。原本地日志仍按两份 2 MiB 轮转，`truncated` 必须保留。旧版本接收的历史任务不补发诊断。

新增 `UploadDiagnostics` 只允许 Windows Relay 的本地已领取运行，且主结果处于确认的 result/receipt 阶段。诊断资产仍实际下载并核对 SHA/长度；不使用主结果的快速上传自检豁免。重启或不确定上传复用同一文件及 SHA，无权限触发重新执行任务。

## 验证与升级

回归覆盖：发现先返回、不确认 accepted 不得 Claim、控制动作在待上传前调度、单评论让出回合、成功缓存复用与故障/凭据/到期失效、所有者恢复、不确定交付、同机预留、实际 Pi 闭环、独立诊断与重启不重复执行。Windows 发布仍受 PowerShell 5.1、完整安装包解压闭环与重复并发/维护恢复门禁约束。

本机受控性能比较入口：

```sh
git show 5703071:Connector.ps1 > /tmp/Connector-075.ps1
PWSH=/absolute/path/to/pwsh python3 tools/benchmark_admission.py \
  --baseline /tmp/Connector-075.ps1 --output /tmp/admission-comparison.json
```

该基准使用真实常驻 PowerShell、相同 6 个任务与 16 个历史 Issue、本机延迟 API；测首个接收端 Poll 派发到各原 owner Claim 返回。计入控制交付及状态构建，不计进程冷启动、商业模型、资源竞争或真实 A5。不能将本机收益外推为公网闭环提速。

原始样本：[admission-076-benchmark.json](evidence/admission-076-benchmark.json)。API 每次 GET/POST 固定附加 80 毫秒，3 组独立对照交错顺序，以下为组中位数。6 个任务均取得各自原 owner 的执行权限，最终 12 条控制评论全部确认，未减少交付义务。

| 指标 | 0.7.5 | 0.7.6 |
|---|---:|---:|
| 最后一个任务取得 Claim 回复 | 17.57 秒 | 10.90 秒（减少 38.0%） |
| 各任务 Claim 回复的平均等待 | 11.07 秒 | 7.81 秒 |
| 所有 started 评论确认 | 19.06 秒 | 15.09 秒 |
| 完整控制流程 GET / POST | 52 / 12 | 22 / 12 |

此结果为**部分验证：本机控制阶段**。真实 Windows 内网 Pi 启动与全链路收益待升级复测，不能把 38% 套用到之前的 826 秒。

两端使用已有配置/状态旁路升级，无需提高 maxConcurrentRuns、清空任务或修改机器授权。保持原 10 秒轮询与写入间隔。内网验收使用固定只读多机入口及一次同机重复，收集主结果、独立诊断与 Mac 原始计时；区别任务发现、accepted 排队、机器等待、Claim 排队与 Pi 本身。真实内网收益必须在 Windows 升级后验证。
