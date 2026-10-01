// Chrome 每个扩展只能打开一个 offscreen 文档。这个宿主仅负责导出，
// 按需创建，复用创建锁避免并发冲突；任务结束释放线程、正文和 Blob。
const hosts = new WeakMap();

export function getOffscreenHost(chrome) {
  if (hosts.has(chrome)) return hosts.get(chrome);
  const path = 'features/export/engine/offscreen.html';
  const url = chrome.runtime.getURL(path);
  let creating = null;
  const exists = async () => (await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url],
  })).length > 0;
  function ensure() {
    // 锁覆盖“查询 + 创建”，不能等 getContexts 返回后才上锁。
    if (!creating) creating = (async () => {
      if (await exists()) return;
      await chrome.offscreen.createDocument({
        url: path,
        reasons: ['BLOBS', 'WORKERS'],
        justification: 'Generate export files in a disposable worker while retaining their Blob until saving finishes.',
      });
    })().finally(() => { creating = null; });
    return creating;
  }
  const host = Object.freeze({ url, exists, ensure });
  hosts.set(chrome, host);
  return host;
}
