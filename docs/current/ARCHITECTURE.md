# 架构与运行边界

## 当前范围

ChatGPT Tidy 是面向 `chatgpt.com` 的 Chromium Manifest V3 扩展，使用原生 JavaScript、HTML、CSS，没有自建业务服务器。产品版本为 **0.5.0**；当前候选尚不等于已发布。

本轮在第一阶段目录归位基础上拆分运行时职责，并修复有回归证据的提示/导航缺陷。不是功能重写，也不承诺消灭未知问题。来源、方案与实际验收分别见 [BASELINE_VALIDATION](BASELINE_VALIDATION.md)、[REFACTOR_PLAN](REFACTOR_PLAN.md)、[VALIDATION](VALIDATION.md)。

## 三层和独立文案入口

```text
app/       组合根与应用协调：注册、装配、消息入口、跨栏工作流
features/  时间、标题、收藏、书签、搜索、导出、设置各自业务
platform/  身份、连接、导航、资料、目录、偏好、数据库、主题、公共控件
messages/  唯一词库、提示生命周期、登记、生成索引及有界诊断
```

- `app` 可以装配 feature 和 platform；feature 不反向导入 app，不通过另一个 feature 的 DOM 改状态。
- 多栏能力在 platform，共用不表示任意模块可写共享状态。每个可变状态由一个明确控制器拥有，其他模块通过意图、窄接口或只读快照协作。
- `ui` 不自动等于“只有 DOM”：控制器与呈现放在对应 feature 的 UI 目录，但文件职责分开。纯呈现不得请求、变更选择、启动定时器或把渲染当作提交。
- `background`、`chatgpt`、`storage`、`model` 按需存在；导出另有 `engine`。不为空目录凑结构，也不保留旧路径转发。
- 每个业务文件见 [FILE_GUIDE](FILE_GUIDE.md)，七栏公开能力见 [FEATURE_CONTRACTS](FEATURE_CONTRACTS.md)。

## 运行环境和消息方向

```text
侧栏 DOM 意图
  → 栏目控制器 / 跨栏工作流
  → 侧栏 request-client
  → Worker request-router（先准入，后分派）
      ├→ 领域服务 → 账号事务 / 浏览器能力
      └→ 页面网关 → ISOLATED 桥 → MAIN 分派 → ChatGPT 适配器
                   ← 对应请求回包 / 独立事件 ←

导出任务：Worker → offscreen 宿主 → 独立计算线程
保存回执：浏览器 downloads → Worker → 侧栏只读任务投影
```

对应运行环境的标准方向为：**Side Panel → Service Worker → Content(ISOLATED) → MAIN**。

`src/platform/protocol.js` 定义消息信封与错误码。调用方向不意味着调用方拥有下游状态；回包也不证明动作完成。身份、准入、导航、写入和下载分别有自己的判定。

### 侧栏：组合根不冒充所有者

`app/sidepanel/panel.js` 装配七栏、依赖、固定绑定标签、路由和页面连接转换。请求运输、快照代际、资料动作、导航回执、短提示、跨栏导出选择、视图投影与文档生命周期各由专门模块负责。

| 状态 / 行为 | 所有者 | 其他模块如何使用 |
| --- | --- | --- |
| 页面文档是否可操作 | `platform/session/ui/page-session-controller.js` | 壳处理准入转换；栏目停止旧读取，不通过隐藏 DOM 代替撤销 |
| 当前标签快照与读取代际 | `app/sidepanel/context-controller.js` | 栏目接收当前上下文，旧回包不能覆盖新页面 |
| 账号资料、修订与操作 lease | `platform/library/ui/library-controller.js` 与后台 identity | 壳的资料控制器协调动作和投影，视图不能签发身份 |
| 每标签当前导航意图 | `navigation-owner.js` / 后台 `worker-navigation.js` | 侧栏 coordinator 分派精确回执；栏目确认目标后才消费 |
| 搜索条件、分页、读取 | `search-query-controller.js` | view 分派输入；view-model 和 presentation 只读 |
| 导出篮、来源草稿 | `export-selection.js` | 来源栏只读选择状态并发送意图，渲染不修改选择 |
| 导出读取、预览、后台任务展示 | 各自 export 控制器 | UI 组合根组装投影，不把离开栏目当作后台任务取消 |
| 短提示的当前实例与时序 | notice controller + 公共 lifecycle | 业务保留原因和恢复状态；译文/重绘不重新授权旧动作 |

### 后台和网页：有序准入，专用执行

Worker 的组合根负责能力装配、浏览器事件注册和唤醒；router 先验证来源与参数，再按消息处理器调用窄网关和领域服务。页面组合根负责装配观察、桥接与命令处理，快照观察和业务命令不混成一个状态机。

后台以浏览器提供的 sender 核对真实标签、documentId、账号/工作区及 epoch；payload 不能覆盖真实来源。侧栏固定使用其 `expectedTabId`，不能用活动/聚焦标签猜目标。`platform/library/background/library-identity.js` 独占身份与进程内 lease，外部 DTO 只作比对。

API 令牌只留在页面适配器内存，不进入侧栏、资料库或诊断。MAIN 与宿主页同源，不被视为对页面保密的区域。`manifest.json` 声明真实入口；MAIN bundle 是生成物。

## 生命周期与取消

