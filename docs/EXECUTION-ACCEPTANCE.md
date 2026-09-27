# 0.6 接收端维护与任务验收

Windows 仍只有 `local-smoke` 时，请使用 [0.6.2 服务器接入与一次验收](SERVER-SETUP.md)：从真实机器列表建立探测入口，并按本机授权启用远程实验入口维护。


## 本次修复的失败路径

Relay #5 的 A5 分析和 #6 的入口修复均完成了 ZIP/receipt 传输，但实际只运行 CPU 自检。#6 返回 `repair_completed=false`、`config_validated=false`、`ssh_probe_executed=false`，旧运行器仍按 exit 0 标记成功。64/68 ms 是该子进程耗时，不是 Pi 会话总时长。原始证据：

- https://github.com/Kirrito-k423/AIConnector-Relay/issues/5#issuecomment-5846253851
- https://github.com/Kirrito-k423/AIConnector-Relay/issues/6#issuecomment-5851897970

0.6 将入口能力匹配、独立验收、范围内修复和停止原因贯通。源码入口：`capabilities.mjs`、`maintenance.mjs`、`verification.mjs`、`worker.mjs`，均在 `service/`。

## 能力发现与任务契约

Windows 以独立的 `[AIC][node:windows-inner] 接收端能力` Issue 追加 `AIConnector capabilities v1` 评论；不占用实验 task/run。只接受节点作者白名单内的公告。快照含版本、配置哈希、profile ID、mode、工具、检查 ID、上下文/Skill 摘要；不发布文件路径、命令、服务器地址、上下文正文或凭据。配置变化或半小时后刷新，Mac 拒绝超过两小时的快照。公告仅表明节点近期公布过能力，不证明 SSH/NPU 在线。

Mac `GET /api/capabilities` 读取缓存公告，`POST /api/preflight` 输入 `{ "task": ... }` 预检。`POST /api/tasks` 强制同样预检；所有本地 API 使用已有 dashboard Bearer Token。没有公告、入口不匹配、检查缺失或版本已变更都不运行 smoke。Windows 启动前再次核对配置哈希和实际工具；旧版直接写入 Relay 的任务也必须满足新契约，否则返回 blocked ZIP。

任务新增字段：

```json
{
  "requirements": {
    "mode": "maintenance",
    "tools": ["read_local_file", "patch_local_json", "run_maintenance_command"],
    "checks": ["config-valid", "ssh-readonly"]
  },
  "code": {"repository": "aiconnector-maintenance", "revision": "maintenance-v1"},
  "environment": {"target": "auto"},
  "invocation": {"entry": "auto", "arguments": []}
}
```

其他 task_id/revision/run_id/title/objective/acceptance/artifacts 字段与原协议相同。`auto` 仅在唯一匹配时选择入口；发送端不猜 profile 名。`mode` 分为 smoke/probe/maintenance/experiment，调用方须如实声明目标。程序不靠自然语言猜测把维护请求改成 smoke。原始 `acceptance` 文字保留给人复核；机器验收由 `requirements.checks` 指向 Windows 本地检查定义。

内置 smoke 仅检查 `cpu-smoke`（sum=50005000）。其他入口必须配置 `verification`。例如实际实验产物：

```json
"verification": [
  {"id":"correctness","kind":"output-json","file":"metrics.json","pointer":"/correct","equals":true}
]
```

检查支持 output-json、local-json、command、local-api、execution；通过条件为明确的 equals 或 exists。local-json/command/local-api 仅用于维护入口，验证命令/API 必须本地标为 readOnly。退出码检查只能证明命令完成，应结合产物内容、配置值或明确的业务证据。

## 一次本地升级与授权

旧 Windows Pi 没有自举维护工具，不能通过再发提示词升级。新包解压到**另一个固定目录**；保留旧目录、模型网关和原 service 配置。新的 Windows 运行器用旧配置文件，沿用其 dataDir、DPAPI、Connector 状态、模型、代理和 profiles。不得把临时下载目录作为长期安装路径。

