import { assertExpectedConversationContext } from "../../../platform/context-guard.js";
import { isValidTabId } from "../../../platform/navigation/panel-owner.js";
import { libraryError } from "../../../platform/session/background/request-binding.js";
import "../../../platform/protocol.js";

import { createExportGateway } from "../adapters/export-gateway.js";
import "../../../features/export/model/export-preview.js";

// Export requests retain selection membership, lease checks, resource handles and download ownership.
export function createExportHandler({ binding, pageGateway, library, catalog, exportJobs }) {
  const protocol = globalThis.TidyProtocol;
  const getBoundTab = binding.getBoundTab;
  const requestTabSnapshot = pageGateway.snapshot;
  const requestLibrarySnapshot = library.snapshot;
  const assertLibraryContext = library.assertCurrent;
  const readLibrary = library.read;
  const validateCatalogSelection = catalog.validate;
  const getExportJobService = exportJobs.get;
  const gateway = createExportGateway({ pageGateway });
  const requestCurrentConversationExport = gateway.current;
  const requestBatchConversationExport = gateway.batch;
  const requestTabExportPreview = gateway.preview;
  // 页面事件与用户点击之间仍有一个通知窗口。读取/新提交都检查刚取得的
  // 原生正信号；false 只是未观察到进行中，API 适配器仍有自己的读取检查。
  function assertResponseNotInProgress(snapshot) {
    if (snapshot?.adapter?.responseInProgress !== true) return;
    throw Object.assign(new Error("The current response is still in progress."), {
      tidyCode: protocol.ErrorCode.EXPORT_RESPONSE_PENDING,
    });
  }

  async function handle({ envelope, sender, libraryOwner, batchExportSelection }) {
    if ([protocol.Type.EXPORT_JOB_START, protocol.Type.EXPORT_JOB_STATUS, protocol.Type.EXPORT_JOB_CANCEL, protocol.Type.EXPORT_JOB_DISMISS].includes(envelope.type)) {
      const owner = { tabId: libraryOwner.tab.id, accountKey: libraryOwner.accountKey,
        documentId: libraryOwner.identity.documentId, epoch: libraryOwner.identity.epoch };
      const payload = envelope.payload || {};
      if (envelope.type === protocol.Type.EXPORT_JOB_STATUS) return getExportJobService().status(owner);
      if (envelope.type === protocol.Type.EXPORT_JOB_CANCEL) return getExportJobService().cancel(owner, payload.id);
      if (envelope.type === protocol.Type.EXPORT_JOB_DISMISS) return getExportJobService().dismiss(owner, payload.id);
      let currentSnapshot = null;
      if (payload.expectedConversationId) {
        const { snapshot } = await requestLibrarySnapshot(libraryOwner);
        currentSnapshot = snapshot;
        assertExpectedConversationContext(libraryOwner.tab, snapshot, { tabId: owner.tabId, conversationId: payload.expectedConversationId });
      }
      await assertLibraryContext(libraryOwner);
      assertResponseNotInProgress(currentSnapshot);
      return getExportJobService().start(owner, payload);
    }
    if (envelope.type === protocol.Type.EXPORT_IMAGE_RESOURCE) {
      const readHandle = envelope.payload?.readHandle;
      if (typeof readHandle !== "string" || !/^image-\d+-[a-z0-9]+$/.test(readHandle) || readHandle.length > 160) {
        throw libraryError("Invalid export resource handle.");
      }
      // 句柄仅用于同一页面内查找；权限仍来自绑定标签、账号及文档归属。
      const request = protocol.request(protocol.Type.EXPORT_IMAGE_RESOURCE, { readHandle });
      const response = await pageGateway.send(libraryOwner.tab.id, request, libraryOwner.identity.documentId);
      await assertLibraryContext(libraryOwner);
      if (!protocol.isResponse(response, request.requestId) || response.type !== request.type || !response.ok
        || response.payload?.readHandle !== readHandle) throw libraryError("The export resource changed.");
      return response.payload;
    }
    if (envelope.type === protocol.Type.EXPORT_CURRENT_CONVERSATION) {
      const payload = envelope.payload || {};
      if (!isValidTabId(payload.expectedTabId) || typeof payload.expectedConversationId !== "string" || !payload.expectedConversationId) {
        throw Object.assign(new Error("Current conversation export requires an exact tab and conversation."), {
          tidyCode: protocol.ErrorCode.INVALID_REQUEST,
        });
      }
      const tab = await getBoundTab(payload.expectedTabId, sender);
      const { snapshot } = await requestTabSnapshot(tab);
      assertExpectedConversationContext(tab, snapshot, {
        tabId: payload.expectedTabId,
        conversationId: payload.expectedConversationId,
      });
      if (
        snapshot.conversation.bindingStatus !== "bound"
        || snapshot.conversation.identityStatus !== "stable"
      ) {
        throw Object.assign(new Error("The current conversation is not stable enough to export."), {
          tidyCode: protocol.ErrorCode.EXPORT_UNAVAILABLE,
        });
      }
      if (snapshot.adapter?.responseInProgress === true) {
        // 先确认当前账号归属，避免把失效 owner 的失败误报成等待回复。
        await assertLibraryContext(libraryOwner);
        assertResponseNotInProgress(snapshot);
      }
      const result = await requestCurrentConversationExport(tab, {
        expectedConversationId: payload.expectedConversationId,
        fallbackTitle: snapshot.conversation.title.value,
      });
      await assertLibraryContext(libraryOwner);
      return result;
    }
    if (envelope.type === protocol.Type.EXPORT_CONVERSATIONS) {
      const payload = envelope.payload || {};
      const { conversationIds, bookmarkIds, searchSelection } = batchExportSelection;
      const searchRows = searchSelection
        ? await validateCatalogSelection(payload.expectedTabId, searchSelection, sender)
        : new Map();
      const [favorites, bookmarks] = await Promise.all([
        readLibrary("favorites", libraryOwner),
        readLibrary("bookmarks", libraryOwner),
      ]);
      const bookmarkItems = bookmarkIds.map((id) => bookmarks.items[id]).filter(Boolean);
      if (bookmarkItems.length !== bookmarkIds.length) {
        throw Object.assign(new Error("One or more selected bookmarks no longer exist."), {
          tidyCode: protocol.ErrorCode.NOT_FOUND,
        });
      }
      const allowedConversationIds = new Set([
        ...Object.keys(favorites.items || {}),
        ...bookmarkItems.map((bookmark) => bookmark.conversationId),
        ...searchRows.keys(),
      ]);
      if (conversationIds.some((id) => !allowedConversationIds.has(id))) {
        throw Object.assign(new Error("The selected conversation is no longer in Favorites, Bookmarks, or the verified date search selection."), {
          tidyCode: protocol.ErrorCode.NOT_FOUND,
        });
      }
      // 数据层缺失的标题保持为空；仅 UI/导出计划按当前语言生成默认名，不污染真实源标题。
      const fallbackTitles = Object.fromEntries(conversationIds.map((id) => [
        id,
        searchRows.get(id)?.title
          || favorites.items?.[id]?.title
          || bookmarkItems.find((bookmark) => bookmark.conversationId === id)?.conversationTitle
          || "",
      ]));
      const tab = await getBoundTab(payload.expectedTabId, sender);
      const result = await requestBatchConversationExport(tab, { conversationIds, fallbackTitles });
      await assertLibraryContext(libraryOwner);
      return result;
    }
    if ([protocol.Type.EXPORT_PREVIEW_OPEN, protocol.Type.EXPORT_PREVIEW_CLOSE].includes(envelope.type)) {
      const payload = envelope.payload || {};
      if (!isValidTabId(payload.expectedTabId) || typeof payload.sessionId !== "string" || !payload.sessionId) {
        throw Object.assign(new Error("Export preview requires an exact tab and session."), {
          tidyCode: protocol.ErrorCode.INVALID_REQUEST,
        });
      }
      const tab = await getBoundTab(payload.expectedTabId, sender);
      if (envelope.type === protocol.Type.EXPORT_PREVIEW_OPEN) {
        const previewMode = payload.mode === "batch" ? "batch" : "current";
        if (
          (previewMode === "current"
            ? (typeof payload.expectedConversationId !== "string" || !payload.expectedConversationId)
            : payload.expectedConversationId != null)
          || typeof payload.title !== "string"
          || typeof payload.closeLabel !== "string"
          || typeof payload.summary !== "string"
          || typeof payload.content !== "string"
          || (payload.format === "pdf" && !globalThis.TidyExportPreview.valid(payload.previewParts))
        ) {
          throw Object.assign(new Error("The export preview payload is invalid."), {
            tidyCode: protocol.ErrorCode.INVALID_REQUEST,
          });
        }
        if (previewMode === "current") {
          const { snapshot } = await requestTabSnapshot(tab);
          assertExpectedConversationContext(tab, snapshot, {
            tabId: payload.expectedTabId,
            conversationId: payload.expectedConversationId,
          });
        }
      }
      if (libraryOwner) await assertLibraryContext(libraryOwner);
      return requestTabExportPreview(tab, envelope.type, payload);
    }
  }

  return Object.freeze({ types: Object.freeze([protocol.Type.EXPORT_JOB_START, protocol.Type.EXPORT_JOB_STATUS, protocol.Type.EXPORT_JOB_CANCEL, protocol.Type.EXPORT_JOB_DISMISS, protocol.Type.EXPORT_IMAGE_RESOURCE, protocol.Type.EXPORT_CURRENT_CONVERSATION, protocol.Type.EXPORT_CONVERSATIONS, protocol.Type.EXPORT_PREVIEW_OPEN, protocol.Type.EXPORT_PREVIEW_CLOSE]), handle });
}
