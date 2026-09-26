# Pi 环境、服务器工具、联网与自动压缩

## Windows 升级与一次配置

Issue #6 报告的现有链路是 Pi → `http://127.0.0.1:18181/v1` → 本机 model-relay → Windows 系统 curl → 公司代理 → 模型 API。本版沿用已有 Base URL、模型 ID、API Key、`compat` 和登录自启配置；不需要重新部署模型网关。网页工具的出网方式单独配置，不推断 Node 能直连外网。

升级前等待没有活动实验，备份原安装目录。用旧目录的 `runtime/node.exe service/cli.mjs uninstall --config service-windows-inner.local.json` 取消 Connector 自启，再 `runtime/node.exe service/cli.mjs stop --config service-windows-inner.local.json` 停止 Connector。将新包的 `service/`、`node_modules/`、`package.json`、`package-lock.json`、`docs/` 覆盖到原固定目录，再运行 `Install-Windows-Service.cmd`。两版包均使用 Node 24.14.0，无需替换正在供模型网关使用的 Node。保留原 `connector.config.json`、所有 `*.local.json`、整个 `service-data/`、`model-relay.mjs` 和网关计划任务。不要删除状态、移动安装目录或重建任务 ID。回退时停止 Connector 并恢复备份的程序目录和配置。

打开看板的“Pi 环境与工具”，按以下顺序一次完成：

1. 全局环境说明：填网络限制、服务器用途、工作目录与实验要求。可填写本地 Markdown 路径，一行一个，相对路径以 service 配置文件所在目录为准。文件总内容连同文本不超过 64 KiB。
2. simpleHtmlWatch：在同一台 Windows 启动其 **v0.4.0-rc.1 或兼容版本**，设置 `http://127.0.0.1:8765`，打开“启用服务器工具”。先在它的页面配置 SSH 机器和主机指纹。
3. 实验入口：展开入口配置，用“添加 SSH 实验入口示例”产生模板，修改机器 ID、仓库名、版本查询和实验命令。`outputs` 指定允许公开交付的文件。
4. 联网：Windows 选“系统 curl”；代理可填公司允许的 HTTP 代理 URL，或者 `system` 使用环境变量，或者 `direct`。`system` 不自动读取 Windows 浏览器 PAC/WinINET 代理。填允许的精确主机名，非默认端口必须包含端口。搜索服务可选，URL 模板须包含 `{query}`。
5. 自动压缩：默认开启。填写模型实际上下文窗口与输出上限；预留空间不得小于单次最大输出，近期保留量与预留量之和必须小于窗口。默认窗口 32768、输出/预留 4096、保留近期 8192。长实验建议超时 1800 秒、最多 32 轮；已有配置的超时/轮数不会被升级覆盖。
6. 保存后点击“检查已保存配置”，可选填一个允许访问的网页 URL。该检查读取文件、服务器状态和网页，不提交实验，也不调用模型。最后从 Mac 发布一项已配置入口的小实验，检查 ZIP 和回执。

配置检查失败会显示该项错误，已通过项保留；不必反复重新填写模型凭据。保存 Pi 配置不会修改模型 Base URL、协议、ID 或密钥。切换模型协议/地址仍使用“连接设置”。

## 配置冻结与数据范围

`runner.agent` 包含 `globalPrompt`、`contextFiles`、`simpleHtmlWatch`、`web` 和 `compaction`。领取任务时读取文件，连同文本、摘要哈希、工具配置与时间写入本机 `spec.json`。后续修改文件/页面只影响下次领取。全局说明和文件会发送到你配置的模型 API，并写入本机 Pi 会话；它们不会加入公开 ZIP。不要放密码或 Token。默认 Pi 全局目录不会被隐式读取；要复用其中 AGENTS.md 请明确列入文件路径。

实时服务器信息通过 `server_status` 查询，保留监控原始采样时间和本次查询时间。`ready` 只表示监控新鲜且未被 simpleHtmlWatch 任务占用，不证明 NPU 空闲或资源独占。SSH 密码由 simpleHtmlWatch 管理；Connector 仅在内存使用其临时本机会话 Token。

## simpleHtmlWatch 实验入口

