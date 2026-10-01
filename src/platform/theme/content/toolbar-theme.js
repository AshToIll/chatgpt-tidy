// 跟随现有页面生命周期；首次安装的旧页面、重载后的旧上下文都不补注入。
globalThis.TidyToolbarTheme.start({ runtime: chrome.runtime, session: globalThis.TidyPageSession });
