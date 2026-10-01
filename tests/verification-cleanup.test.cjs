'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { planCleanup, createArchiveManifest, runCleanup, sourceFingerprint } = require('../tools/clean-verification.cjs');

// All deletion tests use new synthetic OS-temp repositories. Never import the
// current checkout's .tmp contents or touch a real browser/user-data directory.
function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'tidy-verification-cleanup-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), base);
    assert.match(path.basename(resolved), /^tidy-verification-cleanup-[A-Za-z0-9]{6}$/);
    fs.rmSync(resolved, { recursive: true });
  });
  function write(name, value = 'synthetic\n') {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
    return file;
  }
  write('package.json', { name: 'chatgpt-tidy', version: '0.5.0' });
  write('src/manifest.json', { version: '0.5.0' });
  write('tools/example.cjs');
  write('tests/example.test.cjs');
  write('.git/HEAD', 'synthetic repository metadata');
  write('dist/do-not-delete.zip');
  write('node_modules/do-not-delete.txt');
  const report = '.tmp/release-verification-Abc123/report.json';
  write(report, { ok: true, checks: [], sourceFingerprint: 'a'.repeat(64) });
  function archive() {
    const archived = '.artifacts/verification/synthetic/report.json';
    write(archived, fs.readFileSync(path.join(root, report)));
    const manifest = createArchiveManifest(root, [{ originalPath: report, archivedPath: archived }]);
    const file = write('.artifacts/verification/synthetic/manifest.json', manifest);
    return { file, manifest, archived };
  }
  return { root, write, report, archive, exists: name => fs.existsSync(path.join(root, name)) };
}

test('dry-run is the default and does not write, remove, or create evidence', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.root, f.report));
  const result = runCleanup({ root: f.root });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.targets.map(item => item.path), ['.tmp/release-verification-Abc123']);
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.report)), before);
  assert.equal(f.exists('.artifacts'), false);
});

test('apply requires a manifest before touching any output', t => {
  const f = fixture(t);
  assert.throws(() => runCleanup({ root: f.root, apply: true }), /requires --archive-manifest/);
  assert.ok(f.exists(f.report));
});

test('validated apply removes only recognized output and preserves protected roots and unknowns', t => {
  const f = fixture(t);
  f.write('.tmp/not-a-test/profile/keep.txt');
  f.write('tmp/unknown.txt');
  f.write('.tmp-similar/keep.txt');
  f.write('.tmp/deep-refactor/export-i18n/en.txt');
  f.write('.tmp/deep-refactor/manual-notes.txt');
  const { file } = f.archive();
  const result = runCleanup({ root: f.root, apply: true, archiveManifest: file });
  assert.deepEqual(result.deleted, ['.tmp/deep-refactor/export-i18n', '.tmp/release-verification-Abc123']);
  for (const name of ['src/manifest.json', '.git/HEAD', 'dist/do-not-delete.zip', 'node_modules/do-not-delete.txt',
    '.tmp/not-a-test/profile/keep.txt', 'tmp/unknown.txt', '.tmp-similar/keep.txt', '.tmp/deep-refactor/manual-notes.txt',
    '.artifacts/verification/synthetic/report.json', '.artifacts/verification/synthetic/manifest.json']) assert.ok(f.exists(name), name);
  assert.equal(f.exists(f.report), false);
});

test('an unknown export member retains the entire directory', t => {
  const f = fixture(t);
  f.write('tmp/export-i18n/en.txt');
  f.write('tmp/export-i18n/user-data.txt');
  const plan = planCleanup(f.root);
  assert.ok(plan.retained.some(item => item.path === 'tmp/export-i18n'));
  assert.ok(!plan.targets.some(item => item.path === 'tmp/export-i18n'));
});

test('exact browser prefix and structured receipt are both required, including failed receipts', t => {
  const f = fixture(t);
  f.write('.tmp/bookmark-theme-browser-Abc123/report.json', { ok: false, error: 'synthetic failure' });
  f.write('.tmp/my-browser-Abc123/report.json', { ok: true, checks: [] });
  f.write('.tmp/bookmark-theme-browser-Abc1234/report.json', { ok: true, checks: [] });
  f.write('.tmp/bookmark-theme-browser-Qwe123/profile/user-data.txt');
  const plan = planCleanup(f.root);
  assert.ok(plan.targets.some(item => item.path === '.tmp/bookmark-theme-browser-Abc123'));
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.retained.length, 3);
});

