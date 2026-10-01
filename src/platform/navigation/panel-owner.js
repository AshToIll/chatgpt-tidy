export const PANEL_TAB_ID_PARAM = "tidyTabId";

const PANEL_PATHNAME = "/app/sidepanel/index.html";

/**
 * Chrome reserves -1 for contexts that are not owned by a tab. TIDY panels
 * always belong to one concrete ChatGPT tab, so only non-negative safe
 * integers may cross the panel/background boundary.
 */
export function isValidTabId(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

/**
 * Give every tab-scoped Side Panel instance an explicit, immutable owner.
 * The query parameter is routing metadata; the background worker still
 * verifies it against Chrome's configured panel options before using it.
 */
export function createSidePanelPath(tabId) {
  if (!isValidTabId(tabId)) {
    throw new TypeError("A Side Panel owner must be a non-negative safe integer.");
  }
  return `app/sidepanel/index.html?${PANEL_TAB_ID_PARAM}=${tabId}`;
}

/**
 * Parse only the exact production Side Panel URL shape. Rejecting duplicate,
 * additional, or loosely formatted parameters keeps panel ownership
 * deterministic and makes configuration drift fail closed.
 */
export function parsePanelOwnerTabId(value, expectedBaseUrl) {
  try {
    if (typeof value !== "string" || typeof expectedBaseUrl !== "string") return null;
    const expected = new URL(expectedBaseUrl);
    const candidate = new URL(value);

    if (
      expected.protocol !== "chrome-extension:"
      || expected.pathname !== PANEL_PATHNAME
      || expected.search
      || expected.hash
      || expected.href !== expectedBaseUrl
    ) return null;

    if (candidate.pathname !== PANEL_PATHNAME || candidate.hash) return null;
    // Non-special schemes such as chrome-extension: may expose a serialized
    // origin of "null", so compare their scheme and host explicitly.
    if (
      expectedBaseUrl &&
      (candidate.protocol !== expected.protocol || candidate.host !== expected.host)
    ) return null;

    const entries = [...candidate.searchParams.entries()];
    if (entries.length !== 1 || entries[0][0] !== PANEL_TAB_ID_PARAM) return null;

    const rawTabId = entries[0][1];
    if (!/^(0|[1-9]\d*)$/.test(rawTabId)) return null;
    const tabId = Number(rawTabId);
    if (!isValidTabId(tabId)) return null;

    // Only accept the one URL Chrome receives from createSidePanelPath().
    // This rejects relative, encoded, normalized, or decorated lookalikes.
    const canonical = new URL(expected.href);
    canonical.search = `?${PANEL_TAB_ID_PARAM}=${tabId}`;
    return value === candidate.href && candidate.href === canonical.href ? tabId : null;
  } catch {
    return null;
  }
}
