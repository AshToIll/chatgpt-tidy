const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");
const { readPanelCss } = require('./helpers/read-panel-css.cjs');
const { exportMessages } = require('./helpers/export-i18n.cjs');
const { installPageSession } = require('./helpers/page-session.cjs');
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { TextDecoder, TextEncoder } = require("node:util");

const root = path.resolve(__dirname, "..");

function cssDeclarations(css, selector) {
  const exact = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`^${exact}\\s*\\{([^}]+)\\}`, "m"));
  assert.ok(block, `Missing selector: ${selector}`);
  return Object.fromEntries(block[1].split(";").map((part) => {
    const colon = part.indexOf(":");
    return colon < 0 ? null : [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }).filter(Boolean));
}

function runClassic(context, relativePath) {
  vm.runInContext(
    fs.readFileSync(path.join(root, relativePath), "utf8"),
    context,
    { filename: relativePath },
  );
}

function conversationPayload(overrides = {}) {
  const longBody = `完整正文：${"甲乙丙丁".repeat(110)}：正文结尾`;
  return {
    id: "conversation-1",
    title: "TIDY / 当前会话",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: "assistant-active",
    mapping: {
      root: {
        id: "root",
        parent: null,
        message: { id: "system-1", author: { role: "system" }, content: { parts: ["System"] } },
      },
      user: {
        id: "user",
        parent: "root",
        message: {
          id: "message-user",
          author: { role: "user" },
          create_time: 1_700_000_001,
          content: { content_type: "text", parts: [longBody] },
        },
      },
      "assistant-abandoned": {
        id: "assistant-abandoned",
        parent: "user",
        message: {
          id: "message-abandoned",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["不应导出的旧分支"] },
        },
      },
      "assistant-active": {
        id: "assistant-active",
        parent: "assistant-recap",
        message: {
          id: "message-active",
          author: { role: "assistant" },
          create_time: 1_700_000_002.5,
          content: {
            content_type: "text",
            parts: ["## **结论**\n\n- 第一项\n- 第二项\n\n```js\nconst ready = true;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 导出 | 完成 |"],
          },
          metadata: {
            citations: [{ metadata: { title: "OpenAI", url: "https://openai.com/" } }],
          },
        },
      },
      "assistant-thought": {
        id: "assistant-thought",
        parent: "user",
        message: {
          id: "message-thought",
          author: { role: "assistant" },
          content: {
            content_type: "thoughts",
            thoughts: [{ summary: "先检查会话数据", content: "确认当前分支，再组织导出结构。" }],
          },
          metadata: { reasoning_status: "is_reasoning" },
        },
      },
      "assistant-search": {
        id: "assistant-search",
        parent: "assistant-thought",
        message: {
          id: "message-search",
          author: { role: "assistant" },
          recipient: "web.run",
          content: { content_type: "code", text: "{}" },
          metadata: {
            reasoning_status: "is_reasoning",
            reasoning_title: "查找官方资料",
            search_queries: ["ChatGPT export API"],
          },
        },
      },
      "tool-search": {
        id: "tool-search",
        parent: "assistant-search",
        message: {
          id: "message-tool-search",
          author: { role: "tool" },
          content: { content_type: "text", parts: [] },
          metadata: {
            search_result_groups: [{
              entries: [{ title: "OpenAI", url: "https://openai.com/" }],
            }],
          },
        },
      },
      "assistant-recap": {
        id: "assistant-recap",
        parent: "tool-search",
        message: {
          id: "message-recap",
          author: { role: "assistant" },
          content: { content_type: "reasoning_recap", content: "已核对当前活动分支。" },
          metadata: { finished_duration_sec: 8 },
        },
      },
    },
    ...overrides,
  };
}

function createAdapter({
  payload = conversationPayload(),
  onJson = null,
  url = "https://chatgpt.com/c/conversation-1",
} = {}) {
  const calls = [];
  const location = {
    href: url,
    origin: "https://chatgpt.com",
  };
  const context = vm.createContext({
    URL,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Headers,
    Set,
    RegExp,
    encodeURIComponent,
    location,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === "/api/auth/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ accessToken: "session-token", user: { id: "test-user" } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => {
          onJson?.(location);
          return payload;
        },
      };
    },
  });
  context.globalThis = context;
  runClassic(context, "src/features/export/model/export.js");
  runClassic(context, "src/platform/snapshot.js");
  runClassic(context, "src/platform/chatgpt/route.js");
  installPageSession(context);
  runClassic(context, "src/platform/chatgpt/api.js");
  // Exercise the production native conversation owners, not a test copy of the old export parser.
  for (const file of [
    "src/platform/chatgpt/native-message-references.js", "src/platform/chatgpt/native-message-content.js",
    "src/platform/chatgpt/native-message-process.js",
    "src/platform/chatgpt/active-branch.js",
    "src/platform/chatgpt/conversation-projection.js",
  ]) runClassic(context, file);
  runClassic(context, "src/features/export/chatgpt/export.js");
  return { context, calls, location };
}

