// Development-only seven-feature smoke: production modules run behind isolated fixture adapters.
// Generated panel/transport files and fresh profiles stay outside the shipped extension.
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { sourceFingerprint } = require('./verify-release.cjs');
const { browserArtifactRoot } = require('./browser-fixture.cjs');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
// Use the release source manifest, including maintained tools and browser fixtures,
// so edits to this runner or its diagnostics fragment invalidate source stability.
const rebaseImports = (source, sourceFile) => source.replace(/(\b(?:from|import)\s*["']|\bimport\s*\(\s*["'])(\.\.?\/[^"']+)(["'])/g,
  (_, before, relative, after) => before + pathToFileURL(path.resolve(path.dirname(sourceFile), relative)).href + after);

function prepare(output) {
  const fixtureFile = path.join(ROOT, 'tests/browser/plugin-navigation.mjs');
  let fixture = rebaseImports(read('tests/browser/plugin-navigation.mjs'), fixtureFile);
  const fixtureBase = 'new URL(\x60../../src/$' + '{relative}\x60, import.meta.url).href';
  if (!fixture.includes(fixtureBase)) throw Error('Fixture runtime URL seam changed');
  fixture = fixture.replace(fixtureBase, 'new URL(relative, ' + JSON.stringify(pathToFileURL(path.join(ROOT, 'src') + path.sep).href) + ').href');
  fixture += '\n' + [
    '// Supplementary architecture smoke only. The original runPanelChecks export above is untouched and is never called here.',
    '// All transport is the existing in-memory fixture; admit one healthy synthetic page before the real panel initializes.',
    'pageRuntimeAvailable = true;',
    'const smokeLibraryBefore = JSON.stringify(stored), smokeZoneBefore = preferences.timeZone;',
    'const smokeRoutes = {',
    'time: { selector: "#message-numbers", title: "timeDisplay" },',
    'titles: { selector: ".titles-organization", title: "titleOrganization" },',
    'favorites: { selector: ".favorites-panel", title: "favorites" },',
    'bookmarks: { selector: ".bookmarks-panel", title: "bookmarks" },',
    'search: { selector: ".search-panel", title: "globalSearch" },',
    'export: { selector: ".export-panel", title: "export" },',
    'settings: { selector: "#settings-form", title: "settings" },',
    '};',
    'globalThis.ArchitectureSmoke = Object.freeze({',
    'async ready() {',
    ' await until(() => document.querySelectorAll("[data-bookmark-jump]").length === 3, "Healthy synthetic page did not initialize");',
    ' assert(document.querySelectorAll("[data-view]").length === 7, "Must contain exactly seven feature containers");',
    ' assert([...document.querySelectorAll("[data-view]")].every(view => !view.hidden && !view.inert), "Healthy page must admit all seven modules");',
    ' assert(document.querySelector("#time-view #message-numbers"), "Real time template missing");',
    ' assert(document.querySelector("#settings-view #library-backup"), "Real settings template missing");',
    ' assert(typeof globalThis.ChatGPTTidyDiagnostics?.snapshot === "function" && typeof globalThis.ChatGPTTidyDiagnostics?.exportText === "function", "Diagnostics global missing");',
    ' assert(globalThis.ChatGPTTidyBuildInfo?.version && globalThis.ChatGPTTidyBuildInfo?.fingerprint, "Build identity missing");',
    ' assert(globalThis.ChatGPTTidyNoticeRegistry?.surfaces?.length > 0, "Notice registry missing");',
    ' return { features: 7, diagnostics: true, version: ChatGPTTidyBuildInfo.version, buildFingerprint: ChatGPTTidyBuildInfo.fingerprint };',
    '},',
    'async language(language) {',
    ' dock("settings");',
    ' const select = document.getElementById("language-select");',
    ' select.value = language; select.dispatchEvent(new Event("change", { bubbles: true }));',
    ' await until(() => preferences.language === language && document.documentElement.lang === language, "Language failed: " + language);',
    ' equal(document.querySelector("[data-i18n=\\"language\\"]").textContent, createTranslator(language)("language"), "Central language label");',
    ' equal(preferences.timeZone, smokeZoneBefore, "Language changed time zone");',
    ' equal(JSON.stringify(stored), smokeLibraryBefore, "Language rewrote synthetic library");',
    ' return { language, label: document.querySelector("[data-i18n=\\"language\\"]").textContent };',
    '},',
    'async route(route) {',
    ' const specification = smokeRoutes[route]; assert(specification, "Unknown route");',
    ' dock(route); await sleep(100);',
    ' const active = [...document.querySelectorAll("[data-view]")].filter(view => view.classList.contains("is-active"));',
    ' equal(active.length, 1, "Exactly one active view"); equal(active[0].dataset.view, route, "Requested route active");',
    ' assert(!active[0].hidden && !active[0].inert && getComputedStyle(active[0]).display !== "none", "Active view must be visible and admitted");',
    ' assert(active[0].querySelector(specification.selector), "Real feature component missing: " + route);',
    ' assert(active[0].getBoundingClientRect().width > 0 && active[0].getBoundingClientRect().height > 0, "View has no rendered layout");',
    ' equal(document.getElementById("panel-title").textContent, createTranslator(preferences.language)(specification.title), "Central route title");',
    ' equal(document.querySelector(".time-panel__body").dataset.activeRoute, route, "Shell route ownership");',
    ' return { language: preferences.language, route, component: specification.selector, title: document.getElementById("panel-title").textContent, childElements: active[0].querySelectorAll("*").length };',
    '},',
    'report() {',
    ' assert(networkAttempts === 0, "Synthetic fixture attempted account/network request");',
    ' assert(errors.length === 0, "Uncaught errors: " + errors.join("; "));',
    ' assert(unexpected.length === 0, "Unexpected runtime requests: " + unexpected.join("; "));',
    ' equal(JSON.stringify(stored), smokeLibraryBefore, "Navigation rewrote synthetic library");',
    ' equal(preferences.timeZone, smokeZoneBefore, "Navigation changed time zone");',
    ' assert(!requests.some(item => ["titles.apply", "titles.batch-apply", "favorites.open", "bookmarks.open", "search.open-result", "export.job-start", "library.backup-restore"].includes(item.type)), "Smoke dispatched a mutating/open operation");',
    ' return { networkAttempts, errors: errors.slice(), unexpected: unexpected.slice(), requestTypes: [...new Set(requests.map(item => item.type))], requestCount: requests.length, diagnostics: ChatGPTTidyDiagnostics.snapshot() };',
    '}',
    '});',
  ].join('\n') + '\n';
  fixture = 'import { createDiagnosticsService } from ' + JSON.stringify(pathToFileURL(path.join(ROOT, "src/platform/diagnostics/worker-service.js")).href) + ";\n" + fixture + read("tests/browser/diagnostics-smoke-fragment.js");
  fs.writeFileSync(path.join(output, "transport.mjs"), fixture);
  const panelFile = path.join(ROOT, 'src/app/sidepanel/panel.js');
  let panel = read('src/app/sidepanel/panel.js');
  const ownerSeam = /const panelOwnerTabId = parsePanelOwnerTabId\(\s*globalThis\.location\?\.href,\s*chrome\.runtime\.getURL\("app\/sidepanel\/index\.html"\)\s*,?\s*\);/;
  if (!ownerSeam.test(panel)) throw Error('Production owner seam changed');
  panel = panel.replace(ownerSeam, 'const panelOwnerTabId = 31;');
  panel = 'import "./transport.mjs";\n' + rebaseImports(panel, panelFile);
  fs.writeFileSync(path.join(output, 'panel.mjs'), panel);
  let html = read('src/app/sidepanel/index.html').replace(/((?:src|href)=["'])([^"']+)(["'])/g,
    (_, before, relative, after) => before + pathToFileURL(path.resolve(path.dirname(panelFile), relative)).href + after);
  html = html.replace(pathToFileURL(panelFile).href, pathToFileURL(path.join(output, 'panel.mjs')).href);
  html = html.replace('<body>', '<body><section id="qa-chat" hidden></section><pre id="qa-results" hidden></pre>');
  fs.writeFileSync(path.join(output, 'index.html'), html);
}

async function run(browser, executable, base) {
  const output = path.join(base, browser); fs.mkdirSync(output); prepare(output);
  const profile = path.join(output, 'profile');
  const report = { browser, executable, purpose: 'Second-phase seven-feature architecture and diagnostic settings smoke; not a substitute for the existing acceptance suite', sourceFingerprint: sourceFingerprint(), ok: false, checks: [], screenshots: [], loadingFailures: [], badResponses: [], exceptions: [], externalRequests: [] };
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND', '--allow-file-access-from-files',
    '--window-size=460,960', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let spawnError, socket, id = 0; child.on('error', error => { spawnError = error; });
  const pending = new Map(), requestUrls = new Map();
  async function waitFor(readValue, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (spawnError) throw spawnError; const value = await readValue(); if (value) return value; await sleep(50); }
    throw Error('Timed out: ' + label);
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(Error('CDP timeout: ' + method)); }, 10000);
    pending.set(requestId, message => { clearTimeout(timer); message.error ? reject(Error(message.error.message)) : resolve(message.result); });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  };
  try {
    const port = await waitFor(() => { try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { return null; } }, 'debugger port');
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), receive = pending.get(message.id);
      if (receive) { pending.delete(message.id); receive(message); return; }
      const p = message.params;
      if (message.method === 'Network.requestWillBeSent') { requestUrls.set(p.requestId, p.request.url); if (/^https?:/.test(p.request.url)) report.externalRequests.push(p.request.url); }
      if (message.method === 'Network.loadingFailed') report.loadingFailures.push({ url: requestUrls.get(p.requestId), error: p.errorText, type: p.type });
      if (message.method === 'Network.responseReceived' && p.response.status >= 400) report.badResponses.push({ url: p.response.url, status: p.response.status });
      if (message.method === 'Runtime.exceptionThrown') report.exceptions.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
    });
    await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 460, height: 960, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: pathToFileURL(path.join(output, 'index.html')).href });
    await waitFor(() => evaluate('Boolean(globalThis.ArchitectureSmoke)'), 'smoke transport installed');
    report.checks.push({ name: 'real feature templates and diagnostics installed', result: await evaluate('ArchitectureSmoke.ready()') });
    report.checks.push({ name: 'real diagnostics worker service and storage mounted', result: await evaluate('ArchitectureDiagnosticsSmoke.ready()') });
    const screenshot = async name => {
      const image = await call('Page.captureScreenshot', { format: 'png' }), file = path.join(output, name + '.png');
      fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file);
    };
    const layoutMatrix = async (language, blocked) => {
      // Exercise the real production styles at both sides of the narrow-panel
      // breakpoint and at full/short heights, not only a nominal screenshot.
      for (const width of [320, 460]) for (const height of [440, 960]) {
        await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        for (const confirmation of [false, true]) {
          const parameters = { width, height, confirmation, blocked };
          report.checks.push({ name: 'settings footer geometry, scrolling and action reachability',
            result: await evaluate('ArchitectureDiagnosticsSmoke.layout(' + JSON.stringify(parameters) + ')') });
          if (width === 320 && height === 440 || width === 460 && height === 960) {
            await screenshot('logs-' + language + '-' + width + 'x' + height + (blocked ? '-blocked' : '-ready') + (confirmation ? '-confirm' : ''));
          }
          if (confirmation) await evaluate('ArchitectureDiagnosticsSmoke.dismissConfirmation()');
        }
      }
      await call('Emulation.setDeviceMetricsOverride', { width: 460, height: 960, deviceScaleFactor: 1, mobile: false });
    };
    // 成功反馈只有 3 秒；复制与观察起点必须处于同一浏览器调用，不能让宿主
    // 跨 CDP 调度消耗观察窗口。仍执行原断言及 3200ms 等待，并独立记录两项结果。
    const copyThenExpire = async prefix => {
      const results = await evaluate('(async () => { const results = []; for (const action of ["copy", "feedbackExpires"]) results.push({ action, result: await ArchitectureDiagnosticsSmoke[action]() }); return results; })()');
      for (const { action, result } of results) report.checks.push({ name: prefix + action, result });
    };
    for (const language of ['zh-CN', 'zh-TW', 'en', 'ja']) {
      report.checks.push({ name: 'central language switch', result: await evaluate('ArchitectureSmoke.language(' + JSON.stringify(language) + ')') });
      report.checks.push({ name: 'diagnostics UI translated', result: await evaluate('ArchitectureDiagnosticsSmoke.labels(' + JSON.stringify(language) + ')') });
      for (const route of ['time', 'titles', 'favorites', 'bookmarks', 'search', 'export', 'settings']) {
        report.checks.push({ name: 'real route visible', result: await evaluate('ArchitectureSmoke.route(' + JSON.stringify(route) + ')') });
        if (language === 'zh-CN') await screenshot(route);
      }
      report.checks.push({ name: 'seven routes keep logs owned by settings only', result: await evaluate('ArchitectureDiagnosticsSmoke.routes()') });
      await layoutMatrix(language, false);
      for (const action of ['copy', 'cancelClear', 'clear']) {
        report.checks.push({ name: 'settings log UI ' + action, result: await evaluate('ArchitectureDiagnosticsSmoke.' + action + '()') });
      }
      await copyThenExpire('settings log UI ');
      report.checks.push({ name: 'refresh-required hides business controls but keeps settings log route', result: await evaluate('ArchitectureDiagnosticsSmoke.blockPage()') });
      await layoutMatrix(language, true);
      for (const action of ['copy', 'cancelClear', 'clear']) {
        report.checks.push({ name: 'refresh-required settings log UI ' + action, result: await evaluate('ArchitectureDiagnosticsSmoke.' + action + '()') });
      }
      await copyThenExpire('refresh-required settings log UI ');
      report.checks.push({ name: 'fresh-document recovery restores controls without moving logs', result: await evaluate('ArchitectureDiagnosticsSmoke.recoverPage()') });
      report.checks.push({ name: 'recovered seven routes keep logs in settings', result: await evaluate('ArchitectureDiagnosticsSmoke.routes()') });
    }
    report.diagnosticsHost = await evaluate('ArchitectureDiagnosticsSmoke.report()');
    report.fixture = await evaluate('ArchitectureSmoke.report()');
    report.loadedResources = [...new Set(requestUrls.values())].filter(url => url.startsWith('file:')).length;
    if (report.loadingFailures.length || report.badResponses.length || report.exceptions.length || report.externalRequests.length) throw Error('Resource, JavaScript, or network isolation check failed');
    report.ok = true;
  } catch (error) { report.error = error.stack || String(error); }
  finally {
    report.finishedSourceFingerprint = sourceFingerprint();
    report.sourceStable = report.sourceFingerprint === report.finishedSourceFingerprint;
    report.ok = report.ok && report.sourceStable;
    try { if (socket?.readyState === WebSocket.OPEN) { await call('Browser.close'); socket.close(); } } catch {}
    if (child.exitCode === null) child.kill();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

async function main() {
  // Keep the normal scratch root available on a fresh checkout; an explicit
  // TIDY_BROWSER_ARTIFACT_ROOT follows the shared browser-fixture convention.
  fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  fs.mkdirSync(browserArtifactRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(browserArtifactRoot, 'seven-column-smoke-'));
  if (process.argv.includes('--prepare')) {
    const prepared = path.join(base, 'prepared'); fs.mkdirSync(prepared); prepare(prepared); console.log(prepared); return;
  }
  // Match the existing browser check CLI: pass absolute executable paths to
  // choose browsers. With no arguments, check both installed Chrome and Edge.
  const explicit = process.argv.slice(2);
  const available = explicit.length
    ? explicit.map((executable, index) => ['browser-' + (index + 1), executable])
    : [
      ['chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    ].filter(([, executable]) => fs.existsSync(executable));
  if (!available.length) throw Error('No supported browser found. Supply absolute Chromium executable paths.');
  for (const [, executable] of available) {
    if (!path.isAbsolute(executable) || !fs.existsSync(executable) || !fs.statSync(executable).isFile()) throw Error('Missing absolute browser executable: ' + executable);
  }
  const results = [];
  for (const [name, executable] of available) {
    const report = await run(name, executable, base); results.push(report);
    console.log(JSON.stringify({ browser: name, ok: report.ok, sourceStable: report.sourceStable, checks: report.checks.length, error: report.error, evidence: path.join(base, name, 'report.json') }));
  }
  const summary = { ok: results.every(report => report.ok), browserCount: results.length, featureLanguageCombinationsPerBrowser: 28, logLayoutCasesPerBrowser: 64, logOperationsPerBrowser: 40, results: results.map(report => ({ browser: report.browser, ok: report.ok, sourceStable: report.sourceStable, sourceFingerprint: report.sourceFingerprint, checks: report.checks.length, error: report.error })) };
  fs.writeFileSync(path.join(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('Evidence: ' + base); process.exitCode = summary.ok ? 0 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
