const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { listSourceBundleFiles, readInputFile } = require('./package-extension.cjs');

const root = path.resolve(__dirname, '..');
// Node now includes real Windows cleanup-path audits. Keep its larger budget
// separate: individual browser checks retain their existing three-minute limit.
const childTimeout = browser => browser ? 180000 : 600000;
const browserChecks = [
  ['page-session', 'tools/check-page-session-browser.cjs'],
  ['toolbar-theme', 'tools/check-toolbar-theme-browser.cjs'],
  ['export-jobs', 'tools/check-export-jobs-browser.cjs'],
  ['export-images', 'tools/check-export-images-browser.cjs'],
  ['export-keyboard', 'tools/check-export-keyboard-browser.cjs'],
  ['panel-current-protocol', 'tools/check-plugin-navigation-browser.cjs'],
  ['library-lifecycle', 'tools/check-library-lifecycle-browser.cjs'],
  ['library-backup', 'tools/check-library-backup-browser.cjs'],
  ['panel-theme', 'tools/check-panel-theme-browser.cjs'],
  ['bookmark-theme', 'tools/check-bookmark-theme-browser.cjs'],
  ['message-landing', 'tools/check-bookmark-landing-browser.cjs'],
  ['sidebar-navigation', 'tools/check-sidebar-navigation-browser.cjs'],
  ['native-sidebar-navigation', 'tools/check-sidebar-navigation-browser.cjs', '--native'],
];
const browserDefaults = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

function sourceFingerprint() {
  const hash = createHash('sha256');
  for (const name of listSourceBundleFiles()) {
    hash.update(name + '\0');
    hash.update(createHash('sha256').update(readInputFile(root, name)).digest());
  }
  return hash.digest('hex');
}

// A child exit and its structured browser receipt must both agree. Passing
// Node tests never turns an unavailable/failed browser check into a success.
function classifyChild(child, browser = false) {
  let receipt = null;
  if (browser) {
    try { receipt = JSON.parse(child.stdout); } catch { /* Missing receipt is a failure. */ }
  }
  return {
    ok: !child.error && !child.signal && child.status === 0 && (!browser || receipt?.ok === true),
    exitCode: child.status, signal: child.signal || null, error: child.error?.message || null,
    ...(browser ? { receipt } : {}),
  };
}

function main() {
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const output = fs.mkdtempSync(path.join(root, '.tmp/release-verification-'));
  const explicit = process.argv.slice(2);
  const browsers = explicit.length ? explicit : browserDefaults.filter(file => fs.existsSync(file));
  const report = { startedAt: new Date().toISOString(), node: process.version, sourceFingerprint: sourceFingerprint(),
    browserExecutables: browsers,
    scope: 'Automated source and isolated browser checks only',
    liveExtensionAcceptance: 'not-run', candidateInstallAcceptance: 'not-run', checks: [] };
  function run(name, args, browser = false) {
    const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', shell: false,
      windowsHide: true, timeout: childTimeout(browser), maxBuffer: 16 * 1024 * 1024 });
    fs.writeFileSync(path.join(output, `${name}.log`), (child.stdout || '') + (child.stderr || ''));
    const result = { name, ...classifyChild(child, browser) };
    report.checks.push(result);
    console.log(`[release-verify] ${name}: ${result.ok ? 'PASS' : 'FAIL'}`);
    return result.ok;
  }
  if (run('source-tests', ['tools/verify.cjs'])) {
    if (!browsers.length) report.checks.push({ name: 'browser-availability', ok: false, error: 'No Chromium executable found. Supply absolute Chrome/Edge paths.' });
    for (const [index, executable] of browsers.entries()) {
      if (!path.isAbsolute(executable) || !fs.existsSync(executable)) {
        report.checks.push({ name: `browser-${index + 1}`, ok: false, error: `Missing browser: ${executable}` });
        continue;
      }
      for (const [name, script, ...args] of browserChecks) run(`browser-${index + 1}-${name}`, [script, executable, ...args], true);
    }
  }
  // A long browser run must not silently combine receipts from different
  // source revisions while another editor changes the working tree.
  report.finishedSourceFingerprint = sourceFingerprint();
  report.checks.push({ name: 'source-stability', ok: report.sourceFingerprint === report.finishedSourceFingerprint });
  report.ok = report.checks.every(check => check.ok);
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[release-verify] Evidence: ${output}`);
  console.log('[release-verify] Real account, installed-extension and candidate-package acceptance remain NOT RUN.');
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = { classifyChild, browserChecks, sourceFingerprint, childTimeout };
if (require.main === module) main();
