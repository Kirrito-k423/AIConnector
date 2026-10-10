# 0.7.11：确定性入口配置与模型请求计时

## 为什么改

2026-10-10 的 [Relay #24](https://github.com/Kirrito-k423/AIConnector-Relay/issues/24) 两次 Pi 运行在 600 秒总预算结束。第一次全量 `/profiles` 写入已完成，仅耗时 13 ms，但剩余约 7 秒，没有加载；第二次没有产生任何维护动作，最后读取后等待约 431 秒。仅加载现有配置的判别任务 58 秒完成，实际加载的是 v1。现有数据证明长间隙出现在工具之间，不能区分模型生成、网关和网络，更不能归因于 SSH 或 NPU。

此前 Pi 为添加一项入口，要读取并重新输出所有旧入口。新版消除这一负担，并补充可复核的等待边界。没有提高自动重试预算、放宽机器授权或复位硬件。

## 工具与输入

`configure_server_profiles` 仅向已经授权以下内容的维护入口开放：可写的 `server-registry` 文件、精确 `/profiles` 指针、同一服务的 `reload` POST `/api/reload-agent` 和只读 `readiness` GET `/api/server-readiness`。现有服务器接入功能生成的授权满足条件，不需要重新开放机器权限。

工具参数：

```json
{
  "action_id": "configure-device-v2",
  "file": "server-registry",
  "input_id": "list_inputs 返回的成员 ID",
  "input_sha256": "该成员的 SHA-256",
  "expected_sha256": "read_local_file 返回的文件 SHA-256"
}
```

读取 registry 时可用 `length: 1` 获得完整文件的 SHA，避免把旧脚本送进模型上下文。附件成员是 UTF-8 JSON 的 **profile ID → profile 定义** 映射，不是整个 registry，也不是文本指令。最大 64 KiB、24 项；拒绝重复键、危险键、错误 UTF-8、过深嵌套与机器越权。输入必须来自当前任务已声明、下载并校验的 ZIP；不接受路径或外部 URL。

程序保留原 `machineIds` 与其他 profile 的对象值，以既有 CAS、备份和原子写入替换 `/profiles`，然后自动加载、检查指定 ID、revision 和定义哈希。`server-readiness` 返回实际内存入口的 `loaded_profiles`，哈希按键排序后计算；不导出脚本、路径、机器地址或凭据。

发送端应要求新工具和指定版本检查，并可固定全部目标定义：

```json
{
  "mode": "maintenance",
  "tools": ["configure_server_profiles"],
  "checks": ["server-profiles-loaded"],
  "server_profiles": [
    {"id": "device-entry", "revision": "expected-v2", "definition_sha256": "可选：规范化定义哈希"}
  ]
}
```

`definition_sha256` 如使用，须为 64 位小写十六进制。实际工具输入必须包含与该目标列表一致的 ID 和 revision。即使模型跳过配置而只提交总结，独立验收也不会因已有任意实验入口而通过；执行了新工具的旧任务同样自动启用指定定义检查。旧工具与旧验收仍兼容。

## 中断与恢复

本地 `profile-workflows.json` 保存工作流与子动作 ID；`get_run_state` 和结果 ZIP 返回不含脚本的阶段摘要。write、reload、readiness 分开记录。写入完成但加载尚未开始时，同一运行中的 Pi 可用 **同一 action_id、原始文件 SHA 和输入 SHA** 接续；不会重写或重复加载已完成动作。故障恰好发生在子动作完成与工作流更新之间时，以校验过的子动作和当前文件哈希恢复。

若 write/reload 是 intent 或 unknown，则保持阻塞；不能换 ID 重放。原运行已截止、崩溃或交付后，不自动复活它；人工核对已完成动作后可以提交只读验证/加载任务，或新版本任务。升级不会把旧 action journal 改成成功。机器锁及远程任务未知状态规则保留。

## 计时数据与代价

结果 ZIP 新增 `model-timing.json`：每次 SDK 调用的种类（agent/compaction/cache-warm）、轮次、开始、请求准备完成、响应头、首个非空 text/thinking/tool delta、结束和 SDK usage。`model-requests.jsonl` 在本地异步保存相同边界，便于进程故障排查。Pi 0.87.1 的后台缓存预热以其 `maxTokens=1` 标识；不计为用户工具轮次。

可以拆分：

- SDK 准备：`ready_ms`。
- 准备至响应头：`headers_ms - ready_ms`。
- 响应头至首个输出：`first_output_ms - headers_ms`。
- 首个输出至结束：`output_stream_ms`。
- 无首个输出的超时：`first_output_at = null`，保留请求持续时间和运行停止原因。

这些是 SDK/提供方接口边界，不能直接分出 DNS、TCP、代理排队或模型服务器计算。SDK 在已 abort 后仍可能创建一次未到请求准备阶段的调用；不能把 `requests_started` 直接当成实际 HTTP 请求数。SDK 没有提供 usage 时保留 null，不当成免费或 0 个 token。

每个调用最多写 5 个边界事件，不逐 token 落盘，不周期上传。不保存 prompt、输出内容、URL、headers 或密钥。最多保留 256 个请求摘要；本地异步队列 64 项，慢磁盘时显示丢失数量。十秒分段统计仍是另一份本地诊断，结果交付时再回传。

## 一次性 Windows 验收

升级使用原配置与状态，不删除账本、锁或输入缓存。在新能力公告中确认版本 0.7.11，维护入口包含 `configure_server_profiles` 和 `server-profiles-loaded`。提交一个新维护任务，附准备好的单条 v2 JSON ZIP，并固定要求上述工具、检查及 v2 ID/revision。

一次结果应同时检查：其他条目不变、输入 SHA、写入前后 SHA、write/reload/readiness 状态、指定 v2 定义加载、独立验收、结果 ZIP/回执，以及全部模型请求边界。然后再提交真实 A5 实验；入口就绪和 fixture 测试均不代表 A5 芯片、当前告警或性能已通过。

600 秒是 Windows 配置中的 Pi 总运行预算，包括模型等待、工具与验收，不包括领取前排队及后续上传。看板可设 1800 秒和 32 轮，保存后影响新任务；升级不会覆盖显式设置，也不延长已经运行的 spec。预算调整能给任务更多时间，新工具和计时用于消除负担与查明慢在哪里。

## 验证入口与证据级别

```sh
npm test
node --test tests/service/profile-workflow.test.mjs tests/service/model-timing.test.mjs
python tools/validate_service_bundle.py dist/service/AIConnector-Service-windows-x64.zip
```

回归覆盖大旧映射/单条更新、保留其他入口、输入/文件 SHA、跨运行成员错绑、恶意键和机器越权；覆盖写后中断、子日志已完成而工作流未更新、未知加载禁止重放、已有错误版本不能通过；使用实际 Pi 0.87.1 与本地模型 API fixture 完成三次请求的配置闭环，并验证自动压缩、无首个输出超时和人为分段延迟。

这些属于源码与主机/Windows 安装包验证。实际模型速度、内网交付延迟和 A5 执行仍需升级后的同口径测量；不把 fixture 的毫秒耗时折算成内网加速比例。

主机有界工作量检查使用交付同版 Node 24.14.0。原/新工具 JSON 参数字节数与确定性合并的 CPU 时间如下；时间包含合并、校验、序列化及保全比对，**不含磁盘、API、模型或传输**：

| 原入口数 | 原模型生成参数 | 新模型生成参数 | 合并与检查中位数 |
| --- | ---: | ---: | ---: |
| 1 | 2248 B | 266 B | 0.018 ms |
| 12 | 25042 B | 266 B | 0.125 ms |
| 24 | 49918 B | 266 B | 0.224 ms |

参数负担不再随旧映射增长；这不是内网 E2E 加速倍数。原始 100 次样本与环境见 [profile-0711-macos.json](evidence/profile-0711-macos.json)，重现：`node tools/benchmark_profile_workflow.mjs`。
