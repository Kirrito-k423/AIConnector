# 0.7.16 发布与验收记录

日期：2026-10-14（北京时间）。程序来源：`0763ec346046623e6579c0a1a0855e445e396010`；后续文档提交不改变这些已测试包。

| 验收范围 | 结果 |
| --- | --- |
| Mac 服务源码与新解压包 | 各 173 项通过、6 项 Windows 专用跳过 |
| Mac 实际包的完整交付/重启/断网/未知任务闭环 | 10 项通过、1 项 Windows 专用跳过 |
| 看板浏览器 | 13 项通过，包含接收端排队 IP 与完成任务不受陈旧快照影响 |
| Python Health-only 门禁 | 4 项通过 |
| 原 Windows 0.7.15 包 + 中文安装/配置目录 + CIM/双击 + DPAPI + 大历史 | 26 项通过；历史响应 1,977,116 字节，启用使用小型能力接口 |
| 最终 Windows 发布流程 | 服务、控制器、PowerShell 5.1、实际解压包、故障恢复、看板、维护恢复、32 轮并行与性能检查全部通过 |

[完整 Windows 发布验收](https://github.com/Kirrito-k423/AIConnector/actions/runs/38514151677) · [中文路径原包验收](https://github.com/Kirrito-k423/AIConnector/actions/runs/38512197615) · [两端下载](https://github.com/Kirrito-k423/AIConnector/releases/tag/v0.7.16-rc.1)

| 公开包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Mac arm64 | 139264969 | `7e6ce8b41bd6809d4a9d2e625f4ba27665c4e68a13ec0788d7fb26773f2a9d49` |
| Windows x64 | 63612215 | `694df9bc5b0e6ef0a8ab336c5fed2ab2255bd5eea084449e713d9428eed460eb` |

Windows 公开 URL 已匿名全量下载，SHA-256、ZIP CRC 与 7,768 项清单成员均已复核。Mac 本地包全量核验 8,346 项成员，并通过实际运行验收。Mac 已换用最终程序，原配置、看板令牌、文件传输密钥和原 131 项提交均保留。

回归复现确认：旧机器池仅检查控制器 ready，会选中被外部 vLLM 占用的节点；新增 NPU 要求后跳过占用节点并选择空闲 Alarm 备选。全忙时没有 Claim、SSH 或模型调用；释放资源后继续原 run。整组选择去重物理别名；预留丢失与 unknown 仍查询原 ID。结果保留 Warning/Alarm 的原始健康观察。

真实 SSH/NPU/模型在软件测试中由 fixture 提供；历史 npu-smi 格式重放仅验证解析。本次没有运行真实 HIXL、四 worker SSD 或 T3/T4。Windows 需升级并按 [入口适配](SHARED-SCHEDULING-0716.md) 登记 NPU 机器池、修改原 Health-only 脚本/验收后复测。部分卡共享不是本版整机预留的承诺；不抢占外部进程，不重放未知任务，不把 Alarm 伪造为 OK。
