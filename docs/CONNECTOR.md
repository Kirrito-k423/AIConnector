# AIConnector v0.2.0：任务交接与两端轮询

Mac 发布实验任务，Windows 自动收件并保存本地待办；内侧 AI 领取后自行安排实验，再提交结果。Mac 自动下载并校验结果中的 ZIP，向 Issue 发布回执。两端都能在本地 `status.md` 和同一个 Issue 看到进度。

Windows 使用自带 PowerShell 5.1；Mac 使用 PowerShell 7。中间件不启动 SSH、不执行评论中的命令，也不替 AI 判断实验是否达标。

## 第一次启动

1. 完整解压 `AIConnector.zip`，保留整个 `AIConnector` 目录。
2. Windows 双击 `Start-Windows-Connector.cmd`。Mac 运行 `./Start-Mac-Connector.command`；若解压工具没保留执行权限，运行 `zsh ./Start-Mac-Connector.command`。
3. 在各自终端输入 GitHub Token，隐藏输入且只保存在进程内存。两端默认使用 `Kirrito-k423/AIConnector` 的 Issue #2；任务消息与旧探测消息有不同协议标记。
4. 保持终端运行。默认约 60 秒轮询一次；Ctrl+C 停止，重新启动后从原状态目录继续。

Token 需要该仓库 Issues 写权限；使用 `Upload` 上传 ZIP 还需要 Contents 写权限。也可设置本机进程环境变量 `AICONNECTOR_GITHUB_TOKEN`。请勿将 Token 填入任务 JSON、配置或 Issue。

默认允许账号 `Kirrito-k423` 发布两个节点的消息。若换账号，在两端 `connector.config.json` 的 `authors` 中按节点修改允许列表。两个节点共用账号时，平台只能验证账号，不能证明是哪台物理机器发出的消息。

Mac 可用 `AICONNECTOR_PWSH` 指向现有 `pwsh`。需要代理时，启动脚本后附加 `-Proxy http://127.0.0.1:7890`；Windows 的代理地址按其本机网络配置填写。代理仅作用于此进程。Mac PowerShell 安装参考 [Microsoft 官方说明](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-macos)。

## AI / 人工操作的最小流程

以下 Mac 命令中的 `pwsh` 可替换为现有 PowerShell 7 的绝对路径。Windows 的 `Connector-Windows.cmd` 会校验包内脚本、处理下载标记，并保留失败退出码。正常运行不要求 Python。

**Mac：发布任务。** 修改 `examples/task.json`，写清代码版本、环境、执行入口与验收标准。一次实验由 `task_id / revision / run_id` 唯一标识。将入口命令作为描述交给内侧 AI，不能将它理解为中间件已经执行。

```sh
pwsh -NoProfile -File ./Connector.ps1 -Node mac-outer -Action Submit -File ./examples/task.json
```

`queued` 表示已持久化到本地待发队列。运行中的轮询会发布到 Issue，再独立读回确认；随后 Windows 下载任务附件、校验并回报接收。

**Windows：查看并领取。** 内侧 AI 可读取 `connector-state/windows-inner/status.json`、`status.md` 及 `inbox/*.json`；或运行：

```bat
Connector-Windows.cmd -Action Status
Connector-Windows.cmd -Action Claim -Key smoke/1/run-001
```

只有返回 **`execute: true`** 的首次领取才允许本地执行者启动这次实验。再次领取返回 `execute: false`；同时领取时另一个进程也可能返回 `STATE_BUSY`，稍后查看状态即可。进程若在领取后退出，保留已领取状态，人工或执行器应核查实验是否启动，不能再次领取并重复启动。

**Windows：提交结果。** 实验结束后填写 `examples/result.json`：真实退出码、实际代码版本、结果摘要、指标和产物。实验失败用 `outcome: failed`；因环境等因素无法完成可用 `blocked`，也应给出实际状态。

```bat
Connector-Windows.cmd -Action Complete -Key smoke/1/run-001 -File examples/result.json
```

轮询会按父事件顺序发布领取记录和结果。Mac 收到结果后下载全部附件，核对字节数与 SHA-256；成功结果还要求实际代码版本与任务中的冻结版本一致，然后发布回执。**回执确认结果完整到达；验收标准仍由外侧 AI 或人判断。**

合成示例是人工确认流程，不产生 NPU 实验结果。真实实验应使用新的任务与运行 ID，按实际内容填写。

## 携带 ZIP

