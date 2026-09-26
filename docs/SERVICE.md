# 后台服务、任务看板与 Pi Runner（0.5.0）

这版把已有 Issue / Release 通道接到了本机后台服务。Mac 负责发布和收件，Windows 负责自动领取、调用 Pi、执行已配置实验、打包和交付。无需保持 AI IDE 在线。

## 从安装包启动

使用对应的 `AIConnector-Service-windows-x64.zip` 或 `AIConnector-Service-macos-arm64.zip`。它们包含锁定版本的 Node 24.14.0、Pi 0.87.1 和依赖；Mac 另带 PowerShell 7。Windows 使用系统 PowerShell 5.1。用户机器无需 npm、Python、Git Bash 或下载 Pi 依赖。安装包大于实验 ZIP，实验结果仍严格小于 5 MiB。

1. 解压到固定目录。Windows 双击 `Open-Windows-Dashboard.cmd`；Mac 双击 `Open-Mac-Dashboard.command`。不要在 ZIP 预览里运行。
2. 页面“连接设置”填写 GitHub Token；Windows 再填写 API Key、协议、Base URL 和模型 ID。模型必须支持工具调用。留空的密钥保留旧值。
3. 准备让它长期运行时，运行 `Install-Windows-Service.cmd` / `Install-Mac-Service.command`。Windows 注册当前用户登录时启动的计划任务，并每分钟检查一次是否需要拉起，已有进程运行时不重复启动；Mac 注册用户 launchd。两者退出后由系统重启。**这是用户登录会话服务，Windows 注销后不继续运行。**关闭浏览器不会停止服务。
4. Mac 页面“发布实验任务”已有 CPU 校验示例，直接发布即可。Windows 的默认入口 `local-smoke` 会算出 `sum=50005000`，然后提交 `metrics.json`、执行证据和输出 ZIP。Mac 校验产物后自动发回执。
5. Windows 页面“Pi 环境与工具”配置全局说明、simpleHtmlWatch、网页工具和上下文压缩，保存后点击“检查已保存配置”。完整步骤及 Issue #6 的网关兼容说明见 [Pi 集成 SOP](PI-INTEGRATION.md)。

Windows 如遇 RemoteSigned 下载标记，启动器在比对包内固定 SHA-256 后，只询问一次是否信任这两个脚本；同意后仅移除这两个文件的标记。AllSigned / 组织强制策略会明确阻止启动，程序不会修改或绕过执行策略。Mac 若被 Gatekeeper 拦截，请按组织允许的方式批准下载应用，程序不移除系统安全策略。

页面默认只监听 `127.0.0.1:43110`（Mac）与 `127.0.0.1:43111`（Windows）。启动器打开的 URL 带一次传入浏览器会话的本机访问凭据；它不会发送给 Relay，也不出现在 HTTP 请求 URL。页面提供任务筛选、远端事件时间与作者、真实执行开始/结束时间、Issue / Release / ZIP 链接、同步与 Runner 异常。

密钥保存于 Windows 当前用户 DPAPI 或 macOS 钥匙串。它们不进入任务、状态、日志、进程参数或结果 ZIP。模型会话保存在本机，不自动上传。无人值守环境也可通过进程环境传入 `AICONNECTOR_GITHUB_TOKEN`、`AICONNECTOR_AI_API_KEY`；不要把它们写入公开配置或 Issue。节点必须持有能写 Relay Issues 和 Releases 的 Token。

## 命令与本地文件

```text
runtime/node[.exe] service/cli.mjs init --node mac-outer
runtime/node[.exe] service/cli.mjs open --config service-mac-outer.local.json
runtime/node[.exe] service/cli.mjs start --config service-windows-inner.local.json
runtime/node[.exe] service/cli.mjs status --config service-windows-inner.local.json
runtime/node[.exe] service/cli.mjs uninstall --config service-windows-inner.local.json
runtime/node[.exe] service/cli.mjs stop --config service-windows-inner.local.json
```

`start` 在前台运行，`open` 在后台启动并打开页面，`install` 安装登录自启。要停止自启服务，先 `uninstall` 再 `stop`；已经派出的实验子进程继续执行，不被强杀。若只运行 `stop`，系统守护机制会重新启动主服务。

首次启动生成 `service-<node>.local.json`，该文件不含密钥。默认状态目录 `service-data/<node>/`，与旧版手工 Connector 的状态分开。服务锁、状态校验和绑定检查会阻止多个主进程同时使用该目录或悄悄换通道。升级时保留整个目录和 `.local.json`；不要移动已安装自启服务的路径，不要删除状态来“重试”。

```text
service-data/windows-inner/
  service.json                  # 带 SHA-256 的任务执行与交付账本
  connector/                    # 原有 Connector 的消息/领取/上传账本
  jobs/<SHA256(run-key)>/
    spec.json                   # 领取时冻结的任务、入口与模型配置，无密钥
    worker.json                 # Pi 进程、心跳、真实执行时间
    execution-intent.json       # 启动实验前先持久化
    execution.json              # 真实退出码与实际版本
    sessions/                  # Pi 会话，仅本机
    inputs/                    # 已校验输入 ZIP，不自动执行或解压
    work/                      # 实验工作目录
    result.json / result.zip   # 交付完成后仍保留
```

## 接入自己的实验 / SSH

