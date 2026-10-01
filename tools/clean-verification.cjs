'use strict';
// Explicit end-of-verification housekeeping, never an automatic test hook.
// Workflow: finish source edits -> copy important receipts -> create a manifest
// -> inspect dry-run -> opt in with --apply. No browser is launched or attached.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'tidy-verification-cleanup/v1';
const SOURCE_ALGORITHM = 'tidy-source-v1';
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const BROWSER_OUTPUT = /^(?:bookmark-landing|bookmark-theme|export-image|export-job|export-keyboard|library-backup|library-lifecycle|page-session|panel-theme|plugin-navigation|toolbar-theme)-browser-[A-Za-z0-9]{6}$/;
const SOURCE_DIRS = ['src', 'tools', 'tests', '.githooks', 'docs/current', 'docs/licenses'];
const SOURCE_FILES = ['package.json', 'package-lock.json', 'README.md', 'README.en.md', 'README.ja.md', 'docs/README.md', 'LICENSE', '.gitignore', '.gitattributes'];
const sha = value => createHash('sha256').update(value).digest('hex');
const portable = name => name.split(path.sep).join('/');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fail = message => { throw new Error(message); };

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function relativePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') ||
      name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
      path.isAbsolute(name) || /[\u0000-\u001f]/.test(name)) fail('Unsafe relative path: ' + name);
  return name;
}

// lstat BEFORE realpath/read, for every component, rejects symlinks and Windows
// junctions. Comparing canonical paths additionally rejects redirected ancestors.
// Unknown special file kinds fail closed; only ordinary files/directories qualify.
function plainPath(absolute) {
  const resolved = path.resolve(absolute);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail('Linked or special path refused: ' + cursor);
    if (!samePath(fs.realpathSync.native(cursor), cursor)) fail('Redirected/reparse path refused: ' + cursor);
  }
  return fs.lstatSync(resolved);
}


// Node exposes junctions as symlinks but not every Windows reparse-point tag.
// This fixed, read-only metadata probe checks ALL reparse tags before content
// reads. Paths travel as JSON on stdin, never interpolated into shell commands.
function windowsAudit(items) {
  if (process.platform !== 'win32' || !items.length) return new Map();
  const script = [
    '$ErrorActionPreference="Stop"; $items=ConvertFrom-Json ([Console]::In.ReadToEnd()); $bad=@();',
    'foreach($item in $items){ try {',
    '$cursor=$item.absolute; while($cursor){ $a=[IO.File]::GetAttributes($cursor); if(($a -band 1024) -ne 0){throw "Reparse point refused"}; $cursor=[IO.Path]::GetDirectoryName($cursor) };',
    'if($item.recursive){ $pending=New-Object "System.Collections.Generic.Stack[string]"; $pending.Push($item.absolute);',
    'while($pending.Count){$p=$pending.Pop();$a=[IO.File]::GetAttributes($p);if(($a -band 1024) -ne 0){throw "Reparse point refused"};',
    'if(($a -band 16) -ne 0){foreach($child in [IO.Directory]::EnumerateFileSystemEntries($p)){$pending.Push($child)}} }}',
    '} catch {$bad+=@{absolute=$item.absolute;reason=$_.Exception.Message}} };',
    'ConvertTo-Json -InputObject @($bad) -Compress'
  ].join('\n');
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: JSON.stringify(items), encoding: 'utf8', windowsHide: true, shell: false, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (child.error || child.status !== 0) fail('Windows reparse audit failed: ' + (child.error?.message || child.stderr));
  return new Map(JSON.parse(child.stdout.trim() || '[]').map(item => [item.absolute, item.reason]));
}

function requireWindowsAudit(items) {
  const failures = windowsAudit(items);
  if (failures.size) fail('Reparse/metadata path refused: ' + [...failures.entries()][0].join(': '));
}

function checkedRoot(root = DEFAULT_ROOT) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('Repository root must be absolute');
  const resolved = path.resolve(root);
  if (!plainPath(resolved).isDirectory()) fail('Repository root must be a directory');
  requireWindowsAudit([{ absolute: resolved, recursive: false }, { absolute: path.join(resolved, 'package.json'), recursive: false }]);
  const metadata = readJson(resolved, 'package.json');
  if (metadata.name !== 'chatgpt-tidy') fail('Not a chatgpt-tidy repository');
  for (const name of ['src', 'tools', 'tests']) {
    if (!plainPath(path.join(resolved, name)).isDirectory()) fail('Missing repository directory: ' + name);
  }
  return resolved;
}

