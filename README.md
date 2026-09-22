# AIConnector：通道探测原型

先测清楚内外两台 PC 能通过什么渠道交换数据，再决定实验中间件如何实现。

第一版提供 Windows PowerShell 5.1 / PowerShell 7 脚本，无第三方模块。Windows 不需要 Python，不需要联网安装依赖。Mac 使用 PowerShell 7。

下载：[Windows 探测工具包](https://github.com/Kirrito-k423/AIConnector/releases/download/v0.1.1/AIConnector-Probe.zip) · [SHA-256 校验文件](https://github.com/Kirrito-k423/AIConnector/releases/download/v0.1.1/AIConnector-Probe.zip.sha256) · [版本说明](https://github.com/Kirrito-k423/AIConnector/releases/tag/v0.1.1)。

## Windows：先做不需要账号的检查

1. 将整个压缩包解压到一个目录。
2. 双击 `Run-Windows.cmd`。
3. 查看 `reports` 中最新的中文 `.md` 报告；同名 `.json` 供后续程序汇总。

如果程序启动失败，启动器会保留真实退出码，生成 `reports/startup-*.txt`，记录报错、执行策略、脚本签名状态和下载来源标记。启动失败不算网络探测失败，也不再提示“报告已保存”。

如果只能传递文本，可以只复制 `Probe.ps1` 内容，在 Windows 保存为 **UTF-8 with BOM** 的同名文件，在 PowerShell 中运行 `.\Probe.ps1 -Node windows-inner`。初次只读检查有内置默认配置，不依赖其他文件；BOM 用于确保 Windows PowerShell 5.1 正确读取中文。

第一次运行只发送 GET 请求，检查 GitCode / GitHub 网页和身份 API。**不会创建 Issue、发评论、上传本机文件，也不会改变代理或脚本执行策略。** 如果环境策略禁止执行脚本，保留系统提示作为运行环境限制，不将其误报为平台网络失败。

默认使用运行时的系统代理配置。需要比较直连时，在解压目录打开 PowerShell：

```powershell
.\Probe.ps1 -Mode Scan -Node windows-inner -Proxy direct
```

指定已有的 HTTP 代理：

```powershell
.\Probe.ps1 -Mode Scan -Node windows-inner -Proxy http://127.0.0.1:7890
```

`127.0.0.1` 指运行脚本的这台机器，不能把 Mac 的本机代理地址直接当成 Windows 可用的代理。`system` 也不保证和浏览器扩展、浏览器独立登录状态使用同一路径。

## 启动报错：未进行数字签名（Issue #1）

这表示 PowerShell 在执行 `Probe.ps1` 之前拦截了它，还没有进行网络测试。仅凭这条报错，不能判断是 `RemoteSigned` 加下载来源标记，还是 `AllSigned` 等签名要求。

新版启动器失败后会自动收集只读诊断；也可仅诊断、不启动探测器：

```bat
Run-Windows.cmd --diagnose
```

| 诊断结果 | 对应处理 |
|---|---|
| `EffectivePolicy: RemoteSigned`，`ZoneId=3` 或 `4`，签名不是 `Valid` | 下载文件来源标记可能是直接原因。先核对下载包的 SHA-256 及来源，再按下方说明处理这一个文件 |
| `EffectivePolicy: AllSigned` | 本包脚本未签名；解除下载标记不能满足签名要求，需要受信任的代码签名 |
| `EffectivePolicy: Restricted` | 当前策略禁止脚本，需使用该环境允许的运行方式 |
| `MachinePolicy` 或 `UserPolicy` 不是 `Undefined` | 存在组织策略，按组织允许的签名和执行流程处理 |
| Zone、签名或策略无法读取 | 保留完整诊断，不把未知值当作“没有限制” |

如果确认是 **RemoteSigned + 下载来源标记**，并已核对这是自己信任的发布包，且所在环境允许解除这份文件的来源标记，可在解压目录的 PowerShell 中运行：

```powershell
Unblock-File -LiteralPath .\Probe.ps1
.\Run-Windows.cmd
```

这只解除 `Probe.ps1` 的下载来源标记，不修改执行策略，也不会给脚本添加数字签名。启动器不会自动执行此操作，不设置 `Bypass`，不改注册表或组织策略。依据：[Microsoft 执行策略说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)、[Unblock-File](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/unblock-file)。

## 报告如何读

| 状态 | 实际含义 |
|---|---|
| `HTTP_REACHABLE_ONLY` | 收到成功 HTTP 响应；浏览器登录和页面功能未验证 |
| `NEEDS_TOKEN` | 未带凭据收到 401；还不能判断认证后是否可用 |
| `AUTH_API_VERIFIED` | 身份 API 返回预期字段；还没证明 Issue 写权限 |
| `UNEXPECTED_API_RESPONSE` | 返回 2xx，但结构不是预期 API，可能是登录页或拦截页 |
| `FORBIDDEN_OR_RATE_LIMITED` | 403；权限、网关、风控或限流原因尚不能区分 |
| `NOT_FOUND_OR_NOT_VISIBLE` | 404；可能不存在，也可能没有读取权限 |
| `TIMEOUT` / `TLS_ERROR` / `DNS_ERROR` / `NETWORK_ERROR` | 对应请求失败；单次失败不代表永远不可达 |
| `NOT_CONFIGURED` / `NOT_TESTED` | 尚无证据，不能当作成功或失败 |
| `POST_ACCEPTED` | 平台接受评论，尚未证明对端收到 |
| `RECEIVED_AND_RECEIPT_POSTED` | 接收端校验样本后提交了回执 |
| `PEER_RECEIPT_VERIFIED` | 发送端看到了匹配回执，须两台真实机器分别运行才证明跨网段 |
| `EXACT_BYTES_VERIFIED` | 下载文件与提供的原文件 SHA-256 完全一致 |
| `DOWNLOADED_UNVERIFIED` | 拿到了响应，但没有原文件校验值，不能排除登录页等错误内容 |
| `HASH_MISMATCH` | 下载内容被改变，或拿到错误页面 |

报告记录请求时间、HTTP 状态、响应字节数、SHA-256、内容类型，不保存网页/API 正文、Token 或 URL 查询参数。网页与身份 API 的响应上限为 2 MiB，附件下载为 16 MiB；超出只记为探测器限额，不推断平台最大容量。

## 文本：验证两台机器之间的往返

需要一个专用测试 Issue。把配置 `probe.config.json` 中选定渠道的 `repository` 和 `issue` 填好，例如：

```json
{
  "name": "gitcode",
  "provider": "gitcode",
  "website": "https://gitcode.com/",
  "api_base": "https://api.gitcode.com/api/v5",
  "token_env": "AICONNECTOR_GITCODE_TOKEN",
  "repository": "your-owner/your-test-repo",
  "issue": "123"
}
```

可以保留另一个渠道的空配置，也可以删除其配置对象。GitHub 的 `provider` 为 `github`、`api_base` 为 `https://api.github.com`。不要把 Token 写进配置或命令行；下面的 `-PromptToken` 会以隐藏输入方式提示。也可以由本机凭据管理流程注入 `token_env` 指定的环境变量。

**Send 会创建一条样本评论；Receive 会创建一条校验回执。只写入配置指定的 Issue，不创建或关闭 Issue，不删除评论。** 同一 Session、方向和大小的重复运行会先查询已存在的消息，避免串行重试重复发帖；这不是生产级并发锁。

两端设置同一个 Session，例如 `probe-001`，不同的 Node 名称。

Mac 发 1 KiB 文本（包含中文和换行）：

```powershell
pwsh -NoProfile -File ./Probe.ps1 -Mode Send -Node mac-outer -Peer windows-inner -Session probe-001 -Channel gitcode -SizeBytes 1024 -PromptToken -Proxy http://127.0.0.1:7890
```

Windows 接收并回执：

```powershell
.\Probe.ps1 -Mode Receive -Node windows-inner -Peer mac-outer -Session probe-001 -Channel gitcode -PromptToken
```

Mac 确认回执：

```powershell
pwsh -NoProfile -File ./Probe.ps1 -Mode Verify -Node mac-outer -Peer windows-inner -Session probe-001 -Channel gitcode -PromptToken -Proxy http://127.0.0.1:7890
```

然后交换方向：Windows 执行 Send，Mac 执行 Receive，Windows 执行 Verify。两端 Node/Peer 对调，Session 保持一致。

可按需要将 `SizeBytes` 增至 8192 或 32768，逐档做同样的往返。该参数是 **UTF-8 样本正文** 的字节数；完整评论还包含协议字段和 Markdown 包装，发送报告会另外记录完整评论正文大小。成功只能说明这个大小本次可用，不能宣称已测出平台最大值。工具不自动增加大小、不连续刷屏、不对写入超时自动重发。

公开 Issue 的 Verify 可以不带 Token；私有 Issue 需要相应读取权限。回执基于受控测试 Issue 和节点标签，不构成密码学设备身份认证；不要把此测试协议直接用作任意命令执行通道。

## 文件：测试浏览器上传后的下载完整性

生成合成样本：

```powershell
.\Probe.ps1 -Mode Samples -Node windows-inner
```

输出 `reports/samples`：1、8、32 KiB 文本，JSON、CSV、1×1 PNG 和 `manifest.json`。每个文件有实际字节数和 SHA-256；不收集真实实验文件。

1. 在现有可用浏览器中尝试上传需要测试的样本，记录不允许的文件类型。
2. 将实际下载链接填入配置的 `downloads`，SHA-256 从清单原样复制。
3. 在另一台机器运行 Scan，检查是否为 `EXACT_BYTES_VERIFIED`。
4. 反方向重复；图片如果被平台转码，哈希不一致会明确显示。

```json
"downloads": [
  {
    "name": "text-1024.txt",
    "url": "https://your-actual-download-url",
    "sha256": "这里填写清单中的64位SHA-256"
  }
]
```

下载不携带平台 Token、浏览器 Cookie 或系统登录凭据。若浏览器能下载而脚本不能，报告记录这个能力差异；需要登录的附件自动化下载属于下一步适配范围。带认证的 API 请求遇到重定向会停止，避免 Token 被带到其他地址；若平台迁移，应核对官方 API 地址后更新配置。

## 当前范围和验证边界

- 已实现：GitCode/GitHub 的 HTTP、身份 API、指定 Issue 评论读取；双节点文本样本和回执；有界下载及文件校验；中文 Markdown/JSON 报告。
- 尚未实现：浏览器自动化、网盘 SDK、附件自动上传、长期轮询、NPU 任务执行、自动选择中转路由。现阶段先得到实际可用性证据。
- Windows 目标为系统自带 PowerShell 5.1；本次开发验证在 macOS ARM64 + PowerShell 7.6.6 进行，Windows 真机结果待采集。
- 本地 HTTP 模拟服务覆盖协议与错误处理，不替代真实 GitCode/GitHub 评论写入或两台机器的跨网络测试。

开发测试（Python 只供开发测试使用，Windows 用户运行探测器不需要它）：

```bash
PWSH=/path/to/pwsh python3 -m unittest discover -s tests -v
```

接口依据：[GitCode 读取评论](https://docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-issues-number-comments/)、[GitCode 创建评论](https://docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-issues-number-comments/)、[GitHub 评论接口](https://docs.github.com/en/rest/issues/comments)。网络策略、权限、容量和附件行为仍以两端实测为准。