- 页面首次安装前已打开、或扩展重载遗留的旧文档，刷新前不开放业务；不补注入、不自动刷新、不重放修改操作。
- Worker 休眠、暂时连接错误、账号变化与永久失效不同。连接尝试停止时进入可恢复终态，不继续展示“正在连接”。
- 取消读取或替换查询只撤销该代际的结果提交权；不把正常取消显示为新操作失败。
- 账号/文档变化使旧资料 lease 与读取提交权失效；导航按自身契约处理身份等待和已授权的精确目标文档交接，真实身份撤销或非预期换页才取消对应意图。显示域退出可以暂停观察与清除短反馈，但不能抹掉仍需核对的写入结果。
- 标题批次隐藏后不自动续写；导出后台任务则可跨侧栏关闭继续。两种任务的取消语义不能混用。
- 导航完成须通过标签、当前意图和实际目标校验后才标记消费；错误目标的同编号回执不能提前堵住正确回执。

## 提示：文字、业务状态、显示实例、诊断分离

```text
catalogs/*.json → build-messages → i18n.js / page-runtime.js / 模板初始文字
业务状态 + notice-lifecycle → 展示 / 替换 / 清除
notice-registry + 源码 → build-message-index → MESSAGE_INDEX + build-info
已接入 show/clear → 受限诊断 → 会话收集器 → 用户主动复制
```

1. **文字**只在 catalog 手改；消息键不是错误码。
2. **业务状态**解释为什么出现、能做什么、何时算解决；控制器拥有它。
3. **显示实例**管理持续时长、暂停和旧实例清除。短反馈可超时；阻塞恢复、未知写入、进行中任务不因换栏或通用 timeout 被当作成功。
4. **登记/索引**解释表面、owner、触发、下一步和消失条件，不反向控制业务。
5. **诊断**只保存实际观测的允许常量与关联号，不补猜历史原因。未保留类型化原因时明确标记观察级原因。

诊断通过 Worker 汇集于 `chrome.storage.session`，跨侧栏/网页保留最近最多 512 条、总量不超过 256 KiB 的事件；不写 IndexedDB、local 或 sync，不联网。只保留允许的代码常量、构建信息和生成关联号，不含聊天正文、标题、搜索词、账号、URL、认证信息或任意异常原文。浏览器会话结束即清空；读取/复制/清空诊断不重发业务、不修复任务。入口固定为设置页底部的“排查日志”，与上方设置及备份表单用留白和分隔线区分，不随连接状态或栏目切换移动。设置壳保持可路由；断连只放行表单外的日志操作，其余六栏及设置业务表单继续执行原准入限制。精确容量、入口及不可恢复范围见 [DEVELOPMENT](DEVELOPMENT.md) 与 [STORAGE](STORAGE.md)。

## 保持的业务边界

### 标题

首次预览读取元数据，规则变更本地重算并登记不可变计划。确认后持久化操作和派发许可：`prepared` 尚未派发，`dispatched` 可能派发；HTTP accepted 不等于读回 verified。结果未知时只读核对，不自动重发旧确认、恢复批次或凭超时解锁。离开再返回不能丢失未确认结果。

官方手动改名只更新已有目录行，不制造新目录记录；旧预览必须重新确认。

### 资料、搜索、导航

收藏/书签/备份共用账号事务和修订；隐藏或首次加载期间的变更提示保留，返回补读，旧结果不能覆盖新修订。关键词读取远端结果；日期与批量标题复用目录，不把目录当完整正文库，也不把错误当空结果。

关键词卡片交给官方 `history_search` 路由；交接只证明路由接受，不证明定位/高亮。日期与收藏使用 latest 执行器，书签使用精确消息执行器；发出滚动不等于落稳。搜索不以整页导航兜底，不伪造原生左栏选中态。

### 导出与保存

读取精确会话当前活动分支，统一 DTO 校验、归一化、投影和生成；预览不是另一份正文实现。格式、图片、附件、部分失败均保留。后台一次一个任务，不自动排队；启动冻结正文和选项，明确取消终止线程，关闭侧栏不终止任务。

ChatGPT 私有引用只在 native-message-references 解码，正文变为普通 Markdown 链接，图片成为结构化媒体块；engine 不再重复解析私有标记。来源标题与 URL 原子配对，不依靠位置、标题相似度猜对应关系；缺失或冲突的关联不伪造链接。代码中的字面量不按运行标记清除。TXT/PDF/图文预览共用 inline-content 链接呈现，PDF 表格和正文使用同一规则。

用户取消生成先持久化 cancelling，撤销迟到结果的下载准入；宿主停止暂时失败仍保持活动锁，不虚报已取消。重启或重试继续清理同一任务，不重放生成；已交浏览器的保存仍依据真实回执。

offscreen 按需创建，结束释放正文、线程和 Blob；可复用空宿主。session 只存最小回执，不存正文/凭据/签名资源地址。Worker 重启只核对宿主和浏览器回执，不重放下载。保存以浏览器 downloads 完成回执为准，生成 Blob 或打开另存为不等于落盘。

## 共享底座和品牌

`platform/library` 统一资料，`catalog` 统一目录，`session` 统一准入，`navigation` 统一意图，`preferences` 统一偏好，`ui/theme` 提供公共呈现而非业务状态。这些都不是某一栏的私有副本。

名称为 **ChatGPT Tidy**。工具栏图标来自真实窗口的原生明暗偏好，经后台验证标签归属；不读取 ChatGPT class 或 Tidy 配色，不依赖 offscreen 推断窗口外观。无可信报告使用双向可见描边默认图标。图标由 `tools/build-icons.cjs` 生成。

不能从目录整洁、行数下降或合成测试推定真实账号全部通过；以 [VALIDATION](VALIDATION.md) 的分层证据为准。
