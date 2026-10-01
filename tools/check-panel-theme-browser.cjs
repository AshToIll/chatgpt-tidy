const { runBrowserFixture } = require('./browser-fixture.cjs');
runBrowserFixture({ fixture: 'panel-theme', prefix: 'panel-theme-browser-', windowSize: '1440,940' })
  .then(report => { console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1; })
  .catch(error => { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
