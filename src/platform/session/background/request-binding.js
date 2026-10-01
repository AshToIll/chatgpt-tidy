import { isValidTabId, parsePanelOwnerTabId } from "../../navigation/panel-owner.js";
import "../../protocol.js";

const protocol = globalThis.TidyProtocol;

// URL 分类沿用原有规则；精确路由、文档和账号权限在各自边界继续核验。
export function isChatgptUrl(value) {
  try {
    const url = new URL(value || "");
    return url.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

export function libraryError(message) {
  return Object.assign(new Error(message), { tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH });
}

/**
 * 将请求绑定到明确标签、面板和资料归属，不查询活动标签或创建账号缓存。
 * libraryIdentity 是唯一账号/文档所有者；这里只组合它签发的现有凭证。
 */
export function createRequestBinding({ chrome, libraryIdentity }) {
  const SIDE_PANEL_BASE_URL = chrome.runtime.getURL("app/sidepanel/index.html");
  const { readAccount: readLibraryAccount } = libraryIdentity;

  function isSidePanelDocumentUrl(value) {
    try {
      const candidate = new URL(value || "");
      const expected = new URL(SIDE_PANEL_BASE_URL);
      // chrome-extension: is a non-special URL scheme and some URL runtimes
      // serialize its origin as "null". Compare the actual routing parts.
      return candidate.protocol === expected.protocol
        && candidate.host === expected.host
        && candidate.pathname === expected.pathname;
    } catch {
      return false;
    }
  }

  async function getBoundTab(expectedTabId, sender = null) {
    const senderTabId = isValidTabId(sender?.tab?.id) ? sender.tab.id : null;
    const panelOwnerTabId = isSidePanelDocumentUrl(sender?.url)
      ? parsePanelOwnerTabId(sender.url, SIDE_PANEL_BASE_URL)
      : null;
    const bindingIds = [expectedTabId, panelOwnerTabId, senderTabId].filter(isValidTabId);
    const uniqueBindingIds = [...new Set(bindingIds)];
    if (uniqueBindingIds.length > 1) {
      throw Object.assign(new Error("The Side Panel tab binding changed."), {
        tidyCode: protocol.ErrorCode.TAB_UNAVAILABLE,
        stage: "service-worker.resolve-tab",
      });
    }

    // Extension pages do not have MessageSender.tab. A Side Panel therefore
    // proves ownership with its unique configured URL, while content scripts use
    // their sender tab. No focus-dependent active-tab fallback is permitted.
    if (isSidePanelDocumentUrl(sender?.url) && !isValidTabId(panelOwnerTabId)) {
      throw Object.assign(new Error("The Side Panel owner is invalid."), {
        tidyCode: protocol.ErrorCode.TAB_UNAVAILABLE,
        stage: "service-worker.resolve-tab",
      });
    }
    const tabId = isValidTabId(expectedTabId)
      ? expectedTabId
      : isValidTabId(panelOwnerTabId)
        ? panelOwnerTabId
        : isValidTabId(senderTabId)
          ? senderTabId
          : null;
    if (!isValidTabId(tabId)) {
      throw Object.assign(new Error("The Side Panel is not bound to a ChatGPT tab."), {
        tidyCode: protocol.ErrorCode.TAB_UNAVAILABLE,
        stage: "service-worker.resolve-tab",
      });
    }

    if (isValidTabId(panelOwnerTabId)) {
      try {
        const options = await chrome.sidePanel.getOptions({ tabId });
        const configuredOwnerTabId = parsePanelOwnerTabId(
          new URL(options?.path || "", chrome.runtime.getURL("/")).href,
          SIDE_PANEL_BASE_URL,
        );
        if (!options?.enabled || configuredOwnerTabId !== tabId) {
          throw new Error("The configured Side Panel owner changed.");
        }
      } catch (error) {
        throw Object.assign(new Error("The Side Panel configuration is unavailable."), {
          tidyCode: protocol.ErrorCode.TAB_UNAVAILABLE,
          stage: "service-worker.resolve-panel-options",
          cause: error,
        });
      }
    }

    try {
      // Search is initiated by a tab-bound Side Panel. Resolving that exact tab
      // avoids reinterpreting `currentWindow` after DevTools or another Chrome
      // window takes focus, while still failing closed if the tab disappeared.
      const tab = await chrome.tabs.get(tabId);
      if (!isValidTabId(tab?.id) || tab.id !== tabId) {
        throw new Error("The Side Panel tab binding changed.");
      }
      return tab;
    } catch (error) {
      throw Object.assign(new Error("The ChatGPT tab is no longer available."), {
        tidyCode: protocol.ErrorCode.TAB_UNAVAILABLE,
        stage: "service-worker.resolve-tab",
        cause: error,
      });
    }
  }

  async function libraryContext(payload, sender, { requireExpected, requireIdentity, retryIdentity }) {
    if (!isSidePanelDocumentUrl(sender?.url) && !(isValidTabId(sender?.tab?.id) && isChatgptUrl(sender.tab.url))) {
      throw libraryError("Library operations require the owner panel or ChatGPT content script.");
    }
    const tab = await getBoundTab(payload?.expectedTabId, sender);
    if (requireIdentity && (!payload?.expectedIdentity?.documentId
      || !Number.isInteger(payload.expectedIdentity.epoch) || payload.expectedIdentity.epoch < 0)) {
      throw libraryError("This library action needs the current document's identity lease.");
    }
    const owner = await readLibraryAccount(tab, { retry: retryIdentity });
    const { accountKey, identity } = owner;
    const expected = payload?.expectedAccountKey;
    if ((requireExpected && (typeof expected !== "string" || !expected)) || (expected != null && expected !== accountKey)) {
      throw libraryError("The ChatGPT account changed. Reload this account's library before continuing.");
    }
    if ((sender?.tab && (sender.frameId !== 0 || sender.documentId !== identity.documentId))
      || (payload?.expectedIdentity && (payload.expectedIdentity.documentId !== identity.documentId
        || payload.expectedIdentity.epoch !== identity.epoch))) {
      throw libraryError("This library action belongs to a previous ChatGPT document or identity.");
    }
    return { tab, sender, ...owner };
  }

  function navigationSenderTab(payload, sender, requireIdentity = false) {
    const identity = payload?.expectedIdentity;
    const panelTabId = isSidePanelDocumentUrl(sender?.url) ? parsePanelOwnerTabId(sender.url, SIDE_PANEL_BASE_URL) : null;
    const contentTabId = isValidTabId(sender?.tab?.id) && isChatgptUrl(sender.tab.url)
      && isChatgptUrl(sender.url) && sender.frameId === 0 && sender.documentLifecycle === "active"
      && (!requireIdentity || sender.documentId === identity?.documentId) ? sender.tab.id : null;
    const tabId = sender?.tab ? contentTabId : panelTabId;
    if (!isValidTabId(tabId) || (payload?.expectedTabId != null && payload.expectedTabId !== tabId)) {
      throw libraryError("This navigation needs its exact sender tab.");
    }
    return tabId;
  }

  return Object.freeze({
    getBoundTab, libraryContext, navigationSenderTab, isChatgptUrl, isSidePanelDocumentUrl,
    panelOwnerTabId: url => parsePanelOwnerTabId(url, SIDE_PANEL_BASE_URL),
  });
}
