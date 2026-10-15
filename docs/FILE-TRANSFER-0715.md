# 0.7.15 文件取回：Windows → Mac

AIConnector 现在将文件传输与实验执行分开。文件取回由固定程序执行，模型请求数为零，不需要先修复 Pi 模型网关。Windows 当前账户可读的文件与目录均可请求；同一所有者无需逐项登记目录白名单。首次启用时固定接收 Mac 的公钥，之后其他 AI 只调用传输入口。

## 通道与状态

公开 Relay 继续承载 Issue、Release 和 ZIP。文件请求（含 Windows 路径、查找的文件名）先用 Windows 公钥加密；返回文件、相对文件名、目录结构、逐文件 SHA 和清单用 Mac 公钥加密。使用 `age-encryption@0.3.1`，采用标准 age 文件格式，未自行设计密码算法。Windows 解密身份保存在原凭据库（DPAPI），不会进入 Pi 或任务；Mac 私钥保存在本机权限 0600 的文件，不能上传。

公开平台仍能观察中性任务 ID、节点、时刻、密文大小、分块数量与密文 SHA。公开回执只表示结果索引 ZIP 完整收到，不能表示文件已取回。Mac 解密、逐文件校验后生成**本地** `.aiconnector-receipt.json`；只有其中 `files_verified=true` 才证明文件到手，资料齐备、实验真实性和结论另行验收。

数据不限于单个小 ZIP。从 0.7.17 起程序按最多 768 KiB 明文片段封装，每个加密 ZIP 严格小于 1,000,000 字节，以兼容约 1 MB 的出站代理限制；Mac 继续接受旧版最多 3 MiB 的明文片段；数据分块先上传，最后上传结果索引并发布结果。Windows 上传记录按分块 SHA 落盘；网络断开或服务重启后核对原分块，不重复已确认上传。Mac 保留已验证片段的本地进度，续传不重复下载或追加。发布后源文件变化不会改变本次冻结密文。读取期间文件或目录发生变化会明确失败，不交付伪完整快照。

此版本不是无限制文件系统管理：只支持读取、列表和按精确名称查找，不执行任意命令，不写回 Windows。遵守当前 Windows 账户权限。递归读取拒绝符号链接、junction 和特殊文件；查找跳过链接、遇到无法访问目录时在**加密**列表中写 `query_complete=false` 及缺口，不能断言全盘没有文件。第一版结果索引限制为 256 KiB / 4096 个分块，文件清单限制 3 MiB；这是当前索引格式的边界，超限明确报错。服务执行超时仍适用，网络交付有原有持久化重试；未知读取进程不得换运行 ID 偷偷重跑。尚不支持跨网络直接读取 Linux 服务器文件、目录快照服务或 Windows 文件写入。

## 一次启用

先升级**原** Mac 与 Windows 服务，保留配置、凭据、数据目录、运行和资源锁。以下命令在对应安装目录执行；真实配置可以仍位于旧安装目录。

