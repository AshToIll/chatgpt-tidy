const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const projectRoot = path.resolve(__dirname, '..');

// 这里只检查交付材料，不联网、不更新依赖，也不把“文件齐全”当作上游许可缺口已解决。
function verifyThirdParty(root = projectRoot) {
  function checkedPath(name) {
    if (!name || name.includes('\\') || name.includes(':') || name.startsWith('/')
      || name.split('/').some(part => !part || part === '.' || part === '..')) throw Error(`Unsafe evidence path: ${name}`);
    let current = root;
    for (const part of ['', ...name.split('/')]) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw Error(`Linked evidence input: ${name}`);
    }
    return current;
  }
  const bytes = name => fs.readFileSync(checkedPath(name));
  const json = name => JSON.parse(bytes(name));
  const relative = (base, name) => path.posix.normalize(base + '/' + name);
  const listed = (directory, include) => {
    const files = [];
    for (const entry of fs.readdirSync(checkedPath(directory), { withFileTypes: true })) {
      const name = directory + '/' + entry.name;
      if (entry.isSymbolicLink()) throw Error(`Linked evidence input: ${name}`);
      if (entry.isDirectory()) files.push(...listed(name, include));
      else if (include(name)) files.push(name);
    }
    return files;
  };
  function sameFiles(actual, expected, label) {
    if (new Set(expected).size !== expected.length) throw Error(`Duplicate ${label} inventory entry`);
    if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw Error(`${label} inventory does not match local files`);
  }
  function checkedHash(name, expected) {
    if (!/^[a-f0-9]{64}$/.test(expected || '') || sha256(bytes(name)) !== expected) throw Error(`Third-party hash mismatch: ${name}`);
  }

  const vendor = json('src/vendor/licenses/SOURCES.json');
  if (!vendor.bundles?.length || !vendor.notices?.length || !Array.isArray(vendor.open_gaps)) throw Error('Incomplete vendor evidence index');
  for (const entry of vendor.bundles) checkedHash(entry.local_file, entry.sha256);
  for (const entry of vendor.notices) checkedHash(relative('src/vendor/licenses', entry.file), entry.sha256);
  sameFiles(listed('src/vendor', name => name.endsWith('.js')), vendor.bundles.map(entry => entry.local_file), 'Vendor JavaScript');
  sameFiles(listed('src/vendor/licenses', name => !/\/SOURCES\.(?:json|md)$/.test(name)),
    vendor.notices.map(entry => relative('src/vendor/licenses', entry.file)).filter(name => name.startsWith('src/vendor/licenses/')), 'Vendor notice');

  const fonts = json('src/assets/fonts/SOURCES.json');
  if (!fonts.families?.length || !Array.isArray(fonts.open_gaps)) throw Error('Incomplete font evidence index');
  const fontFiles = [], fontNotices = new Set(), familyIds = new Set();
  for (const family of fonts.families) {
    if (familyIds.has(family.id) || !family.files?.length || !family.local_name_records?.['0']?.length) throw Error('Incomplete or duplicate font family');
    familyIds.add(family.id);
    const notice = relative('src/assets/fonts', family.license_file);
    checkedHash(notice, family.license_sha256); fontNotices.add(notice);
    for (const entry of family.files) {
      const name = relative('src/assets/fonts', entry.file);
      checkedHash(name, entry.sha256); fontFiles.push(name);
    }
  }
  sameFiles(listed('src/assets/fonts', name => name.endsWith('.ttf')), fontFiles, 'Font');
  sameFiles(listed('src/assets/fonts/licenses', () => true), [...fontNotices].filter(name => name.startsWith('src/assets/fonts/licenses/')), 'Font notice');

  // 开发依赖的许可只进源码包，不把测试库本体或 node_modules 带进浏览器安装包。
  const development = json('docs/current/DEVELOPMENT_DEPENDENCIES.json');
  const lock = json('package-lock.json');
  const packageJson = json('package.json');
  const dependencyList = value => JSON.stringify(Object.entries(value || {}).sort());
  if (dependencyList(packageJson.devDependencies) !== dependencyList(lock.packages[''].devDependencies)
    || dependencyList(packageJson.dependencies) !== dependencyList(lock.packages[''].dependencies)) throw Error('Package manifest differs from dependency lock');
  sameFiles(Object.keys(lock.packages).filter(name => name !== ''), development.dependencies.map(entry => entry.lock_path), 'Development dependency');
  for (const entry of development.dependencies) {
    const locked = lock.packages[entry.lock_path];
    if (entry.version !== locked.version || entry.license !== locked.license || entry.source_tarball !== locked.resolved
      || entry.integrity !== locked.integrity || entry.scope !== 'test-only' || locked.dev !== true) throw Error(`Development dependency evidence mismatch: ${entry.package}`);
    checkedHash(entry.license_file, entry.license_sha256);
  }
  return { ok: true, runtimeLibraries: vendor.bundles.length, vendorNotices: vendor.notices.length,
    fontFamilies: familyIds.size, fontFiles: fontFiles.length, developmentDependencies: development.dependencies.length,
    upstreamNoticeGaps: vendor.open_gaps, fontProvenanceGaps: fonts.open_gaps };
}

module.exports = { verifyThirdParty };
if (require.main === module) {
  try { console.log(JSON.stringify(verifyThirdParty(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
