import { PREFERENCES_KEY } from "../../platform/preferences/preferences.js";
import { isValidTabId } from "../../platform/navigation/panel-owner.js";
import "../../platform/protocol.js";

// Browser events own document/tab lifetimes, not feature protocol dispatch.
// No registration side effects: the service-worker registers every listener synchronously.
export function createBrowserLifecycle({ chrome, binding, navigation, identity, libraryHandler, exportJobs, panelHost, pageGateway }) {
  async function updated(tabId, changeInfo, tab) {
    if (changeInfo.url || changeInfo.status === "complete") {
      try {
        await panelHost.configure(tabId, changeInfo.url || tab.url);
        if (changeInfo.status === "complete" && binding.isChatgptUrl(changeInfo.url || tab.url)) {
          // Installation can miss document_start in an already-loading tab. Completion wakes the bounded handshake.
          const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
          if (frame?.documentId && frame.documentLifecycle === "active" && binding.isChatgptUrl(frame.url)) {
            panelHost.publishContext({ tabId, url: frame.url, documentId: frame.documentId }, "document-load-complete");
          }
        }
      } catch (error) { panelHost.reportError(error, "updated", tabId); }
    }
  }
  async function activated({ tabId }) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await panelHost.configure(tabId, tab.url);
    } catch (error) { panelHost.reportError(error, "activated", tabId); }
  }
  function history(details) {
    if (details.frameId !== 0 || !isValidTabId(details.tabId)
      || (details.documentLifecycle && details.documentLifecycle !== "active")) return;
    navigation.observeRoute(details);
    panelHost.publishContext(details, "spa-route");
  }
  function committed(details) {
    if (details.frameId !== 0 || !isValidTabId(details.tabId) || details.documentLifecycle !== "active") return;
    // Retire navigation first, then publish the document identity and revoke owned resources.
    navigation.committed(details);
    identity.committed(details);
    libraryHandler.revoke(details.tabId);
    void exportJobs.revoke(details.tabId).catch(() => {});
    panelHost.publishContext(details, "document-committed");
  }
  function storageChanged(changes, areaName) {
    if (areaName !== "sync" || !changes[PREFERENCES_KEY]) return;
    const envelope = globalThis.TidyProtocol.event(globalThis.TidyProtocol.Type.PREFERENCES_UPDATED, changes[PREFERENCES_KEY].newValue);
    // Extension pages and existing content scripts use separate browser delivery channels.
    chrome.runtime.sendMessage(envelope).catch(() => {});
    void pageGateway.broadcast(envelope);
  }
  function removed(tabId) {
    void exportJobs.revoke(tabId).catch(() => {});
    navigation.closeTab(tabId);
    panelHost.closeTab(tabId);
    identity.closeTab(tabId);
    libraryHandler.revoke(tabId);
  }

  return Object.freeze({ updated, activated, history, committed, storageChanged, removed });
}
