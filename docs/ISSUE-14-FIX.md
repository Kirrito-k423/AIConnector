# 0.7.13：入口合并前校验与程序执行路径

## 已核实的原因

[Issue #14](https://github.com/Kirrito-k423/AIConnector/issues/14) 对应 [Relay #36](https://github.com/Kirrito-k423/AIConnector-Relay/issues/36)。原 ZIP、SHA 与协议结果已独立核对：Pi 运行 1394.385 秒、19 轮、23 次工具步骤；没有成功写入，三个手工 patch 均在授权/机器范围校验处被拒绝。最终为 MODEL_USAGE_BUDGET。传输回执已经完成，不是 1394 秒的原因。

发送方的原任务将保持字段顺序的 JSON SHA 当作 definition_sha256；实际程序先递归排序对象键。附件正确的定义摘要为 74f3aedbacac7586565692e59ab874bf072f8fc4ec6755e210db05ef7adc48be。configure_server_profiles 的校验拒绝发生在写入意图前，耗时约 7 ms；原模型随后重读注册表并尝试其他写法，无法修复任务中被冻结的错误摘要。

模型请求累计约 1394.126 秒，占 Pi 区间的约 99.98%；最长三次为 413.842、316.837、180.933 秒。SDK 记录的输入 111120、输出 74802、缓存读取 915904 Token，累计 1101826 超过 Windows 已配置的 1000000 上限。缓存读取和重复上下文属于 SDK 累计用量，不是新增生成 Token，也不等同账单。缺少服务端细粒度记录，不能把流式输出区间细分成网关和模型计算。

## 校验与失败行为

Mac 在入队、上传和发布前核对附件成员与 requirements.server_profiles 的完整 ID/revision/canonical SHA。Windows 在调用模型前独立重复检查，并验证原 registry 的机器授权和合并范围。错误摘要、缺失/歧义附件、机器越权均明确失败；不会让模型尝试改写整个清单或耗尽预算。相同错误或不同的被拒绝动作不会重置无进展预算。

制作摘要请使用包内工具，而不是手写 JSON 排序规则：

```text
runtime/node tools/profile_contract.mjs /实际路径/profile.json
```

Windows 使用 runtime/node.exe。工具只输出 id/revision/definition_sha256；不输出命令、路径、主机或凭据。它不授予机器权限，接收端仍核对已有 registry 白名单。

## 纯入口合并不需要模型

接收端的维护入口公告新增 profile_workflow.direct=true。发送方仅在明确需要“合并指定定义、加载、核对”时使用：

```json
{
  "requirements": {
    "mode": "maintenance",
    "profile_workflow": "direct",
    "tools": ["configure_server_profiles", "verify_task"],
    "checks": ["server-profiles-loaded"],
    "server_profiles": [
      {"id": "实际入口", "revision": "冻结版本", "definition_sha256": "工具生成的64位摘要"}
    ]
  }
}
```

其余任务字段及经过校验的 ZIP 保持现有格式。所有目标须固定定义摘要；只允许声明上述配置/验收工具，不混入服务器查询或其他模型工作。旧接收端不公告该能力时，Mac 预检拒绝任务，不静默退回 Pi。普通维护、只读诊断及需要判断/修复的工作保留 Pi 路径。

程序使用本机既有文件与 API 授权，自动选择唯一匹配的已校验附件，保留机器白名单和其他定义，以 CAS、备份、原子写入、reload/readiness 完成一次流程。未知写入/加载继续保留原动作及全局锁；不重放，不关闭授权检查。维护不会执行 SSH/NPU，不增加服务器或改为任意命令。

结果 execution.engine=profile-workflow、停止原因为 PROFILE_WORKFLOW_VERIFIED；agent.turns/duration_ms=0、模型请求为 0。程序真实耗时使用 execution.executor_duration_ms。结果的 agent.budget 和 runner_* 指标保留轮数、动作、SDK Token 实际用量与上限；每轮明细仍在 model-timing.json。工具结束事件新增成功/错误码和读取区间，不记录内容或敏感参数。

## 本轮内网证据与验收边界

Windows 手工启用 direct 后，原 #32 的 r3 只读探针已 receipt/succeeded：相同源程序、控制机与原八个主机哈希，全部 64 张卡查询完整。执行器主体 20.152 秒（原 Pi 117.285 秒），SSH 控制区间约 15.821 秒（原 16.309 秒），云端 task 发布到 receipt 发布 204 秒（原 262 秒）。它证明省去了模型环节；不同机器时钟不混用，单次测量不是稳定延迟分布。

五处 80E3A207 告警依旧存在，原八机部署 SHA 保持一致。该只读探针仅预留控制机，没有整组 Grant 或 NPU 工作负载，不能当作正常 64-rank 基线、PC/stall 样本或 A5 性能提升。

0.7.13 的自动合并、非法摘要早停与 unknown 保留在本机和 Windows CI 的实际 Node/SDK/HTTP/文件流程验证；实际内网 Windows 升级后仍须验收该维护流程。不要为了复测这项修复重复修改已正确启用的 direct 入口。
