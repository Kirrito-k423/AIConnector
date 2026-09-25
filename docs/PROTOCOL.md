# 任务协议 v1

协议标记为 `aiconnector.task.v1`，与只读/写入探测的 `aiconnector.probe.v1` 分开。单个 Issue 是一条通道的追加记录；普通人类评论和旧探测评论均不会作为任务导入。

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

发送前先把消息标为 `uncertain` 并落盘。发送后通过独立完整评论列表核对事件，才标记 `confirmed`。进程在任意一个写入点退出，重启后都先读回查证；查不到未知消息不会自动再次 POST。只有明确 429 或带限流证据的 403 才允许冷却后再试。其他 4xx 标记拒绝，超时、5xx 和未确认响应保留未知。

此设计提供持久化去重与一次本地领取许可，不承诺跨状态丢失、外部执行器或多台同身份机器的 exactly-once 执行。领取后崩溃不会自动释放或接管；需要核查实验实际状态。

轮询采用完整分页读和事件去重，先保证不会因时间游标或乱序跳过消息。每次最多 `max_pages × 100` 条，达到上限停止推进；持续增长的 Issue 需要另开通道配置与状态目录。当前不使用 webhook、ETag 增量同步或数据库服务。

## 文件与平台

ZIP 清单包含 `name`、`bytes`、`sha256`、`url`，最多五个，各小于 5 MiB。稳定地址必须匹配配置中的 HTTPS 路径前缀；本地 HTTP 仅允许 loopback 测试。下载不携带平台 Token，禁止 HTTPS 降级；写入请求不跟随重定向。缓存以 SHA-256 命名，不解压或执行产物。

GitHub Release 上传使用 namespace、节点、完整 SHA-256 命名，先完整分页检查已有资产；未知上传仅可用现有资产下载校验后恢复确认。平台拒绝、容量上限和持续运行吞吐均需单独实测。

依据：[GitHub Issue 评论接口](https://docs.github.com/en/rest/issues/comments)、[GitHub API 限流建议](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)、[GitCode 评论列表接口](https://docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-issues-number-comments/)。
