// Fresh, offline Chromium profile only. Does not access the user's account.
const { runBrowserFixture } = require("./browser-fixture.cjs");
runBrowserFixture({ fixture: "title-sidebar-sync", prefix: "title-sidebar-browser-", focusEmulation: true })
  .then(report => { console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1; })
  .catch(error => { console.error(error); process.exitCode = 1; });
