# 0.7.5 交互与传输优化

本版针对 0.7.4 实验中发现的三个瓶颈：上传后公网重新下载阻塞结果发布、每个动作启动 PowerShell、历史状态反复投影及落盘。任务协议、机器预留、领取所有者和不确定交付的恢复边界保持兼容。

## 行为变化

| 路径 | 0.7.5 行为 | 保留的约束 |
|---|---|---|
| Windows 新上传的结果 ZIP | 收到明确的 201 响应并核对资产名称、大小、运行 URL 及可用摘要后，立即允许结果入队；不再等待发送端重新公网下载 | Mac 必须实际获取并校验 SHA/长度才回执；上传响应不确定、422 或发现已有资产时，发送端仍下载核对内容，绝不覆盖同名资产 |
| 服务传输 | 一个常驻 PowerShell 进程持有状态锁，复用解析环境及 HTTP 连接池 | 请求串行；进程退出或响应丢失不在传输层自动重放，领取恢复使用原 owner/event；stdin EOF 退出并释放锁 |
| 待发送事件 | 每次 Flush 最多发送 4 条就绪事件，5 秒预算到期后不启动下一条 | 正在执行的 HTTP 不被打断，因此 5 秒不是严格请求超时；父事件确认后才发送子事件，持久化写入间隔及 Retry-After 优先 |
| 本地提交 | 提交唤醒独立于后台轮询完成 | 已开始的网络请求仍会占用单写入者；不会开启多个进程竞争同一状态文件 |
| 不可变任务冲突 | `RUN_IS_IMMUTABLE` / `REVISION_IS_IMMUTABLE` 持久化为 rejected，重启后也不反复提交 | 保留原任务和错误；更改任务需要新的 revision/run，不修改已发布记录 |
| 状态快照 | 按事件 ID 索引来源；仅写变化文件；状态不变时复用已保存状态对应的快照 | 关键意图仍原子写入及 fsync；缓存随保存的状态摘要改变而失效，重启重新验证持久化状态 |

“上传已确认”在快速路径表示 API 已确认资产，不代表公网下载已验证。`uploads[].public_verification=receiver_required` 明确标记该区别；最终 Mac receipt 才表示接收校验通过。独立 CLI Upload 仍执行原发送端下载校验，输入 ZIP 路径也保持发送端验证。

常驻进程独占 `state.lock` 和 `watch.lock`。服务运行时，直接执行同目录的 `Connector.ps1` 写入或查询会报 `STATE_BUSY`；使用看板、Node CLI status 或诊断导出。确需独立 PowerShell 操作时先正常停止服务。关闭或升级服务会等待已发动作完成、关闭传输 stdin、等待进程退出，再释放服务锁。原配置及状态无需迁移或清空。

## 本地性能证据

真实 Mac PowerShell、合成已完成任务账本。每组先创建投影，再测 5 次取中位数；包含 IPC 和 JSON 传输。

| 历史任务 | 0.7.4 冷进程 Status / ms | 0.7.5 常驻 Status / ms | 每次修改文件数：旧 → 新 |
|---:|---:|---:|---:|
| 1 | 683.33 | 2.24 | 4 → 0 |
| 39 | 2748.79 | 3.74 | 42 → 0 |
| 100 | 6362.25 | 7.87 | 103 → 0 |

常驻进程初次启动分别约 448/935/1992 ms，已单独记录，不包含在缓存命中的 Status 中位数中。该基准衡量本地传输状态读取，不能外推成 A5 或公网闭环提速倍数。后台 Poll 改变状态时仍需构建新投影；本版未消除全部 O(历史状态规模) 计算。原始样本见 [resident-075-benchmark.json](evidence/resident-075-benchmark.json)。

```sh
git show 77fa243:Connector.ps1 > /tmp/Connector-074.ps1
PWSH=/absolute/path/to/pwsh python3 tools/benchmark_resident.py \
  --baseline /tmp/Connector-074.ps1 --output /tmp/resident-comparison.json
```

## 计时与验收

已有 operation_id 继续贯穿服务排队及 HTTP。新增 `runtime_ready`、传输 `action_started/action_finished`、`upload_api_confirmed`、`upload_verification_deferred`、`state_saved`、`snapshot_built/snapshot_cached`、`flush_batch`。可从同一 run 的诊断分别定位 API 上传、自检、动作等待和发布；`files_written` 是实际投影文件写入数，`events_sent` 是批次 POST 次数。日志仍不包含凭据、正文或查询字符串。

自动回归覆盖：常驻进程复用和凭据刷新、UTF-8、错误响应不能授权执行、传输退出不自动重放、独占状态锁、原 owner 的崩溃恢复、已存在资产损坏拒绝、结果先发布但损坏 ZIP 不回执、后续网络恢复形成原运行的回执、批次上限与原 event 身份。Windows 门禁使用系统 PowerShell 5.1，并运行新安装包解压后的完整 Node/Pi 闭环和重启/网络故障测试。

升级后在内网一次验收：两端读回 0.7.5；使用原有固定只读入口提交多机任务，核对 ZIP 和 receipt；导出两端同一批运行的诊断，将资源等待与实际执行分开统计。网络受限或资产损坏时结果可以先显示“已发布”，必须继续显示未验证，不能提前给 receipt。已有 unknown、机器占用 waiting 不因升级被强制解锁或重新执行。

页面 SSE、轻量列表接口和独立长下载执行资源尚未在本版实现；常驻传输仍有非抢占的网络等待。真实内网、商业模型和 A5 的闭环延迟需两端升级后再测。
