const fs = require("node:fs"), test = require("node:test"), assert = require("node:assert/strict");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");
function node(tagName = "div") {
  return { tagName, dataset: {}, children: [], textContent: "", setAttribute() {},
    replaceChildren(...children) { this.children = children; } };
}
async function harness(language) {
  const { createTranslator } = await import("../src/messages/i18n.js");
  const status = node(), module = node(), pageRefresh = node(); module.dataset.view = "bookmarks";
  const runtime = createPanelRuntime();
  runtime.load("src/platform/protocol.js");
  runtime.load("src/platform/library/library-hydration.js");
  const { createShellPresentation } = runtime.load("src/app/sidepanel/shell-presentation.js");
  const presentation = createShellPresentation({
    elements: { status, pageRefresh, timeControl: node(), views: [module] },
    translate: createTranslator(language),
    document: { createElement: node },
  });
  const model = { route: "bookmarks", pageSession: { phase: "ready" }, error: null, hasSnapshot: false };
  // Exercise the public presentation owner with explicit input models.
  // No panel.js fragments or private state are reconstructed in this fixture.
  function renderConnection() {
    const refreshRequired = presentation.renderPageConnection(model);
    presentation.renderContextStatus({ ...model, refreshRequired });
  }
  return { presentation, model, status, module, pageRefresh, renderConnection, render(error, phase = "ready") {
    Object.assign(model, { pageSession: { phase }, error });
    renderConnection();
    presentation.renderModuleError({ root: module, owner: "bookmarks", className: "bookmark-empty",
      error, visible: phase === "ready" });
  } };
}

for (const [language, message] of [["zh-CN", "连接中断，请刷新网页"], ["en", "Connection lost. Reload ChatGPT."],
  ["ja", "ChatGPTのページを再読み込みしてください"]]) {
  test(`page refresh uses one shared red notice, with no competing local prompt (${language})`, async () => {
    const h = await harness(language);
    for (const [stage, disconnect] of [["service-worker.snapshot-send-message", "receiver-missing"],
      ["service-worker.library-account-transport", "receiver-missing"], ["content.library-runtime-send-message", "context-invalidated"]]) {
      h.render({ code: "ADAPTER_UNAVAILABLE", details: { stage, disconnect } }, "refresh-required");
      assert.equal(h.pageRefresh.hidden, false); assert.equal(h.pageRefresh.textContent, message);
      assert.equal(h.pageRefresh.children.length, 0, "no ineffective reread button");
      assert.equal(h.status.hidden, true); assert.equal(h.module.hidden, true);
    }
  });
}

test("real retryable errors retain buttons; stale F5 DOM is replaced when the error changes", async () => {
  const h = await harness("zh-CN");
  h.render({ code: "ADAPTER_UNAVAILABLE", details: { stage: "service-worker.page-session", disconnect: "receiver-missing" } }, "refresh-required");
  for (const error of [{ code: "ADAPTER_UNAVAILABLE" }, { code: "STORAGE_ERROR" }, { code: "LIBRARY_ACCOUNT_UNAVAILABLE" },
    { code: "ADAPTER_UNAVAILABLE", details: { status: 503 } }, { code: "ADAPTER_TIMEOUT" },
    { code: "ADAPTER_UNAVAILABLE", details: { stage: "service-worker.snapshot-send-message", disconnect: "connection-closed" } }]) {
    h.render(error);
    assert.equal(h.pageRefresh.hidden, true); assert.equal(h.module.hidden, false);
    for (const root of [h.status, h.module]) {
      assert.equal(root.children.length, 2); assert.equal(root.children[1].tagName, "button");
      assert.equal(root.children[1].textContent, "重新读取"); assert.equal(root.children[0].textContent.includes("F5"), false);
    }
  }
  h.render({ code: "ADAPTER_UNAVAILABLE", details: { stage: "sidepanel.runtime-send-message", disconnect: "context-invalidated" } });
  for (const root of [h.status, h.module]) {
    assert.equal(root.children.length, 1); assert.equal(root.children[0].textContent, "连接中断，请重开侧栏");
  }
});

test("page admission replaces a local time error; library results cannot unlock it", async () => {
  const h = await harness("zh-CN");
  h.render({ code: "ADAPTER_TIMEOUT" }); assert.equal(h.status.hidden, false);
  h.model.pageSession = { phase: "refresh-required" };
  h.model.moduleErrors = { favorites: null };
  h.renderConnection();
  assert.equal(h.pageRefresh.hidden, false); assert.equal(h.status.hidden, true); assert.equal(h.status.children.length, 0);
  h.model.moduleErrors.favorites = null; h.renderConnection();
  assert.equal(h.pageRefresh.hidden, false);
  h.model.pageSession = { phase: "ready" }; h.renderConnection();
  assert.equal(h.pageRefresh.hidden, true); assert.equal(h.status.hidden, false);
  assert.equal(h.status.children[1].tagName, "button", "unrelated retryable time error is not lost");
});

