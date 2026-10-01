/* 计算线程按格式加载内置库；侧栏没有脚本注入、字体读取或文件生成职责。
   importScripts 是同步本地加载，整次任务的超时/取消由独立宿主负责终止线程。 */
(function (root) {
  'use strict';
  const api = root.TidyExport = root.TidyExport || {};
  const libraries = Object.freeze({
    pdf: { file: 'pdf-lib-1.17.1.min.js', ready: () => typeof root.PDFLib?.PDFDocument?.create === 'function' },
    generators: { file: 'regenerator-runtime-0.14.1.js', ready: () => typeof root.regeneratorRuntime?.wrap === 'function' },
    fonts: { file: 'fontkit-1.1.1.min.js', ready: () => typeof root.fontkit?.create === 'function' },
    zip: { file: 'jszip-3.10.1.min.js', ready: () => typeof root.JSZip === 'function' },
  });
  async function ensureExportDependencies(plan) {
    const names = [...(plan.format === 'pdf' ? ['pdf', 'generators', 'fonts'] : []), ...(plan.zipped ? ['zip'] : [])];
    for (const name of names) {
      const library = libraries[name];
      if (library.ready()) continue;
      if (typeof root.importScripts !== 'function') throw api.exportError('exportDependencyEnvironment');
      try { root.importScripts('../../../vendor/' + library.file); }
      catch { throw api.exportError('exportDependencyFailed', { name: library.file }); }
      if (!library.ready()) throw api.exportError('exportDependencyNotReady', { name: library.file });
    }
  }
  Object.assign(api, { ensureExportDependencies });
})(globalThis);
