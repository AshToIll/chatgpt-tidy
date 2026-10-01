# 文件职责树：从产品功能找到代码

本页对应 `chatgpt-tidy-0.5.0` 架构候选目录。产品版本已与 `src/manifest.json` 同步为 0.5.0；尚未对外发布。

## 先看这个导航

| 想修改/检查什么 | 先去哪里 |
| --- | --- |
| 某栏界面、交互、专属样式 | `src/features/<栏目>/ui/` |
| 某栏在 ChatGPT 原网页上的星标、书签、时间等 | 对应 `features/<栏目>/chatgpt/` |
| 某栏如何真正修改标题、保存资料、生成文件 | 同栏的 `background/`、`storage/` 或导出 `engine/` |
| 改一句错误/成功/加载/空状态/按钮文案 | `src/messages/catalogs/`，不去改生成的 i18n.js |
| 查为什么出现这句提示、怎么消失 | [提示索引](MESSAGE_INDEX.md) → 登记的源码调用位置 → 当次诊断 |
| 标签快照与请求代际 | `src/app/sidepanel/context-controller.js` |
| 导航意图、精确回执与撤销 | `src/platform/navigation/` 与 `app/sidepanel/navigation-coordinator.js` |
| 跨栏导出选择与返回 | `src/app/sidepanel/export-workflow.js`，状态归 `features/export/ui/export-selection.js` |
| 复制/清空会话诊断 | `src/features/settings/ui/diagnostics-view.js` 与 `src/platform/diagnostics/` |
| 资料保存在哪里、备份包含什么 | [存储说明](STORAGE.md) |

## 完整业务源码树

这里逐文件说明业务源码；成批字体、图标与第三方库按用途合并。`【生成】` 表示可加载但不手工维护的产物。各栏按需使用子目录，不为了凑齐结构建立空文件夹。