test("page-session notice gates six modules and the settings form while retaining the settings shell", async () => {
  const { createTranslator } = await import("../src/messages/i18n.js");
  const runtime = createPanelRuntime();
  runtime.load("src/platform/protocol.js");
  runtime.load("src/platform/library/library-hydration.js");
  const { createShellPresentation } = runtime.load("src/app/sidepanel/shell-presentation.js");
  const views = ["time", "titles", "favorites", "bookmarks", "search", "export", "settings"]
    .map(view => Object.assign(node(), { dataset: { view } }));
  const pageRefresh = node(), timeControl = node(), settingsForm = node();
  const settings = views.find(view => view.dataset.view === "settings");
  const businessViews = views.filter(view => view !== settings).concat(settingsForm);
  const shell = createShellPresentation({
    elements: { views, pageRefresh, timeControl, settingsForm }, translate: createTranslator("en"),
    document: { createElement: node },
  });
  for (const phase of ["connecting", "refresh-required"]) {
    assert.equal(shell.renderPageConnection({ pageSession: { phase }, route: "time" }), true);
    assert.equal(pageRefresh.hidden, false);
    assert.equal(timeControl.hidden, true);
    assert.equal(pageRefresh.children.length, 0, "admission never adds a local retry control");
    settings.hidden = true; settings.inert = true; // A retired root cannot remain stuck behind an old gate.
    shell.renderPageConnection({ pageSession: { phase }, route: "settings" });
    assert.equal(settings.hidden, false); assert.equal(settings.inert, false);
    for (const view of businessViews) {
      assert.equal(view.hidden, true, view.dataset.view);
      assert.equal(view.inert, true, view.dataset.view);
    }
  }
  assert.equal(shell.renderPageConnection({ pageSession: { phase: "ready" }, route: "time" }), false);
  assert.equal(pageRefresh.hidden, true);
  assert.equal(timeControl.hidden, false);
  for (const view of [...views, settingsForm]) {
    assert.equal(view.hidden, false, view.dataset.view);
    assert.equal(view.inert, false, view.dataset.view);
  }
});

test("the production panel composes the same shell notice owner and live reconnect command", () => {
  const panel = fs.readFileSync("src/app/sidepanel/panel.js", "utf8");
  const shell = fs.readFileSync("src/app/sidepanel/shell-presentation.js", "utf8");
  assert.match(panel, /import\s+\{[^}]*createShellPresentation[^}]*\}\s+from\s+"\.\/shell-presentation\.js"/);
  assert.match(panel, /const shell = createShellPresentation\(\{ elements, translate \}\)/);
  assert.match(panel, /const refreshRequired = shell\.renderPageConnection\(\{ pageSession: state\.pageSession, route: state\.route,/);
  assert.match(panel, /onReconnect: \(\) => \{ void pageSession\.check\(\); \}/);
  assert.match(panel, /shell\.renderContextStatus\(\{ route: state\.route, error: context\.get\(\)\.error,[\s\S]{0,100}refreshRequired \}\)/);
  assert.doesNotMatch(panel, /function (?:contextErrorPresentation|renderContextStatus|renderModuleError)\(/,
    "the application root must not retain a second copy of presentation logic");
  assert.match(shell, /renderPageRefreshNotice\(\{[\s\S]{0,160}model: \{ pageSession \}, translate, onReconnect/);
});

test("retired product code, settings root, translations, preview entry and protocols are absent", () => {
  for (const file of ["src/sidepanel/library-recovery-view.js", "src/sidepanel/library.css", "tools/fixtures/library-recovery-preview.js",
    "tools/fixtures/library-recovery-preview.html", "tests/library-recovery-view.test.cjs", "tests/storage-account-migration.test.cjs"]) assert.equal(fs.existsSync(file), false, file);
  for (const file of ["src/app/sidepanel/index.html", "src/app/sidepanel/panel.js", "src/app/sidepanel/shell-presentation.js", "src/platform/library/ui/library-controller.js", "src/platform/library/content/library-client.js",
    "src/platform/protocol.js", "src/messages/i18n.js", "src/platform/library/storage/account-library.js", "src/features/favorites/storage/favorites.js", "src/features/bookmarks/storage/bookmarks.js",
    "src/app/background/service-worker.js", "tools/date-search-export-preview.cjs", "README.md", "docs/current/RELEASE_CHECKLIST.md"]) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /unclaimed|claimUnclaimed|libraryRecovery|library-recovery|LIBRARY_CLAIM|LIBRARY_UNCLAIMED|readLegacy|旧资料待认领/i, file);
  }
});