已经安装 0.7.15-rc.2 的当前配对实例，可以保持 Windows 看板打开，下载 [v2 启用小修复包](https://github.com/Kirrito-k423/AIConnector/releases/download/v0.7.15-rc.2/AIConnector-FileTransfer-Enable-Windows-v2.zip)，全部解压后双击 `Enable-file-transfer.cmd`。它自动找到原服务并核验，适用于旧命令静默退出或 [Issue #15](ISSUE-15-FIX.md) 的历史响应过大问题。包内 Mac 公钥必须是本次接收方的公钥；不要把这个配对包用于其他 Mac。

Mac 创建接收身份（父目录预先存在；不要覆盖旧身份）：

```sh
./runtime/node service/data-cli.mjs init-key \
  --identity /私有目录/identity.txt --recipient /私有目录/mac-recipient.txt
```

只把 `mac-recipient.txt` 公钥交给 Windows。Windows PowerShell **一次**启用所有者文件系统读取并热加载，不配置逐文件清单：

```powershell
.\runtime\node.exe service/data-cli.mjs authorize-owned `
  --config "C:\实际路径\service-windows-inner.local.json" `
  --profile owned-files `
  --recipient "C:\实际路径\mac-recipient.txt" `
  --allow-public-ciphertext --reload
```

该命令保留原服务器入口、模型、通道和运行配置，备份原配置，生成 Windows 请求解密身份并写入原 DPAPI 凭据库。成功返回 `scope=owned-filesystem` 和 `reload_required=false`。重复启用同一个 ID 返回 `EXPORT_PROFILE_EXISTS`，不会覆盖原授权；需要改变接收公钥时显式修改配置并复核，不能自动换收件人。

不方便拷贝公钥文件时，可将 `--recipient "公钥文件"` 替换为 `--recipient-text "age1实际Mac公钥"`，只复制一条命令即可；公钥可以公开，私钥绝不能提供给 Windows。

等待 Windows 公告出现 ready 的 `owned-files`：`mode=transfer`、`execution_mode=direct`、`data_export.scope=owned-filesystem`、`chunked=true`。核对公告的 `recipient_sha256` 与 Mac 公钥指纹。未配置身份、旧版本、未热加载或公钥不匹配会在预检时阻断；不用模型诊断来代替这些确定性检查。

## 其他 AI 的操作

使用全局 `$aiconnector` 的辅助脚本。`--config` 放在子命令前，默认发现原 Mac 配置。路径仅发送给 Mac loopback API，在进入 Relay 前已加密。

```sh
python3 /实际Skill路径/scripts/aic.py transfer \
  --profile owned-files --recipient-sha256 Mac公钥指纹 \
  --task-id transfer-001 --revision 1 --run-id run-001 \
  --operation find --source '@home' --name '项目复现报告.md'
```

`@home` 在 Windows 展开为当前账户主目录；`@roots` 展开为可见盘符。可重复 `--source` 指定多个绝对路径。`find` 是精确文件/目录名查找；`list` 列出指定目录一层；`read` 读取指定文件或递归目录。文件名、路径不得手工写入 Issue 文案。任务 ID、入口 ID 使用中性标识。新取件修改内容时使用新修订；重查状态、继续交付与断点续传使用原运行键。

```sh
python3 /实际Skill路径/scripts/aic.py wait --key transfer-001/1/run-001 --seconds 55
python3 /实际Skill路径/scripts/aic.py result --key transfer-001/1/run-001
```

从已校验结果取得本地索引 ZIP 路径和协议 SHA。Mac 下载原运行的分块、解密并验收，`--destination` 必须是尚不存在的新目录：

```sh
./runtime/node service/data-cli.mjs decrypt \
  --config /实际路径/service-mac-outer.local.json \
  --result /已校验缓存/结果摘要.zip --sha256 协议ZIP摘要 \
  --identity /私有目录/identity.txt --key transfer-001/1/run-001 \
  --destination /私有目录/本次取件
```

Mac 接口只下载本次经校验索引声明的分块，限制为该运行 Release 的 `result--windows-inner--SHA.zip`，匿名下载，核对 SHA 和长度。每块的加密绑定含运行键、传输 ID、文件序号和偏移；错误私钥、篡改、跨运行混包、越界路径或哈希不符都拒绝。中断后重复**同一解密命令**即可从私有 `.aiconnector-partial` 目录继续；最终文件和回执只在完整验证后出现，不覆盖已有目标。

读 `listing.json` 中的匹配路径和 `query_complete`，再用新的取件修订 `--operation read --source "实际Windows路径"` 取回报告和源码目录。列表只证明查找结果；文件回执只证明取件；不要在缺少源码、复现脚本、原始结果或版本信息时通知下游“资料齐备”。向其他会话或人员发消息仍需用户明确授权。

读取父目录时，程序排除**本次传输的工作目录**，避免把新生成的密文和进度文件递归复制进自身。私有清单及本地回执记录 `excluded`，并将 `selection_complete=false`；返回文件的 `files_verified=true` 只说明已交付的文件逐项一致，不能忽略排除项称整个选择完整。这是运行时临时数据的排除，不是项目或目录权限白名单。

## Windows 一次性验收

使用无敏感测试目录，至少包含报告、二进制、零字节文件、空目录、嵌套目录及超过 5 MiB 的随机数据。

1. 模型网关停用或不可用时，find/list/read 都完成，模型请求为零；原 NPU 任务和 unknown 资源记录保持不变。
2. 公开 Issue 与所有 ZIP 不出现私有路径、文件名、正文、明文文件摘要或解密身份；双方公钥指纹正确。
3. 模拟分块上传与 Mac 下载中断，恢复同一运行，不重复已确认分块；最终字节逐文件一致，空目录保留。
4. 改错 Mac 私钥、篡改密文、混入其他运行的分块，程序拒绝且不输出最终文件。目录无权限或有链接时报告明确缺口，不能称全盘查找完整。
5. 配置在领取或读取期间改变时返回 `EXPORT_AUTHORIZATION_CHANGED`；其他 AI 无法用 prompt 改变收件人、获得 Windows 写入或命令执行能力。

CI 的 Windows 进程和本机 fixture 验证只能证明程序与协议；内网真实 Windows 启用和 NDS 取件尚需上述实际回执。