```text
src/
├─ app/  应用外壳与启动装配
│  ├─ background/  扩展后台逻辑
│  │  ├─ adapters/  后台到页面的窄网关：通信及领域响应校验。
│  │  │  ├─ export-gateway.js  页面导出通信及当前分支、精确批量集合和预览响应校验。
│  │  │  ├─ search-gateway.js  固定标签的关键词/目录读取通信与响应校验。
│  │  │  └─ title-gateway.js  标题页面通信及原路由/时区复核；写请求仍需持久化派发许可，不自动重放。
│  │  ├─ handlers/  按用例分派的请求处理器；不另建状态总表。
│  │  │  ├─ bookmarks.js  书签读取/变更、精确导航与打开书签侧栏用例。
│  │  │  ├─ export.js  正文、预览、资源和任务命令；保留成员关系、身份 lease 与下载归属检查。
│  │  │  ├─ favorites.js  收藏读取、增删分组、视图设置与打开会话用例。
│  │  │  ├─ library.js  资料身份/加载和备份命令入口，按需创建备份服务。
│  │  │  ├─ navigation.js  取消导航及打开搜索结果；执行状态留在共享导航 owner。
│  │  │  ├─ preferences.js  偏好读取/更新和绑定标签当前上下文读取，成功后领取待处理侧栏路由。
│  │  │  ├─ search.js  关键词与目录请求参数校验，转交搜索网关。
│  │  │  └─ titles.js  标题规则、单次/批量整理和返回原会话入口，按需创建标题服务。
│  │  ├─ browser-lifecycle.js  处理标签、文档、路由及偏好变化；协调所有者撤销和页面通知，监听注册留在组合根。
│  │  ├─ catalog-selection.js  验证标题批量/日期导出选择的目录成员关系；共用候选归属，不共享写权限。
│  │  ├─ export-jobs.js  按需创建后台导出服务，连接身份复核、宿主回执、下载事件和任务通知。
│  │  ├─ export-selection.js  纯校验批量导出参数、去重、传输上限与日期搜索子集约束。
│  │  ├─ library-workflow.js  共享资料身份 lease 复核、事务、元数据刷新与修订广播，不拥有各栏界面。
│  │  ├─ request-policy.js  显式登记资料读取、导出和写操作所需许可，不按消息名前缀自动授权。
│  │  ├─ request-router.js  依来源、参数、意图、手势、页面、账号顺序准入，再分派到唯一功能处理器。
│  │  ├─ runtime-messages.js  唯一运行时消息入口；区分诊断、主题、导出宿主、页面事件和业务请求，明确响应归属。
│  │  ├─ service-worker.js  后台组合根：装配窄能力并同步注册浏览器监听器；不再集中实现功能请求。
│  │  └─ title-catalog-observer.js  核验官方改名事件并投影已有目录行，不创建计划或刷新整个目录。
│  ├─ page/  网页入口
│  │  ├─ isolated.js  扩展隔离环境与网页 MAIN 的通信桥；校验和转发，不直接提供界面。
│  │  ├─ main-world.bundle.js  【生成】实际注入网页的合成脚本；不能手改或当成第二份源码。
│  │  ├─ main-world.js  MAIN 组合根：装配快照、观察、导航与请求工厂，统一停止触发器和释放资源。
│  │  └─ request-router.js  MAIN bridge 入站准入及功能请求分派：先核验文档/source/origin/channel，再调用注入的专属适配器。
│  └─ sidepanel/  侧栏外壳
│     ├─ context-controller.js  当前网页快照与读取代际唯一 owner，拒绝旧请求覆盖新路由。
│     ├─ export-workflow.js  跨栏导出选择及返回去向，不拥有导出篮、草稿或资料缓存。
│     ├─ feature-clients.js  显式功能动作到协议请求的适配表，附加固定标签归属。
│     ├─ filing-context-client.js  每栏归档 Port、重连与关闭生命周期；目标分组由栏目提供。
│     ├─ index.html  侧栏壳：标题、7 个栏目容器、导航、共享提示容器和加载入口。
│     ├─ library-panel-controller.js  收藏/书签视觉选择、计数及请求打开书签页的目标 gate，不复制资料或签发身份。
│     ├─ navigation-coordinator.js  精确导航回执校验、连接期间暂存、栏目消费及完成/取消协调。
│     ├─ notice-controller.js  公共提示呈现与导航提示授权；计时和旧实例隔离交给公共生命周期。
│     ├─ panel-lifecycle.js  文档交互准入、显示/隐藏和销毁编排，只调用注入能力，不持有业务 state。
│     ├─ panel.css  样式装配入口；按原级联顺序 import，不再书写各栏业务样式。
│     ├─ panel.js  侧栏组合根：装配七栏、固定绑定标签、状态 owner 和跨栏事件，不集中持有所有业务模型。
│     ├─ request-client.js  侧栏唯一 IPC 请求出口与协议校验；准入委托会话控制器，不重放失败命令。
│     ├─ search-actions.js  搜索用例适配：关键词走页面、日期走目录，衔接导航与提示。
│     └─ shell-presentation.js  壳层标题、Dock、主题、公共连接/错误及导出角标呈现，不修改栏目业务状态。
├─ features/  7 栏功能所有权目录，不复制公共底座
│  ├─ time/  时间显示
│  │  ├─ chatgpt/  ChatGPT 页面/API 适配
│  │  │  └─ time-presentation.js  在 ChatGPT 会话列表与消息旁展示时间和消息编号。
│  │  └─ ui/  本栏界面、交互与样式
│  │     ├─ time-template.js  时间栏静态结构：日期格式、时间位置/精度、编号和预览。
│  │     ├─ time-view.js  时间栏控件交互、折叠状态、日期示例和实时预览；注入保存能力。
│  │     └─ time.css  时间栏选项、折叠区域、摘要和预览的样式。
│  ├─ titles/  标题整理
│  │  ├─ background/  扩展后台逻辑
│  │  │  ├─ title-batch-service.js  批量标题任务、执行顺序、暂停与回执核对。
│  │  │  └─ title-service.js  单个标题操作的预览计划、确认、持久化与结果核对。
│  │  ├─ chatgpt/  ChatGPT 页面/API 适配
│  │  │  ├─ title-sync.js  标题变化同步到原生会话列表和当前页面。
│  │  │  └─ titles.js  真正读取/修改 ChatGPT 标题；核对账号、会话和服务端结果。
│  │  ├─ model/  数据格式与纯规则
│  │  │  ├─ title-context.js  标题操作对应的页面/会话上下文约束。
│  │  │  ├─ title-dates.js  标题日期前缀、日期计算及本地预览，不发网络请求。
│  │  │  └─ title-rules.js  标题整理规则的合法值和格式化契约。
│  │  ├─ storage/  本栏资料保存与领域规则
│  │  │  ├─ title-operations.js  保存标题计划、单次操作和批量任务记录。
│  │  │  └─ title-rules.js  独立保存标题整理规则，不混入全局显示偏好。
│  │  └─ ui/  本栏界面、交互与样式
│  │     ├─ title-batch-view.js  批量选择、预览、确认、执行进度与回执。
│  │     ├─ title-batch.css  标题批量视图样式。
│  │     ├─ title-catalog.js  标题批量选择所用的目录读取和刷新协调。
│  │     ├─ title-organization-view.js  标题栏目总视图；协调当前会话与批量两个子页面。
│  │     ├─ title-rules.js  界面侧标题规则加载、保存、订阅和暂停/恢复。
│  │     ├─ title-view.js  当前会话标题的规则、预览、确认与操作结果。
│  │     └─ title.css  标题栏目与当前会话视图样式。
│  ├─ favorites/  收藏
│  │  ├─ background/  扩展后台逻辑
│  │  │  └─ favorites-filing-context.js  关联侧栏收藏当前分组与网页一键收藏目的地。
│  │  ├─ chatgpt/  ChatGPT 页面/API 适配
│  │  │  └─ favorites-presentation.js  ChatGPT 原生会话列表中的收藏星标及按钮反馈。
│  │  ├─ storage/  本栏资料保存与领域规则
│  │  │  ├─ favorites-domain.js  收藏增删、分组、移动、排序与数据清洗规则。
│  │  │  └─ favorites.js  账号隔离的收藏资料读写入口。
│  │  └─ ui/  本栏界面、交互与样式
│  │     ├─ favorites-actions.js  收藏动作到请求及资料归属复核，不拥有资料缓存或导航任务。
│  │     ├─ favorites-layout.css  收藏卡片/操作区等前置布局；位置由 CSS 级联顺序决定。
│  │     ├─ favorites-view.js  收藏列表、分组、排序、分页与选入导出的交互。
│  │     └─ favorites.css  收藏栏目主体与列表样式。
│  ├─ bookmarks/  书签
│  │  ├─ background/  扩展后台逻辑
│  │  │  └─ bookmarks-filing-context.js  关联书签当前分组与网页一键书签目的地。
│  │  ├─ chatgpt/  ChatGPT 页面/API 适配
│  │  │  └─ bookmarks-presentation.js  消息书签按钮、会话书签数量与网页侧操作反馈。
│  │  ├─ storage/  本栏资料保存与领域规则
│  │  │  ├─ bookmarks-domain.js  书签增删、分组、摘要、排序和定位资料规则。
│  │  │  └─ bookmarks.js  账号隔离的书签资料读写入口。
│  │  └─ ui/  本栏界面、交互与样式
│  │     ├─ bookmark-navigation.js  书签跳转的开始、撤销、精确目标与结果状态。
│  │     ├─ bookmarks-actions.js  书签动作到请求及资料归属复核；打开流程委托书签导航 owner。
│  │     ├─ bookmarks-dark.css  书签专属深色样式覆盖；保留原级联位置。
│  │     ├─ bookmarks-view.js  消息书签列表、分组、查询、定位及选入导出。
│  │     └─ bookmarks.css  书签栏目主体与列表样式。
│  ├─ search/  搜索
│  │  ├─ chatgpt/  ChatGPT 页面/API 适配
│  │  │  └─ search.js  调用 ChatGPT 搜索并转换为扩展的结果模型。
│  │  ├─ model/  数据格式与纯规则
│  │  │  └─ search.js  关键词搜索请求、分页结果与目标的数据契约。
│  │  └─ ui/  本栏界面、交互与样式
│  │     ├─ conversation-date-search.js  读取共享目录后按日期条件筛选、排序和分页。
│  │     ├─ keyword-excerpt.js  生成搜索结果中的命中摘要与高亮片段。
│  │     ├─ keyword-search.js  关键词查询、分页请求和查询生命周期。
│  │     ├─ search-calendar.js  日期范围选择日历。
│  │     ├─ search-controls.css  搜索输入、模式、日期选择等控制区域样式。
│  │     ├─ search-dark.css  搜索专属深色样式覆盖。
│  │     ├─ search-error-slot.js  当前查询错误的短暂展示权限，计时交给公共生命周期，不删除查询失败事实。
│  │     ├─ search-failure-presentation.js  统一可见错误文案和诊断键映射，保留可重试性，不从原始服务端文本猜原因。
│  │     ├─ search-presentation.js  搜索控件、结果、分页、选择和状态 DOM 的纯呈现，不拥有查询或导航状态。
│  │     ├─ search-query-controller.js  搜索条件、读取代际、异步结果、分页与恢复状态的唯一写入 owner。
│  │     ├─ search-result-navigation.js  搜索点击目标、取消句柄与精确回执归属，不与查询页状态混存。
│  │     ├─ search-results-toolbar.css  结果数量、筛选摘要与工具区样式。
│  │     ├─ search-results.css  搜索结果卡片、摘要、加载/空状态等样式。
│  │     ├─ search-view-model.js  将查询和导出选择状态投影为只读搜索阶段及呈现模型。
│  │     └─ search-view.js  搜索组合根与 DOM 事件、焦点、布局协调；查询、错误及导航状态由独立 owner 管理。
│  ├─ export/  导出
│  │  ├─ background/  扩展后台逻辑
│  │  │  ├─ export-job-service.js  后台导出任务的启动、取消、状态与浏览器保存回执。
│  │  │  └─ offscreen-host.js  管理隐藏生成宿主的创建、通信和复用。
│  │  ├─ chatgpt/  ChatGPT 页面/API 适配
│  │  │  ├─ export-preview-presentation.js  在 ChatGPT 网页显示导出预览，不生成最终 PDF。
│  │  │  └─ export.js  从 ChatGPT 读取指定会话正文、消息片段与资源。
│  │  ├─ engine/  独立文件生成流水线
│  │  │  ├─ assets.js  统一读取图片和字体字节；仅 ChatGPT 同源资源携带凭据，公开外链匿名读取。
│  │  │  ├─ dependencies.js  按需加载本地 PDF/ZIP 库与字体。
│  │  │  ├─ download.js  执行生成计划、组装文件和 ZIP；不冒充浏览器已保存。
│  │  │  ├─ i18n.js  固定一次导出使用的文案快照；不是第二个翻译字典。
│  │  │  ├─ job-worker.js  独立计算线程入口，避免生成文件卡住侧栏。
│  │  │  ├─ normalize.js  整理正文、来源、图片、附件和待导出片段；统一维护内容开关默认值。
│  │  │  ├─ offscreen.html  隐藏导出宿主页面与依赖装配。
│  │  │  ├─ offscreen.js  管理生成线程、临时正文与 Blob 生命周期。
│  │  │  ├─ pdf.js  PDF 字体、图片、纸张和分页排版。
│  │  │  ├─ plan.js  决定文件数量、文件名与目录结构；Markdown 不附带图片资源目录。
│  │  │  ├─ inline-content.js  标准 Markdown 行内链接的统一可读呈现与安全编码；不解析 ChatGPT 私有标记。
│  │  │  └─ serializers.js  输出 Markdown、TXT、JSON，并给 PDF 预览提供相同内容；文本格式只保留媒体说明与链接，角色默认名属于格式约定。
│  │  ├─ model/  数据格式与纯规则
│  │  │  ├─ export-job.js  导出任务阶段、超时、状态和回执的公共契约。
│  │  │  ├─ export-preview.js  导出预览内容、展示约定与约束。
│  │  │  └─ export.js  导出源文档、消息和多会话集合的统一数据模型。
│  │  └─ ui/  本栏界面、交互与样式
│  │     ├─ export-basket.js  导出篮、勾选草稿的纯转换与去重；不发请求，所有权由 export-selection 管理。
│  │     ├─ export-context-controller.js  当前/批量正文读取、上下文代际与文档缓存；控制合并刷新和传输批次。
│  │     ├─ export-job-controller.js  任务提交、状态、取消及有限轮询；未知结果保留重复下载保护，任务事实与卡片显示分离。
│  │     ├─ export-job.css  导出任务进度、警告和状态卡样式。
│  │     ├─ export-markup.js  从只读呈现模型生成 HTML；不访问控制器、派发请求或修改任务/选择。
│  │     ├─ export-preview-controller.js  全屏预览页面 lease、关闭回执和焦点归还，不读写导出篮。
│  │     ├─ export-resources.js  预览图片等资源请求、复用与失效管理。
│  │     ├─ export-selection.js  导出篮、来源草稿、搜索候选和短暂选择反馈的唯一写入 owner。
│  │     ├─ export-view.js  导出 UI 装配、选项/文件名、折叠/滚动和投影推导；读取、选择、预览、任务各有 owner。
│  │     └─ export.css  导出页主体样式。
│  └─ settings/  设置
│     ├─ background/  扩展后台逻辑
│     │  └─ library-backup-service.js  备份生成、导入预览、确认恢复及有效期核对。
│     ├─ model/  数据格式与纯规则
│     │  └─ library-backup-format.js  备份格式版本、文件体积与资料条数上限。
│     ├─ storage/  本栏资料保存与领域规则
│     │  ├─ library-backup-domain.js  备份校验、生成、合并和冲突规则。
│     │  └─ library-backup.js  一次事务读取/恢复收藏和书签。
│     └─ ui/  本栏界面、交互与样式
│        ├─ diagnostics-view.js  设置底部常驻排查日志；用户点击复制、二次确认清空，默认无状态，成功反馈自动消失。翻译重绘不触发 I/O，不控制业务状态。
│        ├─ diagnostics.css  设置独立滚动区与底部日志分隔线布局，复制/清空、内联确认与短反馈样式。
│        ├─ library-backup-view.js  资料备份、文件选择、导入预览与恢复交互。
│        ├─ library-backup.css  备份/恢复区域、预览和状态样式。
│        ├─ settings-template.js  设置栏静态结构：语言、时区、主题和备份挂载区。
│        ├─ settings-view.js  语言/时区/主题控件；不自行重建或管理备份任务。
│        └─ settings.css  设置表单、下拉与主题色板样式。
├─ platform/  跨栏目、跨执行环境共享底座
│  ├─ catalog/  标题与日期搜索共用目录
│  │  ├─ chatgpt/  ChatGPT 页面/API 适配
│  │  │  └─ date-index.js  分页读取普通、归档、置顶、项目会话目录。
│  │  ├─ storage/  本栏资料保存与领域规则
│  │  │  └─ conversation-catalog.js  保存目录元数据和读取 checkpoint；不保存聊天正文。
│  │  ├─ ui/  本栏界面、交互与样式
│  │  │  └─ conversation-catalog-reader.js  标题与日期搜索共用的目录读取和刷新协调。
│  │  └─ date-search.js  会话目录来源、日期条件和分页数据契约。
│  ├─ chatgpt/  ChatGPT 页面/API 适配
│  │  ├─ active-branch.js  完整追溯活动消息分支并恢复正序，拒绝缺失祖先或循环。
│  │  ├─ api.js  ChatGPT 登录状态和接口公共入口；凭据不外传。
│  │  ├─ binding.js  把 URL、原生页面状态、消息绑定到正确会话。
│  │  ├─ conversation-projection.js  统一分组用户消息、助手正文和过程片段，供页面编号与导出共用逻辑编号。
│  │  ├─ message-dom.js  统一查找 ChatGPT 原生消息 DOM，并管理时间/编号/书签共享行的定位与空行清理。
│  │  ├─ messages.js  提取消息摘要，并提供共用的受认证目录读取能力。
│  │  ├─ native-appearance.js  只读原生明暗与不透明画布颜色，输出来源和可用状态。
│  │  ├─ native-message-references.js  依据明确元数据解析原生引用和图片，原子配对标题与地址；不猜内部编号对应的网站。
│  │  ├─ native-message-content.js  纯解码原生正文为标准内容块和资源记录，媒体进入统一开关；保留代码字面量，不读取页面或网络。
│  │  ├─ native-message-process.js  识别隐藏/最终/推理/搜索/工具消息，整理过程片段及去重来源链接。
│  │  ├─ native-observer.js  管理 DOM、主题、SPA 路由和消息观察及解绑，忽略扩展自己插入的 DOM。
│  │  ├─ native-snapshot-reader.js  读取/核对原生 DOM 与 Fiber 会话、侧栏、消息证据，输出绑定后的日期、摘要和定位字段。
│  │  ├─ page-navigation-runtime.js  装配页面意图、原生路由与定位，核验 worker 凭证，统一发送/撤销导航结果。
│  │  ├─ route.js  识别普通会话、项目会话等页面地址。
│  │  ├─ sidebar-dom.js  主会话链接的统一识别：快照、时间、收藏和书签共用；排除任务辅助入口，保留独立列表副本。
│  │  ├─ sidebar-layout.css  原生左栏的时间、星标、书签数量共用布局。
│  │  ├─ snapshot-metadata.js  当前会话可选元数据补读、有界缓存和请求作用域，不缓存正文或无限重试。
│  │  ├─ snapshot-projection.js  合成路由、原生绑定、可选元数据和标题投影，输出统一快照及标题窄快照。
│  │  └─ snapshot-publisher.js  快照指纹去重、有界事件合并、有界绑定重试和事件发布，不自行读取原生证据。
│  ├─ diagnostics/  独立、有界的跨上下文会话诊断，不保存用户内容或业务授权。
│  │  ├─ client.js  本地观测的受限队列、批次上送与只读/清空 API；无轮询或失败自动重试，公开丢弃计数。
│  │  ├─ runtime.js  在侧栏和 ISOLATED 中一次装配诊断 client/sink，不在 MAIN 安装。
│  │  ├─ session-store.js  storage.session 诊断唯一串行写入者，维护 generation、游标、去重和有界记录。
│  │  ├─ wire.js  独立诊断消息、白名单投影、格式及体积上限，不复用业务准入。
│  │  └─ worker-service.js  唯一 worker listener 的诊断分支；验证发送者和结构，连接会话存储。
│  ├─ library/  收藏/书签/备份共用资料机制
│  │  ├─ background/  扩展后台逻辑
│  │  │  ├─ filing-context.js  收藏/书签共用的当前保存分组上下文机制。
│  │  │  └─ library-identity.js  账号/工作区身份与操作许可的权威持有者。
│  │  ├─ content/  网页隔离环境入口
│  │  │  └─ library-client.js  网页星标与书签按钮共用的资料读取/更新客户端。
│  │  ├─ storage/  本栏资料保存与领域规则
│  │  │  └─ account-library.js  收藏与书签共用的账号隔离事务和读改写。
│  │  ├─ ui/  本栏界面、交互与样式
│  │  │  └─ library-controller.js  侧栏共享资料加载、刷新、账号切换和过期结果拦截。
│  │  └─ library-hydration.js  共享资料首次加载、变更重读、错误呈现与局部诊断。
│  ├─ navigation/  统一导航和精确消息定位
│  │  ├─ background/  扩展后台逻辑
│  │  │  ├─ panel-host.js  Side Panel 配置、待领取路由与归档 Port 生命周期，保留原始点击手势打开入口。
│  │  │  └─ worker-navigation.js  每个标签唯一的跳转调度与撤销所有者。
│  │  ├─ chatgpt/  ChatGPT 页面/API 适配
│  │  │  ├─ library-navigation.js  通过 ChatGPT 原生路由打开会话或搜索结果。
│  │  │  ├─ message-location.js  消息滚动、定位、高亮、有界等待与位置落稳检查。
│  │  │  ├─ message-navigation.js  精确消息导航的网页入口。
│  │  │  ├─ navigation-intent.js  网页侧拒绝已经过期或被替换的跳转命令。
│  │  │  └─ virtual-message-target.js  解析虚拟列表中尚未完整挂载的原生消息目标。
│  │  ├─ storage/  本栏资料保存与领域规则
│  │  │  └─ navigation-epoch.js  持久化导航递增版本，避免后台重启混淆新旧操作。
│  │  ├─ ui/  本栏界面、交互与样式
│  │  │  └─ navigation-owner.js  侧栏跨栏目跳转的当前意图、取消与离开管理。
│  │  ├─ conversation-route.js  统一解析普通/项目会话 URL，复用快照路由语法。
│  │  ├─ navigation-identity.js  导航对应的账号、页面身份变化判断。
│  │  └─ panel-owner.js  侧栏归属哪个具体浏览器标签页的编码与校验。
│  ├─ preferences/  全局偏好
│  │  ├─ preference-controller.js  偏好加载/保存状态、订阅、暂停和恢复。
│  │  └─ preferences.js  全局显示偏好的默认值、合法值与保存入口。
│  ├─ session/  网页连接有效期与业务准入
│  │  ├─ background/  扩展后台逻辑
│  │  │  ├─ page-events.js  核验页面快照/预览关闭事件并转发，复用 identity 文档缓存，不新增账号探测。
│  │  │  ├─ page-gateway.js  后台到指定文档的传输、快照/定位响应校验及广播边界。
│  │  │  ├─ page-session.js  后台核验网页桥与当前文档的有效性。
│  │  │  └─ request-binding.js  请求绑定明确标签、面板及资料归属，组合既有 identity 凭证，不猜活动标签。
│  │  ├─ chatgpt/  ChatGPT 页面/API 适配
│  │  │  └─ page-session.js  MAIN 脚本与隔离桥的有效期同步。
│  │  ├─ content/  网页隔离环境入口
│  │  │  └─ page-session.js  启动 ISOLATED 网页会话生命周期。
│  │  ├─ shared/  跨环境公共机制
│  │  │  └─ page-session.js  网页文档生命周期的公共机制和失效约定。
│  │  └─ ui/  本栏界面、交互与样式
│  │     ├─ page-refresh-notice.js  统一连接/刷新提示及各栏目可操作性。
│  │     └─ page-session-controller.js  侧栏业务准入、页面握手、刷新恢复状态。
│  ├─ storage/  本栏资料保存与领域规则
│  │  ├─ database.js  创建/打开 IndexedDB 表结构及校验账号标识。
│  │  └─ schema.js  定义数据在哪种浏览器存储中以及使用什么键。
│  ├─ theme/  共用主题与工具栏明暗适配
│  │  ├─ background/  扩展后台逻辑
│  │  │  └─ toolbar-theme.js  核验主题上报并更新浏览器工具栏图标。
│  │  ├─ content/  网页隔离环境入口
│  │  │  └─ toolbar-theme.js  网页隔离环境的主题上报入口。
│  │  ├─ shared/  跨环境公共机制
│  │  │  └─ toolbar-theme.js  读取并上报浏览器原生明暗偏好。
│  │  ├─ ui/  本栏界面、交互与样式
│  │  │  └─ toolbar-theme.js  真实侧栏的主题上报入口。
│  │  └─ theme.js  共用主题颜色和明暗语义参数。
│  ├─ ui/  本栏界面、交互与样式
│  │  ├─ context-state.js  当前会话/路由与请求代际，避免旧响应覆盖新页面。
│  │  ├─ current-context-card.css  当前会话卡片公共样式。
│  │  ├─ current-context-card.js  收藏、书签共用的当前会话卡片。
│  │  ├─ dark-mode-overrides.css  跨栏公共深色覆盖，保持原声明顺序。
│  │  ├─ dock-navigation.css  7 栏导航按钮、选中态与导出角标布局。
│  │  ├─ dom-ownership.js  标记扩展插入的 DOM，区分原生网页节点。
│  │  ├─ html.js  文本与属性转义，防止普通文本被当成 HTML。
│  │  ├─ group-name-editor.js  收藏/书签共用名称草稿、就近空名校验与仅分组视口的错误定位；不提交资料。
│  │  ├─ library-entry-menu.js  共用移动分组/移除菜单标记；目标及业务动作留在各栏目。
│  │  ├─ library-interactions.css  共用字段错误、移动菜单与侧栏内确认框的主题化样式。
│  │  ├─ library-overlay-position.js  在资料面板内约束浮层位置和长分组菜单滚动，避免滚动区裁切。
│  │  ├─ library-transient-ui.js  共用菜单外点/Esc/隐藏关闭与失效焦点队列，不拥有业务代际。
│  │  ├─ panel-confirmation.js  侧栏文档内的单一异步确认框；所属栏目取消与回焦，写入归属由调用方复核。
│  │  ├─ library-section-headings.css  收藏/书签资料区域共用的标题样式。
│  │  ├─ loading-flower.css  公共加载动画样式。
│  │  ├─ loading-flower.js  公共加载动画节点。
│  │  ├─ narrow-panel-overrides.css  窄侧栏响应式覆盖，保持原断点。
│  │  ├─ notice-actions.css  刷新、重试等提示操作按钮与尾部覆盖规则。
│  │  ├─ notice-card.css  公共状态/提示卡的外观，不决定显示条件。
│  │  ├─ pagination.js  分页边界计算。
│  │  ├─ result-pagination.css  结果分页的公共样式。
│  │  ├─ sidepanel-foundation.css  侧栏基础变量、尺寸、布局、标题和容器。
│  │  ├─ source-export-entry.css  收藏/书签/搜索等来源页进入导出的公共入口样式。
│  │  ├─ stable-list-dom.js  稳定复用列表节点，减少滚动与交互扰动。
│  │  ├─ toast.css  浮动短提示的外观；持续时间不在 CSS 中决定。
│  │  └─ toggle-control.css  开关控件的公共外观。
│  ├─ context-guard.js  防止切换会话后旧操作错误作用于新会话。
│  ├─ protocol.js  跨进程消息名、请求/事件/响应结构、错误码。
│  ├─ snapshot.js  页面、会话、消息快照结构和校验。
│  └─ time-format.js  公共日期、时间、时区、范围和示例格式化。
├─ messages/  唯一产品文案源、提示登记和诊断
│  ├─ catalogs/  可直接编辑的分栏文案源
│  │  ├─ bookmarks.json  书签栏和网页书签按钮的四语文案。
│  │  ├─ common.json  公共按钮、字段、共享连接状态的四语文案。
│  │  ├─ export.json  导出界面、任务、预览与文件内容的四语文案。
│  │  ├─ favorites.json  收藏栏和网页收藏按钮的四语文案。
│  │  ├─ search.json  搜索、日期日历和搜索状态的四语文案。
│  │  ├─ settings.json  设置、备份、主题名与语言自称的四语文案。
│  │  ├─ time.json  时间栏目和网页时间标签的四语文案。
│  │  └─ titles.json  当前/批量标题功能的四语文案。
│  ├─ build-info.js  【生成】版本、源码指纹与诊断白名单；不手改。
│  ├─ diagnostics.js  已接入提示的本地有界观测与安全原因投影；通过注入 sink 上送 session 收集器，不控制业务。
│  ├─ i18n.js  【生成】侧栏/导出使用的翻译运行时及主题名称；不手改。
│  ├─ notice-lifecycle.js  共享 transient/condition/operation 生命周期、owner token、计时与旧实例隔离；不是重试引擎。
│  ├─ notice-registry.js  集中登记提示位置、负责功能、触发概述、恢复和清除条件。
│  ├─ page-runtime.js  【生成】网页展示器使用的轻量文案映射；不手改。
│  ├─ README.md  文案修改规则：唯一手写源、占位符、生成文件与产品边界。
│  └─ retired-keys.json  已审计退役键的身份、理由、替代键和原四语哈希；非运行词库，不保留旧译文或兼容别名。
├─ assets/  图标源稿/PNG、中文与回退字体、来源记录和字体许可证；不是功能代码。
├─ vendor/  随扩展附带的 PDF、字体、ZIP 等第三方运行库及许可证。
├─ _locales/  zh_CN / zh_TW / en / ja 的扩展名称、简介等浏览器元信息；不是运行提示字典。
├─ manifest.json  扩展启动清单：权限、后台入口、网页注入次序、侧栏地址与版本。
└─ THIRD_PARTY_LICENSES.md  随扩展交付的第三方库和字体许可说明。
```

