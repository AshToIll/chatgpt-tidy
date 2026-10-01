import { assertAccountKey } from "../../storage/database.js";
import { isValidTabId } from "../../navigation/panel-owner.js";

function hasAccount(accountKey) {
  try { assertAccountKey(accountKey); return true; }
  catch { return false; }
}

// One lifecycle implementation for Favorites and Bookmarks. A filing target
// belongs to an exact Port + tab + authenticated account, not just a folder ID.
export function createFilingContextRegistry() {
  const targetByTab = new Map();
  const tabByOwner = new Map();

  function clear(owner) {
    const tabId = tabByOwner.get(owner);
    if (!isValidTabId(tabId)) return;
    if (targetByTab.get(tabId)?.owner === owner) targetByTab.delete(tabId);
    tabByOwner.delete(owner);
  }

  function update(owner, { tabId = null, accountKey = null, groupId = null } = {}) {
    // Missing identity also revokes a previously valid destination. A stale
    // folder cannot remain active while the account is being re-observed.
    clear(owner);
    if (!isValidTabId(tabId) || !hasAccount(accountKey)
      || typeof groupId !== "string" || !groupId || groupId.trim() !== groupId) return;
    const displaced = targetByTab.get(tabId);
    if (displaced?.owner && displaced.owner !== owner) tabByOwner.delete(displaced.owner);
    targetByTab.set(tabId, { owner, accountKey, groupId });
    tabByOwner.set(owner, tabId);
  }

  function groupIdForTab(tabId, accountKey) {
    if (!isValidTabId(tabId) || !hasAccount(accountKey)) return null;
    const target = targetByTab.get(tabId);
    return target?.accountKey === accountKey ? target.groupId : null;
  }

  return Object.freeze({ update, clear, groupIdForTab });
}
