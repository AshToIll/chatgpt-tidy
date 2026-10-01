// 仅在隔离测试扩展使用合成归属；实际 offscreen、线程、downloads 服务均使用生产代码。
import { createExportJobService } from '../../features/export/background/export-job-service.js';
const owner = { tabId: 123, accountKey: 'synthetic-account', documentId: 'synthetic-document' };
let valid = true;
const jobs = createExportJobService({ chrome, verifyOwner: async o => {
  if (!valid || o.accountKey !== owner.accountKey || o.documentId !== owner.documentId) throw Error('Owner changed');
} });
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m?.channel === 'tidy.export-host.v1' && m.target === 'service') {
    jobs.acceptHost(m, sender).then(reply); return true;
  }
  if (m?.test !== 'export-jobs' || sender.id !== chrome.runtime.id) return false;
  const run = async () => {
    if (m.action === 'status') return jobs.status(owner);
    if (m.action === 'start') return jobs.start(owner, m.payload);
    if (m.action === 'cancel') return jobs.cancel(owner, m.payload.id);
    if (m.action === 'dismiss') return jobs.dismiss(owner, m.payload.id);
    if (m.action === 'revoke') { valid = false; await jobs.observeOwner(owner.tabId, null); return true; }
    if (m.action === 'inject-lost-handoff') {
      // 故障注入：模拟后台重启后留下的保存交接，原网页也已失效。
      // 只写隔离测试扩展的合成状态；后续恢复、界面和重试下载均走生产代码。
      await chrome.storage.session.set({ 'tidy.export-job.v1': {
        id: 'lost-handoff', owner: { ...owner, documentId: 'retired-document' }, state: 'saving',
        revision: 1, startedAt: Date.now(), updatedAt: Date.now(), outputName: 'interrupted.txt',
        blobUrl: `blob:chrome-extension://${chrome.runtime.id}/missing-handoff`, downloadId: null, warnings: [],
      } });
      return true;
    }
  };
  run().then(value => reply({ value }), error => reply({ error: error.message })); return true;
});
chrome.downloads.onChanged.addListener(d => { void jobs.downloadChanged(d.id); });
chrome.downloads.onCreated.addListener(d => { void jobs.downloadChanged(d.id); });
