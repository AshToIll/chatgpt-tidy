import { createTranslator } from '/src/messages/i18n.js';
import { createLibraryBackupView } from '/src/features/settings/ui/library-backup-view.js';
import { createExportView } from '/src/features/export/ui/export-view.js';

// Production views, synthetic transports. None of these handlers touches the extension or a real account.
const translate = createTranslator('zh-CN'), owner = { accountKey: 'qa-only' };
let ready = false, healthy = false, statusReads = 0;
const backup = createLibraryBackupView({ root: document.querySelector('#backup-root'), translate,
  captureOwner: () => ready ? owner : null, isCurrent: token => token === owner,
  connection: () => ({ error: Error('Synthetic unavailable connection') }),
  reconnect: async () => { ready = true; document.querySelector('#backup-check').textContent = '已重新连接'; },
  checkLibrary() {}, request: async () => { throw Error('This fixture only tests reconnect'); }, onRestored() {}, toast() {},
});
backup.setActive(true);
const view = createExportView({ root: document.querySelector('#export-root'),
  jobRequest: async action => {
    if (action !== 'status') throw Error('This fixture only checks status');
    statusReads++; document.querySelector('#export-check').dataset.statusReads = String(statusReads);
    if (!healthy) throw Error('Synthetic unknown result');
    return null;
  },
  requestDocument: async () => { throw Error('No synthetic conversation selected'); }, requestDocuments: async () => ({ documents: [] }),
  presentFullPreview: async () => {}, dismissFullPreview: async () => {},
  openDownloads: async () => { document.querySelector('#export-check').textContent = '已调用查看下载'; },
});
view.update({ active: true, accountKey: 'qa-only', preferences: { language: 'zh-CN' }, translator: translate });
document.querySelector('#job-recover').addEventListener('click', () => { healthy = true; });
window.addEventListener('pagehide', () => { backup.dispose(); view.suspend({ active: false }); });
