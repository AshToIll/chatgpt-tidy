import { getPreferences, updatePreferences } from "../../../platform/preferences/preferences.js";
import "../../../platform/protocol.js";

export function createPreferencesHandler({ binding, pageGateway, panelHost }) {
  const protocol = globalThis.TidyProtocol;
  async function handle({ envelope, sender }) {
    if (envelope.type === protocol.Type.PREFERENCES_GET) return getPreferences();
    if (envelope.type === protocol.Type.PREFERENCES_UPDATE) return updatePreferences(envelope.payload || {});
    const tab = await binding.getBoundTab(envelope.payload?.expectedTabId, sender);
    const { snapshot } = await pageGateway.snapshot(tab);
    // A snapshot proves a conversation, not an account. Startup never refreshes library metadata.
    // A failed snapshot must not consume the pending route from its owner panel.
    const requestedRoute = panelHost.takeRoute(tab.id, sender);
    return { tab: { id: tab.id, windowId: tab.windowId, title: tab.title || null, url: tab.url || null },
      snapshot, ...(requestedRoute ? { requestedRoute } : {}) };
  }

  return Object.freeze({ types: Object.freeze([protocol.Type.PREFERENCES_GET, protocol.Type.PREFERENCES_UPDATE, protocol.Type.GET_ACTIVE_CONTEXT]), handle });
}
