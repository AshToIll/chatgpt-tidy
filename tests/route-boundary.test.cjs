const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadRoute() {
  const context = vm.createContext({ URL, location: new URL("https://chatgpt.com/") });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(root, "src/platform/snapshot.js"), "utf8"), context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "src/platform/chatgpt/route.js"), "utf8"),
    context,
    { filename: "src/platform/chatgpt/route.js" },
  );
  return context.TidyChatgptRoute;
}

test("production route accepts chatgpt.com and rejects the retired host", () => {
  const route = loadRoute();
  assert.equal(route.parse("https://chatgpt.com/c/conversation-1").supported, true);
  assert.equal(route.parse("https://chat.openai.com/c/conversation-1").supported, false);
  assert.equal(route.parse("https://example.com/c/conversation-1").supported, false);
});

test("native project IDs are shared by plain and named conversation and project URLs", () => {
  const route = loadRoute(), projectId = "g-p-0123456789abcdef0123456789abcdef";
  for (const suffix of ["", "-my-project"]) for (const tail of ["project", "c/conversation-1"]) {
    const pathname = `/g/${projectId}${suffix}/${tail}`;
    const parsed = route.parse(`https://chatgpt.com${pathname}`);
    assert.equal(parsed.projectId, projectId);
    assert.equal(parsed.pathname, pathname);
  }
  assert.equal(route.parse(`https://chatgpt.com/g/${projectId}0-name/project`).projectId, `${projectId}0-name`);
});