function checkedFile(root, name) {
  relativePath(name);
  const absolute = path.resolve(root, name);
  if (!inside(root, absolute)) fail('Path escapes repository: ' + name);
  const stat = plainPath(absolute);
  if (!stat.isFile() || stat.nlink !== 1) fail('Not an unlinked ordinary file: ' + name);
  return { absolute, stat };
}

function readJson(root, name) {
  return JSON.parse(fs.readFileSync(checkedFile(root, name).absolute, 'utf8'));
}

function temporaryPath(root, name) {
  relativePath(name);
  const boundary = name.split('/')[0];
  if (!['.tmp', 'tmp'].includes(boundary) || name === boundary) fail('Path is not below a temporary boundary: ' + name);
  const absolute = path.resolve(root, name), base = path.join(root, boundary);
  if (!inside(base, absolute)) fail('Path escapes temporary boundary: ' + name);
  plainPath(base);
  plainPath(absolute);
  return absolute;
}

function snapshot(root, name, allowBaselineGit = false) {
  const entries = [];
  function visit(relative) {
    const absolute = path.join(root, relative), stat = plainPath(absolute);
    if (path.basename(relative) === '.git' && !(allowBaselineGit && relative === '.tmp/architecture-baseline/checkout/.git')) {
      fail('Nested repository refused: ' + relative);
    }
    if (stat.isFile()) {
      if (stat.nlink !== 1) fail('Hard-linked file refused: ' + relative);
      const digest = sha(fs.readFileSync(absolute));
      const after = fs.lstatSync(absolute);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) fail('File changed during inspection: ' + relative);
      entries.push([portable(relative), 'file', stat.size, stat.mtimeMs, digest]);
    } else {
      entries.push([portable(relative), 'directory', 0, stat.mtimeMs]);
      for (const child of fs.readdirSync(absolute).sort()) visit(portable(path.join(relative, child)));
    }
  }
  visit(name);
  const result = { path: name, type: entries[0][1], files: entries.filter(row => row[1] === 'file').length,
    bytes: entries.reduce((sum, row) => sum + row[2], 0), treeFingerprint: sha(JSON.stringify(entries)) };
  // Keep the validated deletion list private; JSON manifests need only its hash.
  Object.defineProperty(result, 'entries', { value: entries });
  return result;
}

function sourceFingerprint(root = DEFAULT_ROOT) {
  root = checkedRoot(root);
  const rows = [];
  requireWindowsAudit([...SOURCE_DIRS, ...SOURCE_FILES].filter(name => fs.existsSync(path.join(root, name)))
    .map(name => ({ absolute: path.join(root, name), recursive: true })));
  // Source hashing is independent of package whitelist changes and temporary
  // receipts. The tool and its tests are themselves covered by this fingerprint.
  function visit(name) {
    const absolute = path.join(root, name), stat = plainPath(absolute);
    if (stat.isDirectory()) for (const child of fs.readdirSync(absolute).sort()) visit(portable(path.join(name, child)));
    else {
      const { absolute: file } = checkedFile(root, name);
      rows.push([name, sha(fs.readFileSync(file))]);
    }
  }
  for (const name of [...SOURCE_DIRS, ...SOURCE_FILES].sort()) {
    if (fs.existsSync(path.join(root, name))) visit(name);
  }
  return sha(JSON.stringify(rows));
}

