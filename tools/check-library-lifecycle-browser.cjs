// 真实时间 + 页面完成回执；不再使用虚拟时间提前截断异步模块。
const { runBrowserFixture } = require('./browser-fixture.cjs');
runBrowserFixture({ fixture: 'library-lifecycle', prefix: 'library-lifecycle-browser-', windowSize: '1200,1200', nativeInput: true, timeoutMs: 60000 })
  .then(report => { console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1; })
  .catch(error => { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
