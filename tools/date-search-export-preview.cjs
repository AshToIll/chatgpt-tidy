"use strict";

// Local QA only: real panel.js, component views, directory service, IndexedDB,
// serializers and CSS. Chrome runtime, owner tab and download delivery are mocks.
// Usage: node tools/date-search-export-preview.cjs [port]
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const repository = path.resolve(__dirname, "..");
const port = Number(process.argv[2] || 4189);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json",
};

async function panelBootstrap() {
  const { DEFAULT_PREFERENCES, PREFERENCES_KEY } = await import("/src/platform/preferences/preferences.js");
  const params = new URLSearchParams(location.search);
  const language = ["zh-CN", "zh-TW", "en", "ja"].includes(params.get("lang")) ? params.get("lang") : "zh-CN";
  const preferences = { ...DEFAULT_PREFERENCES, language, timeZone: "Asia/Singapore" };
  const titleRules = { mode: "created", dateFormat: "locale" };
  const previewTabId = 1;
  const previewDocumentId = "synthetic-date-export-document";
  const accountKey = `preview-date-export:${params.get("session") || "one"}`;
  // The catalog key is intentionally not the authenticated library owner.
  // QA should catch accidental reuse of the workspace-only directory identity.
  const libraryAccountKey = JSON.stringify([`preview-user:${params.get("session") || "one"}`, "personal"]);
  const dark = params.get("theme") === "dark";
  const record = { boundary: "Real panel.js; mock runtime/owner-tab/download delivery", requests: [], diagnosticsCalls: 0, generated: [], errors: [], lastPreview: null };
  const runtimeListeners = [];
  const diagnosticsSession = {};
  let diagnosticsService = null;
  let exportJob = null, exportWorker = null;
  const jobChanged = () => {
    const event = TidyProtocol.event(TidyProtocol.Type.EXPORT_JOB_CHANGED, { tabId: previewTabId, id: exportJob?.id });
    runtimeListeners.forEach(listener => listener(event)); publish();
  };
  const clone = (value) => structuredClone(value);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const conversations = Array.from({ length: 36 }, (_, index) => {
    const createdAt = Date.UTC(2026, 8, 1 + index % 8, index % 20);
    const updatedAt = Date.UTC(2026, 8, 8, 12) - index * 60_000;
    return {
      conversationId: `preview-date-${String(index + 1).padStart(2, "0")}`,
      title: `${String(index + 1).padStart(2, "0")} ${["Date export workflow", "Search result selection", "Creative project notes", "Product decisions and review"][index % 4]}`,
      updatedAt, projectId: null,
      directoryBounds: { createdAt, updatedAt, sources: ["ordinary"] },
    };
  });
  const byId = new Map(conversations.map((row) => [row.conversationId, row]));
  const favorites = { accountKey: libraryAccountKey, revision: 1, groups: [], view: { groupId: "all", sortField: "updatedAt", sortDirection: "desc", page: 1, pageSize: 7 }, items: {} };
  for (const row of conversations.slice(0, 2)) favorites.items[row.conversationId] = {
    conversationId: row.conversationId, title: row.title, routePath: `/c/${row.conversationId}`,
    createdAt: new Date(row.directoryBounds.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
    savedAt: "2026-09-08T04:00:00.000Z", groupId: null, note: "",
  };
  const bookmarks = { accountKey: libraryAccountKey, revision: 1, groups: [], view: { groupId: "all", query: "", sortField: "bookmarkedAt", sortDirection: "desc", page: 1, pageSize: 8 }, items: {} };
  for (const row of conversations.slice(0, 2)) {
    const bookmarkId = `${encodeURIComponent(row.conversationId)}::${encodeURIComponent(`${row.conversationId}-assistant`)}`;
    bookmarks.items[bookmarkId] = {
      bookmarkId, conversationId: row.conversationId, conversationTitle: row.title,
      messageId: `${row.conversationId}-assistant`, messageTimestamp: "2026-09-08T04:00:00.000Z",
      orderNumber: 2, orderIndex: 1, role: "assistant", bookmarkedAt: "2026-09-08T05:00:00.000Z",
      groupId: null, note: "", excerpt: "Synthetic bookmarked answer for export QA.", routePath: `/c/${row.conversationId}`,
    };
  }
  function documentFor(id) {
    const row = byId.get(id);
    if (!row) throw new Error(`Unknown mock conversation ${id}`);
    return {
      schemaVersion: globalThis.TidyExportContract.VERSION,
      conversation: {
        id, title: row.title, createdAt: new Date(row.directoryBounds.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(), sourceUrl: `https://chatgpt.com/c/${id}`, resources: [],
        messages: ["user", "assistant"].map((role, index) => ({
          id: `${id}-${role}`, messageNumber: index + 1, role, timestamp: "2026-09-08T04:00:00.000Z",
          segments: [{ type: "content", sourceMessageId: `${id}-${role}`, timestamp: "2026-09-08T04:00:00.000Z",
            blocks: [{ type: "paragraph", text: `${role === "user" ? "Question" : "Answer"} for ${row.title}. This is the complete synthetic message, not a search summary.` }] }],
        })),
      }, warnings: [],
    };
  }
  const snapshot = {
    route: { pathname: "/c/preview-date-01", href: "https://chatgpt.com/c/preview-date-01" },
    appearance: { colorScheme: dark ? "dark" : "light" },
    conversation: { conversationId: "preview-date-01", bindingStatus: "bound", identityStatus: "stable",
      title: { value: conversations[0].title }, createdAt: { value: "2026-09-01T00:00:00.000Z" },
      updatedAt: { value: "2026-09-08T12:00:00.000Z" } }, messages: [],
  };
  function publish() {
    const search = document.getElementById("search-view");
    const exportRoot = document.getElementById("export-view");
    const summary = { ...record, accountKey, libraryAccountKey,
      route: document.querySelector(".time-panel__body")?.dataset.activeRoute,
      dimensions: { width: innerWidth, height: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth },
      count: search?.querySelector(".search-list-heading small")?.textContent || "",
      selected: search?.querySelector(".source-export-select__footer > span")?.textContent || "",
      pagination: search?.querySelector(".result-pagination")?.textContent.trim() || "",
      badge: document.querySelector("[data-export-badge]")?.textContent || "",
      basketTitles: [...(exportRoot?.querySelectorAll(".export-basket-row strong") || [])].map((node) => node.textContent),
      searchRows: search?.querySelectorAll(".search-result, .search-export-row").length || 0,
    };
    document.body.dataset.qaSummary = JSON.stringify(summary);
    if (parent !== window) parent.postMessage({ type: "tidy-date-export-preview", summary }, location.origin);
  }
  async function respond(type, payload) {
    const Type = globalThis.TidyProtocol.Type;
    switch (type) {
      // The real panel keeps its admission gate: only this local runtime boundary
      // supplies a synthetic ready document. No production gate is bypassed.
      case Type.PAGE_SESSION_PROBE: return { ready: true, documentId: previewDocumentId };
      case Type.GET_ACTIVE_CONTEXT: return { tab: { id: previewTabId }, snapshot: clone(snapshot) };
      case Type.TITLE_RULES_GET: return clone(titleRules);
      case Type.TITLE_RULES_UPDATE: Object.assign(titleRules, payload); return clone(titleRules);
      case Type.PREFERENCES_GET: return clone(preferences);
      case Type.PREFERENCES_UPDATE: Object.assign(preferences, payload); return clone(preferences);
      case Type.LIBRARY_ACCOUNT: return { accountKey: libraryAccountKey };
      case Type.LIBRARY_GET: return { accountKey: libraryAccountKey,
        identity: { documentId: previewDocumentId, epoch: 0 }, favorites: clone(favorites), bookmarks: clone(bookmarks),
        errors: {} };
      case Type.FAVORITES_GET: return clone(favorites);
      case Type.BOOKMARKS_GET: return clone(bookmarks);
      case Type.FAVORITES_VIEW_UPDATE: Object.assign(favorites.view, payload); return clone(favorites);
      case Type.BOOKMARKS_VIEW_UPDATE: Object.assign(bookmarks.view, payload); return clone(bookmarks);
      case Type.DATE_INDEX_ACCOUNT: return { schemaVersion: globalThis.TidyDateSearch.VERSION, accountKey };
      case Type.DATE_INDEX_SOURCE_PAGE: {
        await wait(120);
        const ordinary = payload.source === "ordinary";
        const offset = ordinary && payload.cursor ? Number(payload.cursor.split(":")[1]) : 0;
        const items = ordinary ? conversations.slice(offset, offset + 12) : [];
        const done = !ordinary || offset + items.length >= conversations.length;
        return { schemaVersion: globalThis.TidyDateSearch.VERSION, source: payload.source,
          conversations: clone(items), projects: [], done, nextCursor: done ? null : `preview:${offset + items.length}`, coverageReasons: [] };
      }
      case Type.EXPORT_JOB_STATUS: return clone(exportJob);
      case Type.EXPORT_JOB_DISMISS:
        if (exportJob?.id === payload.id) {
          exportJob = { ...exportJob, dismissedAt: Date.now(), revision: exportJob.revision + 1 };
        }
        return clone(exportJob);
      case Type.EXPORT_JOB_CANCEL:
        exportWorker?.terminate(); exportWorker = null;
        exportJob = { ...exportJob, state: 'cancelled', revision: exportJob.revision + 1 }; return clone(exportJob);
      case Type.EXPORT_JOB_START: {
        if (exportJob && ['generating', 'saving'].includes(exportJob.state)) return clone(exportJob);
        exportJob = { id: payload.id, outputName: payload.spec.plan.outputName, state: 'generating', revision: 1 };
        // 本地原型只模拟下载回执，计算使用真实线程。真实保存请运行隔离扩展验收脚本。
        exportWorker = new Worker('/src/features/export/engine/job-worker.js');
        exportWorker.onmessage = ({ data }) => {
          if (data.type === 'progress') exportJob.progress = data.progress;
          else {
            exportWorker.terminate(); exportWorker = null;
            exportJob.state = data.type === 'ready' ? 'completed' : 'failed';
            exportJob.errorCode = data.errorCode || '';
            exportJob.warnings = data.result?.warnings || [];
            if (data.result) record.generated.push({ outputName: data.result.outputName, mimeType: data.result.mimeType,
              byteLength: data.result.bytes.byteLength, warnings: data.result.warnings });
          }
          exportJob.revision++; jobChanged();
        };
        exportWorker.onerror = () => {
          exportWorker.terminate(); exportWorker = null;
          exportJob.state = 'failed'; exportJob.errorCode = 'exportJobFailed'; exportJob.revision++; jobChanged();
        };
        exportWorker.postMessage(payload.spec); return clone(exportJob);
      }
      case Type.EXPORT_CURRENT_CONVERSATION: return documentFor(payload.expectedConversationId);
      case Type.EXPORT_CONVERSATIONS:
        if (payload.expectedAccountKey !== libraryAccountKey) throw new Error("Mock library account mismatch");
        if (payload.searchSelection && payload.searchSelection.accountKey !== accountKey) throw new Error("Mock account mismatch");
        await wait(200);
        return { schemaVersion: globalThis.TidyExportContract.COLLECTION_VERSION, documents: payload.conversationIds.map(documentFor) };
      case Type.EXPORT_PREVIEW_OPEN:
        record.lastPreview = { sessionId: payload.sessionId, format: payload.format, title: payload.title };
        return { opened: true };
      case Type.EXPORT_PREVIEW_CLOSE: return { closed: true };
      case Type.SEARCH_MESSAGES: return { schemaVersion: "tidy.search.v1", query: payload.query, items: [], cursor: null, hasMore: false, partialResults: false };
      case Type.SEARCH_OPEN_RESULT:
      case Type.FAVORITES_OPEN:
      case Type.BOOKMARKS_OPEN: return { opened: true };
      default: throw new Error(`Unsupported mock request: ${type}`);
    }
  }
  globalThis.chrome = {
    runtime: {
      id: "local-date-export-preview", lastError: null,
      getURL: (file) => `${location.origin}/src/${file}`,
      onMessage: {
        addListener(listener) { runtimeListeners.push(listener); },
        removeListener(listener) {
          const index = runtimeListeners.indexOf(listener);
          if (index >= 0) runtimeListeners.splice(index, 1);
        },
      },
      connect: () => ({ postMessage() {}, disconnect() {}, onDisconnect: { addListener() {} }, onMessage: { addListener() {} } }),
      async sendMessage(envelope) {
        // Diagnostic traffic is separate from business request counts. Reuse the
        // real strict wire/service; only its session storage and sender are local.
        if (envelope?.channel === "tidy.diagnostics.v1") {
          record.diagnosticsCalls += 1;
          diagnosticsService ||= import("/src/platform/diagnostics/worker-service.js")
            .then(({ createDiagnosticsService }) => createDiagnosticsService({ chrome: globalThis.chrome }));
          return (await diagnosticsService).handle(envelope, { id: chrome.runtime.id,
            url: chrome.runtime.getURL("app/sidepanel/index.html") + "?tabId=1" });
        }
        const request = { type: envelope.type, payload: clone(envelope.payload), status: "pending" };
        record.requests.push(request);
        try {
          const value = await respond(envelope.type, envelope.payload || {});
          request.status = "ok";
          return globalThis.TidyProtocol.response(envelope, value);
        } catch (error) {
          request.status = error.message;
          return globalThis.TidyProtocol.failure(envelope, "INTERNAL_ERROR", error.message);
        } finally { publish(); }
      },
    },
    storage: {
      session: {
        async get(key) { return { [key]: clone(diagnosticsSession[key]) }; },
        async set(value) { Object.assign(diagnosticsSession, clone(value)); },
      },
      sync: { get: (_key, callback) => callback({ [PREFERENCES_KEY]: clone(preferences) }), set: (_value, callback) => callback?.() },
      onChanged: { addListener() {}, removeListener() {} },
    },
    sidePanel: { async close() {} },
  };
  addEventListener("error", (event) => { record.errors.push(event.message); publish(); });
  addEventListener("unhandledrejection", (event) => { record.errors.push(String(event.reason)); publish(); });
  new MutationObserver(publish).observe(document.querySelector(".tidy-shell") || document.querySelector("main"), { childList: true, subtree: true, characterData: true });
  addEventListener("resize", publish);
  await import("/src/app/sidepanel/panel.js");
  await wait(100);
  document.querySelector('[data-route="search"]')?.click();
  document.querySelector('[data-search-mode="date"]')?.click();
  addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.type !== "tidy-preview-route") return;
    const route = event.data.route;
    if (["search", "export", "favorites", "bookmarks", "settings"].includes(route)) document.querySelector(`[data-route="${route}"]`)?.click();
  });
  publish();
}

