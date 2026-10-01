const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const code = fs.readFileSync("tools/verify.cjs", "utf8");

// Run the actual gate with process boundaries substituted, never recursively
// run the test suite from inside itself or depend on a particular shell.
function simulate(results = [], names = ["z.test.cjs", "a.test.cjs", "fixture.js", "folder.test.cjs"]) {
  const calls = [], logs = [], stop = {}, execPath = path.resolve("node-with-spaces", "node");
  let status = 0, listed = false;
  const context = { __dirname: path.resolve("tools"), console: { log: message => logs.push(message), error: message => logs.push(message) },
    process: { execPath, exit(code) { status = code; throw stop; } },
    require(name) {
      if (name === "node:path") return path;
      if (name === "node:fs") return { readdirSync(directory, options) {
        listed = true; assert.equal(directory, path.resolve("tests")); assert.equal(options.withFileTypes, true);
        return names.map(name => ({ name, isFile: () => name !== "folder.test.cjs" }));
      } };
      if (name === "node:child_process") return { spawnSync(command, args, options) {
        calls.push({ command, args: Array.from(args), options: { ...options } }); return results[calls.length - 1] || { status: 0 };
      } };
      throw Error(`Unexpected dependency: ${name}`);
    },
  };
  try { vm.runInNewContext(code, context); } catch (error) { if (error !== stop) throw error; }
  return { calls, logs, status, listed, execPath };
}

const PRE_TEST_CHECKS = [
  ["tools/build-messages.cjs", "--check"],
  ["tools/build-message-index.cjs", "--check"],
  ["tools/build-main-world.cjs", "--check"],
  ["tools/check-architecture.cjs"],
  ["tools/check-third-party.cjs"],
];
const successUntil = index => Array.from({ length: index }, () => ({ status: 0 }));

test("verification checks generated messages, index, bundle, architecture and third-party evidence before sorted tests", () => {
  const h = simulate();
  assert.equal(h.status, 0); assert.equal(h.calls.length, PRE_TEST_CHECKS.length + 1);
  assert.deepEqual(h.calls.map(call => call.args), [...PRE_TEST_CHECKS, ["--test", "tests/a.test.cjs", "tests/z.test.cjs"]]);
  for (const call of h.calls) {
    assert.equal(call.command, h.execPath);
    assert.deepEqual(call.options, { cwd: path.resolve("."), stdio: "inherit", shell: false });
  }
});

for (const [index, args] of PRE_TEST_CHECKS.entries()) {
  test(args[0] + " failure exits before test discovery or later checks", () => {
    const h = simulate([...successUntil(index), { status: 7 }]);
    assert.equal(h.status, 7); assert.equal(h.calls.length, index + 1); assert.equal(h.listed, false);
    assert.deepEqual(h.calls.map(call => call.args), PRE_TEST_CHECKS.slice(0, index + 1));
  });
}

test("test failures propagate their exit status", () => {
  const h = simulate([...successUntil(PRE_TEST_CHECKS.length), { status: 3 }]);
  assert.equal(h.status, 3); assert.equal(h.calls.length, PRE_TEST_CHECKS.length + 1); assert.equal(h.listed, true);
  assert.deepEqual(h.calls.at(-1).args, ["--test", "tests/a.test.cjs", "tests/z.test.cjs"]);
});

test("spawn errors and child signals cannot be reported as successful verification at any stage", () => {
  for (let index = 0; index <= PRE_TEST_CHECKS.length; index++) {
    for (const result of [{ status: null, error: Error("spawn failed") }, { status: null, signal: "SIGTERM" }]) {
      const h = simulate([...successUntil(index), result]);
      assert.equal(h.status, 1); assert.equal(h.calls.length, index + 1);
      assert.equal(h.listed, index === PRE_TEST_CHECKS.length);
    }
  }
});

test("an empty tests directory fails rather than silently running zero tests", () => {
  const h = simulate([], []);
  assert.equal(h.status, 1); assert.equal(h.calls.length, PRE_TEST_CHECKS.length); assert.equal(h.listed, true);
  assert.deepEqual(h.calls.map(call => call.args), PRE_TEST_CHECKS);
});
