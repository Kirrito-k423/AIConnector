# AIConnector：一次运行的通道检查包

检查内外 PC 能通过哪些渠道交换实验任务和结果。Windows 使用系统自带 PowerShell 5.1，不需要 Python、管理员权限或联网安装依赖。

[下载 Windows 检查包 v0.1.4](https://github.com/Kirrito-k423/AIConnector/releases/download/v0.1.4/AIConnector-Probe.zip) · [SHA-256](https://github.com/Kirrito-k423/AIConnector/releases/download/v0.1.4/AIConnector-Probe.zip.sha256) · [验证记录](VALIDATION.md)

## 用户只需一次运行

1. **完整解压** ZIP，双击 `Run-Windows.cmd`。
2. 如果提示下载来源标记，确认信任此包且环境允许后输入 `Y`，本次继续完成检查。
3. 将 `reports` 中本次生成的 **一个 ZIP** 回传。旁边的 HTML 可直接在浏览器查看。

**不需要改配置、填写仓库或逐项重新运行。** 没有 Token 也会完成所有不需要凭据的检查。部分通道失败时，其余检查继续；结果会明确标出失败或未验证原因。默认网络超时为每项 12 秒，完整检查通常需要几十秒至几分钟。启动阶段失败也会自动生成诊断 ZIP。

默认预置：

| 检查 | 本次自动执行的内容 |
|---|---|
| 环境 | 包内脚本校验、PowerShell；启动失败时收集执行策略、签名和下载标记 |
| 网页 / API | GitCode、GitHub 的脚本 HTTP 访问和身份接口响应 |
| 公共评论 | 读取 GitHub AIConnector Issue #2 和 GitCode AIConnector-Probe Issue #1 |
| 实际文件 | 下载并校验 TXT（1 KiB、32 KiB）、JSON、CSV、PNG、ZIP（内含 128 KiB 数据）、1 MiB 二进制，共 7 个合成样本 |
| 报告 | 中文 HTML、Markdown、机器可读 JSON，自动打为一个 ZIP |

下载样本来自本项目 GitHub Release，分别记录 SHA-256。验证一个 1 MiB 文件并不代表测出了平台容量上限；也不证明 GitCode 附件、网盘或公网服务器可用。

默认只发 GET 请求，不发布评论、不上传本地文件。**单机检查可以一次完成；跨网段双向通信仍需两端实际运行并取得对端回执。** 没有凭据的写入权限、附件上传和双机通信会明确保留为未验证，不会包装成全部通过。

## 一次完成写入检查

双击 **Run-Windows-Write.cmd**。程序先显示两个专用测试目标，再分别询问 GitHub / GitCode Token（隐藏输入，各一次；已有环境变量则不询问）。请在本机输入，不要把 Token 发到 Issue 或聊天。

已预置的目标：[GitHub #2](https://github.com/Kirrito-k423/AIConnector/issues/2)、[GitCode #1](https://gitcode.com/shaojiemike/AIConnector-Probe/issues/1)。使用相应账号已有的、获准写入这些仓库的凭据。

本次依次检查：

- 1、8、32 KiB 合成中文评论的提交及独立读回校验。
- 对已存在的 Mac 样本自动核对并发送回执。
- TXT、JSON、CSV、PNG、128 KiB ZIP、1 MiB 二进制的附件接口，提交链接后再匿名下载核对 SHA-256。
- 自动生成一份 HTML / JSON / Markdown 报告和回传 ZIP；某个平台失败时继续另一个平台。

文件全部在内存中合成，不读取用户实验文件。写入与附件下载默认每请求 60 秒；无自动上传重试。`write-state-*.local.json` 用于保存附件上传进度，未知写入不会在重跑时自动重复；请保留它。`UPLOAD_REJECTED` 表示当前 API 路径明确拒绝，不等于浏览器上传也不支持。GitHub 当前评论附件 API 实测支持 PNG，但对其他六个样本返回 422；GitCode 使用其官方图片与文件上传接口。

没有 Token 的平台会标为 `NEEDS_TOKEN`，不能算测试完成。生成回执也不等于 Mac 已读到；Mac 还需要读取回执验证。无需重新执行只读扫描。

命令行可使用 `Probe.ps1 -Mode Write -Node windows-inner -PromptToken`。Mac 可运行 `pwsh -File ./Probe.ps1 -Mode Write -Node mac-outer -PromptToken`。凭据也可由 `AICONNECTOR_GITCODE_TOKEN` / `AICONNECTOR_GITHUB_TOKEN` 提供，不写入报告。

## 下载标记与组织策略

发布包启动器内置了本包 `Probe.ps1` 的 SHA-256。文件不匹配时停止执行。该检查用于发现包内文件不一致，**不是发布者数字签名**。

仅当有效策略为 `RemoteSigned`、没有 MachinePolicy/UserPolicy 强制策略、脚本带互联网来源标记时，启动器才会询问是否解除这一个已校验脚本的来源标记。接受后在同次启动中运行；拒绝则保留文件原状。不会设置 `Bypass`，不会修改执行策略。`AllSigned`、`Restricted` 或组织策略限制仍需使用组织允许的方式处理。

依据：[Microsoft 执行策略](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)、[Unblock-File](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/unblock-file)。

需要仅诊断而不启动检查时，可运行 `Run-Windows.cmd --diagnose`。

## 报告如何读

| 状态 | 含义 |
|---|---|
| `PASS` | 指定评论或列表返回预期 API 数据 |
| `EXACT_BYTES_VERIFIED` | 下载字节与合成原文件 SHA-256 相同 |
| `HTTP_REACHABLE_ONLY` | HTTP 有响应，浏览器登录和网页功能未验证 |
| `NEEDS_TOKEN` | 未带 Token 返回 401，认证能力未验证 |
| `AUTH_REJECTED` | 已带 Token 仍返回 401 |
| `FORBIDDEN_OR_RATE_LIMITED` | 返回 403，不能仅凭这一项判定整个平台不可用 |
| `UNEXPECTED_API_RESPONSE` / `HASH_MISMATCH` | 响应结构或文件内容不符，可能是登录页、拦截页或被修改 |
| `NOT_TESTED` / `NOT_VERIFIED` | 尚无对应能力的充分证据 |

`completed=true` 表示本次检查运行完成，不表示所有通道通过。以每项状态为准。

## 开发者：代理和自定义目标

默认使用 .NET 系统代理配置，未必等于浏览器插件的配置。显式代理只作用于此次请求，不修改系统网络设置：

```powershell
.\Probe.ps1 -Node windows-inner -Proxy http://127.0.0.1:7890
.\Probe.ps1 -Node windows-inner -Proxy direct
```

这里的 `127.0.0.1` 指运行程序的这台 PC。Mac 可使用 PowerShell 7：`pwsh -File ./Probe.ps1 -Node mac-outer`。

自定义平台只读目标用 `read_repository` / `read_issue`；写入目标用 `repository` / `issue`。默认已指向本项目专用测试区。自定义配置通过 `-Config path` 传入；常规用户无需配置。

## 开发者：显式双机文本收发

此步骤属于后续通信验证，需要受控测试 Issue、写入权限和两端分别运行。默认写入目标已设置；以下自定义配置用于其他获准写入的目标。使用同一 Session：

```powershell
# 外部 Mac 发样本
./Probe.ps1 -Config ./probe.local.json -Mode Send -Channel github -Node mac -Peer windows -Session trial1 -PromptToken
# 内部 Windows 读取、校验并发布回执
./Probe.ps1 -Config ./probe.local.json -Mode Receive -Channel github -Node windows -Peer mac -Session trial1 -PromptToken
# Mac 校验对端回执
./Probe.ps1 -Config ./probe.local.json -Mode Verify -Channel github -Node mac -Peer windows -Session trial1
```

可交换 Node/Peer 测试反方向。正文上限 32 KiB，使用合成数据，包含字节数、SHA-256 和稳定消息 ID。顺序重跑会先查已有消息；不提供并发锁。写入结果不明确时不自动重发。回执用于连通性验证，不是设备身份认证。

未实现内网浏览器自动化、持续轮询任务队列或 NPU 实验执行。

## 开发者：发布前验收

```bash
PWSH=/path/to/pwsh python3 -m unittest discover -s tests -v
python3 tools/build_bundle.py
```

Windows CI 用系统 PowerShell 5.1 检查构建后的 ZIP、中文空格目录、真实 cmd 入口、NTFS 来源标记、信任确认、损坏包拒绝、AllSigned 和报告打包。HTTP 错误分支使用本地模拟服务。

发布后额外执行 `tools/validate_release.py v0.1.4`：从公网匿名下载真实 Release ZIP，校验、全新解压、不修改默认配置，启动并检查真实公共 Issue 与 7 个下载样本。此验收与用户内网通信证据分开记录。

接口依据：[GitCode 文件上传](https://docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-file-upload/)、[GitCode 图片上传](https://docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-img-upload/)、[GitHub CLI 附件实现](https://github.com/cli/cli/blob/v2.101.0/internal/attachments/client.go)。