function createSerializerRuntime() {
  const context = vm.createContext({
    URL,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    TextEncoder,
    TextDecoder,
  });
  context.globalThis = context;
  for (const file of [
    "src/features/export/engine/i18n.js", "src/features/export/engine/normalize.js",
    "src/features/export/engine/plan.js",
    "src/features/export/engine/inline-content.js",
    "src/features/export/engine/serializers.js",
  ]) runClassic(context, file);
  return context.TidyExport;
}

test("authenticated ChatGPT requests refresh a rejected session token once", async () => {
  const calls = [];
  let sessionRead = 0;
  let conversationRead = 0;
  const context = vm.createContext({
    Headers,
    Object,
    Promise,
    globalThis: null,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === "/api/auth/session") {
        sessionRead += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ accessToken: `token-${sessionRead}` }),
        };
      }
      conversationRead += 1;
      return { ok: conversationRead > 1, status: conversationRead > 1 ? 200 : 401 };
    },
  });
  context.globalThis = context;
  installPageSession(context);
  runClassic(context, "src/platform/chatgpt/api.js");

  const response = await context.TidyChatgptApi.fetchAuthenticated("/backend-api/conversation/conversation-1");
  assert.equal(response.status, 200);
  assert.equal(sessionRead, 2);
  assert.equal(conversationRead, 2);
  assert.equal(calls[1].options.headers.get("Authorization"), "Bearer token-1");
  assert.equal(calls[3].options.headers.get("Authorization"), "Bearer token-2");

  await context.TidyChatgptApi.fetchAuthenticated("/backend-api/conversation/conversation-1");
  assert.equal(sessionRead, 2, "the refreshed access token should remain memory-cached");
});

test("current export reads the full active branch from the exact conversation endpoint", async () => {
  const { context, calls } = createAdapter();
  const document = await context.TidyChatgptExport.readCurrentConversation({
    expectedConversationId: "conversation-1",
    fallbackTitle: "Fallback",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/auth/session");
  assert.equal(calls[1].url, "/backend-api/conversation/conversation-1");
  assert.equal(calls[1].options.credentials, "include");
  assert.equal(calls[1].options.headers.get("Authorization"), "Bearer session-token");
  assert.equal(document.conversation.messages.length, 2);
  assert.ok(document.conversation.messages[0].segments[0].blocks[0].text.length > 320);
  assert.match(document.conversation.messages[0].segments[0].blocks[0].text, /正文结尾$/);
  assert.doesNotMatch(JSON.stringify(document), /不应导出的旧分支/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(document.conversation.messages[1].segments.map((segment) => segment.type))),
    ["process", "process", "process", "process", "content", "sources"],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(document.conversation.messages[1].segments[4].blocks.map((block) => block.type))),
    ["heading", "unordered-list", "code", "table"],
  );
  assert.equal(document.conversation.messages[1].segments[4].blocks[0].text, "结论");
  assert.equal(document.conversation.messages[1].segments[0].blocks[0].text, "先检查会话数据");
  assert.equal(document.conversation.messages[1].segments[1].queries[0], "ChatGPT export API");
  assert.equal(document.conversation.messages[1].segments[2].results[0].url, "https://openai.com/");
  assert.equal(document.conversation.messages[1].segments[5].items[0].url, "https://openai.com/");
  assert.equal(context.TidyExportContract.validateDocument(document).valid, true);
});

