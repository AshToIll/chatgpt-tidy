import "../../platform/protocol.js";
const protocol = globalThis.TidyProtocol;

// Reads discover an owner; exports require that owner; library actions also
// require the current document lease. Keep the three policies disjoint and
// explicit: a new protocol name must not acquire authority from its prefix.
const LIBRARY_READ_TYPES = new Set([
  protocol.Type.LIBRARY_ACCOUNT, protocol.Type.LIBRARY_GET,
  protocol.Type.FAVORITES_GET, protocol.Type.BOOKMARKS_GET,
]);
const LIBRARY_EXPORT_TYPES = new Set([
  protocol.Type.EXPORT_CURRENT_CONVERSATION, protocol.Type.EXPORT_CONVERSATIONS, protocol.Type.EXPORT_PREVIEW_OPEN,
  protocol.Type.EXPORT_IMAGE_RESOURCE,
  protocol.Type.EXPORT_JOB_START, protocol.Type.EXPORT_JOB_STATUS, protocol.Type.EXPORT_JOB_CANCEL, protocol.Type.EXPORT_JOB_DISMISS,
]);
const LIBRARY_ACTION_TYPES = new Set([
  protocol.Type.LIBRARY_BACKUP_EXPORT, protocol.Type.LIBRARY_BACKUP_PREVIEW,
  protocol.Type.LIBRARY_BACKUP_RESTORE, protocol.Type.LIBRARY_BACKUP_DISCARD,
  protocol.Type.FAVORITES_TOGGLE_CURRENT, protocol.Type.FAVORITES_TOGGLE_SIDEBAR,
  protocol.Type.FAVORITES_REMOVE, protocol.Type.FAVORITES_MOVE,
  protocol.Type.FAVORITES_GROUP_CREATE, protocol.Type.FAVORITES_GROUP_UPDATE,
  protocol.Type.FAVORITES_GROUP_DELETE, protocol.Type.FAVORITES_GROUP_REORDER,
  protocol.Type.FAVORITES_VIEW_UPDATE, protocol.Type.FAVORITES_OPEN,
  protocol.Type.FAVORITES_FILING_CONTEXT,
  protocol.Type.BOOKMARKS_TOGGLE_CURRENT, protocol.Type.BOOKMARKS_REMOVE,
  protocol.Type.BOOKMARKS_MOVE,
  protocol.Type.BOOKMARKS_GROUP_CREATE, protocol.Type.BOOKMARKS_GROUP_UPDATE,
  protocol.Type.BOOKMARKS_GROUP_DELETE, protocol.Type.BOOKMARKS_GROUP_REORDER,
  protocol.Type.BOOKMARKS_VIEW_UPDATE, protocol.Type.BOOKMARKS_OPEN,
  protocol.Type.BOOKMARKS_FILING_CONTEXT, protocol.Type.BOOKMARKS_OPEN_CONVERSATION_VIEW,
]);

export function libraryRequestPolicy(type) {
  if (LIBRARY_READ_TYPES.has(type)) return { requireExpected: false, requireIdentity: false };
  if (LIBRARY_EXPORT_TYPES.has(type)) return { requireExpected: true, requireIdentity: false };
  if (LIBRARY_ACTION_TYPES.has(type)) return { requireExpected: true, requireIdentity: true };
  return null;
}
