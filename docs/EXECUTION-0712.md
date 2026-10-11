# 0.7.12：防空转、八机整组预留与固定入口直接执行

## 更新包与部署

Mac/Windows 包包含固定 Node/Pi 运行时，以及 `watch-companion/` 下的 simpleHtmlWatch 可执行程序、来源 SHA、许可证、Skill 与实例升级说明。无须在内网安装 Go、npm 或下载依赖。现有 AIConnector 配置、Token、账本、unknown 和预留不重建；安装/升级仍使用原入口。

Windows 上先升级 AIConnector。要使用整组实验，再由原 simpleHtmlWatch 实例维护者按 `watch-companion/docs/service-lifecycle.md` 更新原实例的程序：核对真实实例名、数据目录、运行进程及现有任务，停止原服务后使用新程序与原参数、原目录启动，并在变更构建时使用规定的 `-adopt-build`。不新建第二份正式实例，不删预留或复制凭据。`-status` 和 `/healthz` 须显示能力 `atomic-group-reservations-v1`；GET `/api/tasks/reservations` 须有 `atomicGroups:1`。

旧 simpleHtmlWatch 不支持新协议时，AIConnector 返回 `WATCH_GROUP_RESERVATIONS_REQUIRED`，不启动 Pi 或 SSH。程序更新不会自动增加机器授权。原固定八台须已经出现在同一实例的真实机器目录，并被选入 AIConnector registry 的机器授权；不要猜 ID、替换节点或仅把八个地址写进 prompt。

## 防空转

`runner.agent.budget.maxNoProgress` 现在在每个工具轮结束、下一次模型请求前检查。同一证据的重复读取、重复验收或改写总结不重置预算。新文件区间、验收状态变化、配置/执行结果变化有进展；自动压缩后允许恢复一次持久化事实。预算与最大轮数、动作数、Token 和总期限并行保留，unknown 仍只查询原任务。

已有任务仍在运行时，`server_task_status` 在一次工具调用内用本地轮询等待原任务终态；等待不产生连续模型请求，也不因同一 running 状态触发无进展停止。整个任务的总期限仍保留，终态后回收原任务。

本地原复现由 12 个模型请求/11 次重复读取改为 4 个请求/3 次读取，最终 `NO_PROGRESS`；实验只执行一次。它是 Pi SDK+本机模型 fixture 验收，不是内网模型性能结论。

## 八机入口配置

在原受限 registry `/profiles` 内新增或修订一个已授权入口，保留其他入口。例子中的 ID、命令、revision 和输出须替换为真实已冻结的计划。

```json
{
  "kind": "simplehtmlwatch",
  "mode": "experiment",
  "executionMode": "direct",
  "machineId": "CONTROL_MACHINE_ID",
  "machineIds": ["NODE_0", "NODE_1", "NODE_2", "NODE_3", "NODE_4", "NODE_5", "NODE_6", "NODE_7"],
  "repository": "FROZEN_PROJECT",
  "revision": "FROZEN_REVISION",
  "entry": "group-baseline",
  "revisionCommand": "FIXED_REVISION_COMMAND",
  "shell": "FIXED_COORDINATOR_COMMAND",
  "outputs": ["baseline.json", "group-completion.json"],
  "groupCompletionOutput": "group-completion.json",
  "groupRanksPerMachine": 8,
  "verification": [
    {"id": "correctness", "kind": "output-json", "file": "baseline.json", "pointer": "/correct", "equals": true}
  ]
}
```

`machineId` 必须是 `machineIds` 内的控制机，所有 ID 须在 registry 顶层机器白名单。物理别名不算独立节点。整个组在开始执行前一次预留；一台忙或监控不新鲜，不持有部分组。机器等待由服务处理，不调用模型。同 ID 和固定计划在丢失回复/重启后查询原 Grant；不同计划、旧 Grant/代数、已释放 ID 均拒绝。

