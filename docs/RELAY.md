# 专用运行仓库：组织规则 v1

AIConnector 的程序、安装包、缺陷反馈继续放在 `Kirrito-k423/AIConnector`。正式任务记录与实验交付件放在公开仓库 **`Kirrito-k423/AIConnector-Relay`**。后者由程序维护，不提交实验源码，不要求内网机器 clone 或 push。

这是 `aiconnector.config.v2` 默认且固定的 `task-issues-run-releases-v1` 布局。标题、正文、元数据、Tag、资产名称由程序生成，没有需要 AI 自由发挥的模板。事件仍使用任务协议 v1。

## 对象如何对应

| 对象 | GitHub 中的位置 | 不变身份 |
|---|---|---|
| 一项任务 | 一个 Issue | `namespace + task_id` |
| 任务修订 | 原 Issue 中新的 task 评论 | `task_id + revision` |
| 一次运行 | 原 Issue 中一组事件、一个独立 Release | `task_id + revision + run_id` |
| 输入与结果 ZIP | 对应运行的 Release Assets | 方向、节点、完整 SHA-256 |
| Connector 软件版本 | 原代码仓库的 Release | `v0.x.y` |

例如 `datacopy-a3/1/run-001` 和 `datacopy-a3/1/run-002` 是同一任务、同一内容的两次运行，共用一个 Issue，有两个 Release。改入口、参数、验收条件、输入字节或代码版本需要 revision=2。只改变运行文件所在的 Release URL 不算改变实验内容。

## 仓库声明

仓库必须包含 `.aiconnector/relay.json`，其内容与本地配置精确匹配：

```json
{
  "schema": "aiconnector.relay.v1",
  "repository": "Kirrito-k423/AIConnector-Relay",
  "namespace": "experiments-v1",
  "layout": "task-issues-run-releases-v1",
  "protocol": "aiconnector.task.v1",
  "max_artifact_bytes": 5242879
}
```

每轮收发与上传前读取声明，防止配置误指向代码仓库或其他仓库。新仓必须有 main 分支的初始提交，供 GitHub 创建运行 Release 的 Tag；这个 Tag 仅用于附件归档，**不是实验代码版本**。实验代码版本仍以 task.code.revision / result.actual_revision 为准。

维护者可用 `python3 tools/bootstrap_relay.py --apply` 创建、初始化专用仓库。普通 Mac/Windows 用户只需运行安装包，不需要 Python、Git 或 gh。

## Issue 标题和正文

自动标题：

```text
[AIC][datacopy-a3] 测量 DataCopy 的批次与带宽
```

固定标签：`aiconnector:task`、`aiconnector:protocol-v1`。不将不断变化的运行状态塞入标题或标签：一个任务可能有多个运行，单个“成功”标签容易掩盖其他失败运行。

正文以 `AIConnector task issue v1` 开头，展示最初任务标题、目标、ID、协议说明，最后是机器元数据：

```json
{
  "schema": "aiconnector.task-issue.v1",
  "namespace": "experiments-v1",
  "task_id": "datacopy-a3",
  "coordinator": "mac-outer",
  "worker": "windows-inner"
}
```

正文作为固定任务登记页，不随着运行反复改写。完整任务要求以相应修订的 task 事件为准。程序通过元数据和平台返回的允许作者识别任务，不通过标题或标签猜测；PR、普通 Issue、其他命名空间和未授权作者均不作为任务通道。同一任务出现两个有效 Issue 会停止并报告 `DUPLICATE_TASK_ISSUE`。

## 评论的正文与机器协议

每条事件是一条追加评论，结构固定：

1. 第一行 `AIConnector task v1`。
2. 中文阶段、`task_id/revision/run_id`、发送与接收节点。
3. 该次运行 Release 链接。
4. 人类可读内容：任务的目标、代码、环境、入口、验收；或结果的结论、退出码、实际版本、指标。
5. 每个 ZIP 的直接下载链接、字节数和 SHA-256。
6. 最后的 JSON 代码块：完整事件信封。

信封包含 `schema / namespace / task_id / revision / run_id / kind / sender / receiver / parent / payload_b64 / payload_sha256 / event_id`。Base64 内是结构化 UTF-8 JSON，不是加密；上方正文给人阅读，下方用于无歧义校验。完整字段和因果关系见 [任务协议](PROTOCOL.md)。

事件链保持 `task → accepted → started → result → receipt`。`started` 表示持久化领取，尚未表示远端进程实际开始；`receipt` 表示完整收到，并不表示实验达标。失败和阻塞结果同样可以回执。后续 Runner 的实际开始/结束时间需要独立证据，不能用评论发布时间代替。