test('source edits invalidate an older evidence manifest', t => {
  const f = fixture(t), { file } = f.archive();
  const before = sourceFingerprint(f.root);
  f.write('src/new-source.js', 'final source changed');
  assert.notEqual(sourceFingerprint(f.root), before);
  assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: file }), /Source changed since archive/);
  assert.ok(f.exists(f.report));
});

test('README translations participate in the protected source fingerprint', t => {
  const f = fixture(t);
  for (const name of ['README.en.md', 'README.ja.md']) {
    f.write(name, 'synthetic translation');
    const before = sourceFingerprint(f.root);
    f.write(name, 'revised translation');
    assert.notEqual(sourceFingerprint(f.root), before, name);
  }
});

test('new output, changed contents, and changed file timestamps all invalidate a plan', t => {
  const f = fixture(t), { file } = f.archive();
  f.write('.tmp/release-verification-Abc123/new.log');
  assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: file }), /Cleanup plan changed/);
  const second = f.archive();
  f.write('.tmp/release-verification-Abc123/new.log', 'replaced');
  assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: second.file }), /Cleanup plan changed/);
  const third = f.archive(), target = path.join(f.root, '.tmp/release-verification-Abc123/new.log');
  fs.utimesSync(target, new Date(), new Date(Date.now() + 10000));
  assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: third.file }), /Cleanup plan changed/);
  assert.ok(f.exists(f.report));
});

test('a new recognized target cannot be authorized by an old manifest', t => {
  const f = fixture(t), { file } = f.archive();
  f.write('tmp/export-i18n/en.txt');
  assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: file }), /Cleanup plan changed/);
  assert.ok(f.exists('tmp/export-i18n/en.txt'));
});

test('missing and corrupted archived evidence abort all deletion', t => {
  const f = fixture(t), first = f.archive();
  f.write(first.archived, 'corrupted evidence');
  assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: first.file }), /Archived evidence differs/);
  const second = f.archive();
  fs.unlinkSync(path.join(f.root, second.archived));
  assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: second.file }), /ENOENT|Reparse\/metadata/);
  assert.ok(f.exists(f.report));
});

test('schema, root, bytes and hash are mandatory; empty preserved evidence is refused', t => {
  const f = fixture(t);
  assert.throws(() => createArchiveManifest(f.root, []), /At least one/);
  for (const mutate of [
    manifest => { manifest.schema = 'untrusted/v0'; },
    manifest => { manifest.root += '-similar'; },
    manifest => { delete manifest.archivedFiles[0].sha256; },
    manifest => { manifest.archivedFiles[0].bytes++; },
    manifest => { manifest.archivedFiles = []; },
  ]) {
    const { file, manifest } = f.archive();
    mutate(manifest); fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: file }));
    assert.ok(f.exists(f.report));
  }
});

test('manifest locations outside the exact archive subtree are refused', t => {
  const f = fixture(t), { manifest } = f.archive();
  for (const name of ['.artifacts/verification-similar/run/manifest.json', '.tmp/manifest.json',
    '.artifacts/verification/manifest.json', '.artifacts/verification/run/not-manifest.json']) {
    const file = f.write(name, manifest);
    assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: file }), /manifest path|Archive must/);
  }
  assert.ok(f.exists(f.report));
});

test('evidence path traversal, absolute paths, ADS and prefix-similar paths are refused', t => {
  const f = fixture(t), { archived } = f.archive();
  for (const originalPath of ['../outside.txt', '/outside.txt', 'C:/outside.txt', '.tmp/../src/manifest.json',
    '.tmp-similar/report.json', '.tmp/file.txt:secret', '.tmp/dir./file.txt', '.tmp\\file.txt']) {
    assert.throws(() => createArchiveManifest(f.root, [{ originalPath, archivedPath: archived }]));
  }
  for (const archivedPath of ['../outside.txt', '.artifacts/verification-similar/run/report.json', 'src/manifest.json']) {
    assert.throws(() => createArchiveManifest(f.root, [{ originalPath: f.report, archivedPath }]));
  }
  assert.ok(f.exists(f.report));
});