```json
{
  "npu-example": {
    "kind": "simplehtmlwatch",
    "entry": "experiment",
    "repository": "my-project",
    "machineId": "实际机器ID",
    "revisionCommand": "git -C /home/your-user/project rev-parse HEAD",
    "shell": "python3 /home/your-user/project/experiment.py --output \"$SHW_RESULTS_DIR/metrics.json\"",
    "outputs": ["metrics.json"]
  }
}
```

任务 `environment.target=npu-example`、`invocation.entry=experiment`、`code.repository=my-project`，`code.revision` 填预期 Git commit，`invocation.arguments=[]`。也可用 `group` 替换 `machineId`；两者均不指定时，必须在本地入口明确写 `allowAnyMachine:true`。Pi 只能提交本地入口中的命令，不能由 Issue 或网页提供任意 shell。版本查询与实验命令合并后不得超过 simpleHtmlWatch 的 4096 字节限制。

`run_experiment` 自动提交、按固定间隔等待完成和回收，不在等待时消耗模型轮数。Pi 也可使用 `submit_server_task`、`server_task_status`、`server_task_logs`、`collect_server_result`，取得执行证据后才能 `submit_summary`。长任务应使用 `run_experiment` 等待，避免模型不断查询消耗轮数。

提交前持久化 `watch-task.json`，任务 ID 由 Connector run key 派生。提交超时、进程中断或响应丢失后只查询原 ID；不会换 ID 再提交，也不开放自动 abandon/取消。simpleHtmlWatch 重启换 Token 时自动刷新。主服务重启不影响独立 Pi worker；worker 本身崩溃仍登记 `unknown`，需要核对远端任务，不能删除账本重跑。

服务器在实验启动前执行真实版本查询，把结果保存为 `aiconnector-revision.txt`。不匹配即停止实验。回收时验证其实际版本和控制器退出码；缺少版本证据或归档失败时交付 blocked，保留远端任务 ID。它不检查 Git 工作区是否脏，需维护实验目录。simpleHtmlWatch 的受限 `tar.gz` 在内存解码，仅取 stdout/stderr 和 `outputs` 列出的普通文件，合成 AIConnector 的小于 5 MiB ZIP；不会把整个远端归档或其它文件直接公开。符号链接、异常路径、重复文件、展开超过 16 MiB 会拒绝。当前不会向服务器自动上传输入 ZIP、安装依赖或同步代码，实验文件需预先存在于服务器。

## 联网工具

`web_fetch` 读取有界 HTML、文本、JSON 或 XML，返回来源 URL、查询时间、文本与裁剪标记。默认响应上限 256 KiB，模型看到的文本最多 16000 字符。`web_search` 仅在本地配置搜索 URL 模板时注册，适用于公司搜索服务或兼容的文本/JSON 搜索端点；不附带商业搜索账号，不保证任意站点可访问，也不能渲染需要 JavaScript 的页面或绕过反扒。

允许主机按 **host:port 精确匹配**，重定向逐跳检查。系统 curl 使用完整路径 `System32/curl.exe`，不经过 PowerShell alias，不加载用户 curlrc，不关闭 TLS 校验。网页工具不会携带模型/GitHub/simpleHtmlWatch Token，不提供任意请求头或 POST。内部文档站也须明确列入允许主机。Mac 的代理地址不是 Windows 上的代理；网络仍遵守运行电脑的实际访问权限。

网页、日志与任务附件均作为参考数据，不能改变本机工具范围。参考资料只返回本机 Pi 会话，不会自动上传到 Relay；由 Pi 提交的最终总结仍会公开。

## 自动压缩与证据

使用锁定 Pi 0.87.1 的原生自动压缩，不另写摘要算法。看板显示压缩开始/完成、次数和环境快照哈希。`get_run_state` 从本机执行证据取回结果与远端任务 ID；摘要丢失细节也不会导致重复执行。对话历史仍在本机 `sessions/`。压缩调用同一模型端点，消耗 API 额度；压缩不是跨任务长期记忆。

验收包含真实 Pi SDK 自动触发压缩并继续 CPU 实验、原任务重复工具调用去重、SHW 提交后丢响应、Token 轮换、实际版本不匹配、归档边界、两种网页传输和页面设置保存。模型、网页与 SHW 使用受控端点；不把这些测试称作真实内网/NPU 验收。Issue #6 的真实模型网关报告与本版新增能力的测试分开记录。
