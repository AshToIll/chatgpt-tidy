const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { verifyThirdParty } = require('../tools/check-third-party.cjs');
const { listSourceFiles, listSourceBundleFiles } = require('../tools/package-extension.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const temporary = path.resolve(__dirname, '../.tmp'); fs.mkdirSync(temporary, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporary, 'third-party-evidence-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(temporary) || !/^third-party-evidence-[A-Za-z0-9]{6}$/.test(path.basename(resolved))) throw Error('Unexpected fixture path');
    fs.rmSync(resolved, { recursive: true });
  });
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), typeof value === 'object' ? JSON.stringify(value) : value);
  };
  const vendor = { bundles: [{ local_file: 'src/vendor/library.js', sha256: hash('library') }],
    notices: [{ file: 'library-LICENSE.txt', sha256: hash('notice') }], open_gaps: ['Synthetic known notice gap'] };
  const fonts = { families: [{ id: 'synthetic', local_name_records: { 0: ['Synthetic author'] },
    license_file: 'licenses/OFL.txt', license_sha256: hash('font notice'), files: [{ file: 'font.ttf', sha256: hash('font') }] }],
    open_gaps: ['Synthetic known provenance gap'] };
  const dependency = { package: 'fake-indexeddb', version: '6.2.5', lock_path: 'node_modules/fake-indexeddb',
    scope: 'test-only', license: 'Apache-2.0', source_tarball: 'synthetic.tgz', integrity: 'synthetic-integrity',
    license_file: 'docs/licenses/test-LICENSE.txt', license_sha256: hash('test notice') };
  const lock = { packages: { '': { devDependencies: { 'fake-indexeddb': '6.2.5' } },
    [dependency.lock_path]: { version: dependency.version, license: dependency.license, dev: true,
      resolved: dependency.source_tarball, integrity: dependency.integrity } } };
  write('src/vendor/library.js', 'library'); write('src/vendor/licenses/library-LICENSE.txt', 'notice');
  write('src/vendor/licenses/SOURCES.json', vendor); write('src/vendor/licenses/SOURCES.md', 'index');
  write('src/assets/fonts/font.ttf', 'font'); write('src/assets/fonts/licenses/OFL.txt', 'font notice');
  write('src/assets/fonts/SOURCES.json', fonts); write('docs/licenses/test-LICENSE.txt', 'test notice');
  write('docs/current/DEVELOPMENT_DEPENDENCIES.json', { dependencies: [dependency] });
  write('package.json', { devDependencies: { 'fake-indexeddb': '6.2.5' } }); write('package-lock.json', lock);
  return { root, write, vendor, fonts, dependency, lock };
}

test('current third-party evidence covers every shipped library and font without claiming gaps closed', () => {
  const result = verifyThirdParty();
  assert.equal(result.ok, true); assert.equal(result.runtimeLibraries, 4);
  assert.equal(result.fontFamilies, 24); assert.equal(result.fontFiles, 355);
  assert.equal(result.developmentDependencies, 1);
  assert.ok(result.upstreamNoticeGaps.some(gap => gap.includes('@pdf-lib/fontkit')));
  assert.ok(result.fontProvenanceGaps.length > 0);
});

test('source-only dependency license is excluded from the extension but included with independent verification tools', () => {
  const source = listSourceBundleFiles(), extension = listSourceFiles();
  for (const name of ['docs/current/DEVELOPMENT_DEPENDENCIES.json', 'docs/licenses/fake-indexeddb-6.2.5-LICENSE.txt', 'tools/check-third-party.cjs']) {
    assert.ok(source.includes(name)); assert.ok(!extension.includes(name));
  }
  assert.ok(extension.includes('assets/fonts/licenses/OFL-noto-sans-jp.txt'));
  assert.ok(extension.includes('vendor/licenses/fontkit-node-NOTICES.txt'));
  assert.ok(extension.every(name => !name.includes('node_modules') && !name.includes('fake-indexeddb')));
});

test('checked file integrity never clears explicitly recorded upstream gaps', t => {
  const { root } = fixture(t), result = verifyThirdParty(root);
  assert.deepEqual(result.upstreamNoticeGaps, ['Synthetic known notice gap']);
  assert.deepEqual(result.fontProvenanceGaps, ['Synthetic known provenance gap']);
});

for (const [label, name] of [['runtime', 'src/vendor/library.js'], ['notice', 'src/vendor/licenses/library-LICENSE.txt'],
  ['font', 'src/assets/fonts/font.ttf'], ['font notice', 'src/assets/fonts/licenses/OFL.txt'], ['development notice', 'docs/licenses/test-LICENSE.txt']]) {
  test(`changed ${label} bytes fail the evidence gate`, t => {
    const { root, write } = fixture(t); write(name, 'changed');
    assert.throws(() => verifyThirdParty(root), /hash mismatch/);
  });
}

for (const name of ['src/vendor/extra.js', 'src/vendor/licenses/extra-LICENSE.txt', 'src/assets/fonts/extra.ttf', 'src/assets/fonts/licenses/extra.txt']) {
  test(`unregistered third-party input is not silently packaged: ${name}`, t => {
    const { root, write } = fixture(t); write(name, 'extra');
    assert.throws(() => verifyThirdParty(root), /inventory does not match/);
  });
}

test('missing original license blocks packaging rather than retaining a broken online-only reference', t => {
  const { root } = fixture(t); fs.unlinkSync(path.join(root, 'src/vendor/licenses/library-LICENSE.txt'));
  assert.throws(() => verifyThirdParty(root), /ENOENT/);
});

test('dependency version/lock changes require refreshed license evidence', t => {
  const { root, write, lock } = fixture(t); lock.packages['node_modules/fake-indexeddb'].version = '9.0.0';
  write('package-lock.json', lock);
  assert.throws(() => verifyThirdParty(root), /Development dependency evidence mismatch/);
});

test('unregistered dependency is rejected instead of assumed covered by another package license', t => {
  const { root, write, lock } = fixture(t); lock.packages['node_modules/new-package'] = { version: '1.0.0', dev: true };
  write('package-lock.json', lock);
  assert.throws(() => verifyThirdParty(root), /Development dependency inventory/);
});

test('duplicate font entries and traversal paths fail closed', t => {
  const { root, write, fonts, vendor } = fixture(t); fonts.families.push(fonts.families[0]);
  write('src/assets/fonts/SOURCES.json', fonts);
  assert.throws(() => verifyThirdParty(root), /duplicate font family/);
  vendor.bundles[0].local_file = '../outside.js'; write('src/vendor/licenses/SOURCES.json', vendor);
  assert.throws(() => verifyThirdParty(root), /Unsafe evidence path/);
});