普通人工备注允许存在，但不会变成执行指令。修改已导入的协议评论或登记正文会停止推进。关闭 Issue 是整理页面，不取消任务、不重新派发、不表示实验成功；程序读取 open 和 closed 的任务记录。要重复实验创建新的 run_id。

## Release 和 ZIP

固定 Tag：

```text
aic-v1.<namespace>.<task_id>.r<revision>.<run_id>
aic-v1.experiments-v1.datacopy-a3.r1.run-001
```

ID 不允许点号，因此这些字段不会产生分隔符歧义。Release 标题是 `[AIC][datacopy-a3][r1][run-001]`，公开、非 draft，标记 prerelease 且 `make_latest=false`。它用于运行归档，不发布软件。

Release 正文以 `AIConnector run release v1` 开头，包含运行身份、任务查找链接、文件规则及如下元数据：

```json
{
  "schema": "aiconnector.run-release.v1",
  "namespace": "experiments-v1",
  "task_id": "datacopy-a3",
  "revision": 1,
  "run_id": "run-001"
}
```

资产名称固定为：

```text
input--mac-outer--<完整64位SHA256>.zip
result--windows-inner--<完整64位SHA256>.zip
```

上传需要明确所属运行：

```sh
# Mac：在 Submit 前上传输入，将返回的清单放入 task.artifacts
pwsh -NoProfile -File ./Connector.ps1 -Node mac-outer -Action Upload -Key datacopy-a3/1/run-001 -File input.zip -PromptToken
```

```bat
REM Windows：Claim 后上传结果，将返回的清单放入 result.artifacts
Connector-Windows.cmd -PromptToken -Action Upload -Key datacopy-a3/1/run-001 -File result.zip
```

首次输入上传可以先创建 Release；没有附件时发布 task 也会创建对应 Release。输入和结果共享该次运行的 Release。返回的 `name / bytes / sha256 / url` 清单放入协议载荷。程序拒绝引用其他运行、其他节点方向、其他仓库或名称与摘要不一致的附件。相同文件在同一运行去重；另一次运行有自己的 URL。

每个 ZIP 严格小于 5 MiB，任务和结果各最多五个；接收前验证大小和 SHA-256。软件上限不等于内网已验证容量。文件只能追加，不覆盖、不删除；不自动解压或执行。公开仓库内的任务说明和 ZIP 都公开，凭据只保存在本机。

## 持久化与恢复

创建 Issue、创建 Release、发评论、上传文件都先保存待写记录。写入结果不明时，先通过独立 GET 查证；未找到也不自动重发。明确限流持久化冷却，明确拒绝可修复权限后调用 RetryRejected。对象创建和其他写入共享写入间隔，首次任务可能跨几次轮询完成登记。

RetryRejected 的 Key 是 status.json 中 provisions 的原始键，例如 `issue:datacopy-a3`、`release:datacopy-a3/1/run-001`。ZIP 对应 `upload:<运行键>:<SHA256>`；评论仍使用 event_id。它们都只接受 rejected，拒绝强行重试 uncertain。

状态输出包含 Issue/Release 链接，以及按因果阶段排列的 timeline：平台作者、逻辑节点、事件 ID、平台发布时间、首次本地观察时间、评论链接。平台发布时间和本地观察时间分别保存，不混为实验执行时间；旧记录缺失的时间保持未知。

默认轮询完整读取 Issue 列表及每个任务的评论列表，排除 PR；分页不完整则不导入部分事件。每个列表受 max_pages 限制，本地状态仍有 16 MiB 上限。当前面向小规模实验，尚未实现大规模增量同步或自动归档压缩。

## 从 v0.2.0 升级

新默认配置使用独立的 `connector-state-relay/<node>`，不会重置原 `connector-state/<node>` 或搬运旧 Issue 的历史。两端需一起使用新包，并为新仓库授予 Issues 和 Contents 写权限。旧仓库和旧状态保留用于历史查看。

需要继续旧通道时，显式使用 `-Config examples/connector.legacy.config.json`；旧配置仍采用单 Issue / 单 Release 布局，并兼容 GitCode 评论。新布局只用于已验证 GitHub API 的专用仓库。

接口依据：[GitHub Issues](https://docs.github.com/en/rest/issues/issues)、[Issue comments](https://docs.github.com/en/rest/issues/comments)、[Releases](https://docs.github.com/en/rest/releases/releases)。
