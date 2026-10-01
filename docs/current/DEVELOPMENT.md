# 开发与检查

## 环境与运行入口

使用 **Node >=24** 和 npm，在当前候选目录根部执行：

```sh
npm ci
npm run build
npm run verify
```

产品 manifest/package 为 **0.5.0**，候选不等于已发布。来源与历史基线见 [BASELINE_VALIDATION](BASELINE_VALIDATION.md)，本次证据见 [VALIDATION](VALIDATION.md)。来源版本只读，不在那里生成或修改文件。

Chrome/Edge 开发者模式加载本项目 `src`；扩展重载后刷新 ChatGPT，再重开侧栏，避免新旧页面脚本混用。不同目录可能产生不同扩展 ID，资料不自动共享，先看 [STORAGE](STORAGE.md)。

库、字体随源码提供，正常开发不依赖相邻项目或个人草稿；只有重新制备字体时才需要自行准备字体源与对应 Python 环境。

## 修改入口与职责

| 修改目标 | 入口 |
| --- | --- |
| 界面、事件、专属样式 | `features/<栏目>/ui/` 的 view/presentation/CSS |
| 条件、选择、请求代际、操作状态 | 同栏 controller / owner，不塞回 render |
| 页面 API 或原生 UI 适配 | 同栏 `chatgpt/` 或明确共享的 `platform/chatgpt/` |
| 领域规则 / 事务 | 同栏 `model/storage/background`，复用平台身份与数据库 |
| 运输、消息分派、浏览器生命周期 | `app/sidepanel`、`app/background`、`app/page` 的对应窄模块 |
| 词句 | `messages/catalogs/*.json` |
| 提示时序 | 所属业务 owner + `messages/notice-lifecycle.js`，同步登记和回归 |
| 诊断 | `messages/diagnostics.js` 本地观测；`platform/diagnostics/` 会话传输/存储 |

`panel.js`、`service-worker.js`、`main-world.js` 是组合根，不应再次积累请求策略或可写共享大对象。feature 不反向导入 app，不直接操作别栏 DOM。每个状态只有一个可写 owner，呈现只接只读投影；注释说明责任和可调参数。

逐文件看 [FILE_GUIDE](FILE_GUIDE.md)，七栏合同看 [FEATURE_CONTRACTS](FEATURE_CONTRACTS.md)。不保留旧路径 re-export、别名或兼容壳。路径变化同时更新 manifest、HTML、CSS import、Worker、资源 URL、来源校验、测试夹具、构建器和打包白名单，不只改 JS import。

## 文案和提示修改

唯一手写源是 `src/messages/catalogs/`：公共与七栏词库，含四种语言、网页按钮、主题名和语言自称。

1. **改词：** 保留稳定键与 `{count}`、`{title}` 等参数含义，检查所有语言；不要改生成运行时。
2. **加提示：** 同时明确类型、owner、已知原因、用户下一步、替换/清除条件，并登记 `notice-registry.js`、补相应状态回归。
3. **改时序：** 只对 transient 使用 TTL；未知写入/阻塞状态不允许借通用超时消失。变更切栏/取消规则必须验证迟到回包、旧计时器、语言重绘及 owner 变化。
4. **不再显示：** 修改状态/调用规则后核对所有入口；不能只删中文或把词句改空。
5. **保护基线：** 既有文案/行为基线不整体重录。明确批准的变动按键记录前后与理由，保留旧断言及新增失败→通过证据。

模板结构仍归视图，文案生成器同步壳与时间/设置模板的初始文字；它们不是第二份手写词库。`src/_locales/` 只管浏览器扩展名称/简介。

### 文案键、提示位置与退役不是同一个数量

整理中提到的 **603** 是退役审计前的全部 UI 文案键，包含按钮、标签、选项、空状态和提示，不是 603 条错误。**21** 是按展示位置/控制器登记的提示 surface，不是句数；同一 surface 可在不同状态使用多条文字，同一键也可能被多个位置引用。

当前保留 **596 个 active 文案键**，另有 **7 个已审计退役键**。`src/messages/retired-keys.json` 只保存退役身份、原 catalog、理由、替代键和原四语哈希，不是第二份词库，也不参与运行时显示或提供兼容别名。没有等价替代时保持空替代列表，不为补齐映射恢复旧提示。

原 `BEHAVIOR_BASELINE.json` 的 **2268 条翻译哈希保持不变**；这次仅从运行 catalog 移除获准的 7 键 × 4 语言，即 28 条旧翻译入口。构建/测试以退役清单核对这些精确缺失，其余旧文案及新增文案审批仍按原约束检查。不能据静态扫描“没有引用”就直接删除动态键，也不能通过重录基线掩盖缺译。


## 生成顺序

