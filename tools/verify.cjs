const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Always resolve from this file, not the caller's shell or current directory.
const root = path.resolve(__dirname, "..");
function run(label, args) {
  console.log(`[verify] ${label}`);
  const child = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", shell: false });
  if (child.error) console.error(`[verify] ${child.error.message}`);
  if (child.signal) console.error(`[verify] child terminated by ${child.signal}`);
  if (child.error || child.signal || child.status !== 0) process.exit(child.status || 1);
}

// Generated artifacts must be checked in dependency order; verification never repairs them.
run("message catalog check", ["tools/build-messages.cjs", "--check"]);
run("message trace index check", ["tools/build-message-index.cjs", "--check"]);
run("bundle check", ["tools/build-main-world.cjs", "--check"]);
run("architecture boundaries", ["tools/check-architecture.cjs"]);
run("third-party evidence", ["tools/check-third-party.cjs"]);
const tests = fs.readdirSync(path.join(root, "tests"), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".test.cjs"))
  .map(entry => `tests/${entry.name}`).sort();
if (!tests.length) {
  console.error("[verify] No test files found in tests/.");
  process.exit(1);
}
run("full test suite", ["--test", ...tests]);
