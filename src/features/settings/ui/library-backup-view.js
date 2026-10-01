import "../../../messages/notice-lifecycle.js";
import { LIBRARY_BACKUP_LIMITS, backupError } from "../model/library-backup-format.js";

const errorKeys = Object.freeze({ BACKUP_INVALID: "backupInvalid", BACKUP_TOO_LARGE: "backupTooLarge",
  BACKUP_FILE_TOO_LARGE: "backupFileTooLarge",
  BACKUP_VERSION: "backupVersion", BACKUP_ACCOUNT_MISMATCH: "backupAccountMismatch",
  BACKUP_EXPIRED: "backupExpired", BACKUP_CHANGED: "backupChanged", CONTEXT_MISMATCH: "backupOwnerChanged" });

export async function downloadLibraryBackup({ text, filename }, { downloads = chrome.downloads, urls = URL } = {}) {
  const url = urls.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  let downloadId, released = false;
  const release = () => {
    if (released) return;
    released = true; downloads.onChanged.removeListener(changed); urls.revokeObjectURL(url);
  };
  const changed = delta => {
    if (delta.id === downloadId && ["complete", "interrupted"].includes(delta.state?.current)) release();
  };
  try {
    // 每次让用户选择位置和文件名；等待选择期间保留文件，不按固定秒数提前销毁。
    downloadId = await downloads.download({ url, filename, saveAs: true, conflictAction: "uniquify" });
    if (!Number.isInteger(downloadId)) throw new Error("Missing backup download receipt");
    downloads.onChanged.addListener(changed);
    // 小备份可能在回执到达前已经下载完；查询补上这段事件空窗。
    // 查询暂时失败时仍保留监听，不能因此提前释放正在保存的文件。
    const items = await downloads.search({ id: downloadId }).catch(() => []);
    if (items.some(item => ["complete", "interrupted"].includes(item.state))) release();
    return true; // 只表示浏览器已接收，不宣称已落盘。
  } catch (error) {
    release();
    if (/cancel/i.test(error?.message || "")) return false;
    throw error;
  }
}