Windows 本地管理员/AI 根据实际环境准备 `maintenance.local.json`。这是本地授权文件，不从公开 Issue 自动导入。模板如下，先替换路径和已配置 SSH alias；不要填写密码。JSON 内 Windows 路径可使用 `/`。

```json
{
  "profileId": "connector-maintenance",
  "contextFiles": ["D:/AIConnector/AGENT_CONTEXT.md"],
  "skills": [{"path":"D:/skills/receiver-maintenance/SKILL.md","references":[],"requiredTools":["patch_local_json"]}],
  "profile": {
    "kind":"maintenance","entry":"maintain","repository":"aiconnector-maintenance","revision":"maintenance-v1","outputs":[],
    "maintenance": {
      "enabled":true,
      "files": {
        "service-config":{"path":"D:/AIConnector/service-windows-inner.local.json","format":"service-config","write":true,"pointers":["/runner/agent/simpleHtmlWatch/baseUrl"]},
        "environment":{"path":"D:/AIConnector/AGENT_CONTEXT.md","format":"text","write":true}
      },
      "commands": {
        "config-check":{"argv":["D:/AIConnector-0.6/runtime/node.exe","D:/AIConnector-0.6/service/cli.mjs","status","--config","D:/AIConnector/service-windows-inner.local.json"],"readOnly":true,"timeoutSeconds":30},
        "ssh-readonly":{"argv":["C:/Windows/System32/OpenSSH/ssh.exe","-o","BatchMode=yes","-o","ConnectTimeout=10","approved-server-alias","uname -s; uptime; cat /proc/sys/kernel/random/boot_id"],"readOnly":true,"timeoutSeconds":30}
      },
      "apis": {
        "reload":{"baseUrl":"http://127.0.0.1:43111","route":"/api/reload-agent","method":"POST","body":{},"readOnly":false,"auth":"dashboard","tokenFile":"D:/AIConnector/service-data/windows-inner/dashboard.token"},
        "agent-check":{"baseUrl":"http://127.0.0.1:43111","route":"/api/agent-check","method":"POST","body":{},"readOnly":true,"auth":"dashboard","tokenFile":"D:/AIConnector/service-data/windows-inner/dashboard.token"}
      }
    },
    "verification":[
      {"id":"watch-port","kind":"local-json","file":"service-config","pointer":"/runner/agent/simpleHtmlWatch/baseUrl","equals":"http://127.0.0.1:8766"},
      {"id":"config-valid","kind":"command","command":"config-check","equals":0},
      {"id":"watch-live","kind":"local-api","api":"agent-check","pointer":"/checks/simpleHtmlWatch/ok","equals":true},
      {"id":"ssh-readonly","kind":"command","command":"ssh-readonly","equals":0}
    ]
  }
}
```

只读 SSH 需要本地已有凭据/known_hosts。上例不改服务器，不启动 NPU；口令型环境应由 Windows 本地管理员配置固定、已审核的探测脚本，不能把密码放进 argv、Issue 或 ZIP。Skill/上下文路径必须真实存在；无 Skill 时删除 skills 项，不写虚假路径。8766 为样例，应按实际 simpleHtmlWatch 端口设置检查和提示。

先用新包进行只读预检：

```powershell
.\runtime\node.exe .\service\cli.mjs upgrade --config "D:\AIConnector\service-windows-inner.local.json" --maintenance "D:\local\maintenance.local.json"
```

通过后，一个入口备份配置、激活授权、重绑当前用户登录服务：

```powershell
.\Upgrade-Windows.cmd "D:\AIConnector\service-windows-inner.local.json" "D:\local\maintenance.local.json"
```

Mac 发送服务也需使用 0.6 才能在投递前检查 Windows 公告。将 Mac 新包解压到固定新目录，用新包的 `runtime/node service/cli.mjs upgrade --config <原 service-mac-outer.local.json 的绝对路径>` 先预检，再追加 `--apply` 重绑服务；Mac 不需要 maintenance 授权文件。原节点、通道、数据和钥匙串保持不变。