function baselineCheckout(root) {
  const summary = readJson(root, '.tmp/architecture-baseline/summary.json');
  const checkout = '.tmp/architecture-baseline/checkout';
  const metadata = readJson(root, checkout + '/package.json');
  const manifest = readJson(root, checkout + '/src/manifest.json');
  if (summary.head !== 'c6248d51517503b2844d27ed9b9eddf03c7e5bc9' || summary.source040Modified !== false ||
      metadata.name !== 'chatgpt-tidy' || metadata.version !== '0.4.0' || manifest.version !== '0.4.0') return false;
  let head = fs.readFileSync(checkedFile(root, checkout + '/.git/HEAD').absolute, 'utf8').trim();
  if (head.startsWith('ref: ')) {
    const ref = relativePath(head.slice(5));
    if (!ref.startsWith('refs/')) return false;
    const loose = checkout + '/.git/' + ref;
    if (fs.existsSync(path.join(root, loose))) head = fs.readFileSync(checkedFile(root, loose).absolute, 'utf8').trim();
    else {
      const packed = fs.readFileSync(checkedFile(root, checkout + '/.git/packed-refs').absolute, 'utf8');
      head = packed.split(/\r?\n/).find(line => line.endsWith(' ' + ref))?.split(' ')[0];
    }
  }
  return head === summary.head;
}

function classify(root, name, stat) {
  const base = path.posix.basename(name);
  if (stat.isDirectory() && BROWSER_OUTPUT.test(base)) {
    const report = readJson(root, name + '/report.json');
    return typeof report.ok === 'boolean' && (Array.isArray(report.checks) || typeof report.error === 'string')
      ? 'isolated-browser-output' : null;
  }
  if (stat.isDirectory() && /^release-verification-[A-Za-z0-9]{6}$/.test(base)) {
    const report = readJson(root, name + '/report.json');
    return typeof report.ok === 'boolean' && Array.isArray(report.checks) && /^[a-f0-9]{64}$/.test(report.sourceFingerprint)
      ? 'release-verification' : null;
  }
  if (stat.isDirectory() && /^(?:\.tmp\/deep-refactor|tmp)\/export-(?:i18n|v3)$/.test(name)) {
    const permitted = base === 'export-i18n' ? /^(?:en|ja|zh-CN|zh-TW)\.(?:json|md|pdf|txt)$/ : /^导出 V3 排版验收\.(?:json|pdf|txt|zip)$/;
    const children = fs.readdirSync(path.join(root, name));
    return children.length && children.every(child => permitted.test(child) && plainPath(path.join(root, name, child)).isFile())
      ? 'synthetic-export-output' : null;
  }
  if (name === '.tmp/architecture-baseline/checkout' && stat.isDirectory() && baselineCheckout(root)) return 'architecture-baseline-checkout';
  if (stat.isFile() && ['.tmp/sidebar-navigation-browser.html', '.tmp/native-sidebar-navigation-browser.html'].includes(name)) {
    const content = fs.readFileSync(checkedFile(root, name).absolute, 'utf8');
    return /<pre id="results" data-complete="true">/.test(content) ? 'sidebar-browser-receipt' : null;
  }
  return null;
}

function planCleanup(root = DEFAULT_ROOT) {
  root = checkedRoot(root);
  const targets = [], retained = [], candidates = [];
  // Gather names only; do not descend into unknown directories. The metadata
  // audit sees precisely the candidate paths whose producer signatures we read.
  for (const base of ['.tmp', 'tmp']) {
    const absolute = path.join(root, base);
    if (!fs.existsSync(absolute)) continue;
    plainPath(absolute);
    requireWindowsAudit([{ absolute, recursive: false }]);
    for (const child of fs.readdirSync(absolute).sort()) {
      const name = base + '/' + child;
      if (['.tmp/deep-refactor', '.tmp/architecture-baseline'].includes(name)) {
        const stat = plainPath(path.join(root, name));
        requireWindowsAudit([{ absolute: path.join(root, name), recursive: false }]);
        if (stat.isDirectory()) for (const inner of fs.readdirSync(path.join(root, name)).sort()) candidates.push(name + '/' + inner);
        else candidates.push(name);
      } else candidates.push(name);
    }
  }
  const plausible = name => BROWSER_OUTPUT.test(path.posix.basename(name)) ||
    /^release-verification-[A-Za-z0-9]{6}$/.test(path.posix.basename(name)) ||
    /^(?:\.tmp\/deep-refactor|tmp)\/export-(?:i18n|v3)$/.test(name) ||
    name === '.tmp/architecture-baseline/checkout' ||
    ['.tmp/sidebar-navigation-browser.html', '.tmp/native-sidebar-navigation-browser.html'].includes(name);
  const auditItems = candidates.filter(plausible).map(name => ({ absolute: path.join(root, name), recursive: true }));
  if (candidates.includes('.tmp/architecture-baseline/checkout')) {
    auditItems.push({ absolute: path.join(root, '.tmp/architecture-baseline/summary.json'), recursive: false });
  }
  const auditFailures = windowsAudit(auditItems);
  function inspect(name) {
    try {
      if (auditFailures.has(path.join(root, name))) fail('Reparse/metadata path refused: ' + auditFailures.get(path.join(root, name)));
      if (name === '.tmp/architecture-baseline/checkout' && auditFailures.has(path.join(root, '.tmp/architecture-baseline/summary.json'))) fail('Baseline summary metadata refused');
      const absolute = temporaryPath(root, name), stat = fs.lstatSync(absolute);
      // These are routing containers, NOT recursive deletion targets. All other
      // unrecognized directories are opaque: do not inspect personal contents.
      if (['.tmp/deep-refactor', '.tmp/architecture-baseline'].includes(name) && stat.isDirectory()) {
        for (const child of fs.readdirSync(absolute).sort()) inspect(name + '/' + child);
        return;
      }
      const kind = classify(root, name, stat);
      if (!kind) { retained.push({ path: name, reason: 'Unknown or unproven output; retained' }); return; }
      targets.push({ ...snapshot(root, name, kind === 'architecture-baseline-checkout'), kind });
    } catch (error) { retained.push({ path: name, reason: error.message }); }
  }
  for (const name of candidates) inspect(name);
  return { root, targets, retained, bytes: targets.reduce((sum, item) => sum + item.bytes, 0),
    planFingerprint: sha(JSON.stringify(targets)) };
}

