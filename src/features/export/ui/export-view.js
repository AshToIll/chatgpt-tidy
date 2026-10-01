import { createExportContextController } from "./export-context-controller.js";
import { createExportJobController } from "./export-job-controller.js";
import { createExportPreviewController } from "./export-preview-controller.js";
import { createExportResources } from "./export-resources.js";
import { renderExportMarkup, FORMAT_META } from "./export-markup.js";
import { renderListMarkup } from "../../../platform/ui/stable-list-dom.js";

const snapshotTitle = snapshot => String(snapshot?.conversation?.title?.value || "").trim();
const isBoundSnapshot = snapshot => Boolean(snapshot?.conversation?.conversationId
  && snapshot.conversation.bindingStatus === "bound" && snapshot.conversation.identityStatus === "stable");
const normalizedAccountKey = value => typeof value === "string" && value && value === value.trim() ? value : null;

/**
 * 导出 UI 装配：这里只拥有控件设置、折叠/滚动与呈现投影。
 * 选择、正文请求、任务和页面预览分别有唯一可写 owner；render 不改变这些业务模型。
 */
export function createExportView({
  root, requestDocument, requestDocuments, requestResource, presentFullPreview, dismissFullPreview,
  formatTimestamp, jobRequest, selection,
  onToast = () => {}, onSourceRequest = () => {}, reloadSources = async () => {},
  openDownloads = async () => {}, onStateChange = () => {},
}) {
  if (!root) throw new Error("Export view root is required");
  if (!selection || typeof selection.snapshot !== "function" || typeof selection.subscribe !== "function") {
    throw new Error("Export selection owner is required");
  }
  if (typeof requestDocument !== "function") throw new Error("Export document request is required");
  if (typeof requestDocuments !== "function") throw new Error("Batch export document request is required");
  if (typeof presentFullPreview !== "function") throw new Error("Export preview presenter is required");
  if (typeof dismissFullPreview !== "function") throw new Error("Export preview dismissor is required");
  const exportApi = globalThis.TidyExport, exportContract = globalThis.TidyExportContract, preview = globalThis.TidyExportPreview;
  if (!exportApi || !exportContract || !preview) throw new Error("Export runtime is unavailable");
  root.addEventListener("error", preview.onImageError, true);
  const state = {
    active: false, preferences: null, t: key => key, mode: "current",
    format: "markdown", content: { timestamps: true, messageNumbers: true, ...exportApi.DEFAULT_PROJECTION_OPTIONS }, roleNames: { user: "", assistant: "" },
    pdf: { pageSize: "A4", orientation: "portrait", fontSize: "standard", pageNumbers: true },
    filename: "", filenameConversationId: null, filenameTouched: false,
    settingsView: null, settingsTarget: "content", scrollTop: 0, exportError: null,
    batchPlanError: null, batchOrganizationOpen: null, conversationOrganization: "per-conversation",
    bookmarkOrganization: "all-bookmarks", batchFilename: "", batchSingleFilename: "", batchSingleSignature: "",
    showAllConversations: false, showAllBookmarkGroups: false, expandedBookmarkGroups: new Set(),
  };
  let ready = false, updating = false, contextInput = {};
  let data = {}, sources = {}, task = {}, currentPlan = null, batchPlanning = { plan: null, error: null, signature: "" };
  const disclosureKeys = new Map();
  const fullPreview = createExportPreviewController({
    root, present: presentFullPreview, dismiss: dismissFullPreview,
    onError(error) { const notice = exportApi.exportErrorDescriptor(error, state.t, "exportPreviewFailed");
      onToast(notice.key, true, notice.values, globalThis.ChatGPTTidyDiagnostics?.cause(error)); },
  });
  const jobs = createExportJobController({ jobRequest, onChanged: () => { changed(); onStateChange(); },
    onAcceptedFailure(key, cause) { if (key === "exportJobNotStarted") { state.exportError = { key }; changed(); }
      else onToast(key, true, {}, cause); },
  });
  const documents = createExportContextController({ requestDocument, requestDocuments, exportApi, exportContract,
    onChanged: changed, onInvalidated: () => invalidateResult({ clearError: false }), rememberCause, translate });
  const imageReader = createExportResources({ request: payload => requestResource(payload),
    validResource: exportContract.validResource, onResolved: result => documents.applyResource(result) });

  function changed() {
    if (!ready || updating) return;
    refreshDerived();
    render();
  }
  function syncReaders() {
    documents.update({ ...contextInput, active: state.active, mode: state.mode, sources });
    fullPreview.updateOwner({ accountKey: data.accountKey, verified: data.scopeVerified, active: state.active });
  }
  function ensureVisible() {
    return state.mode === "batch" ? documents.ensureBatch() : documents.ensureCurrent();
  }
  const ensureDocument = options => documents.ensureCurrent(options);
  const ensureBatchDocuments = options => documents.ensureBatch(options);
  const currentPlanReady = () => documents.currentReady();
  const batchSourcesReady = () => documents.batchSourcesReady();
  const selectedConversationIds = () => documents.selectedConversationIds();
  const basketCount = () => selection.basketCount();
  const jobBusy = () => jobs.busy();
  const refreshJob = () => jobs.refresh();
  const cancelJob = () => jobs.cancel();
  const dismissJob = () => jobs.dismiss();
  const closeFullPreview = options => fullPreview.close(options);
  const batchPlan = () => batchPlanning.plan;
  const exportPlan = () => state.mode === "batch" ? batchPlan() : currentPlan;
  const batchPlanReady = () => batchSourcesReady() && !data.batchStaleConversationIds.size
    && !data.batchLoading && !data.batchLoadError && Boolean(batchPlan());

  function invalidateResult({ clearError = true } = {}) {
    fullPreview.close();
    if (clearError) state.exportError = null;
    if (ready && !updating) refreshDerived();
  }
  function refreshDerived() {
    data = documents.snapshot(); sources = selection.snapshot(); task = jobs.snapshot();
    const title = (data.document?.conversation?.title || snapshotTitle(data.snapshot)) || translate("untitled");
    if (data.conversationId && (state.filenameConversationId !== data.conversationId || !state.filenameTouched)) {
      state.filename = title; state.filenameConversationId = data.conversationId;
    }
    const bookmarks = basketBookmarkItems(), groups = basketBookmarkGroups();
    if (sources.basket.conversations.length <= 1) state.conversationOrganization = "per-conversation";
    const groupCount = new Set(bookmarks.map(item => item.groupId || "ungrouped")).size;
    if (bookmarks.length <= 1 || (state.bookmarkOrganization === "per-conversation" && groups.length < 2)
      || (state.bookmarkOrganization === "per-bookmark-group" && groupCount < 2)) state.bookmarkOrganization = "all-bookmarks";
    batchPlanning = buildBatchPlan();
    if (batchPlanning.signature !== state.batchSingleSignature) {
      state.batchSingleSignature = batchPlanning.signature;
      state.batchSingleFilename = "";
    }
    state.batchPlanError = batchPlanning.error;
    currentPlan = buildCurrentPlan();
    jobs.setPresentation({ active: state.active, documentHidden: Boolean(globalThis.document?.hidden) });
    task = jobs.snapshot();
    fullPreview.updateOwner({ accountKey: data.accountKey, verified: data.scopeVerified, active: state.active });
    syncImages();
  }

  function buildBatchPlan() {
    try {
      const data = normalizeBatchData();
      // A refresh gap is not a different output selection. Keep the user's
      // single-file name until a complete plan proves its identity has changed.
      if (!data || !basketCount()) return { plan: null, error: null, signature: state.batchSingleSignature };
      const config = { mode: "batch", messages: exportApi.createExportMessages(state.t), format: state.format,
        conversationIds: sources.basket.conversations.map(record => record.conversationId),
        bookmarkIds: [...sources.basket.bookmarkIds], conversationOrganization: state.conversationOrganization,
        bookmarkOrganization: state.bookmarkOrganization, bookmarkGroups: bookmarkGroupConfig(), options: { ...state.content }, data };
      const automatic = exportApi.buildExportPlan({ ...config, names: { zip: state.batchFilename } });
      if (automatic.zipped || !automatic.files[0]) return { plan: automatic, error: null, signature: "" };
      const file = automatic.files[0];
      const signature = file.kind === "conversation" ? `conversation:${file.conversations.map(item => item.id).join(",")}`
        : `bookmarks:${file.bookmarkEntries.map(item => item.bookmarkId).join(",")}`;
      const customName = signature === state.batchSingleSignature ? state.batchSingleFilename : "";
      return { plan: customName ? exportApi.buildExportPlan({ ...config,
        names: { zip: state.batchFilename, [file.customKey || "single"]: customName } }) : automatic, error: null, signature };
    } catch (error) {
      // 失败保留完整选择，不能把缺失书签悄悄从导出计划里丢掉。
      return { plan: null, error, signature: state.batchSingleSignature };
    }
  }

  function selectedImages() {
    return globalThis.TidyExportJobs.needsImageResolution(state.format) ? exportApi.selectedImageResources(exportPlan()) : [];
  }

  function pendingImageCount() { return selectedImages().filter(item => item.resource.pending).length; }

  function syncImages() {
    const enabled = state.active && data.scopeVerified && (state.mode === "batch" ? batchPlanReady() : currentPlanReady());
    const resources = enabled ? selectedImages().map(({ conversationId, resource }) => {
      const source = state.mode === "batch" ? data.batchDocuments.get(conversationId) : data.document;
      return source?.conversation.resources.find(item => item.id === resource.id);
    }).filter(Boolean) : [];
    imageReader.update({ accountKey: data.accountKey, enabled, resources });
  }

  function translate(key, values = {}) {
    return state.t(key, values);
  }

  // 持久提示保存 key 和原始参数；绘制时再翻译，切语言不重新读取、不重置提示寿命。
  // 诊断旁路：只保存错误代码/请求号；不保存文件名、正文、账号、服务端文本。
  const noticeCauses = new WeakMap();


  function rememberCause(notice, error) {
    if (notice && typeof notice === "object") noticeCauses.set(notice, globalThis.ChatGPTTidyDiagnostics?.cause(error));
    return notice;
  }

  function observeRenderedNotices() {
    try {
      const observer = globalThis.ChatGPTTidyDiagnostics;
      if (!observer) return;
      const shown = (selector) => state.active && Boolean(root.querySelector?.(selector));
      const observe = (surface, key, visible, cause = null) => observer.notice({ event: visible && key ? "show" : "clear",
        surface, messageKey: key, source: "src/features/export/ui/export-view.js", ...cause });
      observe("export.account", "exportAccountRequired", shown("[data-retry-library]"), { reasonCode: "EXPORT_ACCOUNT_UNVERIFIED" });
      observe("export.current.error", data.loadError?.key,
        state.mode === "current" && shown("[data-export-retry]"), noticeCauses.get(data.loadError));
      observe("export.batch.error", data.batchLoadError?.key,
        state.mode === "batch" && shown(".export-preview-state--error"), noticeCauses.get(data.batchLoadError));
      observe("export.generation.error", state.exportError?.key, shown(".export-error"), noticeCauses.get(state.exportError));
      const missing = state.batchPlanError?.missingBookmarks || [];
      const selectionKey = state.batchPlanError?.code !== "EXPORT_SELECTION_INCOMPLETE" ? "exportBatchUnavailable"
        : missing.length && missing.every(item => item.reason === "content-excluded") ? "exportSelectionFiltered" : "exportSelectionIncomplete";
      observe("export.selection.error", selectionKey, !state.exportError && state.mode === "batch"
        && Boolean(state.batchPlanError) && shown(".export-selection-error, .export-error"), observer.cause(state.batchPlanError));
      const jobKey = task.unknown ? "exportJobUnknown" : task.submission ? "exportJobStarting"
        : { busy: "exportJobBusy", starting: "exportJobStarting", generating: "exportJobGenerating", saving: "exportJobSaving",
          cancelling: "exportJobCancelling", completed: "exportJobCompleted", failed: "exportJobFailed", cancelled: "exportJobCancelled" }[task.job?.state];
      observe("export.job", jobKey, shown("[data-export-job]"), {
        ...(task.unknown ? task.observedFailure : { reasonCode: task.job?.errorCode || "OBSERVATION_ONLY_UNSPECIFIED" }),
        jobId: task.job?.id || task.admissionId });
    } catch { /* 观测读取DOM失败也不得干扰功能。 */ }
  }

  function noticeText(notice) {
    return translate(notice.key, { ...notice.values,
      ...(notice.unitKey ? { unit: translate(notice.unitKey) } : {}) });
  }

  function currentConversation() {
    return data.document?.conversation || null;
  }

  function responseInProgress() {
    return data.snapshot?.adapter?.responseInProgress === true;
  }

  function updatePresentation(model) {
    const presentationKeys = ['language', 'timeZone', 'dateFormat', 'messageTimePrecision'];
    const previous = JSON.stringify(presentationKeys.map(key => state.preferences?.[key]));
    if (Object.hasOwn(model, "preferences")) state.preferences = model.preferences || null;
    if (typeof model.translator === "function") state.t = model.translator;
    if (previous !== JSON.stringify(presentationKeys.map(key => state.preferences?.[key]))) {
      invalidateResult({ clearError: false });
    }
  }

  function resolvedRoleNames() {
    return exportApi.resolveRoleNames(state.roleNames);
  }

  function disclosureOpenAttribute(selector, itemKeys) {
    // 同一份说明刷新时沿用用户的展开/收起；换账号、导出范围或问题条目则默认收起。
    // 用内容身份而非译文判断，切语言不打断阅读；批量范围也不跟随当前聊天变化。
    const scope = state.mode === "batch"
      ? [sources.basket.conversations.map(record => record.conversationId).sort(), [...sources.basket.bookmarkIds].sort()]
      : data.conversationId;
    const key = JSON.stringify([data.accountKey, state.mode, scope, itemKeys]);
    // details.open 会先于异步 toggle 事件变化。绘制前直接读取，避免刚点开就刷新时丢状态。
    // 节点已消失则不继承，说明重新出现时仍默认收起；无需存入用户设置。
    const open = disclosureKeys.get(selector) === key && root.querySelector(selector)?.open;
    disclosureKeys.set(selector, key);
    return open ? " open" : "";
  }

  function missingImages() {
    // 用户主动排除图片不算内容丢失；只展示本次选择需要的资源警告。
    return state.content.mediaAttachments
      ? selectedImages().filter(({ resource }) => !resource.pending && !resource.src) : [];
  }

  function sourceWarnings(missing = missingImages()) {
    return missing.length ? [translate("exportImageUnavailable")] : [];
  }

  function messageCount() {
    return currentConversation()?.messages?.length || data.snapshot?.messages?.length || 0;
  }

  function basketBookmarkItems() {
    const items = sources.basket.bookmarkIds
      .map((id) => sources.bookmarks?.items?.[id])
      .filter(Boolean);
    return items.sort((left, right) => {
      const leftTime = Date.parse(left.messageTimestamp || left.bookmarkedAt || "") || 0;
      const rightTime = Date.parse(right.messageTimestamp || right.bookmarkedAt || "") || 0;
      return leftTime - rightTime;
    });
  }

  function basketConversationRecords() {
    return sources.basket.conversations.map((record) => {
      const favorite = sources.favorites?.items?.[record.conversationId];
      const bookmark = basketBookmarkItems().find((item) => item.conversationId === record.conversationId);
      const document = data.batchDocuments.get(record.conversationId)?.conversation;
      return {
        ...record,
        conversation: {
          id: record.conversationId,
          // The freshly read export document is authoritative for the output
          // label; repository metadata remains the immediate fallback while it
          // is loading or when the source module is temporarily unavailable.
          title: document?.title || favorite?.title || record.searchMetadata?.title || bookmark?.conversationTitle || translate("untitled"),
          createdAt: document?.createdAt || favorite?.createdAt || record.searchMetadata?.createdAt || bookmark?.bookmarkedAt || "",
          updatedAt: document?.updatedAt || favorite?.updatedAt || record.searchMetadata?.updatedAt || favorite?.createdAt || "",
          sourceUrl: document?.sourceUrl || favorite?.routePath || bookmark?.routePath || (record.searchMetadata ? `/c/${encodeURIComponent(record.conversationId)}` : ""),
        },
      };
    });
  }

  function basketBookmarkGroups() {
    const groups = new Map();
    basketBookmarkItems().forEach((bookmark) => {
      const id = bookmark.conversationId;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(bookmark);
    });
    return [...groups.entries()].map(([conversationId, bookmarks]) => {
      const document = data.batchDocuments.get(conversationId)?.conversation;
      const favorite = sources.favorites?.items?.[conversationId];
      const first = bookmarks[0];
      return {
        conversation: {
          id: conversationId,
          title: document?.title || favorite?.title || first?.conversationTitle || translate("untitled"),
          createdAt: document?.createdAt || favorite?.createdAt || first?.bookmarkedAt || "",
          updatedAt: document?.updatedAt || favorite?.updatedAt || "",
        },
        bookmarks,
      };
    }).sort((left, right) => (Date.parse(left.conversation.createdAt) || 0) - (Date.parse(right.conversation.createdAt) || 0));
  }

  function bookmarkGroupConfig() {
    return [
      { id: "ungrouped", name: translate("ungrouped"), system: true },
      ...(sources.bookmarks?.groups || []).map((group) => ({ id: group.id, name: group.name, system: false })),
    ];
  }

  function normalizeBatchData() {
    const ids = selectedConversationIds();
    const conversations = ids
      .map((id) => data.batchDocuments.get(id)?.conversation)
      .filter(Boolean);
    if (conversations.length !== ids.length) return null;
    const bookmarks = basketBookmarkItems().map((bookmark) => ({
      id: bookmark.bookmarkId,
      conversationId: bookmark.conversationId,
      messageId: bookmark.messageId,
      bookmarkedAt: bookmark.bookmarkedAt,
      groupId: bookmark.groupId,
    }));
    return exportApi.normalizeExportData({ conversations, bookmarks });
  }

  function batchPreviewText() {
    const plan = batchPlan();
    if (!plan) return "";
    const lines = [plan.outputName];
    plan.files.forEach((file) => {
      const count = file.kind === "conversation"
        ? `${file.conversations.length} ${translate("conversationItemsUnit")}`
        : `${file.bookmarkEntries.length} ${translate("bookmarkItemsUnit")}`;
      lines.push(`- ${file.path} (${count})`);
    });
    return lines.join("\n");
  }

  function exportData() {
    if (!currentConversation()) return null;
    return exportApi.normalizeExportData({
      conversations: [currentConversation()],
      bookmarks: [],
    });
  }

  function exportContext(messages) {
    const preferences = { ...state.preferences };
    return {
      messages,
      options: { ...state.content },
      roleNames: resolvedRoleNames(),
      pdf: { ...state.pdf },
      formatTimestamp: (value) => formatTimestamp?.(value, preferences) || value,
    };
  }

  function buildCurrentPlan() {
    const planData = exportData();
    if (!planData) return null;
    if (currentConversation().id !== data.conversationId) {
      throw new Error(translate("contextChanged"));
    }
    return exportApi.buildExportPlan({
      mode: "current",
      messages: exportApi.createExportMessages(state.t),
      format: state.format,
      currentConversationId: currentConversation().id,
      options: { ...state.content },
      names: { current: state.filename },
      data: planData,
    });
  }

  function pdfSummary() {
    return [
      state.pdf.pageSize,
      translate(state.pdf.orientation === "landscape" ? "exportLandscape" : "exportPortrait"),
    ].join(" · ");
  }

  // 顶部范围和底部按钮共用数量摘要；数量为零的类别不显示，避免出现“0 条书签”等干扰。

  function countLabel(count, unitKey) {
    const language = state.preferences?.language;
    if (language === "en") {
      const singular = unitKey === "conversationItemsUnit" ? "conversation" : "bookmark";
      return `${count} ${singular}${count === 1 ? "" : "s"}`;
    }
    return `${count} ${translate(unitKey)}`;
  }

  function batchCountSummary() {
    const parts = [];
    if (sources.basket.conversations.length) {
      parts.push(countLabel(sources.basket.conversations.length, "conversationItemsUnit"));
    }
    if (sources.basket.bookmarkIds.length) {
      parts.push(countLabel(sources.basket.bookmarkIds.length, "bookmarkItemsUnit"));
    }
    return parts.join(" + ");
  }

  function footerSummary() {
    if (state.mode === "batch") {
      const conversations = sources.basket.conversations.length;
      const bookmarks = sources.basket.bookmarkIds.length;
      const summary = conversations || bookmarks ? batchCountSummary() : translate("exportList");
      return `${summary} · ${FORMAT_META[state.format].label}`;
    }
    return `${translate("currentConversation")} · ${FORMAT_META[state.format].label}`;
  }

  function serializeCurrentPreview() {
    const plan = exportPlan();
    const file = plan?.files?.[0];
    if (!file) return null;
    const previewFormat = state.format === "pdf" ? "txt" : state.format;
    return exportApi.serializeTextFile(file, previewFormat, exportContext(plan.messages));
  }

  function pdfPreviewParts(plan, maxText = Infinity) {
    if (!plan) return [];
    const context = exportContext(plan.messages);
    return plan.files.flatMap(file => [
      ...(plan.files.length > 1 ? [{ type: "text", text: file.path }] : []),
      ...exportApi.serializePreviewParts(file, context, maxText),
    ]);
  }

  function previewPayload(sessionId) {
    const content = state.format === "pdf" ? "" : state.mode === "batch" ? batchPreviewText() : serializeCurrentPreview();
    if (typeof content !== "string") return null;
    const summary = state.format === "pdf" ? `${footerSummary()} · ${pdfSummary()} · ${translate("exportPdfPreviewNotice")}` : footerSummary();
    return {
      sessionId,
      expectedAccountKey: data.accountKey,
      expectedConversationId: state.mode === "current" ? data.conversationId : null,
      mode: state.mode,
      title: translate("exportFullPreview"),
      closeLabel: translate("exportClosePreview"),
      summary,
      content,
      ...(state.format === "pdf" ? { previewParts: pdfPreviewParts(exportPlan()) } : {}),
      format: state.format,
      colorScheme: data.snapshot?.appearance?.colorScheme === "dark" ? "dark" : "light",
      pdf: {
        pageSize: state.pdf.pageSize,
        orientation: state.pdf.orientation,
        fontSize: state.pdf.fontSize,
      },
    };
  }

  function leaveSettings() {
    const view = state.settingsView, target = state.settingsTarget;
    state.settingsView = null;
    render();
    const selector = `[data-export-settings-view="${view}"]`;
    (root.querySelector(`${selector}[data-export-settings-target="${target}"]`) || root.querySelector(selector))?.focus({ preventScroll: true });
  }

  function openFullPreview(opener) {
    if (!(state.mode === "batch" ? batchPlanReady() : currentPlanReady()) || pendingImageCount() || fullPreview.isOpen()) return;
    return fullPreview.open(previewPayload(), opener);
  }

  // 只读呈现 DTO：模板收不到任何可写 owner，也无法派发读取或更改跨栏选择。
  function render() {
    const previousSecondaryScroller = root.querySelector(".export-secondary-scroll");
    const plan = exportPlan(), missing = missingImages();
    const conversationRecords = basketConversationRecords().map(record => ({ ...record,
      messageTotal: data.batchDocuments.get(record.conversation.id)?.conversation?.messages?.length,
      highlighted: sources.batchHighlightedConversationIds.includes(record.conversation.id) }));
    const bookmarkGroups = basketBookmarkGroups().map(group => ({ ...group,
      overlap: sources.basket.conversations.some(record => record.conversationId === group.conversation.id),
      highlighted: group.bookmarks.some(bookmark => sources.batchHighlightedBookmarkIds.includes(bookmark.bookmarkId)),
      expanded: state.expandedBookmarkGroups.has(group.conversation.id),
      bookmarks: group.bookmarks.map(bookmark => {
        const document = data.batchDocuments.get(bookmark.conversationId)?.conversation;
        const message = document?.messages?.find(item => item.id === bookmark.messageId);
        return { ...bookmark, text: message ? exportApi.segmentsToPlainText(message.segments, document.resources || []).slice(0, 180)
          : bookmark.excerpt || translate("messageMissing"),
          role: message?.role === "assistant" ? "assistant" : "user", messageNumber: message?.messageNumber,
          timestamp: message?.timestamp || bookmark.messageTimestamp || bookmark.bookmarkedAt,
          groupLabel: sources.bookmarks?.groups?.find(candidate => candidate.id === bookmark.groupId)?.name || translate("ungrouped"),
          highlighted: sources.batchHighlightedBookmarkIds.includes(bookmark.bookmarkId) };
      }),
    }));
    const missingBookmarks = state.batchPlanError?.missingBookmarks || [];
    const markup = renderExportMarkup({
      // 编辑控件接收原始草稿（包括空串）；默认名称只用于摘要、预览和导出，不能反写输入框。
      format: state.format, content: state.content, pdf: state.pdf, roleNames: { ...state.roleNames },
      preferences: state.preferences, filename: state.filename, settingsView: state.settingsView, mode: state.mode,
      accountKey: data.accountKey, scopeVerified: data.scopeVerified, loading: data.loading,
      documentStale: data.documentStale, loadError: data.loadError, currentResponsePending: data.currentResponsePending, batchLoading: data.batchLoading,
      batchLoadError: data.batchLoadError, batchRetryable: data.batchRetryable, batchFailedTitles: data.batchFailedTitles,
      batchPlanError: state.batchPlanError, batchOrganizationOpen: state.batchOrganizationOpen,
      conversationOrganization: state.conversationOrganization, bookmarkOrganization: state.bookmarkOrganization,
      batchFilename: state.batchFilename, batchSingleFilename: state.batchSingleFilename,
      showAllConversations: state.showAllConversations, showAllBookmarkGroups: state.showAllBookmarkGroups,
      job: task.job, jobSubmission: task.submission, jobUnknown: task.unknown, jobWarningsOpen: task.warningsOpen,
      exportError: state.exportError, plan, currentTitle: (currentConversation()?.title || snapshotTitle(data.snapshot)) || translate("untitled"),
      messageCount: messageCount(), currentReady: currentPlanReady(), batchReady: batchPlanReady(),
      responseInProgress: responseInProgress(), boundSnapshot: isBoundSnapshot(data.snapshot), batchSourcesReady: batchSourcesReady(),
      batchStaleCount: data.batchStaleConversationIds.size, conversationCount: sources.basket.conversations.length,
      bookmarkCount: sources.basket.bookmarkIds.length, conversationRecords, bookmarkGroups, bookmarkItems: basketBookmarkItems(),
      pendingImages: pendingImageCount(), missingImages: missing,
      currentPreviewText: !state.settingsView && state.mode === "current" && plan && state.format !== "pdf"
        ? exportApi.serializeTextExcerpt(plan.files[0], state.format, exportContext(plan.messages), 2600) : "",
      currentPdfParts: !state.settingsView && state.mode === "current" && state.format === "pdf" ? pdfPreviewParts(plan, 2600) : [],
      warningsOpen: missing.length > 0 && Boolean(disclosureOpenAttribute("[data-export-warnings]",
        missing.map(({ conversationId, resource }) => JSON.stringify([conversationId, resource.id])).sort())),
      selectionErrorOpen: missingBookmarks.length > 0 && Boolean(disclosureOpenAttribute("[data-export-selection-error]",
        missingBookmarks.map(item => JSON.stringify([item.bookmarkId, item.reason])).sort())),
      selectionMissingLabels: missingBookmarks.map(item => {
        const saved = sources.bookmarks?.items?.[item.bookmarkId];
        return saved?.excerpt || saved?.conversationTitle || translate("untitled");
      }),
      jobHidden: jobs.noticeHidden(), jobBusy: jobs.busy(),
      jobCancellable: globalThis.TidyExportJobs.active(task.job) && task.job?.state !== "cancelling",
      jobTerminal: globalThis.TidyExportJobs.terminal(task.job),
      exportApi, preview, formatTimestamp,
    }, state.t);
    renderListMarkup(root, markup);
    observeRenderedNotices();
    const scroller = root.querySelector("[data-export-scroll]");
    if (scroller) scroller.scrollTop = state.scrollTop;
    if (state.settingsView === "shared") {
      const secondaryScroller = root.querySelector(".export-secondary-scroll");
      const anchor = root.querySelector(`[data-export-settings-anchor="${state.settingsTarget}"]`);
      if (secondaryScroller && secondaryScroller !== previousSecondaryScroller && anchor) {
        secondaryScroller.scrollTop = Math.max(0, anchor.offsetTop - secondaryScroller.offsetTop - 4);
      }
    }
  }

  async function runDownload() {
    if (jobBusy()) { root.querySelector("[data-export-job]")?.focus({ preventScroll: false }); void refreshJob(); return; }
    if (!jobRequest || !(state.mode === "batch" ? batchPlanReady() : currentPlanReady()) || pendingImageCount()) return;
    state.exportError = null;
    try {
      // 冻结本次计划后交给任务 owner；后续设置/页面变化只影响下一次导出。
      const plan = exportApi.clone(exportPlan()), context = exportContext(plan.messages), timestamps = {};
      function collect(value) {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (["timestamp", "createdAt", "updatedAt"].includes(key) && typeof child === "string") timestamps[child] = context.formatTimestamp(child);
          else if (child && typeof child === "object") collect(child);
        }
      }
      collect(plan);
      return await jobs.submit({ id: crypto.randomUUID(), expectedAccountKey: data.accountKey,
        ...(state.mode === "current" ? { expectedConversationId: data.conversationId } : {}),
        spec: { plan, context: { options: context.options, roleNames: context.roleNames, pdf: context.pdf, timestamps }, warnings: sourceWarnings() } }, { onResponsePending: documents.captureResponsePending() });
    } catch (error) {
      // 此处尚未交付任务的本地计划错误不冒充“后台状态未知”，也不重放写请求。
      state.exportError = rememberCause(exportApi.exportErrorDescriptor(error, state.t, "exportGenerationFailed"), error);
      render();
    }
  }

  function setMode(mode) {
    if (!["current", "batch"].includes(mode)) return false;
    state.mode = mode; state.settingsView = null;
    updating = true; sources = selection.snapshot(); syncReaders(); updating = false;
    invalidateResult(); render(); return true;
  }

  function updateContext(model = {}) {
    const previous = data, wasVerified = data.scopeVerified;
    updating = true;
    contextInput = { snapshot: model.snapshot || null, accountKey: normalizedAccountKey(model.accountKey),
      verified: Boolean(normalizedAccountKey(model.accountKey)) };
    state.active = Boolean(model.active);
    updatePresentation(model);
    selection.updateSources({ accountKey: contextInput.accountKey, verified: contextInput.verified,
      ...(Object.hasOwn(model, "favorites") ? { favorites: model.favorites } : {}),
      ...(Object.hasOwn(model, "bookmarks") ? { bookmarks: model.bookmarks } : {}) });
    sources = selection.snapshot();
    jobs.updateOwner({ accountKey: contextInput.accountKey, verified: contextInput.verified });
    syncReaders();
    data = documents.snapshot();
    if (previous.contextKey !== data.contextKey) {
      state.filenameConversationId = null; state.filenameTouched = false;
      if (state.mode === "current") state.settingsView = null;
      fullPreview.close();
    }
    if (previous.accountKey !== data.accountKey) {
      state.expandedBookmarkGroups.clear(); state.batchSingleFilename = ""; state.batchSingleSignature = "";
    }
    updating = false;
    refreshDerived(); render();
    if (data.scopeVerified && (previous.accountKey !== data.accountKey || !wasVerified)) void refreshJob();
    if (state.active) void ensureVisible();
  }

  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-export-job-dismiss]")) { void dismissJob(); return; }
    if (event.target.closest("[data-export-job-cancel]")) { void cancelJob(); return; }
    const mode = event.target.closest("[data-export-mode]");
    if (mode) {
      const nextMode = mode.dataset.exportMode === "batch" ? "batch" : "current";
      if (nextMode === state.mode) return;
      state.scrollTop = 0;
      setMode(nextMode);
      if (state.mode === "current") void ensureDocument();
      else void ensureBatchDocuments();
      root.querySelector(`[data-export-mode="${state.mode}"]`)?.focus({ preventScroll: true });
      return;
    }
    const source = event.target.closest("[data-export-source]");
    if (source) {
      if (source.disabled) return;
      onSourceRequest?.(source.dataset.exportSource, state.settingsView === "manage" ? "manage" : "batch-main");
      return;
    }
    const addToggle = event.target.closest("[data-export-add-toggle]");
    if (addToggle) {
      const menu = root.querySelector(".export-add-menu");
      if (menu) {
        menu.hidden = !menu.hidden;
        addToggle.setAttribute("aria-expanded", String(!menu.hidden));
      }
      return;
    }
    const expandGroup = event.target.closest("[data-export-expand-bookmark-group]");
    if (expandGroup) {
      const conversationId = expandGroup.dataset.exportExpandBookmarkGroup;
      if (state.expandedBookmarkGroups.has(conversationId)) state.expandedBookmarkGroups.delete(conversationId);
      else state.expandedBookmarkGroups.add(conversationId);
      render();
      return;
    }
    const removeConversation = event.target.closest("[data-export-remove-conversation]");
    if (removeConversation) {
      selection.removeConversation(removeConversation.dataset.exportRemoveConversation);
      return;
    }
    const removeBookmark = event.target.closest("[data-export-remove-bookmark]");
    if (removeBookmark) {
      selection.removeBookmarks([removeBookmark.dataset.exportRemoveBookmark]);
      void ensureBatchDocuments();
      return;
    }
    const removeBookmarkGroup = event.target.closest("[data-export-remove-bookmark-group]");
    if (removeBookmarkGroup) {
      const ids = basketBookmarkItems().filter((item) => item.conversationId === removeBookmarkGroup.dataset.exportRemoveBookmarkGroup).map((item) => item.bookmarkId);
      selection.removeBookmarks(ids);
      void ensureBatchDocuments();
      return;
    }
    if (event.target.closest("[data-export-show-all-conversations]")) {
      // The list remains intentionally compact at first render. Showing all is
      // represented by removing the visual limit for this render cycle.
      state.showAllConversations = true;
      render();
      return;
    }
    if (event.target.closest("[data-export-show-all-bookmark-groups]")) {
      state.showAllBookmarkGroups = true;
      render();
      return;
    }
    const organizationToggle = event.target.closest("[data-export-organization-toggle]");
    if (organizationToggle) {
      const key = organizationToggle.dataset.exportOrganizationToggle;
      state.batchOrganizationOpen = state.batchOrganizationOpen === key ? null : key;
      render();
      return;
    }
    const organization = event.target.closest("[data-export-organization]");
    if (organization) {
      const key = organization.dataset.exportOrganization;
      if (key === "conversations") state.conversationOrganization = organization.dataset.value;
      if (key === "bookmarks") state.bookmarkOrganization = organization.dataset.value;
      state.batchOrganizationOpen = null;
      invalidateResult();
      render();
      root.querySelector(`[data-export-organization-toggle="${key}"]`)?.focus({ preventScroll: true });
      return;
    }
    const format = event.target.closest("[data-export-format]");
    if (format && FORMAT_META[format.dataset.exportFormat]) {
      if (state.format === format.dataset.exportFormat) return;
      state.format = format.dataset.exportFormat;
      state.scrollTop = 0;
      invalidateResult();
      render();
      return;
    }
    const settings = event.target.closest("[data-export-settings-view]");
    if (settings) {
      state.settingsView = settings.dataset.exportSettingsView;
      state.settingsTarget = settings.dataset.exportSettingsTarget || state.settingsView;
      state.scrollTop = 0;
      render();
      root.querySelector("[data-export-settings-back]")?.focus({ preventScroll: true });
      return;
    }
    if (event.target.closest("[data-export-settings-back]")) {
      leaveSettings();
      return;
    }
    const pdfSetting = event.target.closest("[data-export-pdf-setting]");
    if (pdfSetting && pdfSetting.dataset.exportPdfSetting in state.pdf) {
      state.pdf[pdfSetting.dataset.exportPdfSetting] = pdfSetting.dataset.value;
      invalidateResult();
      render();
      return;
    }
    const fullPreview = event.target.closest("[data-export-full-preview]");
    if (fullPreview) {
      void openFullPreview(fullPreview);
      return;
    }
    if (event.target.closest("[data-export-refresh]")) {
      if (state.mode === "batch") void ensureBatchDocuments({ force: true });
      else void ensureDocument({ force: true });
      return;
    }
    if (event.target.closest("[data-export-retry]")) {
      void ensureDocument({ force: true });
      return;
    }
    if (event.target.closest("[data-export-batch-retry]")) {
      // 来源丢失时先重读收藏/书签；不能原样重试一个注定失败的前置检查。
      void (async () => {
        const accountKey = data.accountKey;
        if (!batchSourcesReady()) {
          try { await reloadSources(); } catch { return; }
        }
        if (state.active && data.accountKey === accountKey) await ensureBatchDocuments({ force: true });
      })();
      return;
    }
    if (event.target.closest("[data-export-job-check]")) { void refreshJob(); return; }
    if (event.target.closest("[data-export-downloads]")) {
      void Promise.resolve().then(openDownloads).catch(() => onToast("bookmarkOpenFailed", true)); return;
    }
    if (event.target.closest("[data-export-action]")) void runDownload();
  });

  root.addEventListener("change", (event) => {
    const format = event.target.closest("[data-export-secondary-format]");
    if (format && FORMAT_META[format.value]) {
      state.format = format.value;
      invalidateResult();
      render();
      return;
    }
    const toggle = event.target.closest("[data-export-toggle]");
    if (!toggle) return;
    const key = toggle.dataset.exportToggle;
    const group = toggle.dataset.exportToggleGroup;
    if (group === "pdf" && key in state.pdf) state.pdf[key] = toggle.checked;
    else if (key in state.content) state.content[key] = toggle.checked;
    invalidateResult();
    render();
  });

  root.addEventListener("input", (event) => {
    const role = event.target.closest("[data-export-role]");
    if (role && role.dataset.exportRole in state.roleNames) {
      state.roleNames[role.dataset.exportRole] = role.value;
      invalidateResult();
      render();
      return;
    }
    const filename = event.target.closest("[data-export-filename]");
    if (filename) {
      const kind = filename.dataset.exportFilename;
      if (kind === "batch") {
        state.batchFilename = filename.value;
      } else if (kind === "batch-single") {
        state.batchSingleFilename = filename.value;
      } else {
        state.filename = filename.value;
        state.filenameTouched = true;
      }
      invalidateResult();
      // 文件名立即更新预览；保留输入节点本身，输入光标不会被重建打断。
      render();
    }
  });

  root.addEventListener("scroll", (event) => {
    if (event.target.matches?.("[data-export-scroll]")) state.scrollTop = event.target.scrollTop;
  }, true);

  // 用户在阅读结果时不抢走卡片；收起详情或移开后再给一整段阅读时间。
  root.addEventListener("toggle", event => {
    if (!event.target.matches?.("[data-export-job-warnings]")) return;
    jobs.setPresentation({ warningsOpen: event.target.open }); task = jobs.snapshot();
  }, true);
  for (const [type, key, inside] of [["pointerover", "pointerInside", true], ["pointerout", "pointerInside", false],
    ["focusin", "focusInside", true], ["focusout", "focusInside", false]]) {
    root.addEventListener(type, event => {
      const card = event.target.closest?.("[data-export-job]");
      if (!card || card.contains?.(event.relatedTarget)) return;
      jobs.setPresentation({ [key]: inside }); task = jobs.snapshot();
    });
  }
  document.addEventListener?.("visibilitychange", () => jobs.setPresentation({ documentHidden: document.hidden }));

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing) return;
    if (fullPreview.isOpen()) closeFullPreview({ restoreFocus: true });
    else if (state.settingsView) leaveSettings();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });



  selection.subscribe(event => {
    sources = selection.snapshot();
    if (!ready || updating) return;
    if (event.reason === "begin") {
      state.mode = "batch"; state.settingsView = null;
    }
    if (event.reason === "sources" && sources.accountKey !== contextInput.accountKey) {
      // Shell 先提交资料 owner，再提交页面上下文；不能用旧页面把新账号反写回去。
      onStateChange(); return;
    }
    if (event.reason === "begin" || event.basketChanged || event.reason === "sources") {
      updating = true;
      if (event.reason === "begin") documents.invalidateBatch({ clearError: true });
      syncReaders(); updating = false;
      invalidateResult(); refreshDerived();
    }
    render(); onStateChange();
    if (state.active && event.basketChanged && event.reason !== "sources") void ensureVisible();
  });
  data = documents.snapshot(); sources = selection.snapshot(); task = jobs.snapshot();
  ready = true;
  refreshDerived();

  return Object.freeze({
    updateContext, render, refreshJob, hasActiveJob: jobBusy,
    suspend(model = {}) {
      updating = true;
      updatePresentation(model);
      if (Object.hasOwn(model, "active")) state.active = Boolean(model.active);
      contextInput = { ...contextInput, verified: false };
      selection.suspend(); documents.suspend();
      jobs.updateOwner({ accountKey: data.accountKey, verified: false });
      fullPreview.close();
      updating = false; refreshDerived(); render();
    },
    retry: () => state.mode === "batch" ? ensureBatchDocuments({ force: true }) : ensureDocument({ force: true }),
    setMode,
    setSettingsView(view) { state.settingsView = view || null; state.scrollTop = 0; },
    handleFullPreviewClosed: fullPreview.handleClosed,
  });
}