```text
build-messages → build-message-index → build-main-world
文案运行时       提示索引/源码指纹      MAIN 注入 bundle
```

统一运行 `npm run build`。专项入口：

```sh
npm run build:messages
npm run build:message-index
npm run check:messages
npm run check:architecture

node tools/build-message-index.cjs --check
node tools/build-main-world.cjs --check
```

- `--check` 只比较、不写入；过期时改源后重新生成。
- `i18n.js`、`page-runtime.js`、`build-info.js`、MAIN bundle 和提示索引均不手改。
- 业务文件变化也改变源码指纹/索引行号，即使没改文字仍须重新生成。
- 图标执行 `npm run build:icons`；参数与源稿见 `src/assets/icons/README.md`。
- `npm run verify` 验证生成物、架构、第三方材料及 Node 回归，不等于真实浏览器验收。
- `npm run setup:hooks` 只配置当前 Git 仓库提交检查，不改全局配置。

## 从一句提示追到证据

在 [MESSAGE_INDEX](MESSAGE_INDEX.md) 搜屏幕文字：

```text
实际文字 → 稳定键 / catalog → 引用和动态映射
                              → 表面 owner / 触发 / 下一步 / 消失条件
                              → 当次 show/clear / 原因码 / 关联号 / 构建指纹
```

一个消息键可能有多个原因。静态引用说明可能路径，不是当次分支；动态键无字面引用也不能直接删除。只报告真正留存的类型化原因；`OBSERVATION_ONLY_UNSPECIFIED` 表示观察到提示但没有足够原因，不是确定根因。

### 用户取证入口

设置页底部常驻**排查日志**，上方设置/资料备份单独滚动，细分隔线区分辅助排查与日常工具。**复制日志**主动读取当前会话记录并写入剪贴板；**清空日志**经内联二次确认后清空已保存记录，取消不执行清空。连接停止或需要刷新时，日志仍只在设置内，不搬到公共连接区，也不自动打开设置；其余六栏、偏好与备份继续保持原业务门禁。初始不显示“尚未读取”，换语言/重绘不触发读取；成功反馈 3 秒后消失，失败分别提示重试，已知日志不完整时仍如实说明，不把失败当成功。

诊断不包含聊天正文、标题、搜索词、账号标识、任意 URL、Bearer/令牌或异常原文，不主动联网。可保存的只有词库键/表面/源码常量、时间、构建指纹、生成关联号，以及通过白名单的原因和阶段字段。复制的是观测报告，不是聊天导出，也不是完整错误堆栈。

### 开发者接口：区分两层

在**该侧栏页面 DevTools**：

```js
// 跨侧栏/网页、由 Worker 验证并写入 storage.session 的已保存记录。
await globalThis.TidyDiagnosticsClient.read()
await globalThis.TidyDiagnosticsClient.exportText()
// 返回 { eventCount, text, incomplete }，text 是适合复制的 JSON 报告。
await globalThis.TidyDiagnosticsClient.clear()

// 当前文档的本地观测缓冲；不是上面的全局会话记录。
globalThis.ChatGPTTidyDiagnostics.snapshot()
globalThis.ChatGPTTidyDiagnostics.exportText()
```

网页本地观测需要选择**本扩展的 content-script / isolated world**，不是默认 MAIN 控制台。网页客户端只允许上送，跨上下文读取/清空限侧栏来源；MAIN 不安装诊断 client。

| 层 | 容量 / 生命周期 | 限制 |
| --- | --- | --- |
| 本地 observer | 当前文档内存最近 256 条 | 关闭/重载文档丢失；仅用于本地观察与受限上送 |
| Worker session collector | 最近最多 512 条、总量上限 256 KiB | `chrome.storage.session`，浏览器会话结束清空；扩展重载/更新不承诺保留 |
| 客户端队列 | 最多 64 条等待 + 16 条在途 | 无轮询/失败自动重试；失败/溢出计数随报告公开 |
| Worker 写入队列 | 最多 32 项操作（含在途）、128 条等待事件 | 超限明确拒绝，不自动重试；不影响业务请求 |

Worker 是 session 记录的唯一串行写入者，核验真实 sender 和构建白名单；不复制账号/正文数据，也不走业务重试。清空提升 generation，旧队列不得把已清记录写回。容量淘汰不是 UI 清除，不能伪造 clear 事件。已成功写入的记录可跨侧栏关闭与 Worker 休眠保留；尚在本地/在途的记录可能丢失，不承诺完整历史。复制报告含当前读取客户端计数，以及当前 Worker 实例的存储/队列拒绝计数；后者随 Worker 重启归零。它们不能当作所有文档的完整失败统计；没有已知缺失也不保证其他文档没有尚未发送的事件。

