# 本次验证记录

更新日期：2026-09-24；下面按日期保留历史证据。

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
