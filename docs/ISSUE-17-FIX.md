# 0.7.19：能力公告恢复与手动同步提示

Issue #17 的 `POLL_TOO_FREQUENT` 与 `PROVISION_UNCERTAIN_OR_REJECTED` 是两条不同路径。前者是手动同步 15 秒防重复点击；后者可能让 Windows 能力公告停止更新，超过两小时后 Mac 不再接收新任务投递。

## 复现与修复

真实 PowerShell + HTTP fixture 复现：公告 POST 在写入前断开，随后的 GET 返回 200，原实现将公告保存在 `capabilities_pending`，对应 provision 永久保持 `uncertain`；下次 Advertise 抛出与现场一致的 `line:203 / HTTP_OK / http:200 / PROVISION_UNCERTAIN_OR_REJECTED`。诊断里的 200 是最后一次查询的状态，不证明原 POST 成功。现场原始 POST 的失败类型仍需 Windows 本地记录核实。

- 对不确定的能力公告，先完整读取远端评论。若找到了完全一致、作者与命名空间合法的公告，即使它不是最新评论，也只确认已有记录，不重新发布。
- 如果完整读取确认不存在，沿用持久化交付恢复规则：至少两次相隔一个轮询间隔的缺席观察，并经过不短于两倍请求超时、两倍轮询间隔和写入间隔的等待期；重复故障指数退避，上限一小时。旧状态没有原发送时间时，从本次首次观察开始等待。
- 查询失败不算缺席证据，并清除本轮缺席计数。明确拒绝的请求不会自动重投，改为显示 `PROVISION_REJECTED_<原HTTP码>`。任务创建、Release 创建、Claim、SSH 执行和机器预留没有获得新的自动重试权限。
- 保留原 pending 公告正文、运行身份和所有历史状态。原公告核对完成后，服务再按当前配置发布新快照；不修改已发布公告的时间来绕过新鲜度校验。
- 重复手动同步返回“正在同步/稍后可同步”及剩余等待时间，合并重复请求，不再把防连点显示成失败。按钮显示倒计时；状态栏在出错时仍保留最近同步时间。自动轮询和 GitHub 限流退避继续生效。

默认八路密文上传、768 KiB 分块、全局写入间隔、加密配对和断点保留机制继续沿用 0.7.18。此修复不证明内网已经达到八路并发或取得速度提升。

## 验证入口

- `tests/service/manual-poll.test.mjs`：真实本地服务接口，连续请求、多个调用者及已在途 Poll 合并。
- `tests/test_relay.py -k capability`：真实 PowerShell，发送前/发送后丢回复、独立缺席观察恢复、旧版本状态、查询失败、非最新评论匹配、明确 403、限流恢复。
- `tests/web/dashboard.test.mjs`：真实 Chromium，倒计时、防重复点击、后台同步状态、旧服务错误兼容、故障与最近同步时间同时显示。
- `tools/validate_service_bundle.py`：全新解压、manifest 校验、实际包内 Connector 再跑能力公告回归，继续运行双端服务与八路上传 fixture。

## Windows 验收

下载新包后解压，双击 `Upgrade-Windows.cmd`，使用原配置和原数据目录。不要删除 `state.json`、provisions、配对密钥或现有任务；不需要重新启用 owned-files。

1. 看板版本为 0.7.19，最近同步时间持续更新，重复点击不显示 `POLL_TOO_FREQUENT`。
2. 如果公告是“不确定”，看板显示正在核对；经过正常等待和完整读取后应恢复公告。若原状态为明确拒绝，应显示具体状态码，先据该码处理权限/远端拒绝，不能通过删除状态强行重试。
3. Mac 能读到两小时内的 Windows 新公告，且 owned-files 仍 ready、收件人绑定未改变。
4. 再执行同一组四文件、约 74 MB 的复测，从 Windows `transfer_part_started` 和 HTTP elapsed 日志重建并发，与旧版 152 分 1 秒的首末分块到达间隔比较。未完成此步骤前，不宣布八路实测通过。

Issue 正文中历史 `FILESYSTEM_IO_ERROR`、`UPLOAD_REJECTED` 的确切成因不能由最新评论推断；保留它们的本地诊断及原任务身份，公告恢复后分别核验。
