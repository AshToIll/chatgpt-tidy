# 存储与备份

结构以 `src/platform/storage/schema.js` 和 `src/platform/storage/database.js` 为准。本地账号隔离不是加密或跨浏览器同步。

## 数据库

唯一数据库为 `chatgpt-tidy-storage`，**IndexedDB version 1**。首次打开创建结构，重复打开不清空已有资料；运行时不读取、搬迁或删除旧开发库。

| Store | 主键 | 用途 |
| --- | --- | --- |
| `favorites` | `[accountKey, conversationId]` | 会话收藏；按账号和分组索引。 |
| `favorite-groups` | `[accountKey, id]` | 收藏分组；顺序不是身份，排序索引非唯一。 |
| `bookmarks` | `[accountKey, bookmarkId]` | 消息书签；同账号的会话/消息组合唯一。 |
| `bookmark-groups` | `[accountKey, id]` | 书签分组；顺序不是身份，排序索引非唯一。 |
| `module-state` | `key` | 资料修订、目录 checkpoint、标题操作/批次记录及导航 epoch。 |
| `conversation-index` | `[accountKey, conversationId]` | 会话目录元数据，不保存完整聊天正文。 |

## 事务与身份

- 用户与工作区共同决定归属，相同条目 ID 在不同归属下互不覆盖。无效归属在打开仓库前拒绝。
- `src/platform/library/storage/account-library.js` 统一资料读改写，同步领域变换在同一个 IndexedDB 事务内提交，失败整体回滚。
- 只读查询不落盘默认值。默认分组仅在全新资料库首次变更时保存，删空分组不会自动补种。
- 目录使用 `catalogVersion: 2` 记录契约；未知/损坏版本拒绝，不猜测迁移。checkpoint 和并发修订在写事务内复核。
- 官方手动改名只更新已有目录行，不改会话时间、项目归属或 checkpoint；晚到旧扫描不能还原新标题。
- 文档 lease、导航 ticket、导出篮和正文缓存仅在内存。持久化 epoch 不是可恢复的执行授权。

## 标题记录

`src/features/titles/storage/title-operations.js` 将操作与回执保存在 `module-state`，不保存认证信息。

- `prepared` 表示尚未授予派发许可；`dispatched` 表示可能已派发。accepted 只证明请求被接受，不等于 verified。
- 中断后只读核对实际标题，不重发旧确认。显式核对也处理已持久化 accepted 的记录，避免恢复永久卡住。
- 目标题可核验；原标题或第三方改过的标题记为冲突，再按当前状态重新预览。没有有效读取时不凭超时解锁；历史回执不匹配时不计作本次成功。
- 批次替换先保存新计划与指针，再删除旧记录。即使删除失败，旧指针也无执行权限；只清理明确未执行的过期预览，不按年龄删除未知写入或结果回执。

## 浏览器存储

| 区域与键 | 内容 |
| --- | --- |
| sync：`tidy.v1.preferences` | 语言、时区、主题、时间/编号等全局显示偏好。 |
| local：`tidy.titles.rules.v1` | 标题整理的 `mode` 和 `dateFormat`，不跨设备同步。 |
| session：`tidy.export-job.v1` | 当前导出最小回执。 |
| session：`tidy.export-retired-handoffs.v1` | 未确认保存交接的撤销凭据。 |
| session：`tidy.diagnostics.session.v1` | 已接入提示的有界会话诊断；不属于用户资料、备份或任务恢复记录。 |

设置由 Worker 串行合并字段补丁；读取失败不以默认值覆盖原值，丢失回执先核对、不自动重放。缺失设置只读默认值。全局偏好整条记录的类型损坏会明确报错，字段按合法值归一化；标题规则只采纳合法的 `mode`/`dateFormat` 字段，其余补默认值。

导出 session 回执可以包含内部 Blob URL、文件名、来源和阶段，但不包含正文、Bearer 或图片签名地址。浏览器退出或扩展重载后不承诺恢复。

## 会话诊断边界

`src/platform/diagnostics/session-store.js` 是诊断 session 键的唯一串行写入者；`worker-service.js` 在唯一 Worker listener 的独立诊断分支校验来源和白名单。诊断不走资料数据库事务，也不改变任何既有表/字段/偏好键。

- 仅写 `chrome.storage.session`，不写 IndexedDB、local 或 sync，不放入资料备份；不主动联网。
- 最多 512 条、总序列化存储量不超过 256 KiB，另有最多 128 个随机诊断 context 的顺序游标；容量淘汰不代表界面提示已经消失。仍有留存记录的 context 不丢弃顺序游标；淘汰 context 时同时删其记录。完全离开窗口后不保证永久去重。
- 已保存记录可跨侧栏关闭和 Worker 休眠保留；浏览器会话结束清空，扩展重载/更新不承诺恢复，不是长期历史日志。
- 仅保留构建信息、时间、白名单提示/原因/阶段常量和经过安全校验的生成关联号；不保留聊天正文、标题、搜索词、账号、业务会话/消息 ID、URL、凭据或任意异常原文。
- 上送仅接受本扩展精确侧栏或顶层活跃 ChatGPT 内容脚本；读取/清空只允许侧栏来源。不开放 MAIN 或网页脚本直接读取 session。
- 设置中的复制诊断读取已保存快照；清空提升 generation，旧 generation 的在途事件不能把已清记录补回。保存失败不报告为已保存。
- 当前文档另有 256 条内存观测缓冲，与 session 集合不同；客户端和 Worker 写入队列均有限额。未写入或容量淘汰的事件可能缺失，报告显式标注已知不完整，不能复原完整历史。
- 清空诊断不删收藏/书签，不改变导出/标题/备份结果，不解除未知写入锁，也不重试业务。

入口和取证限制见 [DEVELOPMENT](DEVELOPMENT.md)。

## 资料备份

设置页使用 `chatgpt-tidy.library-backup`、`version: 1` 的独立 JSON 格式：

- 包含当前账号/工作区的收藏、书签、分组、已有备注和摘录；当前没有备注编辑入口。
- 不包含设置、标题历史、目录缓存、完整聊天、图片或认证信息。备份文件未加密，不是聊天导出 JSON。
- 新目录可能产生不同扩展 ID，资料不会自动共享；在旧版导出，再到同账号/工作区的新版恢复。
- 导入先严格校验，再只读预览；确认时复核身份、有效期和库修订，在同一事务合并。已有条目不覆盖，重复导入不重复，分组 ID 冲突重新分配。
- 预览确认有效期为 10 分钟；取消、换账号/文档或 Worker 重启使旧确认失效。回执丢失不自动重放，提示检查现有资料。
- 单文件最多 8 MiB，收藏与书签合计最多 20,000 条，每类最多 500 个分组；参数位于 `src/features/settings/model/library-backup-format.js`。
- 文件中的账号字段只用于防止误导入，不是数字签名，也不能建立登录身份。

检查命令见 [DEVELOPMENT](DEVELOPMENT.md)。
