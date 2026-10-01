const { runBrowserFixture } = require('./browser-fixture.cjs');
runBrowserFixture({ fixture: 'bookmark-theme', prefix: 'bookmark-theme-browser-', windowSize: '1100,1100', focusEmulation: true, nativeInput: true })
  .then(report => { console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1; })
  .catch(error => { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