Pi 通过官方 SDK 在独立子进程内运行。`run_experiment` 执行本机已配置入口，`submit_summary` 总结已有证据，`get_run_state` 在压缩后恢复任务事实。开启本机配置后还可使用 simpleHtmlWatch 和网页工具。Pi 不能从公开评论安装插件、加载仓库扩展或任意修改执行命令。默认不开放 IDE 的完整 shell/edit 能力。

在 Windows 本机配置 `runner.profiles`，环境名称映射到明确入口。例如本地 Python 程序：

```json
{
  "my-experiment": {
    "kind": "command",
    "entry": "run-fixed-experiment",
    "repository": "my-project",
    "cwd": "D:/experiments/project",
    "revisionCommand": ["git", "rev-parse", "HEAD"],
    "argv": ["python", "run_experiment.py"],
    "allowTaskArguments": false,
    "outputs": ["metrics.json", "plot.png"]
  }
}
```

任务的 `environment.target` 选 `my-experiment`，`invocation.entry`、`code.repository` 必须匹配入口。`revisionCommand` 从实验环境查询真实版本，必须等于任务 `code.revision`；此命令自身应只读、有界，代码目录需由操作者保证没有未提交修改。Runner 不会自动 checkout / clone。默认不传入远端任务参数；明确允许后参数也只作为 argv 传递，不做 shell 拼接。

受信任入口通过 `AICONNECTOR_TASK_FILE`、`AICONNECTOR_INPUT_DIR` 和 `AICONNECTOR_RUN_DIR` 读取任务、输入 ZIP、写回结果。显式列入 `outputs` 的文件必须位于 `AICONNECTOR_RUN_DIR` 根目录，不能是符号链接；总大小有界。只有这些文件及受限长度的 stdout/stderr、结构化执行证据会进入公共 ZIP。GitHub/API 凭据不会传给实验进程。

SSH 可使用 [simpleHtmlWatch 入口](PI-INTEGRATION.md)，由其管理远端长任务、日志和结果；也可将 `argv` 指向你本机维护的 SSH 包装程序。后者负责远端固定工作目录、版本检查、运行与收集文件，不能在重连时盲目重新提交。SSH 退出/超时无法证明远端任务结束时，结果必须标记 blocked 并人工核对。默认 smoke 完全不访问 SSH/NPU。

## 恢复语义

| 中断位置 | 恢复行为 |
| --- | --- |
| 本地已发布，尚未写 Issue | 持久化发送队列恢复，原 run_key 不变 |
| API 限流 / 通道暂时离线 | 尊重原 Connector 的冷却与不确定写入回读规则 |
| 主服务退出，Pi 仍在执行 | 独立 Pi 子进程继续；重启主服务读取同一运行目录 |
| 实验完成，上传前断网 | 保留 ZIP，恢复后只继续 Upload / Complete |
| 已发结果、尚未回执 | 继续轮询，同一实验不再启动 |
| 领取后派发是否成功无法证明 | `unknown`，不自动重派，暂停新任务派发 |
| Pi / 实验进程异常消失 | `unknown` 或 blocked，不声称完成，不重复执行 |
| 模型拒绝 / 认证失败 / 超时 | 尽可能交付 blocked ZIP 和已有执行证据 |
| 本地账本损坏、通道绑定改变 | 停止并报告，不能删除状态后重跑 |

`unknown` 需要操作者核对本机/服务器真实进程与工作目录；页面提供“核对环境后，将本次登记为未完成”，确认后交付 blocked 结果并解除队列阻塞。仍存活的工作进程会阻止此操作。不会通过删除锁或清空账本掩盖执行不确定性；确认需要再运行时使用新的 run_id。传输回执与科学验收仍是两件事。

`proxy` 控制 Relay 通道，`runner.proxy` 单独控制模型 API：`system` 使用环境中的 HTTPS_PROXY / HTTP_PROXY，`direct` 直连，也可以指定 `http://127.0.0.1:7890`。模型代理和密钥不传入实验子进程。

## 开发与验收

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
PWSH=/path/to/pwsh python3 -m unittest discover -s tests/service -p test_e2e.py -v
python3 tools/build_service.py --node /path/to/portable/node --pwsh-home /path/to/pwsh-directory
python3 tools/validate_service_bundle.py dist/service/AIConnector-Service-macos-arm64.zip
```

验收使用真正 Pi SDK 和真实 CPU 子进程，但模型与 Relay API 可以是本地受控端点。测试覆盖完整五阶段、双向 ZIP、主服务执行中被杀、通道 503/429、领取不确定、工作进程被杀、版本不符、持久化损坏、HTTP 认证与跨源拒绝。Windows CI 在全新目录解压交付包，使用包内 Node/Pi 和 Windows PowerShell 5.1 再跑完整测试，另覆盖 DPAPI 与下载标记。

真实 GitHub 联调另行记录；本地/Windows CI 通过不等于用户内网、实际 API 或 NPU 已验收。具体证据见 `VALIDATION.md`。

官方接口依据：[Pi SDK](https://pi.dev/docs/latest/sdk)、[Windows](https://pi.dev/docs/latest/windows)、[兼容模型接入](https://pi.dev/docs/latest/models)。实施锁定 npm 0.87.1，以随包类型声明为准，不依赖未来 latest 行为。
