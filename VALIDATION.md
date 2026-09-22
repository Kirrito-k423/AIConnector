# 本次验证记录

日期：2026-09-22。

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

本地 PowerShell 7.6.6：30 项中 20 项通过，10 项 Windows 专用检查留给 Windows CI。新增构建后 ZIP 的中文空格路径、完整配置与合成文件清单、可复现构建、失败项目后继续检查、报告 HTML/JSON/Markdown/ZIP 一致性检查。

Windows 验收包含两层：

- 回归层：实际系统 PowerShell 5.1 和 cmd，解压后的 ZIP，NTFS 下载标记，接受/拒绝信任，包损坏、AllSigned、启动诊断，模拟 HTTP 错误分支。
- 发布层：匿名下载实际 Release ZIP，全新目录解压，保留原始默认配置，设置与互联网下载相同的脚本来源标记，确认后只启动一次，检查公共 Issue 和 7 个真实文件下载。使用 cmd 调用入口，不冒称鼠标操作或 Explorer 解压 UI 已自动验证。

用户最新 [Issue #1 报告](https://github.com/Kirrito-k423/AIConnector/issues/1#issuecomment-5773008430) 已证明旧包在其 Windows PowerShell 5.1.26100.7705 上完成只读扫描；默认公共评论和文件下载当时没有配置，因此不算这些能力通过。此前“用户机器尚未扫描成功”的历史记录已被此证据更新。

后续 Windows CI 和发布包实测结果在完成后补录。双机回执、自动附件上传与 NPU 任务执行仍未验证。