test('directory junctions or symlinks are retained, never followed into targets', t => {
  const f = fixture(t);
  f.write('outside-synthetic/report.json', { ok: true, checks: [] });
  fs.symlinkSync(path.join(f.root, 'outside-synthetic'), path.join(f.root, '.tmp/bookmark-theme-browser-Abc123'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const plan = planCleanup(f.root);
  assert.ok(plan.retained.some(item => item.path === '.tmp/bookmark-theme-browser-Abc123'));
  assert.ok(!plan.targets.some(item => item.path === '.tmp/bookmark-theme-browser-Abc123'));
  const { file } = f.archive();
  runCleanup({ root: f.root, apply: true, archiveManifest: file });
  assert.ok(f.exists('outside-synthetic/report.json'));
  assert.ok(fs.lstatSync(path.join(f.root, '.tmp/bookmark-theme-browser-Abc123')).isSymbolicLink());
});

test('links inside a recognized tree prevent deleting that tree', t => {
  const f = fixture(t);
  f.write('outside-synthetic/keep.txt');
  fs.symlinkSync(path.join(f.root, 'outside-synthetic'), path.join(f.root, '.tmp/release-verification-Abc123/linked'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const plan = planCleanup(f.root);
  assert.equal(plan.targets.length, 0);
  assert.match(plan.retained[0].reason, /[Ll]ink|[Rr]eparse/);
  assert.ok(f.exists('outside-synthetic/keep.txt'));
});

test('linked temporary boundaries and linked archive ancestors are refused', t => {
  const f = fixture(t);
  f.write('outside-synthetic/keep.txt');
  fs.symlinkSync(path.join(f.root, 'outside-synthetic'), path.join(f.root, 'tmp'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => planCleanup(f.root), /Linked|reparse/);
  fs.unlinkSync(path.join(f.root, 'tmp'));
  const { file } = f.archive();
  fs.renameSync(path.join(f.root, '.artifacts/verification/synthetic'), path.join(f.root, 'saved-evidence'));
  fs.symlinkSync(path.join(f.root, 'saved-evidence'), path.join(f.root, '.artifacts/verification/synthetic'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: file }), /Linked|[Rr]eparse/);
  assert.ok(f.exists(f.report));
});

test('only the exact historic baseline checkout with matching recorded HEAD is recognized', t => {
  const f = fixture(t), base = '.tmp/architecture-baseline/checkout', head = 'c6248d51517503b2844d27ed9b9eddf03c7e5bc9';
  f.write('.tmp/architecture-baseline/summary.json', { head, source040Modified: false });
  f.write(base + '/package.json', { name: 'chatgpt-tidy', version: '0.4.0' });
  f.write(base + '/src/manifest.json', { version: '0.4.0' });
  f.write(base + '/.git/HEAD', head);
  let plan = planCleanup(f.root);
  assert.ok(plan.targets.some(item => item.path === base && item.kind === 'architecture-baseline-checkout'));
  f.write(base + '/.git/HEAD', 'd'.repeat(40));
  plan = planCleanup(f.root);
  assert.ok(!plan.targets.some(item => item.path === base));
  f.write('.tmp/bookmark-theme-browser-Abc123/report.json', { ok: true, checks: [] });
  f.write('.tmp/bookmark-theme-browser-Abc123/.git/HEAD', head);
  plan = planCleanup(f.root);
  assert.ok(!plan.targets.some(item => item.path === '.tmp/bookmark-theme-browser-Abc123'));
  assert.ok(plan.retained.some(item => /Nested repository/.test(item.reason)));
});

test('CLI defaults are documented and unknown flags never start cleanup', () => {
  const script = path.resolve(__dirname, '../tools/clean-verification.cjs');
  const result = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown or incomplete argument/);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Default is dry-run/);
});

test('a file arriving during deletion survives and prevents removing its directory', t => {
  const f = fixture(t), { file } = f.archive(), unlink = fs.unlinkSync;
  let injected = false;
  t.mock.method(fs, 'unlinkSync', function(target, ...args) {
    if (!injected && path.resolve(target) === path.join(f.root, f.report)) {
      injected = true;
      f.write('.tmp/release-verification-Abc123/late-unknown.txt', 'must survive');
    }
    return unlink.call(fs, target, ...args);
  });
  assert.throws(() => runCleanup({ root: f.root, apply: true, archiveManifest: file }), /ENOTEMPTY|EEXIST/);
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(path.join(f.root, '.tmp/release-verification-Abc123/late-unknown.txt'), 'utf8'), 'must survive');
  assert.ok(f.exists('.artifacts/verification/synthetic/report.json'));
});
