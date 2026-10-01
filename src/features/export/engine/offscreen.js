// 此模块只管理计算线程和 Blob 的寿命，不调用下载 API、不自行宣告保存成功。
// Worker 可休眠，侧栏可关闭；任务仍由此独立宿主持有。正文只留内存，不写持久化存储。
(() => {
  const CHANNEL = 'tidy.export-host.v1';
  let current = null, worker = null, timer = null, blobUrl = null, lastProgress = 0;
  const publish = data => chrome.runtime.sendMessage({ channel: CHANNEL, target: 'service', id: current?.id, ...data }).catch(() => {});
  function stop() {
    worker?.terminate(); worker = null; clearTimeout(timer); timer = null;
    if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null;
  }
  function run(id, spec) {
    if (current?.id === id) return current;
    if (current && ['generating', 'ready'].includes(current.state)) throw new Error('Export host is busy');
    stop(); current = { id, state: 'generating' };
    worker = new Worker('./job-worker.js');
    const fail = code => {
      // 宿主会跨任务保留：旧线程/已排队超时的迟到回调不能清理新任务。
      if (current?.id !== id || current.state !== 'generating') return;
      stop(); current = { id, state: 'failed', errorCode: code }; void publish({ type: 'failed', errorCode: code });
    };
    timer = setTimeout(() => fail('exportJobTimeout'), TidyExportJobs.GENERATION_TIMEOUT_MS);
    worker.onerror = () => fail('exportJobFailed');
    worker.onmessage = event => {
      if (current?.id !== id || current.state !== 'generating') return;
      const data = event.data;
      if (data.type === 'progress') {
        current.progress = data.progress;
        if (Date.now() - lastProgress > 250) { lastProgress = Date.now(); void publish(data); }
      } else if (data.type === 'ready') {
        clearTimeout(timer); timer = null; worker.terminate(); worker = null;
        const { bytes, mimeType, warnings } = data.result;
        blobUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        current = { id, state: 'ready', blobUrl, warnings };
        void publish({ type: 'ready', blobUrl, warnings });
      } else if (data.type === 'failed') fail(data.errorCode);
    };
    worker.postMessage(spec); return current;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.channel !== CHANNEL || message.target !== 'host') return false;
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('app/background/service-worker.js')) return false;
    try {
      if (message.type === 'run') respond({ ok: true, job: run(message.id, message.spec) });
      else if (message.type === 'inspect') respond({ ok: true, job: current });
      else if (message.type === 'stop') {
        if (current && current.id !== message.id) respond({ ok: false });
        else { stop(); current = null; respond({ ok: true, job: null }); }
      }
      else respond({ ok: true });
    } catch { respond({ ok: false }); }
    return false;
  });
})();
