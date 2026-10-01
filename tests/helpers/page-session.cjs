const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 旧功能测试仍使用真实总闸，而不是在生产代码里添加缺少 lifecycle 时的旁路。
function installPageSession(context, { runtime = false } = {}) {
  context.AbortController ||= AbortController;
  context.AbortSignal ||= AbortSignal;
  context.Event ||= Event;
  const document = context.document;
  if (document) {
    const root = document.documentElement;
    if (root) {
      const attributes = new Map();
      root.setAttribute ||= (name, value) => attributes.set(name, String(value));
      root.getAttribute ||= name => attributes.get(name) ?? null;
    }
    // 单模块 VM fixtures 不需要完整 DOM；缺少的方法只在测试中补齐。
    document.removeEventListener ||= () => {};
    document.dispatchEvent ||= () => true;
  }
  context.removeEventListener ||= () => {};
  if (context.window) context.window.removeEventListener ||= () => {};
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../src/platform/session/shared/page-session.js"), "utf8"), context);
  context.TidyPageSession = context.TidyPageSessionContract.create({ runtime: runtime ? context.chrome.runtime : null });
  return context.TidyPageSession;
}

module.exports = { installPageSession };
