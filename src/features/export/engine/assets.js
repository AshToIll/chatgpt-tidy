/* 导出资源统一读取：这里只负责请求凭据和字节，不负责计划授权、缓存、超时或排版。 */
(function (root) {
  'use strict';
  const api = root.TidyExport = root.TidyExport || {};

  async function readExportAsset(source, { signal } = {}) {
    // 上传图、生成图、外链图是产品来源；真正的读取凭据由请求资源地址决定。
    // 上传/生成图也可能是外部签名地址，必须匿名读取，且不能重写 URL 或签名参数。
    // 只有精确 HTTPS ChatGPT origin 保留凭据；外部 HTTP(S)、data 和内置字体均不携带。
    let parsed;
    try { parsed = new URL(source); } catch { /* 内置相对路径由 fetch 原样解析。 */ }
    if (parsed?.username || parsed?.password) throw new Error('Invalid export asset URL');
    const credentials = parsed?.origin === 'https://chatgpt.com' ? 'include' : 'omit';
    const response = await fetch(source, { signal, credentials });
    if (!response.ok) throw Object.assign(new Error('Export resource unavailable'), { code: 'EXPORT_ASSET_HTTP' });
    return new Uint8Array(await response.arrayBuffer());
  }

  Object.assign(api, { readExportAsset });
}(typeof globalThis !== 'undefined' ? globalThis : window));
