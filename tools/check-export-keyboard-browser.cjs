// 表单焦点、模态 Tab 与关闭恢复均使用真实 Chromium 输入，不用合成键盘事件冒充。
const { runBrowserFixture } = require('./browser-fixture.cjs');
runBrowserFixture({ fixture: 'export-keyboard', prefix: 'export-keyboard-browser-', focusEmulation: true, nativeInput: true })
  .then(report => { console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1; })
  .catch(error => { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