有运行中/待启动 worker 会拒绝升级，先等待原任务退出。升级不重启模型网关，不复制密钥，不清理旧状态。备份路径在命令输出中。若安装失败，保留备份和错误码；恢复备份配置后用旧包的 `Install-Windows-Service.cmd --config <原配置>` 重新注册旧服务。若系统对下载脚本有文件标记限制，先运行新包已有 `Prepare-Windows-Service.cmd` 校验/解除文件标记；不更改组织执行策略。

维护写入需提供读取时的 SHA256；仅允许明确列出的文件和精确 JSON pointer，先备份再原子替换。service-config 写入前先校验结构。备份、完整配置、原始 API 响应和完整会话留本地；公开审计只含动作 ID、字段名、修改前后哈希、退出码及检查摘要。`restore_local_file` 使用本次备份并检查当前内容未被他人修改。每个动作持久化 intent；unknown 动作或服务器任务不换 ID 重放。

## 验收驱动的执行与预算

`submit_summary` 可以在没有执行实验时报告阻塞，它只保存阶段总结。会话返回后运行本地独立检查，全部通过且已有总结才成功；明确 false 的完成度字段也阻止成功。未通过则把差异反馈给同一 Pi 会话，在授权内继续修复。无进展、未知副作用、时间/轮次/动作/token/费用预算用尽均 blocked，并保留已有证据。

`runner.agent.budget` 默认 maxContinuations=4、maxNoProgress=2、maxActions=64、maxTotalTokens=200000、maxCost=0。maxCost=0 表示不启用费用限额；启用前配置 `runner.model.cost` 的 input/output/cacheRead/cacheWrite 单价（SDK 单位为每百万 token 美元）。累计用量来自 SDK 所有 assistant 和 compaction usage；提供商未报告的用量不能视作真实零费用，限额在已报告的请求结束后生效，单次请求可能超额。总超时和 maxTurns 沿用本地已有值。

ZIP 的 result.agent 记录会话起止、duration_ms、turns、continuations、tool_steps、usage、stop_reason、实际工具和 Skill 哈希。result.execution 单独记录命令/服务器执行时间；Issue 时间线是传输事件。界面明确分开三者，receipt 只证明结果已收到。

## Windows 一次验收清单

1. 页面显示实际 0.6 版本；能力公告含 maintenance profile、实际工具和已加载 Skill 哈希。Mac 自动发现唯一入口；维护目标误选 smoke 时预检拒绝，模型请求数和 CPU 运行数均为零。
2. 在授权测试配置中注入一个可回滚错误，发送一个完整维护目标：读指定说明和附件、检查 simpleHtmlWatch 机器状态、诊断、备份、修复、重载、配置验证、只读 SSH 探测。不得改真实生产控制端口来制造故障。
3. 查看同一 run 中的继续执行事件和独立检查；只有真实配置/接口/SSH 证据满足才成功。回传 result/acceptance/actions/inputs、ZIP 哈希和 receipt，小于 5 MiB。私有原始 SSH 输出仅本机留存。
4. 验证回滚后内容哈希与修改前一致；服务重启不重跑已执行动作，未知远端任务查询原 ID。模型首次总结“完成”但检查未过应继续或 blocked。
5. 若仍失败，一次返回脱敏的版本、配置哈希、实际工具/Skill、未通过检查、stop_reason、Pi 总耗时、命令耗时、累计用量。不要再次只提交 CPU smoke 毫秒数。

本地/CI 测试使用真实 Pi SDK、受控模型/API 和真实本地文件/子进程，不代表用户 Windows 的模型、SSH 或 A5 已验收。需以上实际回执才能关闭部署验收。

## 当前边界与原实验

输入 ZIP 校验哈希、安全解压后提供 list_inputs/read_input；inputs.json 分开记录 downloaded、staged、exposed_to_model、read_by_agent、uploaded_to_server。当前不自动把代码/输入上传到服务器，uploaded_to_server 始终 false；实验代码准备仍需已有批准的本地工作流。simpleHtmlWatch 继续验证执行机 actual_revision 并保留原任务 ID。自动代码传输/编译验收是后续独立工作，不能用本次维护测试或静态 opcode 分析替代真实 A5 热点采样。
