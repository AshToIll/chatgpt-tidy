// classic content 与 ESM sidepanel 共用的一次性装配；不在 MAIN world 安装。
(function attachDiagnosticsRuntime(global) {
  "use strict";
  if (global.TidyDiagnosticsClient || global.TidyDiagnosticsBootstrap) return;
  const bootstrap = { failures: 0 };
  global.TidyDiagnosticsBootstrap = bootstrap;
  try {
    if (!global.chrome?.runtime?.id || typeof global.chrome.runtime.sendMessage !== "function"
      || !global.TidyDiagnosticsTransport || typeof global.ChatGPTTidyDiagnostics?.setSink !== "function") return;
    const client = global.TidyDiagnosticsTransport.createClient({ runtime: global.chrome.runtime });
    global.TidyDiagnosticsClient = client;
    client.attach(global.ChatGPTTidyDiagnostics);
  } catch { bootstrap.failures++; } // 不记录Error.message，不影响扩展业务初始化。
})(globalThis);
