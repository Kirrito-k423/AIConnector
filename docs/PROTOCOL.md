# 任务协议 v1

协议标记为 `aiconnector.task.v1`，与只读/写入探测的 `aiconnector.probe.v1` 分开。新默认布局为一项任务一个 Issue、一次运行一个 Release，具体标题和元数据见 [专用运行仓库](RELAY.md)。旧 config.v1 仍使用单个 Issue 通道。普通人类评论和旧探测评论均不会作为任务导入。

## 事件与身份

每个事件包含 `schema`、`namespace`、`task_id`、整数 `revision`、`run_id`、`kind`、`sender`、`receiver`、`parent`、`payload_b64`、`payload_sha256` 和 `event_id`。

- 运行身份为 `task_id/revision/run_id`；任务和运行 ID 仅允许小写字母、数字、下划线、连字符，长度 1–64。
- `payload_b64` 保存 UTF-8 JSON 的原始字节，`payload_sha256` 校验该字节串，最大 16 KiB。
- 事件 ID 是删除 `event_id` 后的 JSON 经键名按 ordinal 递归排序、压缩序列化，再取 UTF-8 SHA-256。字段名和控制值使用 ASCII；载荷由 Base64 传输，避免不同 PowerShell 的 Unicode 转义差异破坏跨端哈希。
- 评论包含中文状态和摘要，尾部代码块为完整协议；正文总量不超过 32 KiB。
- `namespace` 隔离同 Issue 的不同试验。节点固定为 `mac-outer` 与 `windows-inner`。导入同时核对平台返回的真实 `user.login` 与按节点配置的允许账号；不信任评论正文自称的作者。
- 摘要用于完整性和去重，不是数字签名。共用平台账号不能提供物理设备身份认证。

## 因果关系

| 事件 | 发布方 | 父事件 | 载荷 |
|---|---|---|---|
| `task` | Mac | 空 | 目标、代码基线、环境、入口、参数、验收标准、输入 ZIP 清单 |
| `accepted` | Windows | task | `status: accepted`；确认任务输入已校验 |
| `started` | Windows | accepted | `status: started`；确认持久化领取 |
| `result` | Windows | started | outcome、exit_code、actual_revision、summary、metrics、artifacts |
| `receipt` | Mac | result | `status: receipt`；确认结果和产物完整收到 |

事件可能乱序到达，只有完整且父 ID 相符的连续链才推进。相同事件重复出现会去重；同一运行同一阶段出现不同事件会标为冲突。已导入评论被修改后，该运行也会停止推进，避免把可变评论当作不可变历史。

任务输入示例见 [task.json](../examples/task.json)；结果示例见 [result.json](../examples/result.json)。指标仅作为数据记录，验收标准不会被转换成自动执行表达式。成功结果要求退出码为 0，并在回执前比较实际代码版本；失败或阻塞结果也可以被确认完整收到。

## 存储与投递

本地单一状态快照同时保存事件、已见评论摘要、领取、待发消息和上传进度。保存采用同目录临时文件、刷新、原子替换；校验摘要覆盖序列化的全部状态。状态损坏时停止，不自动回滚到可能丢失领取的旧快照。状态文件上限 16 MiB，保存超限时保留上一份完整快照并停止当前操作；另开通道时应保留旧目录，不能清空活跃任务的领取记录。

状态文件锁互斥所有读改写操作；轮询只在一轮处理期间持有该锁，睡眠时释放，以便内侧 AI 领取或提交。额外的轮询锁阻止同目录启动第二个 Watch。

发送前先把消息标为 `uncertain` 并落盘。发送后通过独立完整评论列表核对事件，才标记 `confirmed`。0.7.1 起，不可变协议事件在两次有间隔的完整读取仍缺失、且退避时间已到后，以原 `event_id` 和原正文重新排队。这是至少一次投递：迟到请求可能产生重复评论，接收端按事件 ID 去重，持久 Claim 不再授予第二次执行许可。恢复重传不创建新运行，也不重启 Pi / SSH。

ZIP 使用同一运行内的 SHA-256 文件名和原字节进行相同的读回恢复；同名文件不覆盖，遇到上传 422 会再查询现有资产并验证下载内容。分页失败、限流、错误响应不能作为缺失证据；连续读取失败会清空该次缺失计数。明确 429 或带限流证据的 403 仍持久化冷却，其他明确 4xx 拒绝保持人工处理。对象创建（Issue / Release 等 provisions）没有随之放开自动重试。详见 [交付恢复](ISSUE-9-FIX.md)。

0.7.4 的服务在调用 Claim 前持久化随机 `claim_owner`，通过本地参数 `-ClaimOwner` 交给 Connector。领取与 started outbox 原子保存该身份；相同身份、未完成且无协议冲突时，可重复取回同一 `claim_event_id` 和任务，不新建事件或领取。身份不写入公开协议。不同身份、无身份旧领取、已有结果均不授予执行权限。Runner 只在无领取返回确认、PID、spec、worker、进程退出、实验意图及结果文件时允许重取，并在启动前保存不可跨越的本地记录。重试间隔指数退避为 1–60 秒，实际发起时间还受服务调度周期约束。

此设计提供持久化去重与同一次本地领取的恢复，不承诺跨状态丢失、外部执行器或多台同身份机器的 exactly-once 执行。存在启动证据或身份不明时仍需核查实验实际状态，不能靠 TTL 自动释放或接管。具体边界见 [Issue #11](ISSUE-11-FIX.md)。

轮询采用完整分页读和事件去重，先保证不会因时间游标或乱序跳过消息。每次最多 `max_pages × 100` 条，达到上限停止推进；持续增长的 Issue 需要另开通道配置与状态目录。当前不使用 webhook、ETag 增量同步或数据库服务。

## 文件与平台

ZIP 清单包含 `name`、`bytes`、`sha256`、`url`，最多五个，各小于 5 MiB。稳定地址必须匹配配置中的 HTTPS 路径前缀；本地 HTTP 仅允许 loopback 测试。下载不携带平台 Token，禁止 HTTPS 降级；写入请求不跟随重定向。缓存以 SHA-256 命名，不解压或执行产物。

新布局的 GitHub Release 按 namespace/task/revision/run 归档，资产使用 input/result、节点、完整 SHA-256 命名，先完整分页检查已有资产；未知上传仅可用现有资产下载校验后恢复确认。平台拒绝、容量上限和持续运行吞吐均需单独实测。

依据：[GitHub Issue 评论接口](https://docs.github.com/en/rest/issues/comments)、[GitHub API 限流建议](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)、[GitCode 评论列表接口](https://docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-issues-number-comments/)。
