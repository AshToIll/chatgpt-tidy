/* 提示表面登记与展示类别，不拥有业务状态或自动恢复策略。
 * 文字由catalog维护；lifecycle只管展示实例，diagnostics只观察安全证据。 */
(function installNoticeRegistry(global) {
  "use strict";
  const surfaces = [
  {
    "surface": "shell.toast",
    "owner": "app",
    "source": "src/app/sidepanel/notice-controller.js",
    "trigger": "showToast 被业务调用；按原有连接状态、所有权及导航有效性判定是否显示。",
    "recovery": "按调用方错误类别及现有按钮处理；toast 本身不增加按钮。",
    "clear": "瞬时反馈由精确实例计时或当前交互撤销；导航反馈绑定栏目与intent；未知写入没有TTL。",
    "kinds": [
      "transient",
      "operation"
    ]
  },
  {
    "surface": "session.page-refresh",
    "owner": "platform",
    "source": "src/platform/session/ui/page-refresh-notice.js",
    "trigger": "会话非ready统一阻塞；connecting是实际探测，stalled表示探测已停止，refresh-required仅来自明确文档断连证据。",
    "recovery": "stalled显示只读重新连接；refresh-required请刷新ChatGPT网页；不重放业务写入。",
    "clear": "下次 renderPageRefreshNotice 看到 ready；无自动消失时间。",
    "kinds": [
      "condition"
    ]
  },
  {
    "surface": "titles.current.notice",
    "owner": "titles",
    "source": "src/features/titles/ui/title-view.js",
    "trigger": "render 的 state.error、state.notice 或非 verified 回执提示，按原优先级。",
    "recovery": "原有重新预览/核对按钮；未知写入回执不会自动重试写入。",
    "clear": "编辑预览可随上下文撤销；已提交计划与未知回执独立保留，只读核对失败不覆盖主状态；无独立计时。",
    "kinds": [
      "condition",
      "operation"
    ]
  },
  {
    "surface": "titles.batch.notice",
    "owner": "titles",
    "source": "src/features/titles/ui/title-batch-view.js",
    "trigger": "noticeMarkup 按操作错误、预览过期、限流、目录问题顺序选择。",
    "recovery": "按目录/回执原因显示重新读取、继续、连接或切回当前会话。",
    "clear": "状态/阶段变化后重绘不再返回 notice；无独立消失计时。",
    "kinds": [
      "condition",
      "operation"
    ]
  },
  {
    "surface": "titles.batch.receipt",
    "owner": "titles",
    "source": "src/features/titles/ui/title-batch-view.js",
    "trigger": "非 select 阶段且回执状态未就绪或读取错误。",
    "recovery": "重新核对状态；不自动重新修改。",
    "clear": "回执状态就绪、回到 select 或离开视图。",
    "kinds": [
      "operation"
    ]
  },
  {
    "surface": "search.error",
    "owner": "search",
    "source": "src/features/search/ui/search-view.js",
    "trigger": "有效且可见的当前交互 showErrorNotice 接收错误；日期/关键词共用瞬时槽。",
    "recovery": "关键词按 retryable 显示重试；日期统一使用原刷新入口。",
    "clear": "5000ms、开始新交互、通道撤销、关闭/切换；不从历史 readErrors 反复生成。",
    "kinds": [
      "transient"
    ]
  },
  {
    "surface": "export.account",
    "owner": "export",
    "source": "src/features/export/ui/export-view.js",
    "trigger": "scopeVerified 为 false，导出页只绘制账号确认状态。",
    "recovery": "原有重试资料连接按钮。",
    "clear": "scopeVerified 为 true 后重绘或栏目离开；无独立计时。",
    "kinds": [
      "condition"
    ]
  },
  {
    "surface": "export.current.error",
    "owner": "export",
    "source": "src/features/export/ui/export-view.js",
    "trigger": "当前预览实际呈现 loadError；优先级由 currentPreviewMarkup 决定。",
    "recovery": "原重试读取按钮，不自动反复请求。",
    "clear": "重试、内容/会话失效清空、模式切换或预览隐藏。",
    "kinds": [
      "condition"
    ]
  },
  {
    "surface": "export.batch.error",
    "owner": "export",
    "source": "src/features/export/ui/export-view.js",
    "trigger": "批量预览实际呈现 batchLoadError。",
    "recovery": "仅 batchRetryable 为真时显示原重试按钮。",
    "clear": "重试、来源变化、模式切换或预览隐藏。",
    "kinds": [
      "condition"
    ]
  },
  {
    "surface": "export.generation.error",
    "owner": "export",
    "source": "src/features/export/ui/export-view.js",
    "trigger": "state.exportError 存在且动作区实际呈现生成失败。",
    "recovery": "修改或重试原导出入口；不显示原始服务端文本。",
    "clear": "invalidateResult、开始新任务或视图不再呈现；无独立计时。",
    "kinds": [
      "condition"
    ]
  },
  {
    "surface": "export.job",
    "owner": "export",
    "source": "src/features/export/ui/export-view.js",
    "trigger": "jobMarkup 有可显示的任务/提交/未知状态且任务未收起。",
    "recovery": "按阶段使用原取消、核对、查看下载、关闭按钮。",
    "clear": "手动收起或原成功/警告定时收起；失败不自动收起；悬停/聚焦/警告展开/隐藏页面暂停计时。",
    "kinds": [
      "operation",
      "transient"
    ]
  },
  {
    "surface": "settings.backup.status",
    "owner": "settings",
    "source": "src/features/settings/ui/library-backup-view.js",
    "trigger": "update 按进行中、errorKey、未确认连接顺序选择状态。",
    "recovery": "按原条件重新连接/查看资料；文件失败重选文件。",
    "clear": "普通文件预览离栏清理；已提交恢复按账号保留pending/unknown，离栏不清；未知结果仅明确核对后解除再次导入锁。",
    "kinds": [
      "condition",
      "operation"
    ]
  },
  {
    "surface": "page.favorite.error",
    "owner": "favorites",
    "source": "src/features/favorites/chatgpt/favorites-presentation.js",
    "trigger": "网页收藏变更请求失败，按钮显示 pageFavoriteFailed。",
    "recovery": "原收藏页查看结果；请求失败不证明写入失败。",
    "clear": "点击提示关闭、再次操作或节点移除；普通重绘和切语言保留原提示；无自动消失计时。",
    "kinds": [
      "operation"
    ]
  },
  {
    "surface": "page.bookmark.error",
    "owner": "bookmarks",
    "source": "src/features/bookmarks/chatgpt/bookmarks-presentation.js",
    "trigger": "网页书签变更/打开请求失败；具体分支看文案键和已知错误码。",
    "recovery": "查看书签或再次打开，按原按钮行为。",
    "clear": "点击提示关闭、再次操作或节点移除；普通重绘和切语言保留原提示；无自动消失计时。",
    "kinds": [
      "transient",
      "operation"
    ]
  },
  {
    "surface": "shell.preferences",
    "owner": "settings",
    "source": "src/app/sidepanel/shell-presentation.js",
    "trigger": "moduleErrors.preferences 存在时显示；全局槽不依赖设置栏是否打开。",
    "recovery": "retryable 时原有重读设置按钮；失效侧栏按原文案重开。",
    "clear": "错误被新的设置读取/保存状态清除；无自动计时。",
    "kinds": [
      "condition",
      "operation"
    ]
  },
  {
    "surface": "shell.context",
    "owner": "time",
    "source": "src/app/sidepanel/shell-presentation.js",
    "trigger": "state.error 存在、没有快照且共享刷新提示未占位。",
    "recovery": "按 contextErrorPresentation 的 retryable 显示原重试按钮。",
    "clear": "读取到快照、错误清空或共享刷新提示出现后重绘。",
    "kinds": [
      "condition"
    ]
  },
  {
    "surface": "favorites.library-status",
    "owner": "favorites",
    "source": "src/app/sidepanel/shell-presentation.js",
    "trigger": "收藏读取失败或尚未取得收藏数据时显示；从同一槽呈现。",
    "recovery": "失败按错误是否可恢复显示原重试；等待状态不添加操作。",
    "clear": "资料读取成功并绘制收藏视图，或外层导航/会话层隐藏；无独立计时。",
    "kinds": [
      "condition"
    ]
  },
  {
    "surface": "bookmarks.library-status",
    "owner": "bookmarks",
    "source": "src/app/sidepanel/shell-presentation.js",
    "trigger": "书签读取失败或尚未取得书签数据时显示；账号和当前会话等待沿用原规则。",
    "recovery": "失败按错误是否可恢复显示原重试；等待状态不添加操作。",
    "clear": "资料读取成功并绘制书签视图，或外层导航/会话层隐藏；无独立计时。",
    "kinds": [
      "condition"
    ]
  },
  {
    "surface": "export.selection.error",
    "owner": "export",
    "source": "src/features/export/ui/export-view.js",
    "trigger": "批量规划存在 batchPlanError 且动作区实际呈现错误；区分选中书签缺失与被内容设置排除。",
    "recovery": "调整选择或内容设置，再从原入口重试；不会导出不完整选择。",
    "clear": "选择/设置改变后规划错误清空、切换模式或动作区隐藏；无独立消失计时。",
    "kinds": [
      "condition"
    ]
  },
  {
    "surface": "titles.current.recovery",
    "owner": "titles",
    "source": "src/features/titles/ui/title-view.js",
    "kinds": [
      "condition"
    ],
    "trigger": "已提交修改仍待确认，且本次只读核对失败的次级提示实际呈现。",
    "recovery": "重新核对状态；不得重新提交修改，也不得覆盖原写入未确认主状态。",
    "clear": "再次开始核对、当前操作得到确认、视图隐藏或销毁；主操作与其原因独立保留。"
  },
  {
    "surface": "titles.rules.status",
    "owner": "titles",
    "source": "src/features/titles/ui/title-organization-view.js",
    "kinds": [
      "condition",
      "operation"
    ],
    "trigger": "标题格式设置读取、保存失败或保存回执未确认，且规则区域实际显示提示。",
    "recovery": "读取失败可重新读取；保存未知先核对，不自动重放写入。",
    "clear": "所属读取成功，或对应字段被后续已确认保存覆盖；无关事件和其他字段成功不能抹除未知结果。"
  }
];
  // 分组名称校验属于对应表单，不占用全局 toast 或资料加载状态。
  for (const owner of ["favorites", "bookmarks"]) surfaces.push({
    surface: owner + ".group-name-validation",
    owner,
    source: "src/features/" + owner + "/ui/" + owner + "-view.js",
    trigger: "新建或重命名提交时名称去除首尾空白后为空；请求尚未发出。",
    recovery: "在原输入框填写分组名称后重新提交。",
    clear: "输入得到有效名称、取消对应表单、重置账号或移除对应编辑目标；不设独立定时器。",
    kinds: ["condition"],
  });
  global.ChatGPTTidyNoticeRegistry = Object.freeze({ schemaVersion: 2,
    surfaces: Object.freeze(surfaces.map(item => Object.freeze({ ...item, kinds: Object.freeze(item.kinds) }))) });
})(globalThis);
