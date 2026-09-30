# Windows 服务器接入与一次验收（0.6.2）

## 为什么 0.6.1 已升级仍然不能执行 A5

`local-smoke` 只运行 Windows 上的 CPU 自检。软件升级保留了原配置，不会凭空获得 SSH 目标、实验入口或维护授权。Issue #8 的 81922 ms / 6 轮属于 Pi；69 ms 是 CPU 命令耗时。该结果没有执行 A5。

0.6.2 增加本机接入向导、独立服务器入口清单及受限维护能力。接入后外部 AI 可先探测真实服务器，再通过维护任务登记实验入口，最后提交实验并核对原始产物。

## Windows 一次操作

1. 下载并解压新的 Windows 服务包，保留旧安装目录。在新目录运行：
   ```bat
   Upgrade-Windows.cmd "C:\原安装目录\service-windows-inner.local.json"
   ```
   必须传**当前运行服务的原配置**。升级保留节点、通道、数据目录、历史任务、模型和凭据，重新绑定登录服务，成功后打开原服务看板。若已有运行任务，先等待完成；升级不会重跑任务。不再要求为普通升级手写维护策略 JSON。
2. 看板「Pi 配置」确认已启用同机 simpleHtmlWatch，地址使用实际端口，例如 `http://127.0.0.1:8766`。已有的地址保留，程序不猜测端口或扫描内网。模型 API Key 与 SSH 密码分别仍由本机凭据库与 simpleHtmlWatch 管理。
3. 点「接入服务器 → 读取机器列表」，选择所需机器（最多 12 台）。列表来自控制器的实际可调度机器 ID；繁忙、断连、尚未确认主机指纹的机器需先在 simpleHtmlWatch 处理。名称含 A5 或状态 ready 不能证明芯片型号或 NPU 空闲。
4. 勾选「允许远程 Pi 维护所选机器的实验入口」，点「保存并公布能力」。此项授权允许远端 AI 登记并执行所选服务器上的命令。不会执行 SSH、修改模型密钥、扩大机器范围或自动投递实验。随后等待正常轮询在 Relay 的接收端能力 Issue 公布 `probe` 和 `server-maintenance`。

新建本地文件位于原 dataDir：`server-profiles.local.json`、`SERVER_CONTEXT.md`，配置变更前备份在 `setup-backups/`。机器 ID 与配置路径仅在本地保存；公开能力公告不含 SSH 地址、凭据或 shell。公开任务、日志和结果仍需遵循原 Relay 数据范围。

可不勾选维护，只有只读探测入口。若要撤销维护，重新读取列表并保存未勾选状态；已经领取的任务使用冻结快照，应先等待其结束。减少机器范围前，先移除清单中仍引用该机器的入口；程序不会静默丢弃原入口。

## 外部 AI 如何使用

先从 Mac `GET /api/capabilities` 或现有 aiconnector Skill 状态接口读取**最新 Windows 公告**。按公告的 `id / mode / repository / revision / entry / checks / tools` 构造任务。多个探测入口的 repository 相同，必须明确 `environment.target`，不要用 `auto` 猜机器。能力公告超过两小时不可用于新任务。

1. **探测**：每台选定机器有一个 `server-probe-<ID摘要>`。要求 `mode: probe`，检查 `ssh-probe / boot-time / npu-info`，repository `aiconnector-server-probe`，revision `server-probe-v1`，entry `server-probe`。Pi 通过真实 SSH 读取 `/proc/stat` 的启动时间、执行 `npu-smi info`，回收 `server-probe.json` 和控制器任务 ID。需 Python 3；`npu-smi` 不可用时独立检查失败，不能把 CPU 机器报成 A5。芯片型号依据原始输出判断，此探测不运行 NPU workload，也不能推导整个机房的机器总数。
2. **登记实验**：目标 `server-maintenance`，mode `maintenance`，repository `aiconnector-server-registry`，revision `server-registry-v1`，entry `server-registry`，tools 包含 `read_local_file / patch_local_json / call_local_api`，checks 为 `experiment-entry-configured`。把真实项目的入口定义作为任务文字或小 ZIP 输入，要求 Pi 读取 `server-registry`，保留已有条目，只修改 `/profiles`，调用 `reload` 后核对 `readiness`。操作自动备份、校验文件 SHA；未知动作不会重放。
3. **执行实验**：等能力公告出现新实验入口后，按其固定 revision、entry、检查 ID 提交新的 `experiment` 任务。验收必须包含 server task ID、实际 revision、退出码、独立检查与真实输出文件；Mac 校验 ZIP 并生成 receipt。维护成功只证明入口配置并热加载，不能证明实验已成功。

