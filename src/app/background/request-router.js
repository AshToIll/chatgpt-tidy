import { pageSessionRequestPolicy } from "../../platform/session/background/page-session.js";
import { isValidTabId } from "../../platform/navigation/panel-owner.js";
import { isChatgptUrl, libraryError } from "../../platform/session/background/request-binding.js";
import { libraryRequestPolicy } from "./request-policy.js";
import { normalizeBatchExportSelection } from "./export-selection.js";
import "../../platform/protocol.js";

// Ordered admission pipeline: sender -> pure shape -> intent -> user gesture -> page -> account -> feature.
// Per-request context carries only immutable ownership evidence and the current intent, never worker state.
export function createRequestRouter({ binding, pageSession, navigation, panelHost, handlers }) {
  const protocol = globalThis.TidyProtocol;
  const getBoundTab = binding.getBoundTab;
  const isSidePanelDocumentUrl = binding.isSidePanelDocumentUrl;
  const routes = new Map();
  for (const handler of handlers) {
    for (const type of handler.types) {
      if (routes.has(type)) throw new Error(`Duplicate background request owner: ${type}`);
      routes.set(type, handler.handle);
    }
  }
  async function handleRequest(envelope, sender = null) {
    if ([protocol.Type.LIBRARY_BACKUP_EXPORT, protocol.Type.LIBRARY_BACKUP_PREVIEW,
      protocol.Type.LIBRARY_BACKUP_RESTORE, protocol.Type.LIBRARY_BACKUP_DISCARD].includes(envelope.type)
      && !isSidePanelDocumentUrl(sender?.url)) throw libraryError("Library backups require the owner side panel.");
    if ([protocol.Type.EXPORT_JOB_START, protocol.Type.EXPORT_JOB_STATUS, protocol.Type.EXPORT_JOB_CANCEL, protocol.Type.EXPORT_JOB_DISMISS].includes(envelope.type)
      && !isSidePanelDocumentUrl(sender?.url)) throw libraryError("Export jobs require the owner side panel.");
    // Pure selection validation precedes identity/network reads. A malformed
    // request must not consume account traffic or start any library/catalog I/O.
    const batchExportSelection = envelope.type === protocol.Type.EXPORT_CONVERSATIONS
      ? normalizeBatchExportSelection(envelope.payload || {}) : null;
    const navigationHandle = [protocol.Type.SEARCH_OPEN_RESULT, protocol.Type.FAVORITES_OPEN, protocol.Type.BOOKMARKS_OPEN,
      protocol.Type.BOOKMARKS_OPEN_CONVERSATION_VIEW].includes(envelope.type) ? navigation.begin(envelope, sender) : null;
    try {
      // 打开侧栏必须消费原点击手势，不能等 IPC 后再调用；其余业务仍先经过页面准入。
      if (envelope.type === protocol.Type.BOOKMARKS_OPEN_CONVERSATION_VIEW) {
        if (!isValidTabId(sender?.tab?.id) || !isChatgptUrl(sender.tab.url)) throw libraryError("Open bookmarks from the bound ChatGPT page.");
        await panelHost.open(sender.tab.id);
        navigation.assertCurrent(navigationHandle);
      }
      const pagePolicy = pageSessionRequestPolicy(envelope.type);
      if (!pagePolicy) throw Object.assign(new Error("Unsupported extension command."), { tidyCode: protocol.ErrorCode.UNSUPPORTED_TYPE });
      if (pagePolicy !== "control") {
        const tab = await getBoundTab(envelope.payload?.expectedTabId, sender);
        const session = await pageSession.assert(tab, { expectedDocumentId: sender?.tab ? sender.documentId : null });
        if (pagePolicy === "probe") return session;
        if (navigationHandle) navigation.assertCurrent(navigationHandle);
      }
      return await dispatchRequest(envelope, sender, navigationHandle, batchExportSelection);
    } catch (error) {
      // Failed admission/transport already returns an explicit error to its
      // caller. Retire the same command and its timer, not a second later toast.
      if (navigationHandle) navigation.fail(navigationHandle);
      throw error;
    }
  }

  async function dispatchRequest(envelope, sender, navigationHandle, batchExportSelection) {
    const libraryPolicy = libraryRequestPolicy(envelope.type);
    const libraryOwner = libraryPolicy ? await binding.libraryContext(envelope.payload, sender, {
      ...libraryPolicy,
      retryIdentity: envelope.type === protocol.Type.LIBRARY_GET
        && isSidePanelDocumentUrl(sender?.url) && envelope.payload?.retryIdentity === true,
    }) : null;
    if (navigationHandle) {
      navigation.assertCurrent(navigationHandle);
      if (libraryOwner) {
        libraryOwner.navigationHandle = navigationHandle;
        await navigation.prepare(navigationHandle, libraryOwner.tab, libraryOwner.identity);
      }
    }
    const handle = routes.get(envelope.type);
    if (!handle) throw Object.assign(new Error(`Unsupported request type: ${envelope.type}`), {
      tidyCode: protocol.ErrorCode.UNSUPPORTED_TYPE,
    });
    return handle({ envelope, sender, libraryOwner, navigationHandle, batchExportSelection });
  }

  return Object.freeze({ handle: handleRequest });
}