将需要传输的文件打成一个小于 5 MiB 的 ZIP，然后显式上传：

```bat
Connector-Windows.cmd -PromptToken -Action Upload -File result.zip
```

Mac 对应命令为：

```sh
pwsh -NoProfile -File ./Connector.ps1 -Node mac-outer -Action Upload -File ./input.zip -PromptToken
```

命令返回一个 `name / bytes / sha256 / url` 清单对象，将它放入任务或结果 JSON 的 `artifacts` 数组。一次最多 5 个 ZIP。上传按完整 SHA-256 命名，先检查服务器已有文件，再上传并匿名下载校验；不覆盖资产。

接收端缓存文件到 `connector-state/<node>/artifacts/<sha256>.zip`，不自动解压或执行。任务附件校验失败时不会回报接收；结果附件校验失败时不会发布回执。配置中的 `artifact_prefixes` 限定可用的稳定文件路径。

5 MiB 是程序的保护上限，**不是实网已验证容量**；目前用户内网只验证了含 128 KiB 合成数据的 ZIP。GitCode 评论可以通过配置切换使用；`Upload` 目前只支持已经双向验证的 GitHub Release，GitCode 附件稳定链接可用作输入或结果引用。

## 查看状态与恢复

| 状态 / 字段 | 含义与处理 |
|---|---|
| `task` | 任务已发布，等待 Windows 确认 |
| `accepted` | Windows 已接收并校验输入；尚未领取执行 |
| `claimed: true` | 本地领取已经持久化，不再返回第二次执行许可 |
| `started` | 已领取事件已被通道独立读回；不保证 SSH 命令实际启动 |
| `result` | 结果已发布，等待 Mac 校验 |
| `receipt` | Mac 已核对结果版本和产物并回执 |
| `conflict` | 同一运行出现冲突事件或已接收评论被修改；停止推进该运行 |
| outbox `pending` | 尚未发送；重启后可发送 |
| outbox `uncertain` | 请求可能已经成功；只查原消息，不自动重发 |
| outbox `rate_limited` | 明确限流，保存冷却期限后恢复 |
| outbox `rejected` | 服务端明确拒绝；修复权限后用 RetryRejected 显式重新排队 |
| `STATE_BUSY` | 另一操作持有状态锁；稍后重试本地命令 |
| `STATE_CORRUPT` / `STATE_CONFIG_MISMATCH` | 保留原文件并停止；不得删除状态目录当作修复 |

修复权限后，可使用 `-Action RetryRejected -Key <event_id>` 将明确拒绝的评论重新排队；上传使用文件的完整 SHA-256 作为 Key，随后再次运行 `Upload`。它拒绝处理 `uncertain`，未知写入仍必须先查证。

`status.json` 的待发队列按消息列出状态，不把本地排队显示为远端已收到。投递失败不会丢弃已保存的任务和结果。不同任务互不覆盖。

**保留 `connector-state`，升级时只替换程序文件。** 状态丢失后，服务器已出现的领取/结果不会重新变成可领取；但仅存在本地且未发布的领取不能从网络恢复，所以不能靠删除目录重新初始化。一个节点应只有一个运行中的状态目录；多台物理机器使用同一节点身份不在此版本的去重保证内。

已领取但实验是否运行不明时，先通过内侧 AI / 服务器进程记录核查；确认终态后用原运行提交结果。需要重复实验时使用新 `run_id`；修改任务内容用新 `revision`，不编辑旧协议评论。此版本没有自动租约接管、取消正在执行的实验或自动重跑。

轮询默认在完整读取所有评论页后推进状态；分页不完整不导入部分任务。限流遵守 `Retry-After` / GitHub 配额重置时间，冷却期限写入磁盘。未知 POST 结果只读回查证，不能保证网络分区时仍持续投递。

## 单轮调试与本地验证

`-Action Poll` 只做一轮；`-Action Watch -Cycles 2` 做两轮后退出。可以附加 `-Config`、`-StateDir`，但同一状态目录绑定节点和通道配置，不能拿旧状态切换其他仓库。

```sh
PWSH=/path/to/pwsh python3 -m unittest discover -s tests -p 'test_connector*.py' -v
python3 tools/build_connector.py
```

协议与平台依据见 [PROTOCOL.md](PROTOCOL.md)。真实用户内网上的持续任务交接需要两端启动后才能形成证据；本地模拟接口和 GitHub 托管 Windows 验收分别记录。