## 项目外层

```text
项目根目录/
├─ src/                 上面列出的扩展运行文件；浏览器加载此目录
├─ docs/README.md        文档阅读顺序
├─ docs/current/         当前架构、文件树、功能契约、文案索引、开发与存储说明
├─ docs/licenses/        开发依赖许可
├─ tests/*.test.cjs      Node 单元/边界/回归测试，按功能命名
├─ tests/browser/       浏览器合成回归场景，不等于真实账号验收
│  └─ diagnostics-smoke-fragment.js  七栏浏览器检查复用的诊断场景片段，正式测试依赖，不从临时证据目录加载
├─ tests/fixtures/      合成页面与预览样本
├─ tests/helpers/       测试共用装配与宿主替身
├─ tools/               构建、检查、打包和本地预览工具
├─ dist/                生成的安装包、源码包和哈希；不是第二套源码
├─ node_modules/        安装的开发依赖，不手改
├─ .artifacts/verification/  本地精选验证证据与归档清单；不属于运行或公开源码包
├─ .tmp/、tmp/          可再生成的验证输出及本地临时工作；只清理已识别产物，未知项保留
├─ .githooks/           可选择启用的提交检查
├─ .gitignore           不进入版本管理的文件规则
├─ .gitattributes       换行与第三方原文件规则
├─ package.json         版本、依赖与 npm 命令
├─ package-lock.json    开发依赖的确切版本
├─ README.md            用户安装、功能与开发入口
└─ LICENSE              项目许可
```