固定控制命令经版本包装后的完整 SHA 与原 run 绑定；Grant 下只允许这条控制机计划启动。协调器必须自行按原业务要求启动并等待所有 rank；资源组预留不自动实现 HCCL/SHMEM 启动屏障、不复制 Windows ZIP 到 Linux、不提供任意 SSH shell，也不证明设备健康或业务正确。

协调器能读取 `AICONNECTOR_RUN_KEY`、`AICONNECTOR_GROUP_MACHINE_IDS`（有序 JSON 数组）、`AICONNECTOR_GROUP_RANKS_PER_MACHINE`。结果写入 `$SHW_RESULTS_DIR`。全部远端进程得到终态后，使用实际退出证据生成：

```json
{
  "schema": "aiconnector.group-completion.v1",
  "run_key": "ORIGINAL_TASK/REVISION/ORIGINAL_RUN",
  "members": [
    {"machine_id": "NODE_0", "ranks": [
      {"rank": 0, "process_id": "ACTUAL_REMOTE_PROCESS_ID", "exit_code": 0}
    ]}
  ]
}
```

这是结构示意；八机×八 rank 必须完整提供 8 个 member、各 8 条退出记录、唯一且完整的 rank 0–63。进程标识来自实际 rank；exit_code 非零保留真实值。不得用 `all_nodes_reserved=true` 或 `all_processes_stopped=true` 替代记录。`group-processes-stopped` 是程序追加的独立检查，缺失记录会使任务失败且保留整组预留。控制机结束后不会因此自动解锁其余节点；失败任务在全部 rank 确认退出后也能释放。

结果 ZIP 的 `resource-grant.json` 记录 Grant、代数、机器数量、组 SHA、固定命令 SHA，不导出主机地址或凭据。完整原始实验输出随 ZIP 交付，Mac 仍独立核对正常 64-rank 正确性、真实样本、版本及来源。

## 固定任务直接执行

本机入口 `executionMode` 为 `direct` 时，固定入口执行、独立检查和打包不调用模型，也不要求配置 AI API Key。`pi` 为兼容默认值；维护入口继续使用 Pi，direct 不允许维护或任务自带任意 shell。失败后生成明确 blocked 结果，保留失败和原任务，不自动换 ID 启动 Pi 重跑。

发送任务明确要求执行模式与组：

```json
{
  "requirements": {
    "mode": "experiment",
    "execution_mode": "direct",
    "tools": [],
    "checks": ["correctness", "group-processes-stopped"],
    "resources": {"machine_count": 8, "atomic_group": true, "group_sha256": "SHA_FROM_RECEIVER_CAPABILITIES"}
  }
}
```

其余 task/revision/run/code/environment/invocation 字段保持现有协议。模式、机器数量和组 SHA 在 Mac 预检与 Windows 执行前都核对；不能将单机 CPU 入口包装为八机实验。能力公告新增 `execution_mode / resources`，不发布内网命令和地址。

直接执行的 `execution.engine=direct`、`agent.turns=0`、`agent.duration_ms=0`、`DIRECT_VERIFIED` 只说明固定任务独立检查完成。实际执行耗时见 `execution.executor_duration_ms` 与 `worker-timing.json`；不将其误记为 Pi 耗时。`model-timing.json` 的请求数为 0；失败保留实际退出码、版本、unknown 与检查缺项。

## 验收边界

软件测试覆盖实际 Go HTTP 控制器和实际 Node worker 的协议连接、原子预留、冲突、丢失回复、重启、原意图、缺少 rank 记录、直接执行无模型请求及原 Pi/传输/安装回归。SSH 与 rank 退出在该跨程序测试中使用 fixture；不构成 A5/NPU 或正常业务 64-rank 验收。

Windows 更新后，先核对原实例和新能力公告，再用原固定八机计划取得新 Grant、执行正常基线与结果回收。五处已有设备告警仍须按真实状态处理，程序不会 reset、解除他人占用或用不同节点替代。