诊断失败不应影响业务显示/写入/下载；反过来，清空诊断也不清除用户资料、不隐藏真实提示、不解除未知写入锁、不修复或重发任务。会话存储边界见 [STORAGE](STORAGE.md)。

排查应区分：代码允许的路径、当次记录证实的分支、未记录或尚未实测的部分。不要用静态扫描和猜测填补现场缺口。

## 浏览器与真实账号验收

```sh
npm run verify:release
npm run verify:columns
```

在本机可用 Chrome/Edge 的独立测试配置中运行合成回归；也可传浏览器可执行文件参数。缺浏览器、子进程失败或结构化回执不匹配都必须失败，日志在 `.tmp/`。长运行前后核对源码指纹，避免混合不同修订的证据。

`npm run verify:columns` 使用正式工具 `tools/check-seven-columns-browser.cjs` 和 `tests/browser/diagnostics-smoke-fragment.js` 覆盖七栏、四语言及交互/诊断场景；不加载旧 `.tmp/` 验证脚本。它仍是隔离合成检查，不证明真实账号全部无 bug；结果与未测项以当次回执为准。

页面会话专项：

```sh
node tools/check-page-session-browser.cjs <browser-executable>
```

合成夹具不连接真实 ChatGPT 账号。实际发布前另查七栏、四语言、键盘焦点与主题，以及：
- 切栏/账号/会话、隐藏、连续点击、迟到回执、错误目标和明确取消。
- 连接尝试耗尽后的停止/重新连接，永久旧页才要求刷新。
- 标题和备份结果未知，切出再回和核对再失败仍保留恢复语义。
- 搜索部分失败、短提示到期、新查询替换旧请求。
- 导出选择、图片/附件、部分失败、后台任务取消及浏览器保存完成。
- 复制诊断无内容/凭据，跨文档、清空竞态和 session 生命周期。

原已知缺陷不是本轮可接受豁免；保留原断言并补修复回归，不能删测试或弱化条件换取通过。真实标题写入只用用户允许修改的测试会话。测试与未测项均写入本次验证记录。

## 打包与独立复现

```sh
npm run package:extension
npm run package:source
```

`dist/` 的安装包仅运行文件/许可，源码包附当前文档、测试与工具，不含依赖目录、Git 历史、个人草稿与临时证据。包名取产品版本。

检查文件清单、哈希及路径，再到独立解压目录执行 `npm ci`、`npm run verify`。公开源码不依赖旧本机路径；ZIP 生成不等于上传、安装或真实账号验收。发布前按 [RELEASE_CHECKLIST](RELEASE_CHECKLIST.md) 检查，以本次实际源码和产物记录为准。

## 验证产物归档与显式清理

测试可继续生成 `.tmp/`、`tmp/` 输出；不要在验证尚在运行时清理。保留有用报告/日志至本地 `.artifacts/verification/<run>/`，本次收尾使用 `.artifacts/verification/0.5.0-closeout/`。这些是本机证据，不进入扩展安装包或公开源码包。历史日志中的旧临时路径只表示当时执行位置，查证时按归档映射取副本，不需要重新创建旧目录。

`tools/clean-verification.cjs` 不由测试自动调用。默认 dry-run 只列出已识别验证产物、候选删除计划和保留项；不改正常本地开发权限，不启动/关闭浏览器进程，也不清理真实浏览器资料：

```sh
npm run clean:verification
```

先完成源码和文档修改，再复制选定重要证据。工具导出的 `createArchiveManifest(root, archivedFiles)` 验证副本并返回清单数据；它本身不复制证据，也不写 manifest。归档条目中的 `originalPath` / `archivedPath` 使用仓库相对正斜线路径；将返回数据保存为归档目录内的 `manifest.json`，确认 dry-run 后才显式执行：

```sh
npm run clean:verification -- --apply --archive-manifest .artifacts/verification/<run>/manifest.json
```

应用前验证仓库归属、当前源码指纹、完整候选计划、归档副本字节数与 SHA-256；每项删除前再核对目标树快照。源码、归档或目标发生变化必须重新核对，不能用强制跳过。未知/无法确认归属的项目保留，未知目录不递归探索；该工具不是通用目录清空命令。

清单要求有已复制证据，但不自动保证每个删除目标都完整归档，保留哪些原始材料仍需人工确认。失败检查的临时输出也可能属于候选，并非“只删通过结果”。删除不是事务，逐项删除期间失败可能留下部分已删、部分未删；检查实际回执，不宣称全有或全无。不要同时传 `--dry-run` 和 `--apply`，前者不会抵消后者。

清理范围、实际删除结果、归档完整性以该次清单和回执为准；这里不提前声明最终测试通过或已释放多少空间。原基线证据映射见 [BASELINE_VALIDATION](BASELINE_VALIDATION.md)。