缺少真实仓库路径、固定代码版本或实验脚本时，应明确指出缺项，不能捏造，也不要改投 CPU 自检。当前 ZIP 只到 Windows 并供模型读取，**不会自动上传源码到服务器**。本版支持服务器已有项目或可容纳在固定 shell 中的小脚本；大项目离线部署仍需单独的输入传输实现。

清单条目示例（用实际值替换；禁止直接提交占位符）：

```json
{
  "my-experiment": {
    "kind": "simplehtmlwatch",
    "mode": "experiment",
    "machineId": "本机已选择的真实ID",
    "entry": "benchmark",
    "repository": "project-name",
    "revision": "实际提交SHA",
    "revisionCommand": "git -C /home/user/project rev-parse HEAD",
    "shell": "cd /home/user/project\npython3 benchmark.py --output \"$SHW_RESULTS_DIR/metrics.json\"",
    "outputs": ["metrics.json"],
    "verification": [{"id":"correctness","kind":"output-json","file":"metrics.json","pointer":"/correct","equals":true}]
  }
}
```

命令与版本检查合计限 3800 字节，为控制器 4096 字节上限预留包装空间。入口必须固定选择授权机器，不支持任意机器/组或用户追加 shell 参数。输出限已声明的平面文件名，结果 ZIP 小于 5 MiB。维护工具只能修改此清单的 `/profiles`；schema、机器授权、主配置、模型地址与密钥不在写权限内。清单会校验，禁止登记 Windows 本机 `command` 或嵌套维护入口。

## 结果可信度与兼容

- `result.agent` 的时长、轮数、停止原因、用量由运行器产生。正式摘要也由运行器生成；模型文字在 `model_report` 标记 `verified:false`，完整内容在 ZIP `report.json`。模型自填的 `duration_ms / pi_* / session_* / receipt_* / runner_*` 等保留字段不再成为正式 metrics。其他模型指标仍标明来源，不能代替产物检查。
- 执行端不再代为宣称 Mac receipt 已确认；以时间线中的实际协议事件为准。
- PowerShell JSON 解析保留时间字符串。PS 7.5+ 使用 `DateKind String`，早期 PS 6/7 使用其自带 JSON 解析器关闭日期转换；PS 5.1 保持原行为。修复后可以从已有消息的 Base64 payload 重新生成正确快照，无须重跑 Issue #8 或放宽 metrics 一致性校验。

## Windows 内网一次回传验收

按上述流程接入后，由发送端连续完成：最新能力公告 → 一台目标机器 probe → 登记一个小实验入口 → 新实验执行 → ZIP → Mac receipt，再在无活动任务时重启服务确认入口保留。回传以下证据一次即可：

- 服务版本、probe / maintenance / experiment 的能力公告链接；
- 探测和实验 Issue、server task ID、选中的 machine ID、实际 revision；
- `server-probe.json` 中启动时间和原始 NPU 型号；实验原始指标与独立检查；
- Pi `agent` 统计、结果 ZIP SHA、Mac receipt 与重启后入口保留结果。

受控 CI 的模型和 simpleHtmlWatch 适配器测试不等于内网硬件验收。不能用 `ready`、入口配置成功、CPU smoke 或 `GOAL_VERIFIED` 单独宣称 A5 实验已完成。