function archivePath(root, name) {
  relativePath(name);
  if (!/^\.artifacts\/verification\/[^/]+\/.+/.test(name)) fail('Archive must be below .artifacts/verification/<run>/: ' + name);
  return checkedFile(root, name);
}

function validateArchivedFiles(root, files) {
  if (!Array.isArray(files) || !files.length) fail('At least one preserved evidence file is required');
  requireWindowsAudit(files.flatMap(item => [item.originalPath, item.archivedPath].map(name => {
    relativePath(name); return { absolute: path.join(root, name), recursive: false };
  })));
  const originals = new Set(), archives = new Set();
  return files.map(item => {
    if (!item || originals.has(item.originalPath) || archives.has(item.archivedPath)) fail('Duplicate or missing archived evidence entry');
    temporaryPath(root, item.originalPath);
    const original = checkedFile(root, item.originalPath), archived = archivePath(root, item.archivedPath);
    if (path.posix.basename(item.archivedPath) === 'manifest.json') fail('Manifest cannot certify itself');
    originals.add(item.originalPath); archives.add(item.archivedPath);
    const originalHash = sha(fs.readFileSync(original.absolute)), archivedHash = sha(fs.readFileSync(archived.absolute));
    if (original.stat.size !== archived.stat.size || originalHash !== archivedHash) fail('Archived evidence differs: ' + item.originalPath);
    if ('bytes' in item && (item.bytes !== original.stat.size || item.sha256 !== originalHash)) fail('Archived evidence checksum mismatch: ' + item.originalPath);
    return { originalPath: item.originalPath, archivedPath: item.archivedPath, bytes: original.stat.size, sha256: originalHash };
  });
}

// API for a caller that has ALREADY copied the chosen evidence. This function
// only validates and returns JSON; it does not copy, delete, or write a manifest.
// All originalPath/archivedPath values are repo-relative forward-slash paths.
function createArchiveManifest(root, archivedFiles) {
  root = checkedRoot(root);
  const before = sourceFingerprint(root);
  const plan = planCleanup(root);
  const files = validateArchivedFiles(root, archivedFiles);
  if (before !== sourceFingerprint(root)) fail('Source changed while creating manifest');
  return { schema: SCHEMA, root, sourceAlgorithm: SOURCE_ALGORITHM, sourceFingerprint: before,
    createdAt: new Date().toISOString(), cleanupPlan: { targets: plan.targets, planFingerprint: plan.planFingerprint }, archivedFiles: files };
}

