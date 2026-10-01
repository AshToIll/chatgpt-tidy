const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const runner = fs.readFileSync(path.join(root, 'tools/check-plugin-navigation-browser.cjs'), 'utf8');

// 只在 VM 内模拟文件和浏览器回包；不创建目录、启动浏览器或读取真实用户资料。
function runFixture(stdout) {
  const browserArtifactRoot = path.join(root, 'mock-browser-artifacts');
  const output = path.join(browserArtifactRoot, 'plugin-navigation-browser-one-run');
  const writes = new Map();
  const logs = [];
  const process = { argv: ['node', 'runner', 'mock-chromium'], exitCode: undefined };
  let spawnCount = 0;
  const fakeFs = {
    mkdirSync(directory) { assert.equal(directory, browserArtifactRoot); },
    mkdtempSync(prefix) {
      assert.equal(prefix, path.join(browserArtifactRoot, 'plugin-navigation-browser-'));
      return output;
    },
    readFileSync(filename) {
      if (filename === path.join(root, 'src/app/sidepanel/panel.js')) {
        return 'const panelOwnerTabId = parsePanelOwnerTabId(globalThis.location?.href, chrome.runtime.getURL("app/sidepanel/index.html"));';
      }
      assert.equal(filename, path.join(root, 'src/app/sidepanel/index.html'));
      return '<html><head><script src="panel.js"></script></head><body></body></html>';
    },
    writeFileSync(filename, bytes) { writes.set(filename, bytes); },
  };
  const childProcess = {
    spawnSync(executable, args) {
      spawnCount += 1;
      assert.equal(executable, 'mock-chromium');
      assert.ok(args.includes('--dump-dom'));
      return { stdout, stderr: '' };
    },
  };
  const modules = {
    'node:fs': fakeFs, 'node:path': path, 'node:child_process': childProcess,
    'node:url': { pathToFileURL }, './browser-fixture.cjs': { browserArtifactRoot },
  };
  let error;
  try {
    vm.runInNewContext(runner, {
      require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected module: ${name}`); return modules[name]; },
      __dirname: path.join(root, 'tools'), process, console: { log(value) { logs.push(value); } },
    }, { filename: 'check-plugin-navigation-browser.cjs' });
  } catch (cause) { error = cause; }
  assert.equal(spawnCount, 1);
  return {
    writes, logs, process, error,
    runReport: path.join(output, 'report.json'),
    latestReport: path.join(browserArtifactRoot, 'plugin-navigation-browser.json'),
    resultHtml: path.join(output, 'result.html'),
  };
}

function completeDom(report) {
  const encoded = JSON.stringify(report).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<pre id="qa-results" data-complete="true">${encoded}</pre>`;
}

for (const ok of [true, false]) {
  test(`plugin navigation ${ok ? 'passing' : 'failing'} run saves its own report and identical latest report`, () => {
    const report = { ok, checks: [{ label: 'sample <check> & evidence', ok }] };
    const stdout = completeDom(report);
    const actual = runFixture(stdout);
    assert.equal(actual.error, undefined);
    const expected = JSON.stringify(report, null, 2);
    assert.equal(actual.writes.get(actual.runReport), expected, 'each completed run owns a report.json');
    assert.equal(actual.writes.get(actual.latestReport), expected, 'latest report remains byte-identical');
    assert.equal(actual.writes.get(actual.resultHtml), stdout);
    assert.deepEqual(actual.logs, [expected]);
    assert.equal(actual.process.exitCode, ok ? 0 : 1);
  });
}

test('plugin navigation without completion retains raw output but does not invent a report', () => {
  const stdout = '<pre id="qa-results">{"ok":true}</pre>';
  const actual = runFixture(stdout);
  assert.match(actual.error?.message || '', /Browser fixture did not finish/);
  assert.equal(actual.writes.get(actual.resultHtml), stdout);
  assert.equal(actual.writes.has(actual.runReport), false);
  assert.equal(actual.writes.has(actual.latestReport), false);
  assert.deepEqual(actual.logs, []);
  assert.equal(actual.process.exitCode, undefined);
});