// 静态节点只创建一次。刷新账号状态、切换语言或主题不会重建文件控件，也不会吞掉焦点。
export function createLibraryBackupView({ root, captureOwner, isCurrent, request, onRestored,
  toast, translate, download = downloadLibraryBackup, connection = () => ({}), reconnect = async () => {}, checkLibrary = () => {} }) {
  root.innerHTML = `<h2 data-backup-label="backupTitle"></h2>
    <p data-backup-label="backupScope"></p>
    <div class="library-backup__actions"><button type="button" data-backup-export data-backup-label="backupExport"></button>
      <button type="button" data-backup-choose data-backup-label="backupImport"></button></div>
    <input type="file" accept=".json,application/json" data-backup-file hidden />
    <p data-backup-status role="status" aria-live="polite" hidden></p>
    <button type="button" data-backup-retry hidden></button>
    <p data-backup-recovery data-backup-label="backupRestoreCheckHint" hidden></p>
    <button type="button" data-backup-checked data-backup-label="backupRestoreChecked" hidden></button>
    <div class="library-backup__preview" data-backup-preview hidden>
      <p data-backup-filename></p><p data-backup-counts></p><p data-backup-skipped></p>
      <div class="library-backup__actions"><button type="button" data-backup-confirm data-backup-label="backupConfirm"></button>
        <button type="button" data-backup-cancel data-backup-label="cancel"></button></div>
    </div>`;
  const el = name => root.querySelector(`[data-backup-${name}]`);
  let active = false, disposed = false, operation = 0, owner = null, fileOwner = null;
  let busy = null, preview = null, filename = "", errorKey = null, downloadPending = false;
  let observedFailure = null; // 仅诊断字段，不加入业务状态或备份数据。

  // 提交后的恢复按账号持有，不属于文件预览，也不属于当前栏目显示权。
  // 此账本仅覆盖当前 sidepanel 文档；跨关闭/重载需后台持久回执，不能假装已支持。
  const restores = new Map();
  const restoreForAccount = () => restores.get(captureOwner()?.accountKey) || null;
  const restoreBlocksImport = () => ["pending", "unknown"].includes(restoreForAccount()?.phase);
  function ownsRestore(entry) {
    return !disposed && restores.get(entry.owner.accountKey) === entry && entry.lifetime.owns(entry.token);
  }
  function clearRestore(entry) {
    if (!entry || restores.get(entry.owner.accountKey) !== entry) return;
    entry.lifetime.dispose();
    restores.delete(entry.owner.accountKey);
  }
  function clearSettledRestore() {
    const entry = restoreForAccount();
    if (entry && !["pending", "unknown"].includes(entry.phase)) clearRestore(entry);
  }

  // 这里只清理未提交的栏目工作。已派发恢复不共享 operation，不会被隐藏/重绘作废。
  function forget() {
    observedFailure = null;
    const previous = preview, previousOwner = owner;
    operation++; busy = null; preview = null; filename = ""; errorKey = null; owner = null; fileOwner = null;
    el("file").value = "";
    if (previous && previousOwner && isCurrent(previousOwner)) {
      void request("discard", { previewId: previous.id }, previousOwner).catch(() => {});
    }
  }
  function update() {
    if (disposed) return;
    if ((owner && !isCurrent(owner)) || (fileOwner && !isCurrent(fileOwner))) forget();
    for (const node of root.querySelectorAll("[data-backup-label]")) node.textContent = translate(node.dataset.backupLabel);
    const ready = Boolean(captureOwner()?.accountKey), restoreEntry = restoreForAccount();
    const restoring = restoreEntry?.phase === "pending", unknown = restoreEntry?.phase === "unknown";
    el("export").disabled = !active || !ready || Boolean(busy) || downloadPending || restoring;
    el("choose").disabled = !active || !ready || Boolean(busy) || downloadPending || restoring || unknown;
    el("confirm").disabled = !preview || Boolean(busy) || restoring || unknown;
    el("cancel").disabled = Boolean(busy) || restoring;
    el("file").setAttribute("aria-label", translate("backupImport"));
    const progress = restoring ? "backupRestoring" : busy || (downloadPending ? "backupSaving" : null);
    const connectionState = !ready ? connection() : null;
    const connectionError = connectionState?.error;
    const recovery = connectionError ? globalThis.TidyLibraryHydration?.errorPresentation(connectionError, "exportAccountRequired")
      || { messageKey: "exportAccountRequired", retryable: true } : null;
    // 未确认写入始终是主状态；允许安全的只读导出，但不能让导出进度盖掉核对要求。
    const operationKey = restoreEntry?.messageKey;
    const observedKey = unknown ? operationKey : progress || errorKey || operationKey
      || (!ready && !connectionState?.noticeShown ? recovery?.messageKey || "libraryVerifyingAccount" : null);
    const status = observedKey ? translate(observedKey) : "";
    el("status").textContent = status; el("status").hidden = !status;
    const cause = unknown || (!progress && !errorKey && operationKey) ? restoreEntry.cause
      : errorKey ? observedFailure : globalThis.ChatGPTTidyDiagnostics?.cause(connectionError);
    globalThis.ChatGPTTidyDiagnostics?.notice({ event: active && status ? "show" : "clear",
      surface: "settings.backup.status", source: "src/features/settings/ui/library-backup-view.js",
      messageKey: observedKey, ...cause });
    el("retry").hidden = !unknown && (Boolean(progress) || !(recovery?.retryable && !connectionState?.noticeShown));
    el("retry").textContent = translate(unknown ? "backupCheckLibrary" : "reconnect");
    el("retry").disabled = !active;
    el("recovery").hidden = el("checked").hidden = !unknown;
    el("checked").disabled = !active || Boolean(busy) || downloadPending;
    el("preview").hidden = !preview;
    el("filename").textContent = filename;
    if (preview) {
      const { favorites: f, bookmarks: b } = preview.summary;
      // 不论是否有新内容，都只显示这两行数量；0 也保留，避免用户重新理解不同提示。
      el("counts").textContent = translate("backupCounts", { favorites: f.added, bookmarks: b.added });
      el("skipped").textContent = translate("backupSkipped", { count: f.skipped + b.skipped });
    }
  }
  function current(id, token) { return !disposed && active && id === operation && isCurrent(token); }
  function failure(error, stage = "export") {
    observedFailure = globalThis.ChatGPTTidyDiagnostics?.cause(error);
    errorKey = errorKeys[error?.code || error?.tidyCode]
      || ({ file: "backupFileReadFailed", export: "backupFailed" }[stage]);
  }
  async function exportBackup() {
    if (!active || disposed || busy || downloadPending || restoreForAccount()?.phase === "pending" || !captureOwner()?.accountKey) return;
    forget(); clearSettledRestore(); owner = captureOwner(); const token = owner, id = operation;
    busy = "backupPreparing"; update();
    try {
      const result = await request("export", {}, token);
      if (!current(id, token)) return;
      // 切栏目不能重开第二个保存窗口；迟到回执也不向新账号显示旧结果。
      downloadPending = true; busy = "backupSaving"; update();
      try {
        const started = await download(result);
        if (started && current(id, token)) toast("backupDownloadStarted");
      } finally { downloadPending = false; if (!current(id, token)) update(); }
    } catch (error) { if (current(id, token)) failure(error); }
    finally { if (current(id, token)) { busy = null; update(); } }
  }
  function choose() {
    if (!active || disposed || busy || downloadPending || restoreBlocksImport() || !captureOwner()?.accountKey) return;
    forget(); clearSettledRestore(); fileOwner = captureOwner(); update(); el("file").click();
  }
  async function selected() {
    if (disposed) return;
    const file = el("file").files?.[0], token = fileOwner;
    if (!file || !active || !token || !isCurrent(token)) { forget(); update(); return; }
    owner = token; fileOwner = null; const id = ++operation;
    filename = file.name; busy = "backupChecking"; errorKey = null; update();
    try {
      if (file.size > LIBRARY_BACKUP_LIMITS.bytes) throw backupError("BACKUP_FILE_TOO_LARGE");
      const text = await file.text();
      if (!current(id, token)) return;
      const result = await request("preview", { text }, token);
      if (!current(id, token)) {
        if (isCurrent(token)) void request("discard", { previewId: result.id }, token).catch(() => {});
        return;
      }
      preview = result; busy = null; update(); el("confirm").focus();
    } catch (error) { if (current(id, token)) failure(error, "file"); }
    finally { if (current(id, token)) { busy = null; el("file").value = ""; update(); } }
  }
  async function restore() {
    if (!active || disposed || busy || restoreBlocksImport() || !preview || !owner || !isCurrent(owner)) return;
    const submittedOwner = owner, chosen = preview;
    const lifetime = globalThis.ChatGPTTidyNoticeLifecycle.createOwner();
    const entry = { owner: submittedOwner, lifetime, token: lifetime.begin(), phase: "pending", messageKey: null, cause: null };
    clearSettledRestore();
    restores.set(submittedOwner.accountKey, entry);
    // 恢复已经消费预览凭证；忘记文件前先转移所有权，不得 discard 已提交凭证。
    preview = null; forget(); update();
    let result;
    try {
      result = await request("restore", { previewId: chosen.id }, submittedOwner);
    } catch (error) {
      if (!ownsRestore(entry)) return;
      const code = error?.code || error?.tidyCode;
      // 已知 BACKUP 校验错误来自事务提交前。CONTEXT_MISMATCH 也可在写后抛出，
      // 因此缺少成功回执时必须保守保留 unknown，而不是声称没有写入。
      const rejected = typeof code === "string" && code.startsWith("BACKUP_") && errorKeys[code];
      entry.phase = rejected ? "rejected" : "unknown";
      entry.messageKey = rejected || "backupRestoreFailed";
      entry.cause = globalThis.ChatGPTTidyDiagnostics?.cause(error);
      update();
      return;
    }
    if (!ownsRestore(entry)) return;
    entry.phase = "succeeded"; entry.messageKey = "backupRestored";
    // 账号相同可恢复操作状态；列表快照采用仍须通过原 identity/generation 校验。
    if (isCurrent(submittedOwner)) onRestored(submittedOwner, result);
    if (active && isCurrent(submittedOwner)) {
      clearRestore(entry); update(); toast("backupRestored"); el("choose").focus();
    } else update();
  }
  el("export").addEventListener("click", exportBackup);
  el("retry").addEventListener("click", async () => {
    if (!active || disposed || el("retry").disabled) return;
    if (restoreForAccount()?.phase === "unknown") { checkLibrary(); return; }
    el("retry").disabled = true;
    try { await reconnect(); } finally { if (!disposed) update(); }
  });
  el("checked").addEventListener("click", () => {
    if (!active || disposed || el("checked").disabled) return;
    const entry = restoreForAccount();
    if (entry?.phase !== "unknown") return;
    // 仅由用户明确核对后释放导入锁；不宣称恢复成功、不改资料、更不重放恢复。
    clearRestore(entry); update(); el("choose").focus();
  });
  el("choose").addEventListener("click", choose);
  el("file").addEventListener("change", selected);
  el("confirm").addEventListener("click", restore);
  el("cancel").addEventListener("click", () => {
    if (!active || disposed || busy || restoreForAccount()?.phase === "pending") return;
    forget(); update(); el("choose").focus();
  });
  update();
  return Object.freeze({ update, setActive(value) {
    if (disposed) return;
    if (active && !value) forget(); active = Boolean(value); update();
  },
    dispose() {
      if (disposed) return;
      forget(); active = false; disposed = true;
      for (const name of ["export", "choose", "confirm", "cancel", "retry", "checked", "file"]) el(name).disabled = true;
      for (const entry of restores.values()) entry.lifetime.dispose();
      restores.clear();
      globalThis.ChatGPTTidyDiagnostics?.notice({ event: "clear", surface: "settings.backup.status", reasonCode: "VIEW_DISPOSED" }); } });
}
