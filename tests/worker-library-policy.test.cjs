const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync("src/app/background/service-worker.js", "utf8");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync("src/platform/protocol.js", "utf8"), context);
const { libraryRequestPolicy } = require("./helpers/worker-runtime.cjs").createWorkerModuleLoader(context)
  .load("src/app/background/request-policy.js");
const { Type } = context.TidyProtocol;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("library reads, exports and actions have disjoint explicit owner policies", () => {
  const reads = new Set([Type.LIBRARY_ACCOUNT, Type.LIBRARY_GET, Type.FAVORITES_GET, Type.BOOKMARKS_GET]);
  const exports = new Set([Type.EXPORT_CURRENT_CONVERSATION, Type.EXPORT_CONVERSATIONS, Type.EXPORT_PREVIEW_OPEN,
    Type.EXPORT_IMAGE_RESOURCE,
    Type.EXPORT_JOB_START, Type.EXPORT_JOB_STATUS, Type.EXPORT_JOB_CANCEL, Type.EXPORT_JOB_DISMISS]);
  const events = new Set([Type.FAVORITES_UPDATED, Type.BOOKMARKS_UPDATED]);
  const backups = new Set([Type.LIBRARY_BACKUP_EXPORT, Type.LIBRARY_BACKUP_PREVIEW, Type.LIBRARY_BACKUP_RESTORE, Type.LIBRARY_BACKUP_DISCARD]);
  for (const type of Object.values(Type)) {
    const actual = plain(libraryRequestPolicy(type));
    const expected = reads.has(type) ? { requireExpected: false, requireIdentity: false }
      : exports.has(type) ? { requireExpected: true, requireIdentity: false }
      : backups.has(type) || /^(favorites|bookmarks)\./.test(type) && !events.has(type) ? { requireExpected: true, requireIdentity: true } : null;
    assert.deepEqual(actual, expected, type);
  }
  // A future/retired name cannot inherit authority merely by sharing a prefix.
  for (const type of ["favorites.unknown", "bookmarks.locate", "export.unknown", "library.unknown"]) {
    assert.equal(libraryRequestPolicy(type), null, type);
  }
});

test("every production library dispatcher branch is explicitly classified", () => {
  const dispatch = ["favorites", "bookmarks"].map(name => fs.readFileSync("src/app/background/handlers/" + name + ".js", "utf8")).join("\n");
  assert.match(source, /createFavoritesHandler\(/);
  assert.match(source, /createBookmarksHandler\(/);
  assert.match(fs.readFileSync("src/app/background/request-router.js", "utf8"), /libraryRequestPolicy\(envelope\.type\)/);
  const names = [...dispatch.matchAll(/envelope\.type === protocol\.Type\.((?:FAVORITES|BOOKMARKS)_\w+)/g)].map((match) => match[1]);
  assert.ok(names.length > 15, "inspect real dispatcher rather than an empty fixture");
  for (const name of names) assert.ok(libraryRequestPolicy(Type[name]), name);
  assert.doesNotMatch(dispatch, /const libraryScoped/);
});