test("export adapter keeps missing metadata and source warnings language-neutral", async () => {
  const payload = conversationPayload({ title: "" });
  payload.mapping.user.message.content = { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer" }] };
  const { context } = createAdapter({ payload });
  const document = await context.TidyChatgptExport.readCurrentConversation({ expectedConversationId: "conversation-1" });
  assert.equal(document.conversation.title, "");
  assert.equal(document.conversation.resources[0].alt, "");
  assert.equal(document.conversation.messages[0].segments[0].blocks[0].alt, "");
  assert.deepEqual(Array.from(document.warnings), ["IMAGE_UNAVAILABLE"]);
  assert.equal(context.TidyExportContract.validateDocument(document).valid, true);
});

test("export numbering comes from the complete canonical branch, never a mounted-message window", async () => {
  const adapter = createAdapter();
  adapter.context.document = { querySelectorAll() { throw new Error("Export must not enumerate a mounted DOM window"); } };
  const result = await adapter.context.TidyChatgptExport.readCurrentConversation({ expectedConversationId: "conversation-1" });
  assert.deepEqual(Array.from(result.conversation.messages, item => item.messageNumber), [1, 2]);
  assert.deepEqual(Array.from(result.conversation.messages, item => item.id), ["message-user", "message-active"]);
});

test("incomplete or cyclic canonical branches cannot be renumbered as a complete conversation", async () => {
  for (const corrupt of [
    payload => { delete payload.mapping.user; },
    payload => { payload.mapping.root.parent = "assistant-active"; },
    payload => { delete payload.mapping.root.parent; },
  ]) {
    const payload = conversationPayload(); corrupt(payload);
    const adapter = createAdapter({ payload });
    await assert.rejects(adapter.context.TidyChatgptExport.readCurrentConversation({ expectedConversationId: "conversation-1" }), /branch/i);
  }
});

test("current export fails closed when route or response identity changes", async () => {
  const changedRoute = createAdapter({
    onJson(location) { location.href = "https://chatgpt.com/c/conversation-2"; },
  });
  await assert.rejects(
    changedRoute.context.TidyChatgptExport.readCurrentConversation({ expectedConversationId: "conversation-1" }),
    /changed while export data was loading/,
  );

  const changedResponse = createAdapter({ payload: conversationPayload({ id: "conversation-2" }) });
  await assert.rejects(
    changedResponse.context.TidyChatgptExport.readCurrentConversation({ expectedConversationId: "conversation-1" }),
    /identity changed/,
  );

  const wrongStart = createAdapter();
  await assert.rejects(
    wrongStart.context.TidyChatgptExport.readCurrentConversation({ expectedConversationId: "conversation-2" }),
    /changed before export started/,
  );
  assert.equal(wrongStart.calls.length, 0);
});

test("a bound draft route may export its mapped canonical conversation", async () => {
  const alias = createAdapter({ url: "https://chatgpt.com/c/WEB%3Adraft-1" });
  const document = await alias.context.TidyChatgptExport.readCurrentConversation(
    { expectedConversationId: "conversation-1" },
    { routeOwnsConversation: (conversationId) => conversationId === "conversation-1" },
  );
  assert.equal(document.conversation.id, "conversation-1");
  assert.equal(alias.calls[1].url, "/backend-api/conversation/conversation-1");
});

test("Markdown, JSON and TXT serialize the same untruncated current document", async () => {
  const { context } = createAdapter();
  const document = await context.TidyChatgptExport.readCurrentConversation({ expectedConversationId: "conversation-1" });
  const tidy = createSerializerRuntime();
  const data = tidy.normalizeExportData({ conversations: [document.conversation], bookmarks: [] });
  const options = {
    timestamps: true,
    messageNumbers: true,
    visibleProcess: true,
    webProcess: true,
    finalSources: true,
  };

  for (const format of ["markdown", "json", "txt"]) {
    const plan = tidy.buildExportPlan({ messages: exportMessages(),
      mode: "current",
      format,
      currentConversationId: "conversation-1",
      names: { current: "TIDY / 当前会话" },
      options,
      data,
    });
    assert.equal(plan.files.length, 1);
    assert.equal(plan.zipped, false);
    assert.doesNotMatch(plan.outputName, /[\\/:*?"<>|]/);
    const output = tidy.serializeTextFile(plan.files[0], format, {
      messages: plan.messages,
      options,
      roleNames: { user: "我", assistant: "ChatGPT" },
      formatTimestamp: (value) => value,
    });
    assert.match(output, /正文结尾/);
    assert.match(output, /OpenAI/);
    assert.match(output, /先检查会话数据/);
    assert.match(output, /ChatGPT export API/);
    assert.doesNotMatch(output, /不应导出的旧分支/);
    if (format === "json") {
      const json = JSON.parse(output);
      assert.equal(json.schemaVersion, "chatgpt-tidy.export.v3");
      assert.equal(json.conversation.messages[0].role, "user");
      assert.equal(json.conversation.messages[0].displayName, "我");
      assert.equal(json.conversation.messages[1].segments[0].type, "process");
      assert.equal(json.conversation.messages[1].segments[4].type, "content");
      assert.equal("name" in json.conversation.messages[0], false);
    }
  }
});

test("Side Panel export clients keep the bound tab and caller source identity", async () => {
  const runtime = createPanelRuntime();
  runtime.load("src/platform/protocol.js");
  const protocol = runtime.context.TidyProtocol;
  const { createFeatureClients } = runtime.load("src/app/sidepanel/feature-clients.js");
  const calls = [];
  const clients = createFeatureClients({ ownerTabId: 41, protocol,
    request: async (type, payload) => { calls.push({ type, payload }); return payload; },
  });
  const identity = { documentId: "document-one", epoch: 9 };
  const source = { expectedTabId: 999, expectedConversationId: "conversation-1",
    expectedAccountKey: "account-one", expectedIdentity: identity };
  await clients.exportDocument(source);
  await clients.exportDocuments({ ...source, conversationIds: ["conversation-1"], bookmarkIds: [] });
  await clients.exportJob("start", source);
  await clients.presentPreview({ ...source, sessionId: "preview-one" });
  assert.deepEqual(calls.map(call => call.type), [protocol.Type.EXPORT_CURRENT_CONVERSATION,
    protocol.Type.EXPORT_CONVERSATIONS, protocol.Type.EXPORT_JOB_START, protocol.Type.EXPORT_PREVIEW_OPEN]);
  for (const { payload } of calls) {
    assert.equal(payload.expectedTabId, 41, "feature clients must never follow the active or caller-supplied tab");
    assert.equal(payload.expectedConversationId, source.expectedConversationId);
    assert.equal(payload.expectedAccountKey, source.expectedAccountKey);
    assert.equal(payload.expectedIdentity, identity, "source ownership must not be replaced with a newer snapshot");
  }
  await clients.dismissPreview({ sessionId: "preview-one" });
  assert.equal(calls[4].type, protocol.Type.EXPORT_PREVIEW_CLOSE);
  assert.equal(calls[4].payload.sessionId, "preview-one");
  assert.equal(calls[4].payload.expectedTabId, 41);
});

test("formal Side Panel loads the polished export runtime and wires source-backed batch export", () => {
  const html = fs.readFileSync(path.join(root, "src/app/sidepanel/index.html"), "utf8");
  const view = fs.readFileSync(path.join(root, "src/features/export/ui/export-view.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/features/export/ui/export.css"), "utf8");
  const panel = fs.readFileSync(path.join(root, "src/app/sidepanel/panel.js"), "utf8");
  const clients = fs.readFileSync(path.join(root, "src/app/sidepanel/feature-clients.js"), "utf8");
  const markup = fs.readFileSync(path.join(root, "src/features/export/ui/export-markup.js"), "utf8");
  const documents = fs.readFileSync(path.join(root, "src/features/export/ui/export-context-controller.js"), "utf8");
  const jobs = fs.readFileSync(path.join(root, "src/features/export/ui/export-job-controller.js"), "utf8");
  const previewController = fs.readFileSync(path.join(root, "src/features/export/ui/export-preview-controller.js"), "utf8");
  const previewPresentation = fs.readFileSync(path.join(root, "src/features/export/chatgpt/export-preview-presentation.js"), "utf8");
  const bundle = fs.readFileSync(path.join(root, "src/app/page/main-world.bundle.js"), "utf8");

  assert.match(html, /data-route="export"[^>]*>/);
  assert.doesNotMatch(html, /data-route="export"[^>]*disabled/);
  assert.match(html, /id="export-view" class="module-view"[^>]*><\/section>/);
  const scriptOrder = [
    "../../features/export/model/export.js",
    "../../features/export/engine/i18n.js",
    "../../features/export/engine/normalize.js",
    "../../features/export/engine/plan.js",
    "../../features/export/engine/inline-content.js",
    "../../features/export/engine/serializers.js",
    "panel.js",
  ].map((source) => html.indexOf(`src="${source}"`));
  assert.ok(scriptOrder.every((index) => index >= 0));
  assert.doesNotMatch(html, /<script[^>]+src="\.\.\/\.\.\/vendor\//);
  assert.deepEqual([...scriptOrder].sort((a, b) => a - b), scriptOrder);

  assert.match(markup, /data-export-mode="batch"/);
  assert.match(markup, /data-export-source="favorites"/);
  assert.match(markup, /data-export-source="bookmarks"/);
  assert.match(markup, /data-export-source="search"/);
  assert.doesNotMatch(markup, /data-export-source="search"[^>]*disabled/);
  assert.doesNotMatch(markup, /exportBatchSearchPending/);
  assert.match(view, /requestDocuments/);
  assert.match(documents, /requestDocument\(\{\s*expectedConversationId: ticket\.conversationId, expectedAccountKey: ticket\.accountKey/);
  assert.match(markup, /\["toolProcess", "exportToolProcess"\]/);
  assert.match(documents, /function contentKey\(snapshot\)/);
  assert.match(documents, /state\.contextKey === ticket\.contextKey && state\.contentKey === ticket\.contentKey/);
  assert.match(documents, /document\.conversation\.id !== ticket\.conversationId/);
  for (const owner of [view, markup, documents, jobs, previewController]) {
    assert.doesNotMatch(owner, /generateExport|triggerBrowserDownload/);
    assert.doesNotMatch(owner, /exportDownloadStarted|exportBatchSearchPending/);
    assert.doesNotMatch(owner, /exportExistingContentOnly|exportRoleNote|exportJsonRoleNote|exportExample|exportMiniPrompt|exportKeepSettings/);
    assert.doesNotMatch(owner, /export-complete-choice|data-export-complete|actionSummary/);
    assert.doesNotMatch(owner, /function fullPreviewMarkup|class="export-full-preview-layer"/);
  }
  for (const [factory, module] of [["createExportContextController", "export-context-controller"],
    ["createExportJobController", "export-job-controller"], ["createExportPreviewController", "export-preview-controller"],
    ["renderExportMarkup", "export-markup"]]) {
    assert.ok(view.includes('from "./' + module + '.js"'), module + " must be imported by the real export view");
    assert.match(view, new RegExp("\\b" + factory + "\\("), module + " must be called, not only imported");
  }
  assert.match(view, /const plan = exportApi\.clone\(exportPlan\(\)\)/);
  assert.match(jobs, /await jobRequest\("start", request\)/);
  assert.match(panel, /import \{ createFeatureClients \} from "\.\/feature-clients\.js"/);
  assert.match(panel, /createFeatureClients\(\{ request: sendRequest, ownerTabId: panelOwnerTabId, protocol \}\)/);
  assert.match(clients, /request\(type, \{ \.\.\.payload, expectedTabId: ownerTabId \}\)/);
  assert.match(panel, /requestDocument: featureClients\.exportDocument/);
  assert.match(clients, /exportDocument: payload => bound\(protocol\.Type\.EXPORT_CURRENT_CONVERSATION, payload\)/);
  assert.match(panel, /requestDocuments: featureClients\.exportDocuments/);
  assert.match(clients, /exportDocuments: payload => bound\(protocol\.Type\.EXPORT_CONVERSATIONS, payload\)/);
  assert.match(view, /createExportPreviewController\(\{\s*root, present: presentFullPreview, dismiss: dismissFullPreview/);
  assert.match(previewController, /await present\(\{ \.\.\.payload, sessionId: id \}\)/);
  assert.match(previewController, /dismiss\(\{ sessionId: previous\.id, expectedAccountKey: previous\.accountKey \}\)/);
  assert.match(markup, /class="export-action-bar__preview" data-export-full-preview/);
  assert.match(markup, /completed: "exportJobCompleted"/);
  assert.match(markup, /data-export-job-warnings/);
  assert.match(markup, /data-export-job-cancel/);
  assert.match(panel, /jobRequest: featureClients\.exportJob/);
  assert.match(clients, /start: protocol\.Type\.EXPORT_JOB_START/);
  assert.match(css, /:active:not\(:disabled\)\s*\{\s*transform:\s*scale\(\.98\)/);
  assert.doesNotMatch(markup, /exportDownloadStarted/);
  assert.doesNotMatch(markup, /exportExistingContentOnly|exportRoleNote|exportJsonRoleNote|exportExample|exportMiniPrompt|exportKeepSettings/);
  assert.doesNotMatch(markup, /export-complete-choice|data-export-complete|actionSummary/);
  assert.doesNotMatch(markup, /function fullPreviewMarkup|class="export-full-preview-layer"/);
  assert.doesNotMatch(css, /\.export-full-preview-layer|\.export-full-preview__dialog/);
  assert.doesNotMatch(css, /\.export-secondary-note|\.export-mini-conversation|\.export-complete-choice/);
  assert.match(previewPresentation, /position:\s*fixed/);
  assert.match(previewPresentation, /top:\s*50%[\s\S]{0,80}left:\s*50%/);
  assert.match(previewPresentation, /listen\(handle, "pointerdown"/);
  assert.match(previewPresentation, /handle\.setPointerCapture\(event\.pointerId\)/);
  assert.match(previewPresentation, /global\.innerWidth - rect\.width - EDGE_GAP/);
  assert.match(previewPresentation, /event\.target\.closest\("button"\)/);
  assert.match(previewPresentation, /code\.textContent = payload\.content/);
  assert.match(css, /\.export-preview__open\s*\{[^}]*min-height:\s*28px[^}]*font-size:\s*12px/s);
  assert.match(previewPresentation, /CSS_PIXELS_PER_POINT = 96 \/ 72/);
  assert.match(previewPresentation, /font:\s*15px\/1\.65/);
  assert.match(previewPresentation, /PDF_FONT_POINTS = Object\.freeze\(\{ small: 9\.5, standard: 10\.75, large: 12 \}\)/);
  assert.match(previewPresentation, /--preview-font-size/);
  assert.match(previewPresentation, /--preview-page-width/);
  assert.match(previewPresentation, /applyPdfVisualScale\(previewDocument, payload\.pdf\)/);
  assert.match(css, /\.export-mode-tabs\s*\{[\s\S]{0,240}grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.export-format__buttons\s*\{[^}]*height:\s*31px/);
  assert.match(css, /\.export-action-bar__main > button\s*\{[^}]*height:\s*34px/);
  assert.match(css, /#export-view\s*\{[^}]*container:\s*export-view\s*\/\s*size/);
  assert.match(css, /@container export-view \(max-height:\s*760px\)/);
  assert.match(css, /data-native-color-scheme="dark"[^\n]*export-preview__document:not\(\.export-preview__document--pdf\)/);
  assert.match(bundle, /Source: src\/features\/export\/model\/export\.js/);
  assert.match(bundle, /Source: src\/platform\/chatgpt\/api\.js/);
  assert.match(bundle, /Source: src\/features\/export\/chatgpt\/export\.js/);
  assert.match(bundle, /main-world\.export-adapter/);
  // The browser entry must ship the same pure native owners used by adapter tests.
  const nativeSources = ["active-branch", "native-message-references", "native-message-content", "native-message-process", "conversation-projection"]
    .map(name => bundle.indexOf("// Source: src/platform/chatgpt/" + name + ".js"));
  nativeSources.push(bundle.indexOf("// Source: src/features/export/chatgpt/export.js"));
  assert.ok(nativeSources.every(index => index >= 0), "MAIN bundle must include every real export projection dependency");
  assert.deepEqual([...nativeSources].sort((a, b) => a - b), nativeSources);

});

test("export page tabs follow Search without changing the format segment or batch count", () => {
  const css = fs.readFileSync(path.join(root, "src/features/export/ui/export.css"), "utf8");
  const search = readPanelCss();
  const approvedBaseline = fs.readFileSync(path.join(root, "tests/fixtures/approved-ui-baseline.css"), "utf8");
  const view = fs.readFileSync(path.join(root, "src/features/export/ui/export-markup.js"), "utf8");
  for (const [suffix, properties] of [
    ["", ["display", "grid-template-columns", "border-bottom"]],
    [" button", ["min-width", "min-height", "padding", "border", "border-bottom", "background", "color", "font", "font-size", "cursor"]],
    [' button[aria-selected="true"]', ["border-bottom-color", "color", "font-weight"]],
  ]) {
    const actual = cssDeclarations(css, `.export-mode-tabs${suffix}`);
    const expected = cssDeclarations(search, `.search-mode-tabs${suffix}`);
    for (const property of properties) assert.equal(actual[property], expected[property], `export-mode-tabs${suffix}.${property}`);
    for (const retired of ["height", "border-radius", "box-shadow"]) assert.equal(actual[retired], undefined);
  }
  assert.equal(cssDeclarations(css, ".export-mode-tabs").background, undefined);
  assert.equal(cssDeclarations(css, ".export-mode-tabs button:focus-visible")["outline-offset"], "-2px");
  assert.match(cssDeclarations(css, ".export-mode-tabs button:focus-visible").outline, /var\(--accent-ring\)/);
  assert.equal(cssDeclarations(css, ".export-mode-tabs button:disabled").opacity, ".46");
  assert.equal(cssDeclarations(css, ".export-mode-tabs button:disabled").color, "var(--text-tertiary)");
  assert.doesNotMatch(css, /:root\[data-native-color-scheme="dark"\][^{]*\.export-mode-tabs/);
  assert.doesNotMatch(css, /\.export-mode-tabs button\.is-active/);
  assert.deepEqual(cssDeclarations(css, ".export-mode-tabs button span"), cssDeclarations(approvedBaseline, ".export-mode-tabs button span"));
  assert.match(view, /data-export-mode="batch"[^>]*aria-selected=/);
  assert.match(view, /basketCount\(\) > 99 \? "99\+" : basketCount\(\)/);

  // Format is a setting, not a destination: retain the original segmented
  // control and its light/dark active fill rather than styling every tab alike.
  for (const suffix of ["", " button", " button.is-active", " button:focus-visible"]) {
    assert.deepEqual(cssDeclarations(css, `.export-format__buttons${suffix}`), cssDeclarations(approvedBaseline, `.export-format__buttons${suffix}`));
  }
  assert.match(css, /:root\[data-native-color-scheme="dark"\] :is\([^{]*\.export-format__buttons button\.is-active[^{]*\)\s*\{[^}]*background: var\(--surface\)/);
});

test("current and batch exports share one preview size and one footer divider", () => {
  const css = fs.readFileSync(path.join(root, "src/features/export/ui/export.css"), "utf8");
  const view = fs.readFileSync(path.join(root, "src/features/export/ui/export-markup.js"), "utf8");
  assert.equal(cssDeclarations(css, ".export-preview__clip").height, "224px");
  assert.equal(cssDeclarations(css, ".export-preview-block")["border-bottom"], "0");
  assert.equal(cssDeclarations(css, ".export-preview-block")["margin-bottom"], "0");
  assert.match(cssDeclarations(css, ".export-action-bar")["border-top"], /^1px solid /);
  assert.doesNotMatch(css + view, /export-preview-block--(?:current|batch)\b/);
  assert.equal((view.match(/class="export-block export-preview-block /g) || []).length, 1, "preview chrome has one template");
  assert.match(view, /isBatch \? batchPreviewMarkup\(\) : currentPreviewMarkup\(\)/);
});

test("empty export basket follows native theme tokens in every button state", () => {
  const css = fs.readFileSync(path.join(root, "src/features/export/ui/export.css"), "utf8");
  const expected = {
    ".export-basket-empty": { border: "1px solid var(--border-subtle)", background: "var(--surface-subtle)" },
    ".export-basket-empty > strong": { color: "var(--text-primary)" },
    ".export-basket-empty button": { border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text-secondary)" },
    ".export-basket-empty button:hover, .export-basket-empty button:focus-visible": { "border-color": "var(--accent)", color: "var(--accent)" },
    ".export-basket-empty button:disabled:hover": { "border-color": "var(--border)", background: "var(--surface-subtle)", color: "var(--text-tertiary)" },
  };
  for (const [selector, properties] of Object.entries(expected)) {
    const actual = cssDeclarations(css, selector);
    for (const [property, value] of Object.entries(properties)) {
      assert.equal(actual[property], value, `${selector}: ${property}`);
    }
    assert.doesNotMatch(Object.values(actual).join(" "), /#[\da-f]{3,8}\b|rgba?\(/i, `${selector} must not pin a light palette`);
  }
  assert.match(css, /\.export-basket-empty button:disabled,\s*\.export-basket-empty button:disabled:hover/);
});

test("manifest and bridge expose export only through the bound-tab production path", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "src/manifest.json"), "utf8"));
  const isolated = manifest.content_scripts.find((entry) => !entry.world);
  const protocol = fs.readFileSync(path.join(root, "src/platform/protocol.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "src/app/background/service-worker.js"), "utf8");
  const handler = fs.readFileSync(path.join(root, "src/app/background/handlers/export.js"), "utf8");
  const gateway = fs.readFileSync(path.join(root, "src/app/background/adapters/export-gateway.js"), "utf8");
  const pageEvents = fs.readFileSync(path.join(root, "src/platform/session/background/page-events.js"), "utf8");
  const messages = fs.readFileSync(path.join(root, "src/app/background/runtime-messages.js"), "utf8");
  const panel = fs.readFileSync(path.join(root, "src/app/sidepanel/panel.js"), "utf8");
  const previewPresentation = "features/export/chatgpt/export-preview-presentation.js";
  assert.match(worker, /import \{ createExportHandler \} from "\.\/handlers\/export\.js"/);
  assert.match(worker, /createRequestRouter\([\s\S]{0,650}createExportHandler\(\{ binding, pageGateway, library, catalog, exportJobs \}\)/);
  assert.match(handler, /import \{ createExportGateway \} from "\.\.\/adapters\/export-gateway\.js"/);
  assert.match(handler, /createExportGateway\(\{ pageGateway \}\)/);
  assert.match(worker, /pageEvents: createPageEvents\(\{ chrome, identity: libraryIdentity \}\)/);
  assert.match(messages, /EXPORT_PREVIEW_CLOSED[\s\S]{0,150}pageEvents\.previewClosed\(envelope, sender\)/);
  assert.ok(isolated.js.includes("features/export/model/export.js"));
  assert.ok(isolated.js.includes(previewPresentation));
  assert.match(protocol, /EXPORT_CURRENT_CONVERSATION:\s*"export\.current-conversation"/);
  assert.match(protocol, /EXPORT_UNAVAILABLE:\s*"EXPORT_UNAVAILABLE"/);
  assert.match(protocol, /EXPORT_PREVIEW_OPEN:\s*"export\.preview-open"/);
  assert.match(protocol, /EXPORT_PREVIEW_CLOSE:\s*"export\.preview-close"/);
  assert.match(protocol, /EXPORT_PREVIEW_CLOSED:\s*"export\.preview-closed"/);
  assert.match(handler, /getBoundTab\(payload\.expectedTabId, sender\)/);
  assert.match(handler, /requestTabSnapshot\(tab\)/);
  assert.match(handler, /conversationId:\s*payload\.expectedConversationId/);
  assert.match(handler, /requestCurrentConversationExport\(tab,/);
  assert.match(gateway, /result\.payload\.conversation\.id !== payload\.expectedConversationId/);
  assert.match(handler, /EXPORT_PREVIEW_OPEN, protocol\.Type\.EXPORT_PREVIEW_CLOSE/);
  assert.match(handler, /requestTabExportPreview\(tab, envelope\.type, payload\)/);
  assert.match(handler, /EXPORT_PREVIEW_OPEN\)[\s\S]{0,900}requestTabSnapshot\(tab\)/);
  assert.match(pageEvents, /EXPORT_PREVIEW_CLOSED[\s\S]{0,500}tabId:\s*sender\.tab\.id/);
  assert.match(panel, /EXPORT_PREVIEW_CLOSED[\s\S]{0,300}payload\?\.tabId === panelOwnerTabId/);
  assert.doesNotMatch(handler, /EXPORT_CURRENT_CONVERSATION[\s\S]{0,800}queryActiveTab/);
});

test("production export runtime is the single maintained implementation", () => {
  for (const production of [
    "src/features/export/engine/i18n.js", "src/features/export/engine/normalize.js", "src/features/export/engine/plan.js", "src/features/export/engine/inline-content.js", "src/features/export/engine/serializers.js",
    "src/features/export/engine/assets.js", "src/features/export/engine/pdf.js", "src/features/export/engine/download.js", "src/assets/fonts/noto-sans-sc/manifest.json",
    "src/assets/fonts/fallback/manifest.json", "src/assets/fonts/OFL-NotoSansFallbacks.txt",
    "src/vendor/regenerator-runtime-0.14.1.js",
    "src/assets/fonts/NotoEmoji-Regular.ttf", "src/assets/fonts/OFL-NotoEmoji.txt",
  ]) assert.equal(fs.existsSync(path.join(root, production)), true, `${production} must exist`);

  const serializer = fs.readFileSync(path.join(root, "src/features/export/engine/serializers.js"), "utf8");
  assert.match(serializer, /chatgpt-tidy\.export\.v3/);
  assert.match(serializer, /groupAdjacentProcessSegments/);
  assert.doesNotMatch(serializer, /content_blocks|visible_process|web_searches|final_sources/);
});
