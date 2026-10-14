# 0.7.16：共享机器自动选择、排队反馈与告警执行

机器暂时不可用是 `waiting`，不是实验失败。固定实验可声明一组**已授权、代码与数据入口可互换**的候选机器；有足够可用节点时自动选择并预留，全部忙或数量不足时保留原 run 排队，不调用 Pi，不换任务 ID。Warning/Alarm 默认允许执行，并在结果中记录。

## 一、入口契约

在原 Windows `server-registry` 的 `/profiles` 中登记机器池，顶层 `machineIds` 授权保持原样。候选机器不能来自任务正文、IP 猜测或另一台控制器。单节点示例：

```json
{
  "kind": "simplehtmlwatch",
  "mode": "experiment",
  "executionMode": "direct",
  "machinePool": ["AUTHORIZED_NODE_1", "AUTHORIZED_NODE_2"],
  "machineCount": 1,
  "npuHealthPolicy": "allow-warning-alarm",
  "repository": "FIXED_PROJECT",
  "revision": "FIXED_REVISION",
  "entry": "experiment",
  "revisionCommand": "FIXED_REVISION_COMMAND",
  "shell": "FIXED_EXPERIMENT_COMMAND",
  "outputs": ["metrics.json"],
  "verification": [
    {"id": "correctness", "kind": "output-json", "file": "metrics.json", "pointer": "/correct", "equals": true}
  ]
}
```

`machinePool` 与 `machineId / machineIds / group / allowAnyMachine` 互斥。`machineCount` 必须在候选池大小之内。现有固定机器入口不自动改成池，避免把同名但数据、SDK 或代码不同的节点当作可替换环境。

双机及更大任务使用 `machineCount: 2` 等，并保留原 `groupCompletionOutput / groupRanksPerMachine` 和完整各 rank 终态记录。控制器一次预留整个选中组；同一 `resourceKey` 的地址别名只计一台。机器组顺序、控制机、命令 SHA 和原预留 ID 在 POST 前持久化。回复丢失、服务重启和 unknown 都核对原意图，不重新选择或再启动 SSH。

候选机必须在控制器目录中启用、在线/partial 且 `ready`，不能占用别人的任务、预留、continuation 或本地未知资源。`ready` 仍不证明 NPU 空闲；原实验中的进程、HBM、设备数、SDK、模型资产和正确性检查保留。共享 GPU/NPU 的按卡资源分配不是本次机器级池的能力。

新执行固定入口会收到 `AICONNECTOR_NPU_HEALTH_POLICY`，多机协调器还收到已有的 `AICONNECTOR_GROUP_MACHINE_IDS / RUN_KEY / GROUP_RANKS_PER_MACHINE`。协调器必须使用选中组，不能仍在脚本里写死原 IP。

## 二、发送方及排队

能力公告的 `resources.selection=authorized-pool`、`pool_size / pool_sha256 / machine_count / atomic_group` 声明机器池。发送 `target: auto` 时，若只有一个符合代码、模式与验收要求的机器池，优先选该池；多个不等价池仍需明确入口，不能猜实验环境。任务可通过 `requirements.resources.pool_sha256` 冻结候选池。固定八机任务的 `group_sha256` 规则不变。

Windows 本地队列及能力公告中的 `scheduler.waiting` 带原 runKey、等待原因、候选机器和观察时间。Mac 看板显示这些快照，不把队列信息当领取证据。全部机器忙时仍为等待；机器释放后服务继续原 run，用户不必重投。反馈有界，最多 8 个等待项、每项最多 12 台；标记总数和截断，不重传全部历史。

本机所有者已明确授权反馈排队机器的 IP，因此排队快照可以包含合法 IPv4/IPv6；只在等待反馈中输出，不包含主机名称、密码、SSH 用户、端口配置、命令或完整监控。需要隐藏 IP 的部署设置 `runner.queueFeedbackIncludeAddresses: false`。快照使用现有 30 秒能力公告调度和退避，状态改变时发布；相同状态不因每次本地 5 秒重试产生新评论。Mac 的实际可见时间仍包含传输队列、GitHub 轮询和网络延迟。

Issue #16 的默认结果 `server_task.machineName` 改为所选机器 ID，控制器原始错误转为错误码，不自动写入真实 SSH host。已发布的旧 ZIP 是不可变历史，本次不修改或声称撤回它们。实验主动写入 stdout/产物的敏感信息仍由入口管理；IP 反馈授权不等于公开其他内网资料。文件私有取回继续使用已有端到端加密通道。

## 三、Warning/Alarm 门禁

默认策略 `allow-warning-alarm`：设备 Health 为 `OK / Warning / Alarm` 均可以继续执行。可选 `strict`：现有监控样本未知、过期或存在告警时，Connector 在提交 SSH 前拒绝。未知状态没有被改写为 OK。

结果 ZIP 的 `npu-health.json` 记录执行前后已有监控采样的设备 Health、采样时间、查询时间、源 SHA、已知/新鲜标志；不额外启动 SSH 采样。`result.json` 的 `execution.npu_health` 和 Mac 看板标注 Warning/Alarm。采样接口失败或过期明确记为 unknown；告警记录不充当计算、通信或实验验收证据。

**原实验脚本也须改变 Health 判断**。Connector 不会替换冻结脚本或把健康验收失败冒充成功。包内 `tools/npu_health_gate.py` 是无依赖的统一门禁，供入口维护者放进原项目后使用：

```python
from npu_health_gate import evaluate_health

# records 是原 npu-smi 解析产生的实际记录，不能写假数据。
health = evaluate_health([
    {"device": r["device"], "health": r["health"]} for r in records
])
# 保留原四卡空闲、HBM、SDK 等判断；只替换 Health == "OK" 这一条。
if not health["allowed"]:
    raise RuntimeError("NPU_HEALTH_GATE")
# 把 health 写进原门禁 JSON，保留 Warning/Alarm 记录。
```

也可把真实设备记录 JSON 数组送入该工具 stdin。退出 0 表示健康策略允许；退出 86 表示健康门禁未通过。这只处理 Health，不能跳过已有 worker、占用、容量或正确性门禁。

MAC-16 的节点 1 仍不能因策略改变而使用正在运行 vLLM 的卡。节点 2 可在告警记录下继续原 SDK/设备可用性与业务门禁；是否真正完成 HIXL、SSD 四 worker 读回及 T3/T4，必须看新实验的实际证据。本次软件测试不声称这些实验已启动。

## 四、升级与验收

Mac 与 Windows 使用同版 0.7.16 包，保留原配置、密钥、机器授权、预留、队列和 runKey。不需要重置 simpleHtmlWatch；使用原已验证预留接口。升级本身不新增实验池，所有实验入口仍需在原受限维护权限内登记；旧单机/固定组继续按原约束运行。重新「接入服务器」时会增加使用相同只读命令的 `server-probe-pool`，不自动转化其他实验。

验收覆盖：首选忙时选择备选、全忙不 Claim、双机整组与物理别名、预留丢失后查询原 ID、自动入口匹配、反馈大小、真实 Node worker 在告警 fixture 下执行和 ZIP 标注、strict 在 SSH 前拒绝、Mac 排队 UI、原加密文件/恢复/传输回归。Fixture 的机器和 NPU 表是合成数据，不构成真实内网部署、A5 健康或 T3/T4 验收。
