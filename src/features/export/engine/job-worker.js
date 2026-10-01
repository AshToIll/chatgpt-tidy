/* 独立计算线程：关闭侧栏不影响生成；取消时终止线程，连同请求、压缩及字体计算一起释放。
   所有库只从扩展内加载，图片转换和文件内容不发送给第三方服务。 */
importScripts('../model/export-job.js', './i18n.js', './dependencies.js', './assets.js', './normalize.js', './plan.js', './inline-content.js', './serializers.js', './pdf.js', './download.js');
const api = globalThis.TidyExport;
onmessage = async event => {
  const { plan, context, warnings } = event.data;
  let loaded = 0;
  const progress = value => postMessage({ type: 'progress', progress: value });
  const assets = new Map();
  const allowedImages = new Set();
  for (const file of plan.files) {
    const conversations = file.kind === 'conversation' ? file.conversations : file.bookmarkEntries.map(e => e.conversation);
    for (const conversation of conversations) for (const r of conversation.resources || []) if (r.type === 'image' && r.src) allowedImages.add(r.src);
  }
  const assetLoader = source => {
    if (assets.has(source)) return assets.get(source);
    const pending = (async () => {
      let url;
      if (/^\.\/vendor\/fonts\/[a-z0-9_./-]+$/i.test(source) && !source.includes('..')) {
        url = new URL('../../../assets/fonts/' + source.slice('./vendor/fonts/'.length), location.href).href;
      } else if (allowedImages.has(source) && (/^https?:\/\//i.test(source) || /^data:image\/(png|jpeg|webp|gif);base64,/i.test(source))) url = source;
      else throw new Error('Unapproved export asset');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TidyExportJobs.RESOURCE_TIMEOUT_MS);
      try {
        return await api.readExportAsset(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout); loaded++;
        progress({ phase: 'resources', done: loaded, total: null });
      }
    })();
    assets.set(source, pending); return pending;
  };
  try {
    const result = await api.generateExport(plan, { ...context, messages: plan.messages, assetLoader,
      formatTimestamp: value => context.timestamps?.[value] ?? value, onProgress: progress });
    postMessage({ type: 'ready', result: { bytes: result.bytes, outputName: result.outputName, mimeType: result.mimeType,
      warnings: [...new Set([...warnings, ...(result.warnings || [])])] } }, [result.bytes.buffer]);
  } catch (error) {
    // 错误不回传资源地址或底层响应；具体缺图说明通过生成器的 warnings 返回。
    const key = error?.exportMessageKey;
    const code = ['exportDependencyEnvironment', 'exportDependencyNotReady', 'exportDependencyFailed', 'exportPdfAssetFailed', 'exportPdfFontsInvalid'].includes(key)
      ? 'exportDependencyFailed' : key === 'exportPdfNoGlyphs' ? key
        : ['exportInvalidDataField', 'exportConversationsIncomplete'].includes(key) ? 'exportInvalidDocument' : 'exportJobFailed';
    postMessage({ type: 'failed', errorCode: code });
  }
};
