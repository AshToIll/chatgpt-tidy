# 文案与提示维护入口

## 产品经理改哪里

文字只编辑 `catalogs/*.json`。每个消息键对应四种语言；一个键只属于一个文件：

- `common.json`：公共按钮、共享字段、连接状态。
- `time.json`：时间栏与网页时间标签。
- `titles.json`：当前/批量标题整理。
- `favorites.json`：收藏栏及网页收藏按钮。
- `bookmarks.json`：书签栏及网页书签按钮。
- `search.json`：关键词、日期、日历与搜索状态。
- `export.json`：导出页、任务、预览、生成文件。
- `settings.json`：设置、备份、主题名称和本地诊断。

修改字符串值即可；`{count}`、`{title}` 等占位符是运行时参数，不可随意删除。键名是稳定身份，不随措辞改名。`pageBindings` 和 `themeBindings` 只是映射，不是第二份文案。

旧版 2268 条翻译仍由原 `BEHAVIOR_BASELINE.json` 指纹锁定。经批准的新键或修改必须逐键登记 `tests/fixtures/message-copy-amendments.json`；修改记录明确四语言的 before/after 和理由。不能批量重录历史基线。这轮只增加已确认缺失的恢复动作和诊断文案，不改其余标签或英文回退规则。

## 已确认无生产调用的文案退役

`retired-keys.json` 只保存精确退役身份、原所属 catalog、审计理由、现行替代键及四语言原始哈希，不保留旧译文或运行时兼容别名。没有语义等价替代时，`replacements` 为空数组，不能为凑映射而恢复旧提示。

- 删除前必须沿动态 `t()`、模板、映射、网页/主题绑定和导出引擎核实生产来源；索引“无静态引用”不是可删证明。日历的六个动态拼接导航键仍保留。
- 退役键从唯一 catalog 删除；构建器拒绝它在任意 catalog 重新注册。动态绑定仍要求目标文案存在，不把未知键补成旧路径。
- 原 2268 条历史哈希不删不重录。测试逐条核对退役 `beforeHashes`，只允许清单中的四语入口消失；其他原文、缺译回退和新键审批规则不变。
- 直接翻译调用旧键会进入提示索引的 `unknownLiteralCalls` 门禁；合法业务字段、函数名和 DOM dataset 不按裸字符串禁止。新增动态调用仍须审查其键来源并覆盖测试。

## 文字、生命周期、业务状态的边界

- catalog 只回答“显示什么”；`notice-registry.js` 登记表面、类别、恢复入口与清除证据。
- `notice-lifecycle.js` 只拥有提示实例、展示令牌与计时，不请求网络、不自动恢复、不修改业务结果。
- 功能 owner 拥有账号/文档/操作归属和真实结果。旧请求失去展示权，不等于已提交写入被取消。
- `diagnostics.js` 只观察实际呈现与清除；不能决定提示是否出现。

| 类别 | 用途 | 生命周期 |
|---|---|---|
| transient | 搜索或导航的一次反馈、已确认成功 | 可配置 TTL；新交互、离开显示域或本实例到期清除，不改业务失败状态 |
| condition | 连接失败、读取失败、无效输入 | 无 TTL；由当前条件恢复、对应输入变更或显示域变化清除 |
| operation | 在途任务、已提交或结果未知的写入 | 无 TTL；业务 owner 保留待核对结果，隐藏界面不能当作完成 |

## 共用 API

普通内容脚本在 manifest 中先加载 `notice-lifecycle.js`；模块消费者通过副作用 import 加载同一文件。唯一运行时是 `globalThis.ChatGPTTidyNoticeLifecycle`，没有第二套兼容实现。

- `createOwner()`：`begin()` 返回不透明 token；`owns(token)` 检查对象身份；`revoke()` 撤权；`dispose()` 永久停止。token 不含账号或会话内容。
- `createSlot({ onChange, now, setTimer, clearTimer })`：注入时钟方便测试。
  - `replace({ kind, ...presentation }, { owner, token, ttlMs })` 返回新冻结实例；owner/token 可选。
  - `current()` 只读当前实例；普通重绘/翻译不得 replace 来延长时间。
  - `clear(expected, reason)` 只有 expected 仍是当前实例才清除。
  - `setPaused(boolean)` 保留剩余可见时间；`dispose()` 撤销计时和实例。
  - 只有 transient 可以设置正数 TTL。condition/operation 携带 TTL 会直接拒绝。
- owner 撤权本身不取消请求，也不自动抹去 slot；调用方明确处理显示域，同时在业务层保留 unknown。
- `cause(error)` 是唯一安全归因投影；`diagnostics.cause` 引用同一函数。保留已登记 reason、生成的 request/navigation/job ID、源码 stage 白名单、固定断连类别、合法 HTTP status 和布尔 retryable。自由异常文本、details 对象、账号与聊天内容不进入记录。

未知写入的主原因与“核对失败”副原因不能相互替换。标题的两条实际可见提示分别登记；只保留模型中的副原因但没有显示时，不伪造 show 记录。

## 本地诊断的两层边界

1. messages observer 在当前文档保留最多 256 条内存记录。`snapshot()/exportText()/clear()` 只查看或清理这一层。
2. 独立 `platform/diagnostics` 通过注入的 `setSink(fn)` 接收已清洗记录，并聚合至 worker 的 `storage.session`：最多 512 条、256 KiB。成功交付的记录在关闭侧栏后仍可通过设置里的复制/清空入口使用，浏览器会话结束后清除。

sink 同步/异步失败都不能中断业务；它不改变原提示计时或业务状态。尚未发出或在途记录不保证在文档关闭前交付。不上传，不存聊天正文、账号、URL、凭据或原始 Error。诊断留存不是业务回执账本；本轮备份恢复待确认操作只在当前侧栏文档内按账号保留，不冒充跨侧栏关闭的写入恢复能力。

## 改完如何生效

1. `npm run build`：按顺序生成文案、提示索引/构建指纹与网页 bundle。
2. `npm run verify`：检查生成物、架构和回归。
3. 按开发文档重载扩展、刷新 ChatGPT 并重开侧栏，避免继续运行旧构建。

`build:messages` / `check:messages` 是文案专项命令，不能替代完整构建。生成的 i18n/page-runtime/build-info 不手改；侧栏 HTML 与时间/设置模板的初始备用文字也从 catalog 同步，模板结构仍由相应栏目维护。商店元信息仍在 `src/_locales`，不属于运行时提示。
