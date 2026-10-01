// 不连接用户浏览器；验证原生文件控件、键盘确认、IndexedDB 回滚边界和主题。
const { runBrowserFixture } = require('./browser-fixture.cjs');
runBrowserFixture({ fixture: 'library-backup', prefix: 'library-backup-browser-', windowSize: '440,980', focusEmulation: true, nativeInput: true })
  .then(report => { console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1; })
  .catch(error => { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
