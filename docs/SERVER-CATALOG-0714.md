# 0.7.14：有界机器目录与独立验收

Relay #39 的 Windows 0.7.13 运行已回执，但 server_status 在 26 ms 内返回 HTTP_RESPONSE_TOO_LARGE。Pi 随后耗时 176.302 秒、3 轮，唯一绿检查只证明旧实验入口可读，不能证明八机目录完整。旧 trace 没有 HTTP 路由，无法确定超限的是主页、status 还是 ready。

## 接口与读取边界

机器选择改用已有 GET /api/tasks/machines，最多读取 256 KiB、512 条记录。忙碌、离线、停用、过期和未知机器保留；不从 ready 子集推断总目录。监控与 ready 独立返回，可选失败不丢弃目录。

Token 从主页前 64 KiB 中读取完整 meta 后立即结束下载，不下载后续大页面，也不增加原响应上限。各失败保留错误码、route 和 phase（token/request/identity/output）；没有此 API 的控制器明确返回目录不完整，不猜 ID、不读取完整配置或换用任意文件/命令 API。

已有 server_status 返回结构化目录及可选信息，过大的可选输出显式缺失。完整目录匹配优先使用下面的固定入口，避免模型复述大响应。

## 固定只读入口

Windows 启用 simpleHtmlWatch 后，程序公告 watch-catalog：mode=probe，execution_mode=direct，repository=aiconnector-watch-catalog，revision=watch-catalog-v1，entry=server-catalog。它不需要模型 Key，不修改服务配置和机器白名单，不调用 SSH，也不申请或清理 NPU 预留。忙碌及 unknown 的旧资源保持原样；此固定目录查询可以独立读取。

先取得新版 Windows 能力公告，再按实际配置摘要制作不可变任务：

```json
{
  "requirements": {
    "mode": "probe",
    "execution_mode": "direct",
    "tools": [],
    "checks": ["catalog-complete", "catalog-requested-hosts"],
    "catalog_hosts": ["替换为冻结原始地址的64位SHA256"]
  },
  "code": {"repository": "aiconnector-watch-catalog", "revision": "watch-catalog-v1"},
  "environment": {"target": "watch-catalog"},
  "invocation": {"entry": "server-catalog", "arguments": []}
}
```

其余 task_id/revision/run_id/title/objective/acceptance/artifacts 使用现有格式。catalog_hosts 可省略以读取目录第一页；提供时最多 12 个唯一的原始地址 SHA，按原节点顺序填写，不按 hostname 或名称猜测。合并入口后必须等新能力摘要再提交后续任务，不删除 RECEIVER_CONFIG_CHANGED 门禁。

server-catalog.json 保留 machineId、原地址 SHA、资源键 SHA、采样时间、enabled/status/ready/reason、当前 registry 授权，以及控制器身份（可用时）。不导出地址、Token、完整配置或占用进程/任务原文。别名同时存在时报告歧义，只有唯一匹配或唯一已授权别名才能形成对应关系；物理资源不唯一时明确标记。

query_complete 表示有界目录读取完整。requested_hosts_complete 表示所有请求地址均获得明确映射。授权未测或目录失败时对应字段为 null/unknown，不能断言缺失或未授权；只有完整目录确实没有匹配时才是 not_found。过滤后的输出最多 12 条，has_more/offset 表示预览分页；mappings 保留所请求主机的对应状态。目录取证不证明持续健康、空闲、独占 Grant 或 NPU 执行。

当前授权来自本机原 registry，程序在读取前后核对摘要；目录查询期间授权变更返回 CATALOG_AUTHORIZATION_CHANGED。声明的两项独立检查读取本次 server-catalog.json；目录失败、缺项或歧义返回 blocked，不能用旧 experiment-entry-configured 绿检查覆盖。原错误及不完整证据仍打包回传。

## 验收与后续边界

回归覆盖超大监控与小目录并存、大主页的完整 Token 前缀、主页/各路由超限或错误、busy/offline/disabled/过期/unknown、物理别名、未授权、分页、缺少主机、资源重复，以及真实 Node worker 的零模型请求和缺项 blocked。固定目录读取仍保留旧 unknown、任务和资源意图。

Mac 本机 60425 控制器的真实目录读取只证明相同 HTTP 协议在该实例可用，不能替代 Windows 实际身份、目录、授权或八机 Grant。Windows 升级后，用原八机 SHA 一次回传目录证据；完整映射和授权确认前不构造八机实验 profile。现有 simpleHtmlWatch 包已经提供目录 API，本修复不要求再次升级控制器；API 不存在时报告能力缺失。

目录通过后，再使用 profile_workflow.direct 合并原授权内的唯一固定八机实验入口，核对规范定义摘要。随后独立验证实际 service/atomicGroups、Grant/generation/八份分配和固定启动计划。当前占用、设备告警、正常 64-rank 正确性及真实采样仍分别验收；八个只读观察器不能伪装成 64 rank 业务终态。
