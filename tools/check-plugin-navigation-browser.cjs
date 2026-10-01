// Full production Side Panel + native Chromium DOM regression. Chrome IPC is
// synthetic: no real account, network, browser profile or saved data is touched.
// The only panel-source substitution is its immutable tab ID, because file://
// fixtures deliberately cannot impersonate a chrome-extension:// owner URL.
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { browserArtifactRoot } = require('./browser-fixture.cjs');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(browserArtifactRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(browserArtifactRoot, 'plugin-navigation-browser-'));
const panelPath = path.join(root, 'src/app/sidepanel/panel.js');
const ownerSeam = /const panelOwnerTabId = parsePanelOwnerTabId\(\s*globalThis\.location\?\.href,\s*chrome\.runtime\.getURL\("app\/sidepanel\/index\.html"\)\s*,?\s*\);/;
let panel = fs.readFileSync(panelPath, 'utf8');
if (!ownerSeam.test(panel)) throw new Error('Production panel owner seam changed; do not weaken owner validation.');
panel = panel.replace(ownerSeam, 'const panelOwnerTabId = 31;');
// 夹具把入口移动到临时目录，具名导入与仅执行共享模块的 import 都要按原目录解析。
panel = panel.replace(/(\b(?:from|import)\s*["'])(\.\.?\/[^"']+)(["'])/g,
  (_, before, relative, after) => before + pathToFileURL(path.resolve(path.dirname(panelPath), relative)).href + after);
const fixtureUrl = pathToFileURL(path.join(root, 'tests/browser/plugin-navigation.mjs')).href;
// Static imports make Chromium wait for every local module before spending its
// virtual-time budget. A dynamic import here can race --dump-dom on cold I/O.
panel = `import { runPanelChecks } from ${JSON.stringify(fixtureUrl)};\n` + panel + '\nvoid runPanelChecks();\n';
fs.writeFileSync(path.join(output, 'panel.mjs'), panel);
let html = fs.readFileSync(path.join(root, 'src/app/sidepanel/index.html'), 'utf8');
html = html.replace(/((?:src|href)=["'])([^"']+)(["'])/g, (_, before, relative, after) =>
  before + pathToFileURL(path.resolve(root, 'src/app/sidepanel', relative)).href + after);
const panelUrl = pathToFileURL(panelPath).href;
html = html.replace(panelUrl, pathToFileURL(path.join(output, 'panel.mjs')).href).replace('</head>', `
<style>.time-panel{width:360px;margin-left:auto}#qa-chat{position:fixed;left:20px;top:20px;width:620px;height:600px;overflow:auto;background:#fff;color:#222}#qa-chat article{height:220px;padding:20px}#qa-results{position:fixed;left:20px;top:650px;background:white;color:black;white-space:pre-wrap;max-width:600px}</style></head>`);
html = html.replace('<body>', '<body><section id="qa-chat" aria-label="Synthetic native chat"></section><pre id="qa-results"></pre>');
const htmlPath = path.join(output, 'index.html');
fs.writeFileSync(htmlPath, html);
const executable = process.argv[2] || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
if (!executable) throw new Error('An installed Chromium executable is required.');
const result = spawnSync(executable, ['--headless=new', '--disable-gpu', '--disable-extensions',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
  '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
  '--allow-file-access-from-files', '--window-size=1100,950', `--user-data-dir=${path.join(output, 'profile')}`,
  '--dump-dom', '--virtual-time-budget=40000', pathToFileURL(htmlPath).href],
{ encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 12 * 1024 * 1024 });
fs.writeFileSync(path.join(output, 'result.html'), result.stdout || '');
const data = /<pre id="qa-results" data-complete="true">([\s\S]*?)<\/pre>/.exec(result.stdout || '')?.[1];
if (!data) throw new Error(result.error?.message || `Browser fixture did not finish. ${result.stderr?.slice(-1000)}`);
const report = JSON.parse(data.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
// 每次完成的运行都保存自己的结果，清理验证产物时不依赖会被覆盖的全局最新报告。
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(browserArtifactRoot, 'plugin-navigation-browser.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
