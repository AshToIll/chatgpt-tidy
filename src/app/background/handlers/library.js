import { createLibraryBackupRepository } from "../../../features/settings/storage/library-backup.js";
import { createLibraryBackupService } from "../../../features/settings/background/library-backup-service.js";
import "../../../platform/protocol.js";

// Restore preview and durable commit remain in the existing backup service; no automatic replay.
export function createLibraryHandler({ library }) {
  const protocol = globalThis.TidyProtocol;
  let service = null;
  function backup() {
    service ||= createLibraryBackupService({ repository: createLibraryBackupRepository(),
      assertCurrent: library.assertCurrent, notify: library.invalidate });
    return service;
  }
  async function handle({ envelope, libraryOwner }) {
    if (envelope.type === protocol.Type.LIBRARY_ACCOUNT) return { accountKey: libraryOwner.accountKey, identity: libraryOwner.identity };
    if (envelope.type === protocol.Type.LIBRARY_GET) return library.load(libraryOwner, envelope.requestId);
    if (envelope.type === protocol.Type.LIBRARY_BACKUP_EXPORT) return backup().exportBackup(libraryOwner);
    if (envelope.type === protocol.Type.LIBRARY_BACKUP_PREVIEW) return backup().preview(libraryOwner, envelope.payload?.text);
    if (envelope.type === protocol.Type.LIBRARY_BACKUP_RESTORE) return backup().restore(libraryOwner, envelope.payload?.previewId);
    if (envelope.type === protocol.Type.LIBRARY_BACKUP_DISCARD) return backup().discard(libraryOwner, envelope.payload?.previewId);
  }

  return Object.freeze({ types: Object.freeze([protocol.Type.LIBRARY_ACCOUNT, protocol.Type.LIBRARY_GET, protocol.Type.LIBRARY_BACKUP_EXPORT, protocol.Type.LIBRARY_BACKUP_PREVIEW, protocol.Type.LIBRARY_BACKUP_RESTORE, protocol.Type.LIBRARY_BACKUP_DISCARD]), handle, revoke: tabId => service?.revoke(tabId) });
}
