import { parseLibraryBackup, serializeLibraryBackup, mergeLibraryBackup, prepareBackupGroupIds, LIBRARY_KINDS } from "../storage/library-backup-domain.js";
import { backupError } from "../model/library-backup-format.js";

// 预览只保留在 Worker 内存中，每个来源标签最多一份；重启后需要重新选文件，不能重放旧确认。
export function createLibraryBackupService({ repository, assertCurrent, notify,
  now = () => Date.now(), createId = () => crypto.randomUUID(), previewLifetimeMs = 10 * 60_000 }) {
  const previews = new Map();
  const iso = () => new Date(now()).toISOString();
  const sameOwner = (a, b) => a.accountKey === b.accountKey && a.tab.id === b.tab.id
    && a.identity.documentId === b.identity.documentId && a.identity.epoch === b.identity.epoch;
  function prune() {
    for (const [tabId, entry] of previews) if (entry.expiresAt <= now()) previews.delete(tabId);
  }
  function discard(context, id) {
    const entry = previews.get(context.tab.id);
    if (entry && entry.id === id && sameOwner(entry.context, context)) previews.delete(context.tab.id);
    return { discarded: true };
  }
  async function exportBackup(context) {
    const libraries = await repository.read(context.accountKey, () => assertCurrent(context));
    const text = serializeLibraryBackup(context.accountKey, libraries, iso());
    assertCurrent(context);
    return { text, filename: `ChatGPT-Tidy-library-${iso().slice(0, 10)}.json` };
  }
  async function preview(context, text) {
    prune(); assertCurrent(context);
    previews.delete(context.tab.id);
    const backup = parseLibraryBackup(text, context.accountKey);
    const entry = { id: createId(), context, backup, expiresAt: now() + previewLifetimeMs };
    previews.set(context.tab.id, entry);
    try {
      entry.groupIds = await prepareBackupGroupIds(backup);
      assertCurrent(context);
      if (previews.get(context.tab.id) !== entry || entry.expiresAt <= now()) throw backupError("BACKUP_EXPIRED");
      const libraries = await repository.read(context.accountKey, () => assertCurrent(context));
      assertCurrent(context);
      if (previews.get(context.tab.id) !== entry) throw backupError("BACKUP_EXPIRED");
      const merged = mergeLibraryBackup(libraries, backup, iso(), entry.groupIds);
      // 合并后也必须能再次备份，不能导入后才发现超出本格式的可保存范围。
      serializeLibraryBackup(context.accountKey, merged.libraries, iso());
      entry.revisions = Object.fromEntries(LIBRARY_KINDS.map(kind => [kind, libraries[kind].revision]));
      return { id: entry.id, summary: merged.summary };
    } catch (error) {
      if (previews.get(context.tab.id) === entry) previews.delete(context.tab.id);
      throw error;
    }
  }
  async function restore(context, id) {
    prune(); assertCurrent(context);
    const entry = previews.get(context.tab.id);
    if (!entry || entry.id !== id || !entry.revisions || !sameOwner(entry.context, context)) throw backupError("BACKUP_EXPIRED");
    // 确认凭证一次性使用；重复点击、失败重试都不能自动再执行同一笔恢复。
    previews.delete(context.tab.id);
    let summary;
    const libraries = await repository.restore(context.accountKey, () => assertCurrent(context), current => {
      if (entry.expiresAt <= now()) throw backupError("BACKUP_EXPIRED");
      if (LIBRARY_KINDS.some(kind => current[kind].revision !== entry.revisions[kind])) throw backupError("BACKUP_CHANGED");
      const merged = mergeLibraryBackup(current, entry.backup, iso(), entry.groupIds);
      summary = merged.summary;
      return merged.libraries;
    });
    // 只在完整事务成功后通知列表刷新；通知不携带任何摘录或备注。
    for (const kind of LIBRARY_KINDS) if (libraries[kind].revision !== entry.revisions[kind]) notify(kind, libraries[kind]);
    assertCurrent(context);
    return { summary, ...libraries };
  }
  return Object.freeze({ exportBackup, preview, restore, discard, revoke: tabId => previews.delete(tabId) });
}
