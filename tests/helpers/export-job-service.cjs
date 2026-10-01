const fs = require('node:fs'), vm = require('node:vm');
// VM 测试显式装配新增生产模块；session 是独立于 UI 的最小浏览器替身。
function loadExportJobService(context, read = f => fs.readFileSync(f, 'utf8')) {
  if (context.createExportJobService) return;
  context.chrome.storage ||= {};
  if (!context.chrome.storage.session) {
    const data = {};
    context.chrome.storage.session = { get: async key => structuredClone({ [key]: data[key] }), set: async values => Object.assign(data, structuredClone(values)) };
  }
  vm.runInContext(read('src/features/export/model/export-job.js'), context);
  vm.runInContext(read('src/features/export/background/offscreen-host.js').replace(/^export /gm, ''), context);
  vm.runInContext(read('src/features/export/background/export-job-service.js').replace(/^import .*$/gm, '').replace(/^export /gm, ''), context);
}
module.exports = { loadExportJobService };
