// ISOLATED 是唯一能够验证扩展实例存活的页面所有者；不要给失效的旧页补注入脚本。
globalThis.TidyPageSession = globalThis.TidyPageSessionContract.create({ runtime: chrome.runtime, watch: true });
