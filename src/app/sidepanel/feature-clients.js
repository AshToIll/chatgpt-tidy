/** 明确的功能请求适配表。只加固定标签地址，不推断账号，不代替业务状态 owner。 */
export function createFeatureClients({ request, ownerTabId, protocol }) {
  function bound(type, payload = {}) {
    if (!type) throw new TypeError("Unsupported feature operation");
    return request(type, { ...payload, expectedTabId: ownerTabId });
  }
  const titleTypes = Object.freeze({
    preview: protocol.Type.TITLE_PREVIEW, replan: protocol.Type.TITLE_REPLAN,
    apply: protocol.Type.TITLE_APPLY, status: protocol.Type.TITLE_STATUS, reconcile: protocol.Type.TITLE_RECONCILE,
    "batch-preview": protocol.Type.TITLE_BATCH_PREVIEW, "batch-retry-preview": protocol.Type.TITLE_BATCH_RETRY_PREVIEW,
    "batch-replan": protocol.Type.TITLE_BATCH_REPLAN, "batch-apply": protocol.Type.TITLE_BATCH_APPLY,
    "batch-step": protocol.Type.TITLE_BATCH_STEP, "batch-status": protocol.Type.TITLE_BATCH_STATUS,
    "batch-reconcile": protocol.Type.TITLE_BATCH_RECONCILE, "return-owner": protocol.Type.TITLE_RETURN_OWNER,
  });
  const jobTypes = Object.freeze({ start: protocol.Type.EXPORT_JOB_START, status: protocol.Type.EXPORT_JOB_STATUS,
    cancel: protocol.Type.EXPORT_JOB_CANCEL, dismiss: protocol.Type.EXPORT_JOB_DISMISS });
  const backupTypes = Object.freeze({ export: protocol.Type.LIBRARY_BACKUP_EXPORT, preview: protocol.Type.LIBRARY_BACKUP_PREVIEW,
    restore: protocol.Type.LIBRARY_BACKUP_RESTORE, discard: protocol.Type.LIBRARY_BACKUP_DISCARD });
  const dateTypes = Object.freeze({ account: protocol.Type.DATE_INDEX_ACCOUNT, "source-page": protocol.Type.DATE_INDEX_SOURCE_PAGE });
  const select = (mapping, action) => Object.hasOwn(mapping, action) ? mapping[action] : null;
  return Object.freeze({
    // View 提交的会话/身份必须原样保留，不能被最新快照替换。
    titles: (action, payload) => bound(select(titleTypes, action), payload),
    dateCatalog: (action, payload) => bound(select(dateTypes, action), payload),
    exportResource: payload => bound(protocol.Type.EXPORT_IMAGE_RESOURCE, payload),
    exportJob: (action, payload) => bound(select(jobTypes, action), payload),
    exportDocument: payload => bound(protocol.Type.EXPORT_CURRENT_CONVERSATION, payload),
    exportDocuments: payload => bound(protocol.Type.EXPORT_CONVERSATIONS, payload),
    presentPreview: payload => bound(protocol.Type.EXPORT_PREVIEW_OPEN, payload),
    dismissPreview: ({ sessionId }) => bound(protocol.Type.EXPORT_PREVIEW_CLOSE, { sessionId }),
    library: ({ retryIdentity = false, expectedAccountKey, expectedIdentity } = {}) => bound(protocol.Type.LIBRARY_GET, {
      ...(retryIdentity ? { retryIdentity: true } : {}), ...(expectedIdentity ? { expectedAccountKey, expectedIdentity } : {}),
    }),
    backup: (action, payload, owner) => bound(select(backupTypes, action), { ...payload,
      expectedAccountKey: owner.accountKey, expectedIdentity: owner.identity }),
    bookmarkOpen: (target, owner) => bound(protocol.Type.BOOKMARKS_OPEN, {
      navigationIntentId: target.navigationIntentId, bookmarkId: target.bookmarkId,
      expectedAccountKey: owner.accountKey, expectedIdentity: owner.identity,
    }),
  });
}
