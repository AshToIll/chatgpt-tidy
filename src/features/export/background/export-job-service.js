import '../model/export-job.js';
import { getOffscreenHost } from './offscreen-host.js';

// 任务唯一入口：验证归属、单任务准入、最小状态回执、浏览器下载完成核对。
// session 仅存状态/文件名，不存正文或临时图片签名。浏览器重启后不自动重放下载。
export function createExportJobService({ chrome, verifyOwner, notify = () => {} }) {
  const contract = globalThis.TidyExportJobs;
  const KEY = 'tidy.export-job.v1', CHANNEL = 'tidy.export-host.v1';
  const RETIRED = 'tidy.export-retired-handoffs.v1';
  const offscreenHost = getOffscreenHost(chrome);
  const hostUrl = offscreenHost.url;
  let queue = Promise.resolve();
  const dispatching = new Set();
  const exclusive = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const read = async () => (await chrome.storage.session.get(KEY))[KEY] || null;
  async function write(record) {
    record.revision = (record.revision || 0) + 1; record.updatedAt = Date.now();
    await chrome.storage.session.set({ [KEY]: record });
    notify({ tabId: record.owner.tabId, id: record.id }); return record;
  }
  const hostExists = offscreenHost.exists;
  async function host(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ channel: CHANNEL, target: 'host', type, ...payload });
    if (!response?.ok) throw new Error('Export host unavailable'); return response.job;
  }
  const ensureHost = offscreenHost.ensure;
  async function release(record) {
    if (await hostExists()) {
      // 释放正文、Worker 和 Blob，但保留不含对话内容的主题监听。
      // stop 未确认且宿主仍存在时，不能虚报终态；下一次状态核对会重试。
      try { if (await host('stop', { id: record.id })) throw new Error('Export host did not release its job'); }
      catch (error) { if (await hostExists()) throw error; }
    }
  }
  async function finish(record, state, errorCode = '') {
    if (record.blobUrl && record.downloadId == null) {
      // 不确定的浏览器交接保留一个最小“撤销凭据”。即使用户随后发起新任务，
      // 旧保存窗口的迟到回执也只能被取消，不能变成后台悄悄落盘的第二个文件。
      const retired = (await chrome.storage.session.get(RETIRED))[RETIRED] || [];
      await chrome.storage.session.set({ [RETIRED]: [...new Set([...retired, record.blobUrl])] });
    }
    // 停止/释放已确认后才给出终态。清理失败时保留活动回执，后续查询继续核对。
    await release(record);
    record.state = state; record.errorCode = errorCode;
    await write(record); return record;
  }
  async function checkDownload(record, recoverMissing = false) {
    const previousId = record.downloadId;
    const previousName = record.outputName;
    const items = await chrome.downloads.search(record.downloadId != null ? { id: record.downloadId } : { url: record.blobUrl });
    const item = items.find(i => i.url === record.blobUrl && i.byExtensionId === chrome.runtime.id);
    if (!item) {
      // 正在显示另存为窗口时可以还没有下载记录，不能把正常等待当失败。
      // 但后台重启后交接已失联，或已有下载记录消失，就必须结束等待、开放重试。
      if (recoverMissing && !dispatching.has(record.id)) {
        return record.state === 'cancelling' ? finish(record, 'cancelled') : finish(record, 'failed', 'exportJobInterrupted');
      }
      return record;
    }
    record.downloadId = item.id;
    // 另存为允许改名；回执只保留最终文件名，不保存用户的本机文件夹路径。
    const savedName = typeof item.filename === 'string' ? item.filename.split(/[\\/]/).pop() : '';
    if (savedName) record.outputName = savedName;
    if (item.state === 'complete') return finish(record, 'completed');
    if (item.state === 'interrupted') return finish(record, item.error === 'USER_CANCELED' || record.state === 'cancelling' ? 'cancelled' : 'failed',
      item.error === 'USER_CANCELED' || record.state === 'cancelling' ? '' : 'exportJobSaveFailed');
    if (record.state === 'cancelling') {
      await chrome.downloads.cancel(item.id).catch(() => {});
      const after = (await chrome.downloads.search({ id: item.id }))[0];
      if (after?.state === 'complete') return finish(record, 'completed');
      if (after?.state === 'interrupted') return finish(record, 'cancelled', record.errorCode);
    }
    return previousId !== record.downloadId || previousName !== record.outputName ? write(record) : record;
  }
  async function reconcileCancellation(record) {
    // 没有 Blob 交接记录时，取消的是生成任务：只重试释放宿主，不查询下载或重新生成。
    // 已交给浏览器的任务仍以真实保存回执为准，完成下载不能被误报为取消。
    return record.blobUrl ? checkDownload(record, true) : finish(record, 'cancelled');
  }
  async function reconcile(record) {
    if (!contract.active(record)) return record;
    // 已交给浏览器的文件独立收尾。页面刷新/切换不代表用户取消，
    // 也不能挡住失联交接的失败回收；优先核对浏览器实际保存结果。
    if (record.state === 'cancelling') return reconcileCancellation(record);
    if (record.state === 'saving') return checkDownload(record, true);
    try { await verifyOwner(record.owner); }
    catch { return finish(record, 'failed', 'exportJobOwnerChanged'); }
    const running = await hostExists() ? await host('inspect').catch(() => null) : null;
    if (running?.id !== record.id) return finish(record, 'failed', 'exportJobInterrupted');
    if (running.state === 'failed') return finish(record, 'failed', running.errorCode || 'exportJobFailed');
    if (running.state === 'ready') scheduleDownload(record.id, running);
    else if (running.progress && JSON.stringify(running.progress) !== JSON.stringify(record.progress)) {
      record.progress = running.progress; await write(record);
    }
    return record;
  }
  function scheduleDownload(id, ready) {
    if (dispatching.has(id)) return;
    dispatching.add(id);
    // 不在准入锁里等待浏览器文件选择框，取消和状态查询仍然可用。
    void dispatchDownload(id, ready).finally(() => dispatching.delete(id)).catch(() => {});
  }
  async function dispatchDownload(id, ready) {
    let admitted, handoffRejected = false;
    try {
      admitted = await exclusive(async () => {
        const record = await read();
        if (record?.id !== id || !['starting', 'generating'].includes(record.state)) return null;
        await verifyOwner(record.owner);
        if (typeof ready.blobUrl !== 'string' || !ready.blobUrl.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) throw new Error('Invalid export blob');
        record.state = 'saving'; record.progress = { phase: 'saving', done: 0, total: null };
        record.blobUrl = ready.blobUrl; record.warnings = Array.isArray(ready.warnings) ? ready.warnings.filter(w => typeof w === 'string') : [];
        return write(record);
      });
      if (!admitted) return;
      // 单文件和批量 ZIP 共用另存为入口；窗口取消沿用任务的取消终态，不报保存失败。
      const downloadId = await chrome.downloads.download({ url: admitted.blobUrl, filename: admitted.outputName, saveAs: true, conflictAction: 'uniquify' })
        .catch(error => { handoffRejected = true; throw error; });
      await exclusive(async () => {
        const record = await read();
        if (record?.id !== id || !contract.active(record)) { await chrome.downloads.cancel(downloadId).catch(() => {}); return; }
        record.downloadId = downloadId; await write(record); await checkDownload(record);
      });
    } catch (error) {
      await exclusive(async () => {
        const record = await read(); if (record?.id !== id || !contract.active(record)) return;
        // 浏览器已明确拒绝或取消，就没有迟到下载需要撤销；不积攒无用的撤销凭据。
        if (handoffRejected) delete record.blobUrl;
        const cancelled = record.state === 'cancelling' || /cancel/i.test(error?.message || '');
        await finish(record, cancelled ? 'cancelled' : 'failed', cancelled ? '' : admitted ? 'exportJobSaveFailed' : 'exportJobOwnerChanged');
      });
    }
  }
  // 取消只由用户主动操作进入；页面失效走独立的失败/保存核对入口。
  async function cancelRecord(record) {
    if (!contract.active(record)) return record;
    if (record.state !== 'cancelling') {
      // 先保存用户的取消意图，立即撤销下载准入；stop 未确认不等于用户没有取消。
      // 保持 cancelling 活动态，直到宿主释放/浏览器回执确认，避免并发启动新任务。
      record.state = 'cancelling'; record.errorCode = ''; await write(record);
    }
    return reconcileCancellation(record);
  }
  async function interruptOwner(record) {
    if (!contract.active(record)) return record;
    if (record.state === 'cancelling') return reconcileCancellation(record);
    if (record.state === 'saving') return checkDownload(record, true);
    return finish(record, 'failed', 'exportJobOwnerChanged');
  }
  async function start(owner, payload) {
    return exclusive(async () => {
      let record = await read();
      if (record) record = await reconcile(record);
      if (record?.id === payload.id || contract.active(record)) return contract.receipt(record, owner);
      if (!/^[a-z0-9-]{1,100}$/i.test(payload.id || '') || !contract.validSpec(payload.spec)) throw new Error('Invalid export job');
      await verifyOwner(owner);
      record = { id: payload.id, owner, state: 'starting', revision: 0, startedAt: Date.now(),
        outputName: payload.spec.plan.outputName, warnings: [], progress: { phase: 'preparing', done: 0, total: null }, downloadId: null };
      await write(record);
      try {
        await ensureHost(); await verifyOwner(owner);
        await host('run', { id: record.id, spec: payload.spec });
        record.state = 'generating'; await write(record);
      } catch { await finish(record, 'failed', 'exportJobFailed'); }
      return contract.receipt(record, owner);
    });
  }
  const status = owner => exclusive(async () => contract.receipt(await reconcile(await read()), owner));
  const cancel = (owner, id) => exclusive(async () => {
    const record = await read();
    if (record?.id !== id || record.owner.tabId !== owner.tabId || record.owner.accountKey !== owner.accountKey) throw new Error('Export job owner changed');
    return contract.receipt(await cancelRecord(record), owner);
  });
  // 收起的是结果提示，不是删除回执、更不是取消下载。按原任务保存，防止重开侧栏复活。
  const dismiss = (owner, id) => exclusive(async () => {
    const record = await read();
    if (record?.id !== id || record.owner.tabId !== owner.tabId || record.owner.accountKey !== owner.accountKey
      || !contract.terminal(record)) throw new Error('Only the owned terminal notice may be dismissed');
    if (!record.dismissedAt) { record.dismissedAt = Date.now(); await write(record); }
    return contract.receipt(record, owner);
  });
  const revoke = tabId => exclusive(async () => {
    const record = await read(); if (record?.owner.tabId === tabId) await interruptOwner(record);
  });
  async function acceptHost(message, sender) {
    if (message?.channel !== CHANNEL || message.target !== 'service') return false;
    if (sender?.id !== chrome.runtime.id || sender.url !== hostUrl || sender.tab) return false;
    await exclusive(async () => {
      const record = await read();
      if (record?.id !== message.id || !['starting', 'generating'].includes(record.state)) return;
      if (message.type === 'ready') scheduleDownload(record.id, message);
      else if (message.type === 'failed') await finish(record, 'failed',
        ['exportJobTimeout', 'exportDependencyFailed', 'exportPdfNoGlyphs', 'exportInvalidDocument'].includes(message.errorCode) ? message.errorCode : 'exportJobFailed');
      else if (message.type === 'progress' && contract.PHASES.includes(message.progress?.phase)) {
        const { phase, done, total } = message.progress;
        record.progress = { phase, done: Math.max(0, Number(done) || 0), total: Number.isFinite(total) && total > 0 ? total : null };
        await write(record);
      }
    }); return true;
  }
  async function downloadChanged(id) {
    await exclusive(async () => {
      const retired = (await chrome.storage.session.get(RETIRED))[RETIRED] || [];
      if (retired.length) {
        const item = (await chrome.downloads.search({ id }))[0];
        if (item?.byExtensionId === chrome.runtime.id && retired.includes(item.url)) {
          if (item.state === 'in_progress') await chrome.downloads.cancel(id);
          await chrome.storage.session.set({ [RETIRED]: retired.filter(url => url !== item.url) });
          return;
        }
      }
      const r = await read();
      if (!r?.blobUrl) return;
      if (r.downloadId === id && contract.active(r)) await checkDownload(r);
      else if (r.downloadId == null) {
        const item = (await chrome.downloads.search({ id }))[0];
        if (item?.url !== r.blobUrl || item.byExtensionId !== chrome.runtime.id) return;
        // 浏览器交接回执可能晚于 Worker 重启。只认领原 URL，绝不重发生成请求。
        if (contract.active(r)) await checkDownload(r);
        else if (item.state === 'in_progress') await chrome.downloads.cancel(id).catch(() => {});
      }
    });
  }
  const observeOwner = (tabId, identity) => exclusive(async () => {
    const record = await read();
    if (record?.owner.tabId === tabId && (identity?.phase !== 'ready' || identity.accountKey !== record.owner.accountKey
      || identity.documentId !== record.owner.documentId || identity.epoch !== record.owner.epoch)) await interruptOwner(record);
  });
  return Object.freeze({ start, status, cancel, dismiss, revoke, acceptHost, downloadChanged, observeOwner });
}
