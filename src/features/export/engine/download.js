/* 执行导出计划：生成文件内容，需要时组成 ZIP，最后交给浏览器在本机下载。
   内容读取、文件规划和最终下载是不同步骤，不能用“开始生成”冒充“下载完成”。 */
(function (root) {
  'use strict';

  const api = root.TidyExport = root.TidyExport || {};

  async function serializePlannedFile(file, format, context) {
    if (format === 'pdf') return api.serializePdf(file, context);
    return { bytes: api.serializeTextBytes(file, format, context), warnings: [] };
  }

  async function generateExport(plan, context = {}) {
    if (!plan?.files?.length) throw api.exportError('exportNoFiles');
    // ZIP libraries overwrite duplicate entries by design. Reject collisions
    // before any dependency/asset I/O, including case-only names on Windows.
    const occupied = new Set();
    for (const path of plan.files.map((file) => file.path)) {
      const key = String(path).normalize('NFKC').toLowerCase();
      if (occupied.has(key)) throw Object.assign(api.exportError('exportPathCollision', { path }), { code: 'EXPORT_PATH_COLLISION' });
      occupied.add(key);
    }
    await api.ensureExportDependencies(plan);
    const generatedFiles = [];
    const warnings = [];
    // 文字格式只描述媒体；图片字节由 PDF 渲染器按需读取，ZIP 只收集文档。
    const renderContext = { ...context, messages: plan.messages };
    for (const file of plan.files) {
      context.onProgress?.({ phase: 'files', done: generatedFiles.length, total: plan.files.length });
      const result = await serializePlannedFile(file, plan.format, renderContext);
      const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes);
      if (!bytes.byteLength) throw api.exportError('exportEmptyFile', { path: file.path });
      generatedFiles.push({ path: file.path, fileName: file.fileName, bytes, pageCount: result.pageCount || null, pageSize: result.pageSize || null });
      (result.warnings || []).forEach((warning) => { if (!warnings.includes(warning)) warnings.push(warning); });
    }

    if (!plan.zipped) {
      const only = generatedFiles[0];
      return { outputName: plan.outputName, bytes: only.bytes, mimeType: mimeType(plan.format), generatedFiles, warnings };
    }
    const zip = new root.JSZip();
    generatedFiles.forEach((file) => zip.file(file.path, file.bytes));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' },
      metadata => context.onProgress?.({ phase: 'packaging', done: Math.floor(metadata.percent), total: 100 }));
    if (!bytes.byteLength) throw api.exportError('exportZipFailed');
    return { outputName: plan.outputName, bytes, mimeType: 'application/zip', generatedFiles, warnings };
  }

  function mimeType(format) {
    return { markdown: 'text/markdown;charset=utf-8', json: 'application/json;charset=utf-8', txt: 'text/plain;charset=utf-8', pdf: 'application/pdf' }[format] || 'application/octet-stream';
  }

  // 文件生成与下载保存严格分开；只有后台 downloads 回执能确认保存结果。
  Object.assign(api, { generateExport, mimeType });
}(typeof globalThis !== 'undefined' ? globalThis : window));
