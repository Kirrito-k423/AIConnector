# Issue #15：启用取件时响应过大

Windows 双击启用程序报 `HTTP_RESPONSE_TOO_LARGE`。失败发生在启用器读取本机接口时，尚未开始文件读取或传输。

## 原因与修复

旧启用器用 `/api/status` 判断接收服务是否正确。这个接口包含全部任务、任务正文、交付记录和本地队列；任务积累后，响应会超过本机 HTTP 客户端的 1 MiB 上限。启用所需的信息只有服务身份和能力，却读取了无关的完整历史。

启用器改用已有的 `/api/capabilities`，核对 `local.schema` 与 `local.node` 后启用或重新加载，再从相同接口核验 `owned-files` 的 ready 状态、所有者读取范围与固定 Mac 公钥指纹。读取体积与历史任务数量无关。HTTP 上限继续生效，热加载响应另外限制为 16 KiB。

此次修改在首次配置写入前完成服务验证，沿用实际运行进程的原配置与 DPAPI 凭据库。重复执行已绑定同一 Mac 的入口只重新加载；其他 Mac 公钥不会覆盖原绑定。

## Windows 操作

使用 [v2 小修复包](https://github.com/Kirrito-k423/AIConnector/releases/download/v0.7.15-rc.2/AIConnector-FileTransfer-Enable-Windows-v2.zip)，保持 Windows 看板打开，全部解压，再双击 `Enable-file-transfer.cmd`。看到“文件读取已启用并核验”即完成。

不需要重装软件、修改命令或寻找配置路径。v2 替代旧小修复包；原 Mac 和 Windows 安装 ZIP 保持原发布校验值。

这个发布附件携带配对 Mac 的公钥，适用于该配对实例。其他 Mac 使用时必须提供自己的公钥，并与 Windows 公告指纹核对；不能复用别人的收件身份。

## 回归验证

- 实际服务中构造超过 1 MiB 的历史，旧启用器稳定触发 Issue 中相同错误；修复后成功，且断言启用全程不请求 `/api/status`。
- Windows 原生测试下载、核验并解压未经修改的 0.7.15-rc.2 安装 ZIP，启动包内真实 CLI 与后台服务；加入 120 条历史任务，双击启动器通过真实 CIM 发现正在运行的服务，导入原安装库并启用。
- 核验实际后台热加载、DPAPI 凭据保留、固定公钥、重复执行，以及既有任务和实验入口保留。断言输出不包含私钥或凭据。
- 同时运行加密文件、分块续传和真实数据命令入口回归。

[Windows 原生验收](https://github.com/Kirrito-k423/AIConnector/actions/runs/38340264539)：26 项全部通过，无跳过。原安装包来源 `5b3cafb55582c9b29c4358f812e34eda38efc09f`，实际测试看板响应 1,977,116 字节；真实 CIM 自动发现与双击启用通过。

v2 修复 ZIP 为 4,521 字节，SHA-256：`e44e1ba820e81c990d442ac10f33067cf769a312302a2ef996dce35ae02f95a8`。包含已测试脚本、启动器、配对 Mac 公钥和中文说明，不含私钥或资料。

Windows CI 是测试环境证据。内网实际启用以最新 ready 公告为准，文件真正取回以 Mac 本地解密及逐文件验证回执为准。