### 主要工具怎么分

- `build-messages.cjs`：8 份文案源 → 侧栏/网页两份运行时。
- `build-message-index.cjs`：源码与提示登记 → 提示索引、构建指纹和诊断白名单。
- `build-main-world.cjs`：按生产顺序合成 MAIN 注入脚本。
- `build-icons.cjs`：SVG 图标 → 浏览器所需 PNG。
- `verify.cjs`、`verify-release.cjs`：源码/生成物检查与隔离浏览器回归。
- `check-seven-columns-browser.cjs`：正式七栏、四语言及交互/诊断合成检查入口；由 `npm run verify:columns` 调用，不依赖临时脚本。
- `clean-verification.cjs`：停止测试后先预览，再归档小体积报告/截图并显式 apply；验证源码、归档和目标快照，未知项不删除。导航测试每轮写结构化 report.json 供统一清理器识别；可重建的测试扩展副本、缓存和纯合成下载不必长期保存，真实会话/人工 QA 不按缓存处理。
- `check-*-browser.cjs`、`browser-fixture.cjs`：导航、定位、导出、主题、资料生命周期等专项合成验收。
- `check-third-party.cjs`：第三方库、字体、来源及许可证一致性。
- `check-architecture.cjs`：新目录、导入/资源路径和架构边界检查。
- `package-extension.cjs`：运行安装包与公开源码包。
- `*-preview.cjs`：搜索状态、关键词、日期与导出选择的本地预览。
- `audit-title-*.cjs`、`benchmark-title-backend.cjs`：标题链路离线检查/性能模拟，不是线上服务。

## 不要误读这个树

1. 七个功能目录不是七套系统：账号、数据库、连接、导航、目录与公共控件不复制。
2. 组合根负责装配与边界转换；控制器拥有可变业务状态，呈现模块只读投影。拆分是否有效看所有权/依赖/回归，不用行数下降证明。
3. 搜索查询与导航分开；导出篮、来源草稿、正文读取、预览、任务分开。跨栏投影不依赖 render 顺序。
4. 提示文字、业务恢复、显示实例与观测分开。只有短暂反馈可以超时，未知写入不能因换栏/重绘被当作已解决。
5. 诊断不是用户资料或长期日志：session 收集有容量/会话边界，复制不含聊天、账号或凭据，清空不修复业务。
6. [MIGRATION_MAP](MIGRATION_MAP.json) 保存第一阶段路径归位证据，当前完整树以本页与源码为准，不是旧路径兼容表。
7. 历史基线、当前修复与实际验收分别见 [BASELINE_VALIDATION](BASELINE_VALIDATION.md) 和 [VALIDATION](VALIDATION.md)，不把目录说明当作无 bug 或已发布证明。
