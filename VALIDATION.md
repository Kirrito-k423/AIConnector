# 本次验证记录

更新日期：2026-09-25；下面按日期保留历史证据，当前状态以最新日期为准。


## 2026-09-26：后台服务、任务看板与 Pi Runner

实现了两端本机 HTTP 看板、持久化发送/领取/执行/交付账本、独立 Pi 工作进程和用户登录自启。任务通道继续使用公开的 `AIConnector-Relay`，格式与文件命名由程序生成。

- **真实 GitHub 与真实执行：** [Relay Issue #2](https://github.com/Kirrito-k423/AIConnector-Relay/issues/2) 和[由浏览器页面发布的 Issue #3](https://github.com/Kirrito-k423/AIConnector-Relay/issues/3) 各完成 task → accepted → started → result → receipt。Pi 0.87.1 实际调用工具，真实 CPU 子进程计算 `sum=50005000`；返回的 ZIP 分别为 1331 / 1328 字节，两端 SHA-256 一致。[去除本地路径后的证据](docs/evidence/2026-09-26-service-live.json)。
- **Windows 实际安装包：** [CI 全部通过](https://github.com/Kirrito-k423/AIConnector/actions/runs/36214230805)，代码 `454a949`。10 项 Node 测试、全新解压后的 6 项端到端测试，以及下载标记信任与包损坏拒绝检查通过；使用包内 Node 24.14.0 / Pi 0.87.1、系统 PowerShell 5.1。计划任务在主进程被杀及正常停止后都重新拉起；实际 cmd 在 PATH 没有 Node 时仍能启动。ZIP 为 57,824,731 字节，SHA-256 `a42a956d5e180ed6f9d17539c4966a5d88718336ab556a835760b601f53a969a`。[机器证据](docs/evidence/2026-09-26-service-windows-package.json)。原协议与通道的 [Windows 91 项回归](https://github.com/Kirrito-k423/AIConnector/actions/runs/36214230680) 也通过。
- **Mac 实际安装包：** 9 项 Node 测试通过，1 项 Windows DPAPI 检查交给 Windows；全新中文空格目录解压，包内 Node / Pi / PowerShell 7.6.6 的 5 项端到端测试通过，1 项 Windows cmd 检查交给 Windows。含实际 launchd 安装、进程被杀及正常停止后自动拉起。ZIP 为 203,601,707 字节，SHA-256 `37476315e7eabfbf147c999d8e05f01b55fd66bd5531c3468e69c57c514f0554`。[机器证据](docs/evidence/2026-09-26-service-macos-package.json)。
- **浏览器验收：** 实际打开本机页面、发布第二项任务，看到五阶段时间、事件作者、执行开始/结束、Issue / Release / ZIP 链接；检查任务筛选与空列表，结果最终显示已回执。
- **凭据：** macOS 钥匙串实际写入、读回与删除合成凭据；Windows DPAPI 在 Windows CI 检查密文文件和回读。发布证据与 ZIP 不含真实凭据。
- **证据范围：** 实网两端角色运行在同一台 Mac，模型使用受控 API 回复。不是商业模型推理、用户内网 Windows、SSH / NPU 实验或操作系统重新启动验收。进程被杀后的系统拉起与重新开机是不同测试。

安装和可信实验入口的配置见 [SERVICE.md](docs/SERVICE.md)。程序保留未知执行状态，不因重启或失联重新提交实验；人工核对后可交付 blocked 结果。通道回执证明文件到达，不代表科学结论已通过人工验收。


## v0.2.0：任务协议、持久化状态与两端轮询

已发布 [任务交接包 v0.2.0](https://github.com/Kirrito-k423/AIConnector/releases/tag/v0.2.0)，代码固定在 `6e510a0269873d9bd608b161b3f924c5e798e6d7`。使用入口见 [两端启动与 AI 接入说明](docs/CONNECTOR.md)，事件字段、因果关系和恢复语义见 [任务协议](docs/PROTOCOL.md)。

本阶段实现 `task → accepted → started → result → receipt`，任务修订不可变，重复实验使用独立运行 ID；同一状态目录的领取持久化后只返回一次执行许可。两端持续轮询 Issue，按消息摘要去重，并把本地待办、状态和结果保存为 JSON / Markdown。结果回执只证明完整收到，不代替实验验收结论。

[最终 Windows PowerShell 5.1 回归](https://github.com/Kirrito-k423/AIConnector/actions/runs/36094262236) **72 项全部通过**，包括原探测器回归及新增的任务交接检查：

- 任务发布、接收、领取、结果和回执完整流程；各动作使用新进程，验证重启后的持久化。
- 相同事件去重、并发领取只授权一次、乱序恢复、同一修订跨运行内容一致性、冲突评论与作者检查。
- 未知评论 / ZIP 写入只读回查证，明确限流后恢复，连续限流不因评论读取成功而丢失退避计数；明确拒绝只允许显式重新排队。
- 任务与结果 ZIP 下载校验、成功结果代码版本比较、失败实验结果正常回传；损坏状态保留原文件并停止。
- PowerShell 生成的事件摘要由 Python 独立重算；含中文的载荷与任意指标字段名（如 Keys / Values / Count）保持一致。
- **解压后的真实 Windows 启动入口**：中文空格目录、NTFS 下载标记、一次信任确认、Watch / Claim / Complete / 重启完整流程、重复领取拒绝、包损坏拒绝和 AllSigned 不绕过。

Mac 本地完整套件曾运行 68 项，55 项通过、13 项 Windows 专用检查跳过；之后的退避计数、摘要互通、修订一致性和指标字段修复分别通过针对性回归。最终代码的完整平台回归以上面 72 项 Windows 结果为准。

另外在 Mac 启动两个**同时运行**的 PowerShell 7 Watch 进程，通过本地 HTTP 模拟通道完成任务交接，在轮询期间执行 Claim / Complete；双方均到达 receipt，远端共 5 条协议消息。终止并重启后没有增加消息或再次发放执行许可。最终 ZIP 的 Mac 启动脚本也在真实交互终端运行一轮，默认配置不修改，公开 GitHub Issue 读取成功；未发送外部消息。

发布包为 **24,786 字节**，SHA-256 `d847877396ae1e21be1b4046780f0bec4a2ac129cbf5c04ab9abc4a0399bb209`。Windows CI 构建、本地构建和匿名公开下载逐字节一致。

[公开发布包独立验收](https://github.com/Kirrito-k423/AIConnector/actions/runs/36094813967)也已通过：托管 Windows 匿名下载 v0.2.0、校验摘要、在全新中文空格目录解压，保持默认配置，经下载标记信任确认后从真实 cmd 入口完成公开 Issue 读取。该验收没有外部写入。Windows 再次下载到的包也与本地包逐字节一致。详见 [机器可读证据](docs/evidence/2026-09-25-task-connector.json)。

证据边界：自动交接与故障测试使用模拟 GitHub / GitCode 接口，托管 Windows 不代表用户内网。真实通道的双向 ZIP 能力由下文 v0.1.5 内网证据支持；新 v0.2.0 的用户内网持续任务交接尚需两端实际启用，未声称已完成 NPU 实验。SSH 执行器、AI 自动决策及实验验收判断不在本次中间件实现内。

## 2026-09-25：内网恢复补测与真实双机 ZIP 验收

已读取 [Issue #3 的最新结果](https://github.com/Kirrito-k423/AIConnector/issues/3#issuecomment-5825177873)，从 GitHub Release 匿名下载报告 ZIP：5,160 字节，SHA-256 `bfda37119e0ef0fcd583a1c08125619e55ef89d207e3be2996a76c26fd9ef2ed`，ZIP CRC 通过。报告来自用户内网 `windows-inner`，v0.1.5，Windows PowerShell 5.1.26100.7705；用户注明通过 `Run-Windows-Resume.cmd` 运行。

Mac 随后独立读取 GitHub / GitCode 评论中的附件清单，核对 Session、发送接收节点、消息 ID、字节数、SHA-256 和稳定链接，并匿名下载全部 9 个已验证项对应的文件。详细来源、评论 ID 及摘要见 [本次机器可读证据](docs/evidence/2026-09-25-intranet-resume.json)。

| 实际链路 / 项目 | 本次结果 |
|---|---|
| Mac → 内网 Windows，GitHub Release ZIP | Windows 下载 131,190 字节并校验；Mac 重新核对原文件，SHA-256 一致 |
| 内网 Windows → Mac，GitHub Release ZIP | 131,215 字节，双方下载校验通过；Mac 另验 ZIP CRC 和内部 128 KiB 合成载荷 |
| 内网 Windows → Mac，GitCode ZIP | 131,215 字节，SHA-256、ZIP CRC 和内部合成载荷通过 |
| GitCode 原先返回 429 的 32 KiB TXT / JSON / CSV | 本次 Windows 校验通过，Mac 独立下载及合成原始字节比对通过 |
| 之前成功的 GitCode 1 KiB TXT / PNG、GitHub PNG | 原附件链接和评论 ID 保持不变；本次重新下载校验通过 |
| 本次报告 ZIP 回传 | 已实际通过 Release 链接回收并校验；评论注明由本机额外脚本回传，不据此声称发布包已内置自动回传功能 |

此前 GitCode 的四个限流项目全部恢复为通过。GitHub Release 已有真实 Mac 与用户内网 Windows 的双向 ZIP 证据，更新下文 9 月 24 日的待测状态；GitCode ZIP 目前只确认 Windows → Mac 方向。Windows 生成 ZIP 的 SHA-256 为 `38a4961eb964c34bd8fc746a18c5a784c24b0a2b513e6aab393b8f9102bf3d12`，两个平台下载到相同字节。

报告的 **16 项中 9 项验证通过，7 项为保留的旧拒绝记录**：GitCode 1 MiB 二进制 HTTP 400；GitHub 评论附件接口两档 TXT / JSON / CSV / ZIP HTTP 422、1 MiB 二进制 HTTP 403。这 7 项的 `attempts=0`，此次未重试，不能解读为七次新上传失败，也不影响独立 Release ZIP 通道的通过。`summary.peer_verified=false` 只统计文本 `PEER_RECEIPT_VERIFIED`，恢复模式不重跑文本回执；本次 ZIP 接收成功由单项记录及独立下载证据确认。

仍需保留的边界：报告未记录成功项完整的重试响应与等待过程，不能据此确认本次是否再次收到 429、实际 `Retry-After` 或平台配额窗口。已验 ZIP 只含 128 KiB 合成载荷，未证明接近 5 MiB 的容量或任意实验包可用。持续轮询、任务状态协议与 NPU 实验执行器尚未实现。这一轮通道补测已完成，无需为已通过项目再次运行检查包。

## v0.1.5：限流恢复与独立 ZIP 通道

Issue #3 的真实 429 已在本地 HTTP 服务中复现：旧版将限流保存为永久拒绝并继续发送后续文件。修复后保存冷却时间，按 `Retry-After`（秒数或 HTTP 日期）暂停上传；无有效头时按 60 / 120 / 240 秒退避，在每平台 300 秒等待预算及每文件三次限流尝试内恢复。未完成项保留到下一次；超时和未知上传不自动重发。

`Run-Windows-Resume.cmd` 使用原 `reports` 中的记录，迁移旧 429，跳过评论容量测试及成功上传；不重试旧 400 / 403 / 422。公开 Release ZIP 通道独立于原评论附件接口，按完整 SHA-256 命名，先核对服务器已有资产，未知上传可在读回现有文件并校验后确认，不删除或覆盖资产。

Mac 已用真实 `Probe.ps1` 上传一个 131,190 字节的合成 ZIP，发布 Issue 链接后匿名下载校验成功：SHA-256 `f6f98c9176bc9ec555d3bf235121ad1f274570e0f1de0e90a1b02c7cbe1954ea`。[专用传输 Release](https://github.com/Kirrito-k423/AIConnector/releases/tag/probe-artifacts)。GitCode 的实际配额窗口仍未知；15 秒间隔是保守初值，不是限额结论。

本地新增回归覆盖：秒数/日期冷却、跨运行暂停、旧状态迁移、成功项不重发、永久拒绝不重试、Release 上传超时后只读恢复、状态文件丢失后的资产去重、对端 ZIP 下载与非法目标拒绝。[Windows PowerShell 5.1 回归](https://github.com/Kirrito-k423/AIConnector/actions/runs/35983078684) 41 项全通过，其中包含真实 ZIP 包中的恢复入口。

[独立实网 ZIP 测试](https://github.com/Kirrito-k423/AIConnector/actions/runs/35983123728) 已通过：托管 Windows 下载并校验 Mac 发布的 ZIP，然后使用实际 `Probe.ps1` 上传自己的 ZIP，发布评论链接并匿名下载校验。Mac 随后独立下载 Windows CI 的文件，SHA-256、ZIP CRC 和内部 131,072 字节载荷均通过；Windows ZIP 为 131,215 字节，摘要 `38a4961eb964c34bd8fc746a18c5a784c24b0a2b513e6aab393b8f9102bf3d12`。见 [ZIP 双向证据](docs/evidence/2026-09-24-zip-transfer.json)。不同 .NET ZIP 实现产生了不同封装字节，因此两端各自以实际文件 SHA-256 为准。

恢复模式优先处理 GitCode ZIP，再补测其他限流文件。内网 Windows 的 Release 写权限及 GitCode 真实冷却恢复仍需要该机器的运行证据，不能由托管 Windows 替代。

最终 v0.1.5 标签对应 `c4b8ae5`，[最终包回归](https://github.com/Kirrito-k423/AIConnector/actions/runs/35983535387) 与 [公开发布包验收](https://github.com/Kirrito-k423/AIConnector/actions/runs/35983977114) 均通过：Windows PowerShell 5.1 下 41 项测试通过；匿名下载实际 Release、全新中文空格目录解压、默认配置不修改、真实入口启动后 7 个下载样本全部校验成功。公开包验收为只读；ZIP 实网写入的证据来自上面的独立工作流。

Windows CI 构建、本地构建、公开下载的 ZIP 逐字节一致：26,123 字节，SHA-256 `e845da434c4208538289e1698d3c206edabe24403e8704c8f24531ace72e8e1f`。其余 8 个发布资产也与 Windows 构建一致。

## 2026-09-24：内网 Windows 写入与跨机器回执确认

已回收 [Issue #3 的 Windows 写入报告](https://github.com/Kirrito-k423/AIConnector/issues/3#issuecomment-5810898944)，并在外部 Mac 独立读取两个平台的评论、验证回执、下载附件。详细字节数、SHA-256、评论 ID 及失败 HTTP 状态见 [机器可读验证记录](docs/evidence/2026-09-24-write-verification.json)。本节更新 9 月 22 日“内网写入未测”的状态。

报告 ZIP 为 5,100 字节，CRC 正常，包含 JSON / Markdown / HTML；SHA-256 为 `dd8e17cc17ba1628de06cfa17807dd58aac1927bc0e212cd05a4ab6f7bc76cf1`。Windows PowerShell 5.1.26100.7705，v0.1.4 `Write`，运行完成；`completed=true` 不表示所有附件通过。

| 实际链路 | GitHub | GitCode |
|---|---|---|
| Windows 提交评论并独立读回 | 1 / 8 / 32 KiB 通过 | 1 / 8 / 32 KiB 通过 |
| Mac 独立读取 Windows 评论并核对字节、SHA-256、消息 ID | 1 / 8 / 32 KiB 通过 | 1 / 8 / 32 KiB 通过 |
| Mac 原先发送 → Windows 接收回执 → Mac `Verify` | 1 / 8 / 32 KiB 通过 | 1 / 8 KiB 通过；原先未发送 32 KiB |
| Windows 上传附件 → Mac 匿名下载并校验 SHA-256 | PNG 通过 | 1 KiB TXT、PNG 通过 |

Mac 已通过 GitHub `Receive` 为 Windows 的三档评论发布回执；尚未声称 Windows 后续执行过 `Verify`。GitCode 的 Windows 评论已在 Mac 校验，但 Mac 尚未为该方向发布回执。回执依赖本次两个节点实际分别运行的背景，不是设备身份认证。

剩余附件的实际失败原因必须分开记录：

- **GitCode 32 KiB TXT、JSON、CSV、ZIP：HTTP 429，属于限流，格式与容量仍未验证。** 不能将它们当成不支持的文件类型；[官方 API 状态说明](https://docs.gitcode.com/docs/apis/) 也将 429 定义为超过速率限制。当前报告没有保存这些上传响应的 `Retry-After` 或细分原因，无法确定具体限流窗口。
- GitCode 1 MiB 二进制：HTTP 400；仅凭现有日志不能判定是后缀、内容、参数或其他校验问题。
- GitHub 两档 TXT、JSON、CSV、ZIP：HTTP 422；1 MiB 二进制：HTTP 403。仅说明此次附件 API 请求未被接受；用户通过浏览器上传结果 ZIP 的路径已实际可用。

下载 GitHub 附件时应使用评论中保存的稳定 `github.com/user-attachments/assets/...` 链接。报告中的 `evidence.url` 是最后跳转地址且查询参数被脱敏；本次直接读取该 S3 地址返回 403，而使用评论里的稳定链接重新获取后为 HTTP 200，69 字节和 SHA-256 均正确。未复制或保存临时签名参数。

当前证据已支持用评论交换小型任务描述、参数和结果摘要，并通过已验证的附件传回图片。通用 ZIP 自动上传、限流后的待测项目恢复、持续轮询和实验执行器仍未完成。后续补测应只覆盖未确认项目，保留成功记录；不要求用户重复运行已经通过的检查。

## v0.1.4：写入测试及用户内网结果

本节更新下面历史记录中的待测状态。

用户 [v0.1.3 内网 Windows 报告](https://github.com/Kirrito-k423/AIConnector/issues/1#issuecomment-5774000653) 已回收并校验 ZIP：PowerShell 5.1.26100.7705 完成检查，GitHub 与 GitCode 公共评论可读；7 个下载样本中 6 个 SHA-256 正确，1 MiB 二进制在原默认 12 秒期限下超时。该超时不能说明平台容量上限，也不能证明没有收到任何字节。报告没有写入凭据，因此没有证明内网写入。

2026-09-22 在外部 Mac 实际执行的写入：

| 通道与路径 | 实测结果 |
|---|---|
| [GitHub #2 评论 API](https://github.com/Kirrito-k423/AIConnector/issues/2) | 1、8、32 KiB 中文合成正文提交成功，独立 GET 读回，字节数及 SHA-256 一致 |
| GitHub CLI / user-attachments 上传接口 | PNG 上传、发布链接、匿名下载及 SHA-256 校验成功；TXT（1 / 32 KiB）、JSON、CSV、ZIP、1 MiB 二进制均返回 422 |
| [GitCode #1 浏览器评论](https://gitcode.com/shaojiemike/AIConnector-Probe/issues/1) | 1、8 KiB 提交成功，随后通过匿名评论 API 读回并校验；32 KiB 尚未完成 |
| GitCode 附件 / 认证 API 写入 | 未完成；浏览器操作被本机锁屏中断，当前程序没有 GitCode Token |
| 用户内网 Windows 写入 / 双 PC 回执 | 尚未执行，不能用 Mac 或托管 Windows 结果代替 |

GitHub 附件在发布评论引用之前，匿名读取可能返回 404；发布后同一地址可读。探测程序已按“上传 → 发布链接 → 匿名下载校验”执行。422 结论只适用于本次 API 路径，**不代表 GitHub 浏览器或 Release 不支持这些文件**。此前用户已通过浏览器上传 ZIP。

v0.1.4 增加 `Run-Windows-Write.cmd`：预置两个专用目标，一次收集所需 Token，一次检查三档评论和七种附件，自动对已有 Mac 样本发送回执，最后输出一个报告 ZIP。写入请求默认 60 秒；仅上传内存生成的合成数据。附件请求前记录本地状态，结果不确定或重复运行时不自动再次上传。

Mac PowerShell 7.6.6 已对实际 `Probe.ps1 -Mode Write` 执行 GitHub 实网检查，结果与上表一致；GitCode 无 Token 明确记录为 `NEEDS_TOKEN`。本地模拟接口另外覆盖 multipart 文件字节、Base64 图片、评论与附件读回、内容损坏、超时不重传、重复运行、缺凭据不发送请求。

发布前 [Windows 回归](https://github.com/Kirrito-k423/AIConnector/actions/runs/35716793268) 与发布后 [公开包验收](https://github.com/Kirrito-k423/AIConnector/actions/runs/35717196502) 均通过，代码及标签对应 `36eaf5d`：

- Windows PowerShell 5.1.26100.33296：36 项测试全部通过。包含解压后的真实 `Run-Windows-Write.cmd`、中文空格路径、互联网来源标记及一次信任确认；向两个本地模拟 API 完成评论、附件、对端样本回执和 ZIP 报告。
- 公开包验收：匿名下载实际 v0.1.4，全新解压，默认配置未修改，一次启动只读入口完成 GitHub 评论读取及 7 个实网下载样本的 SHA-256 校验。此阶段没有外部写入。
- Mac：25 项通用测试通过，11 项 Windows 专用测试由上述 Windows CI 执行。
- Windows CI 构建、本地构建和匿名下载的发布包逐字节一致：21,419 字节，SHA-256 `16fed4e96269f788d96f60cc951be21efb1ad0c428a1ea241201caf39dac790d`；9 个发布资产（含校验文本和合成样本）与 CI 产物一致。

这些验收证明程序和交付入口按预期工作。用户内网的认证写入与双 PC 回执仍需该机器上的实际执行；GitCode 剩余浏览器测试也仍待解锁后进行。

## 本地程序验证

环境：macOS ARM64，PowerShell 7.6.6。运行时来自 PowerShell 官方 GitHub Release，未安装系统级模块。

```bash
PWSH=/path/to/pwsh python3 -m unittest discover -s tests -v
```

结果：16 项通过。覆盖只读扫描、空评论数组、HTML 假成功、认证未知与拒绝、带凭据重定向拦截、限流不重试、响应大小限制、超时、下载哈希、双方向收发、串行重复消息、损坏样本、不一致 POST 响应、GitHub 认证头、缺少 Token、分页截断、样本完整性（含 PNG CRC）及配置错误脱敏。

测试中的两节点和评论平台均由本机进程及 HTTP 模拟服务提供，**不代表 Windows 或真实跨网段验证**。

## v0.1.1：Windows 启动和兼容性回归

[GitHub 托管 Windows 测试记录](https://github.com/Kirrito-k423/AIConnector/actions/runs/35682791272)，源代码提交 `55089e5`。Windows PowerShell 5.1 下 21 项测试全部通过，包括上述 16 项通用测试，以及 5 项 Windows 启动测试：

- `RemoteSigned` 下带互联网来源标记的未签名脚本确实被拒绝，日志正确记录原因。
- `AllSigned` 仍被执行，没有放宽策略。
- 脚本退出码在收集诊断后保持不变。
- 正常运行不会被误报为失败。
- `--diagnose` 只读取诊断，不执行探测脚本。

Windows 测试中还定位并修复了 PowerShell 5.1 / 7 根 JSON 数组枚举差异，以及从 PowerShell 7 启动 Windows PowerShell 时诊断模块路径可能不兼容的问题。

这些是实际 Windows 操作系统上的回归测试；HTTP 服务仍为模拟服务，执行策略由测试进程设置，**不代表用户内网机器的组织策略、外网可达性或跨机器通信已验证**。

## v0.1.2：默认参数与完整入口回归

Issue #1 后续日志确认下载标记已经解除，失败点转为参数默认值中的 `$PSScriptRoot` 为空。此前测试显式提供 Config 和 OutputDir，启动器测试主要使用替身脚本，未覆盖这条默认启动路径。

修复将默认路径的解析移到参数绑定完成之后。新增测试覆盖两个路径都默认、单个路径默认、从其他目录启动、无配置文件时的 Samples 模式，以及 Run-Windows.cmd 调用真实 Probe.ps1 完成 Scan。

[GitHub 托管 Windows 测试记录](https://github.com/Kirrito-k423/AIConnector/actions/runs/35695017923)，源代码提交 `e0582a6`：Windows PowerShell 5.1 下 24 项测试全部通过。Mac PowerShell 7.6.6 下 18 项通用测试通过、6 项 Windows 专用测试跳过。测试网络仍为本机模拟 HTTP 服务；用户内网机器更新后的扫描结果尚待回读。

## Mac 真实网络观测

使用默认配置，未提供 Token，没有发送外部评论。分别使用显式代理 `http://127.0.0.1:7890` 和关闭 HttpClient 代理的 `direct` 模式。

| 操作 | 显式代理 | direct |
|---|---|---|
| GitCode 网页 GET | HTTP 200 | HTTP 200 |
| GitCode 身份 API GET | HTTP 403 | HTTP 403 |
| GitHub 网页 GET | HTTP 200 | HTTP 200 |
| GitHub 身份 API GET | HTTP 401 | HTTP 401 |

网页 200 仅证明 HTTP 有响应。GitCode 403 尚不能区分网关、风控、认证要求或权限问题。GitHub 未带 Token 返回 401，认证后能力未测。

原始记录保留在本机 `reports` 中，上表是本次观测摘要。运行探测器可在自己的环境生成新的完整 JSON 和 Markdown 报告。

## 仍待真实环境验证

- 用户内网 Windows 的实际执行策略、启动及网络结果。
- 指定测试 Issue 的真实认证、读取和评论写入。
- Mac / Windows 的双向样本和回执。
- 实际附件上传后的对端下载、原始字节校验和容量区间。

当前提供的探测器可以采集以上后续证据；没有把未知项报告为通过。

## v0.1.3：一次运行与发布包验收

前两轮的验收缺口是用显式参数和替身脚本代替用户入口，没有把下载包、解压、来源标记、默认配置和报告交付连成一条检查。v0.1.3 把这条流程加入发布验收，用户不再负责逐项改配置。

本地 PowerShell 7.6.6：原有 20 项非 Windows 专用检查通过；增加跨平台换行测试后，该项及包级检查也通过。Windows 专用检查由 Windows CI 实际执行。新增构建后 ZIP 的中文空格路径、完整配置与合成文件清单、可复现构建、失败项目后继续检查、报告 HTML/JSON/Markdown/ZIP 一致性检查。

Windows 验收包含两层：

- 回归层：实际系统 PowerShell 5.1 和 cmd，解压后的 ZIP，NTFS 下载标记，接受/拒绝信任，包损坏、AllSigned、启动诊断，模拟 HTTP 错误分支。
- 发布层：匿名下载实际 Release ZIP，全新目录解压，保留原始默认配置，设置与互联网下载相同的脚本来源标记，确认后只启动一次，检查公共 Issue 和 7 个真实文件下载。使用 cmd 调用入口，不冒称鼠标操作或 Explorer 解压 UI 已自动验证。

用户最新 [Issue #1 报告](https://github.com/Kirrito-k423/AIConnector/issues/1#issuecomment-5773008430) 已证明旧包在其 Windows PowerShell 5.1.26100.7705 上完成只读扫描；默认公共评论和文件下载当时没有配置，因此不算这些能力通过。此前“用户机器尚未扫描成功”的历史记录已被此证据更新。

最终结果：[完整 Windows 验收记录](https://github.com/Kirrito-k423/AIConnector/actions/runs/35704679571)，代码与发布标签对应 `3421a6d`。

- Windows PowerShell **5.1.26100.33296**：**31 项测试全部通过**。
- 独立发布验收任务匿名下载 v0.1.3，解压到中文空格路径，从其他目录启动真实入口；默认配置未修改，带互联网来源标记的脚本经一次确认后运行完成。
- 公共 Issue 读取通过；7 个真实下载样本全部与预置 SHA-256 一致；一次生成 JSON、Markdown、HTML 和回传 ZIP。未向外部发布评论。
- Mac 经本机 HTTP 代理的实网检查也完成上述公共读取和 7 个文件校验。GitCode 匿名身份接口返回 403，但公共 Issue 列表和评论接口可读；此次自动选中 Issue 的评论数组为空。说明身份接口 403 不能代表整个通道不可用。
- Windows CI 构建 ZIP、本地构建 ZIP、从公开 Release 匿名下载的 ZIP **逐字节相同**：`8375fd909d0710bce13c2f1366a1407c3199da76af3beff79610e29e8bf65f6f`，17,846 字节。7 个合成样本也逐字节一致；独立 SHA 文本清单允许平台换行差异，摘要相同。

此结果证明发布包在 GitHub 托管 Windows 的真实入口和外部网络运行成功。用户内网的 v0.1.3 结果、双机回执、自动附件上传与 NPU 任务执行仍需各自的真实证据，不计入此次通过结论。

## 2026-09-26：专用 Relay 布局 v1

默认任务通道改为公开的 `Kirrito-k423/AIConnector-Relay`；程序自动管理每任务 Issue、每运行 Release 和不可覆盖的 ZIP。任务事件格式保持 v1，旧单 Issue 配置兼容。完整格式见 [RELAY.md](docs/RELAY.md)。

- 本机 PS7：旧协议 27 项回归通过；新布局覆盖多任务、修订与重跑、错误归属、重复/修改的 Issue、Release 元数据、分页失败、创建超时、限流和 UTC 时间规范化。
- 真实 GitHub：同一任务完成两次合成运行；最终运行使用内容不同的输入/结果 ZIP，分别为 191 / 190 字节，完成五阶段事件及两端下载校验，重启领取返回 execute=false。[任务 Issue](https://github.com/Kirrito-k423/AIConnector-Relay/issues/1)；[机器证据](docs/evidence/2026-09-26-relay-layout.json)。
- 实网两端均是 Mac 上独立 PowerShell 进程；没有调用用户内网、SSH 或 NPU。[Windows PS5.1 的 91 项测试通过](https://github.com/Kirrito-k423/AIConnector/actions/runs/36211213575)，包含新旧布局的真实 cmd 包入口；[公开包全新下载验收通过](https://github.com/Kirrito-k423/AIConnector/actions/runs/36211347383)，默认配置未修改。候选包 v0.3.0-rc.1：33,543 字节，SHA-256 `eb0650d0e359bf62bbe62c751c637d900bbf0fbc839b4ac0e83672a10a971272`。
- v0.3 新默认状态目录为 connector-state-relay，原 v0.2 状态目录保留。新布局只支持公开 GitHub；API Token 需授权专用仓库的 Issues 与 Contents。

## 2026-09-26：Pi 环境与工具集成 0.5.0

Issue #6 的 Windows 报告确认现有回环模型网关与 Relay 轮询工作；本次保留该配置，并新增本地上下文快照、simpleHtmlWatch 工具、独立网页传输与 Pi 自动压缩。

- 本机 Node 集成测试：20 项通过；Windows DPAPI 1 项按平台跳过。使用锁定的真实 Pi SDK，自动产生压缩记录后继续任务，CPU 实验只启动一次。
- 两端服务回归：5 项通过；Windows 启动器 1 项按平台跳过。覆盖输入/结果 ZIP、五阶段回执、主服务重启、网络中断和 worker 异常退出。
- SHW 受控 HTTP 验收：提交响应丢失后重建客户端只查原任务、Token 轮换、实际版本证据、未知状态、受限 tar 解析与按 outputs 导出。
- 网页受控 HTTP 验收：Node 与 curl 两种传输，搜索 URL 编码、跨主机重定向拒绝、响应大小上限、不继承业务凭据。
- 浏览器验收：填写全局说明、修改轮数与 curl 选项，保存成功并只读检查到 SHW fixture；未触发真实 SSH。页面检查不代表公司网络通行。
- Windows 安装包与 Mac 安装包的最终结果、SHA-256 和 CI 链接随 v0.5.0-rc.1 Release 提供。未以本机结果代替真实 Windows 内网、真实供应商长上下文或 NPU 实验验收。
