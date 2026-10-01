import "../shared/toolbar-theme.js";

// 侧栏自身属于浏览器窗口。后台从 sender 的固定绑定 URL 核验标签归属，
// 此处不发送可伪造的 tabId，也不根据 ChatGPT 页面或面板 CSS 配色判断明暗。
globalThis.TidyToolbarTheme.start({ runtime: chrome.runtime });
