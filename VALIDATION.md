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