function hostBootstrap() {
  const frame = document.getElementById("panel-preview");
  const form = document.getElementById("preview-options");
  const params = new URLSearchParams(location.search);
  params.set("session", params.get("session") || crypto.randomUUID());
  for (const name of ["width", "height", "lang", "theme"]) {
    const field = form.elements.namedItem(name);
    if ([...field.options].some((option) => option.value === params.get(name))) field.value = params.get(name);
  }
  function apply(reload = false) {
    for (const name of ["width", "height", "lang", "theme"]) params.set(name, form.elements.namedItem(name).value);
    frame.style.width = `${params.get("width")}px`;
    frame.style.height = `${params.get("height")}px`;
    history.replaceState(null, "", `/preview?${params}`);
    if (reload || !frame.getAttribute("src")) frame.src = `/preview/panel?${params}`;
  }
  form.addEventListener("change", (event) => apply(["theme", "lang"].includes(event.target.name)));
  document.querySelectorAll("[data-qa-route]").forEach((button) => button.addEventListener("click", () => {
    frame.contentWindow.postMessage({ type: "tidy-preview-route", route: button.dataset.qaRoute }, location.origin);
  }));
  document.getElementById("preview-reset").addEventListener("click", () => { params.set("session", crypto.randomUUID()); apply(true); });
  addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== "tidy-date-export-preview") return;
    const output = document.getElementById("preview-summary");
    output.textContent = JSON.stringify(event.data.summary, null, 2);
    output.dataset.qaSummary = JSON.stringify(event.data.summary);
  });
  apply();
}

const hostHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TIDY date search export QA</title><style>
*{box-sizing:border-box}body{margin:0;padding:20px;background:#e7e9ed;color:#292c33;font:14px system-ui,sans-serif}main{display:flex;gap:24px;align-items:flex-start}iframe{display:block;border:0;flex:none;box-shadow:0 0 0 1px #b7bcc5}aside{width:380px;flex:none}h1{font-size:20px;margin-top:0}label{display:flex;justify-content:space-between;margin:8px 0}select,button{font:inherit;padding:5px 8px}button{margin:3px 3px 3px 0}p{line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace;background:#fff;padding:12px;border:1px solid #bbc0c8;max-height:560px;overflow:auto}
</style></head><body><main><iframe id="panel-preview" title="Real TIDY panel with synthetic account"></iframe><aside><h1>Date search export QA</h1>
<p>Real panel routing, search and export views, local directory and serializers. Mock Chrome runtime, tab owner and download delivery. No real account access.</p>
<form id="preview-options"><label>Width<select name="width"><option>320</option><option selected>420</option></select></label><label>Height<select name="height"><option selected>740</option><option>900</option></select></label><label>Language<select name="lang"><option selected>zh-CN</option><option>zh-TW</option><option>en</option><option>ja</option></select></label><label>Theme<select name="theme"><option selected>light</option><option>dark</option></select></label></form>
<p>36 synthetic conversations, September 1-8, 2026. Date mode loads the catalog without message reads. Export reads complete synthetic messages only after adding to the basket.</p>
<button data-qa-route="search">Search</button><button data-qa-route="export">Export</button><button data-qa-route="favorites">Favorites</button><button data-qa-route="bookmarks">Bookmarks</button><button data-qa-route="settings">Settings</button><button id="preview-reset">Reset session</button>
<h2>Read-only diagnostics</h2><pre id="preview-summary">Loading</pre></aside></main><script src="/preview/host.js"></script></body></html>`;

async function panelHtml() {
  const original = await fs.readFile(path.join(repository, "src/app/sidepanel/index.html"), "utf8");
  // Production ownership deliberately rejects HTTP. This import map mocks only
  // the owner boundary for QA; production source and module routing stay intact.
  return original.replace("<head>", `<head><base href="/src/app/sidepanel/"><script type="importmap">{"imports":{"/src/platform/navigation/panel-owner.js":"/preview/panel-owner.js"}}</script>`)
    .replace('<script type="module" src="panel.js"></script>', '<script type="module" src="/preview/bootstrap.js"></script>');
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "GET") { response.writeHead(405); response.end("GET only"); return; }
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const common = { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'" };
    let body;
    let type = "text/html; charset=utf-8";
    if (["/", "/preview"].includes(url.pathname)) body = hostHtml;
    else if (url.pathname === "/preview/panel") body = await panelHtml();
    else if (url.pathname === "/preview/host.js") { type = MIME[".js"]; body = `(${hostBootstrap.toString()})();`; }
    else if (url.pathname === "/preview/bootstrap.js") { type = MIME[".js"]; body = `(${panelBootstrap.toString()})();`; }
    else if (url.pathname === "/preview/panel-owner.js") {
      type = MIME[".js"];
      body = 'export const isValidTabId = (value) => Number.isSafeInteger(value) && value >= 0; export const parsePanelOwnerTabId = () => 1;';
    } else {
      const decoded = decodeURIComponent(url.pathname);
      const resolved = path.resolve(repository, `.${decoded}`);
      if (!decoded.startsWith("/src/") || !resolved.startsWith(`${path.join(repository, "src")}${path.sep}`)) {
        response.writeHead(404); response.end("Not found"); return;
      }
      body = await fs.readFile(resolved);
      type = MIME[path.extname(resolved)] || "application/octet-stream";
    }
    response.writeHead(200, { ...common, "Content-Type": type });
    response.end(body);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500);
    response.end(error.code === "ENOENT" ? "Not found" : error.message);
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Date export QA: http://127.0.0.1:${port}/preview`));