function validateManifest(root, manifestPath, plan) {
  const absolute = path.isAbsolute(manifestPath) ? path.resolve(manifestPath) : path.resolve(root, manifestPath);
  if (!inside(path.join(root, '.artifacts/verification'), absolute) || path.basename(absolute) !== 'manifest.json') fail('Invalid archive manifest path');
  const relative = portable(path.relative(root, absolute));
  requireWindowsAudit([{ absolute, recursive: false }]);
  const manifest = JSON.parse(fs.readFileSync(archivePath(root, relative).absolute, 'utf8'));
  if (manifest.schema !== SCHEMA || !samePath(manifest.root || '', root) || manifest.sourceAlgorithm !== SOURCE_ALGORITHM) fail('Archive schema, root or source algorithm mismatch');
  if (manifest.sourceFingerprint !== sourceFingerprint(root)) fail('Source changed since archive; finish edits and archive again');
  if (!manifest.cleanupPlan || JSON.stringify(manifest.cleanupPlan.targets) !== JSON.stringify(plan.targets) ||
      manifest.cleanupPlan.planFingerprint !== plan.planFingerprint) fail('Cleanup plan changed since archive; archive current outputs again');
  for (const item of manifest.archivedFiles || []) {
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('Missing evidence bytes or sha256');
  }
  validateArchivedFiles(root, manifest.archivedFiles);
  return manifest;
}

function runCleanup({ root = DEFAULT_ROOT, apply = false, archiveManifest = null } = {}) {
  root = checkedRoot(root);
  if (apply && !archiveManifest) fail('--apply requires --archive-manifest');
  const plan = planCleanup(root);
  if (archiveManifest) validateManifest(root, archiveManifest, plan);
  if (!apply) return { mode: 'dry-run', ...plan, deleted: [] };
  // Validate EVERYTHING before deleting ANYTHING; a stale report, new output,
  // link, or source edit aborts the entire operation, never a partial preflight.
  const finalPlan = planCleanup(root);
  if (JSON.stringify(finalPlan.targets) !== JSON.stringify(plan.targets)) fail('Cleanup targets changed during preflight');
  validateManifest(root, archiveManifest, finalPlan);
  const deleted = [];
  for (const target of finalPlan.targets) {
    const absolute = temporaryPath(root, target.path);
    requireWindowsAudit([{ absolute, recursive: true }]);
    const current = snapshot(root, target.path, target.kind === 'architecture-baseline-checkout');
    if (current.treeFingerprint !== target.treeFingerprint) fail('Cleanup target changed before deletion: ' + target.path);
    // Delete ONLY enumerated files, then empty directories. A newly arriving
    // unknown file is never swept up by recursive rm: rmdir fails and preserves
    // it. Stop test/browser writers first; filesystem deletion is not atomic.
    for (const entry of [...current.entries].reverse()) {
      const item = temporaryPath(root, entry[0]), stat = fs.lstatSync(item);
      if (entry[1] === 'directory') {
        if (!stat.isDirectory()) fail('Directory replaced before deletion: ' + entry[0]);
        fs.rmdirSync(item);
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry[2] || stat.mtimeMs !== entry[3] ||
            sha(fs.readFileSync(item)) !== entry[4]) fail('File changed before deletion: ' + entry[0]);
        fs.unlinkSync(item);
      }
    }
    deleted.push(target.path);
  }
  return { mode: 'apply', ...finalPlan, deleted };
}

function main(args = process.argv.slice(2)) {
  let apply = false, archiveManifest = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') apply = true;
    else if (args[index] === '--dry-run') continue;
    else if (args[index] === '--archive-manifest' && args[index + 1] && !args[index + 1].startsWith('--')) archiveManifest = args[++index];
    else if (args[index] === '--help') {
      console.log('node tools/clean-verification.cjs [--dry-run | --apply --archive-manifest .artifacts/verification/<run>/manifest.json]\nDefault is dry-run. Copy important evidence and createArchiveManifest AFTER final source edits. Unknown outputs remain untouched.');
      return;
    } else fail('Unknown or incomplete argument: ' + args[index]);
  }
  console.log(JSON.stringify(runCleanup({ apply, archiveManifest }), null, 2));
}
module.exports = { SCHEMA, SOURCE_ALGORITHM, planCleanup, sourceFingerprint, createArchiveManifest, runCleanup };
if (require.main === module) {
  try { main(); } catch (error) { console.error('[verification-cleanup] ' + error.message); process.exitCode = 1; }
}
