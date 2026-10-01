"use strict";

// Local-only visual QA. No extension permissions, account APIs, real searches,
// or browser launch are involved. Stop the foreground server with Ctrl+C.
// Usage: node tools/keyword-search-preview.cjs [port]
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const repository = path.resolve(__dirname, "..");
const port = Number(process.argv[2] || 4187);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
});

// This function is served as an ES module after the real component imports.
// The real view composes the query controller and pure presentation modules.
// Keeping the mocks at the onAction boundary exercises production rendering,
// pagination, deduplication, retries, localization, and ResizeObserver behavior.
function panelBootstrap({ createSearchView, createTranslator, THEMES, NATIVE_APPEARANCE_TOKENS }) {
  const params = new URLSearchParams(location.search);
  const language = ["zh-CN", "zh-TW", "en", "ja"].includes(params.get("lang")) ? params.get("lang") : "zh-CN";
  const appearance = params.get("theme") === "dark" ? "dark" : "light";
  const translator = createTranslator(language);
  const theme = THEMES["mist-indigo"][appearance];
  const native = NATIVE_APPEARANCE_TOKENS[appearance];
  const style = document.documentElement.style;
  document.documentElement.lang = language;
  document.documentElement.dataset.nativeColorScheme = appearance;
  style.colorScheme = appearance;
  const tokens = {
    "--accent": theme.accent,
    "--accent-rgb": theme.accent.slice(1).match(/../g).map((part) => parseInt(part, 16)).join(", "),
    "--accent-foreground": theme.accentForeground, "--accent-ink": theme.accentInk,
    "--accent-soft": theme.accentSoft, "--text-primary": native.textPrimary,
    "--text-secondary": native.textSecondary, "--text-tertiary": native.textTertiary,
    "--surface": native.surface, "--surface-subtle": native.surfaceSubtle,
    "--border": native.border, "--border-subtle": native.borderSubtle,
    "--surface-selected": theme.selectedSurface, "--surface-hover": theme.hoverSurface,
  };
  for (const [name, value] of Object.entries(tokens)) style.setProperty(name, value);

  document.querySelector(".time-panel__body").dataset.activeRoute = "search";
  document.querySelectorAll(".module-view").forEach((view) => view.classList.toggle("is-active", view.id === "search-view"));
  document.querySelectorAll(".dock-button").forEach((button) => button.classList.toggle("is-active", button.dataset.route === "search"));
  document.getElementById("time-display-control").hidden = true;
  document.getElementById("panel-title").textContent = translator("globalSearch");
  document.getElementById("panel-subtitle").textContent = translator("searchSubtitle");
  document.getElementById("close-button").setAttribute("aria-label", translator("close"));
  const root = document.getElementById("search-view");
  root.setAttribute("aria-label", translator("globalSearch"));

  const record = { callCount: 0, openCount: 0, query: "", messageId: null,
    lastRequest: null, requests: [], lastOpen: null, expectedUniqueResults: 83 };
  const retryFailures = new Set();
  const excerptFixtures = new Map();
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function publish() {
    const list = root.querySelector("[data-search-result-list]");
    const summary = { ...record,
      resultCount: root.querySelector("[data-search-result-count]")?.textContent || "",
      visibleRows: root.querySelectorAll("[data-search-keyword-result]").length,
      pageSize: root.querySelector("[data-search-page-size]")?.value || "",
      page: root.querySelector("[data-search-page-input]")?.value || "",
      pagination: root.querySelector(".result-pagination")?.textContent?.trim() || "",
      errorCode: root.querySelector("[data-search-error-code]")?.dataset.searchErrorCode || null,
      excerpts: [...root.querySelectorAll("[data-search-keyword-result]")].slice(0, 10).map((row) => {
        const fixture = excerptFixtures.get(row.dataset.searchKeywordResult);
        const paragraph = row.querySelector(".search-result__keyword-message p");
        const displayed = paragraph?.textContent || "";
        return { fixture: fixture?.name || "regular", originalLength: fixture?.text.length || 0,
          originalMatchIndex: fixture?.text.toLowerCase().indexOf(record.query.toLowerCase()) ?? -1,
          displayedLength: displayed.length, displayedMatchIndex: displayed.toLowerCase().indexOf(record.query.toLowerCase()),
          text: displayed, highlights: paragraph?.querySelectorAll("mark").length || 0,
          unexpectedElements: paragraph?.querySelectorAll("script, img, svg, b").length || 0 };
      }),
      dimensions: { width: innerWidth, height: innerHeight, listHeight: list?.clientHeight || 0,
        listScrollHeight: list?.scrollHeight || 0 },
    };
    const serialized = JSON.stringify(summary);
    document.body.dataset.qaSummary = serialized;
    document.getElementById("panel-title").title = serialized;
    if (parent !== window) parent.postMessage({ type: "tidy-keyword-preview", summary }, location.origin);
  }

  function mockResults(query) {
    const titles = ["ChatGPT 与 Codex 协作流程", "搜索模块与分页验证", "消息定位和关键词高亮", "长期架构与清晰的模块边界"];
    // These first-page samples expose context selection without real message
    // reads. Query presets also exercise literal punctuation and HTML escaping.
    const samples = [
      { name: "late-chinese-with-timestamp", text: `[2026-09-07 22:21] 已经收到，先说明这段消息的前因后果。${"这里是与本次检索无关的开场说明，需要保留在原始消息里，但不应挡住真正的匹配位置。".repeat(5)}现在回到重点：${query} 的关键词摘要应该优先展示命中句，再补充前后文。${"这一段是后续讨论，可以截短，但不能改变原始跳转目标。".repeat(4)}` },
      { name: "late-english", text: `[2026-09-07 22:22] Thanks, I have read the earlier discussion. ${"This introduction covers unrelated setup details and should not occupy the complete visible excerpt. ".repeat(5)}The important point is that ${query} should stay visible with enough neighboring context to identify the message. ${"Additional background may be omitted from the compact result. ".repeat(4)}` },
      { name: "title-only", text: "" },
      { name: "middle-long-chinese-sentence", text: `${"这是一段没有句号的长说明，".repeat(20)}到这里才开始解释 ${query} 应该如何定位前后文，${"结果行仍然需要保持固定高度，不能被消息长度撑开，".repeat(12)}最后才结束这句话。` },
      { name: "keyword-at-end", text: `${"The original message contains earlier background that is not itself a search hit. ".repeat(6)}The final recommendation is ${query}.` },
      { name: "absent-keyword-fallback", text: "[2026-09-07 22:23] 这条官方摘要本身没有命中词。显示时应该保留原文，不隐藏结果，也不补发会话读取请求。标题和消息跳转仍然有效。" },
      { name: "literal-html-and-punctuation", text: `${"Earlier unrelated context can be shortened. ".repeat(6)}Literal text: <b>${query}</b>, C++, [a-z]+, (draft)? and <img src=x onerror=alert(1)> must remain ordinary message text. No markup from this message should create elements.` },
      { name: "keyword-at-start", text: `${query} is already the first word, so its leading context must not gain an omission marker. ${"Only the later background may need shortening. ".repeat(6)}` },
    ];
    const unique = Array.from({ length: 83 }, (_, index) => {
      const titleOnly = index === 2;
      // The first conversation intentionally has two different message hits.
      const conversationId = `preview-conversation-${index === 1 ? 0 : index}`;
      const messageId = titleOnly ? null : `preview-message-${index}`;
      const snippet = titleOnly ? "" : samples[index]?.text ?? (index % 3 === 0
        ? `Please ask ${query} to review the keyword search. The official result order stays unchanged while additional batches arrive. This longer message checks wrapping, truncation, and readability at narrow widths.`
        : index % 3 === 1
          ? `这里经常提到 ${query}。我们希望先看清消息内容，再决定要不要打开会话；后台继续读取搜索结果，不要打断当前的阅读位置。`
          : `${query} の検索結果を確認します。会話タイトルとメッセージを同時に表示し、ページを切り替えても追加リクエストは送りません。`);
      const item = {
        resultId: `preview-result-${index}`, source: "conversation", conversationId, messageId,
        title: titleOnly ? `${query} — 仅会话标题命中 / Title-only result`
          : `${String((index === 1 ? 0 : index) + 1).padStart(2, "0")} · ${titles[(index === 1 ? 0 : index) % titles.length]}`,
        snippet,
        messageTimestamp: titleOnly ? null : "2026-09-07T08:12:30.000Z",
        conversationUpdatedAt: "2026-09-07T09:30:00.000Z", matchKind: titleOnly ? "title" : "message",
      };
      excerptFixtures.set(`keyword:${conversationId}:${messageId || "title"}`, {
        name: samples[index]?.name || "regular", text: snippet || item.title,
      });
      return item;
    });
    // 84 wire rows / 30-row native batches = 3 calls, but only 83 unique hits.
    return [...unique.slice(0, 30), { ...unique[1] }, ...unique.slice(30)];
  }

  async function onAction(action, payload = {}) {
    if (action === "pause" || action === "resume") return;
    if (action === "open") {
      record.openCount += 1;
      record.query = payload.query;
      record.messageId = payload.messageId;
      record.lastOpen = { conversationId: payload.conversationId, messageId: payload.messageId, query: payload.query };
      publish();
      return; // Intentionally no location change and no account interaction.
    }
    if (action !== "query" || payload.mode !== "keyword") {
      throw Object.assign(new Error("This preview only mocks native keyword search"), { code: "SEARCH_UNAVAILABLE" });
    }
    const request = globalThis.TidySearch.normalizeRequest(payload);
    const offset = request.cursor === null ? 0 : Number(request.cursor.replace(/^preview-offset:/, ""));
    if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid preview cursor");
    const entry = { call: ++record.callCount, query: request.query, cursor: request.cursor,
      limit: request.limit, sessionId: request.sessionId, status: "pending" };
    record.query = request.query;
    record.lastRequest = entry;
    record.requests.push(entry);
    if (record.requests.length > 30) record.requests.shift();
    publish();
    await delay(request.query.toLowerCase().includes("slow") ? 700 : 180);
    if (request.query.toLowerCase().includes("retry") && offset > 0 && !retryFailures.has(request.sessionId)) {
      retryFailures.add(request.sessionId);
      entry.status = "SEARCH_UNAVAILABLE";
      publish();
      throw Object.assign(new Error("Preview: second native batch failed once; explicit retry should resume this cursor."), { code: "SEARCH_UNAVAILABLE" });
    }
    const wireRows = mockResults(request.query);
    const items = wireRows.slice(offset, offset + request.limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < wireRows.length;
    const page = { schemaVersion: "tidy.search.v1", query: request.query, items,
      cursor: hasMore ? `preview-offset:${nextOffset}` : null, hasMore,
      partialResults: !hasMore && request.query.toLowerCase().includes("partial") };
    const validation = globalThis.TidySearch.validatePage(page);
    if (!validation.valid) throw new Error(`Invalid preview DTO: ${validation.errors.join(", ")}`);
    entry.status = page.partialResults ? "partial" : "ok";
    entry.returnedRows = items.length;
    publish();
    return page;
  }

  const view = createSearchView({ root, onAction });
  view.setTabId(1, { renderNow: false });
  view.render({ translator, timeZone: "Asia/Singapore", formatTimestamp: (value) => value });
  view.setVisible(true);
  view.setActive(true);
  new MutationObserver(publish).observe(root, { childList: true, subtree: true, characterData: true });
  addEventListener("resize", publish);
  root.addEventListener("change", () => queueMicrotask(publish));
  root.addEventListener("scroll", () => queueMicrotask(publish), true);
  addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.type !== "tidy-preview-query") return;
    const input = root.querySelector("[data-global-search]");
    if (!input) return;
    input.value = String(event.data.query || "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const initialQuery = params.get("query");
  if (initialQuery) {
    const input = root.querySelector("[data-global-search]");
    input.value = initialQuery;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  publish();
}

function hostBootstrap() {
  const params = new URLSearchParams(location.search);
  const frame = document.getElementById("panel-preview");
  const form = document.getElementById("preview-options");
  const output = document.getElementById("preview-summary");
  for (const name of ["width", "height", "lang", "theme"]) {
    const field = form.elements.namedItem(name);
    if ([...field.options].some((option) => option.value === params.get(name))) field.value = params.get(name);
  }
  function apply({ reload = false } = {}) {
    const next = new URLSearchParams(location.search);
    for (const name of ["width", "height", "lang", "theme"]) next.set(name, form.elements.namedItem(name).value);
    frame.style.width = `${next.get("width")}px`;
    frame.style.height = `${next.get("height")}px`;
    history.replaceState(null, "", `/preview?${next}`);
    if (reload || !frame.getAttribute("src")) frame.src = `/preview/panel?${next}`;
    document.getElementById("direct-preview").href = `/preview/panel?${next}`;
  }
  form.addEventListener("change", (event) => apply({ reload: ["theme", "lang"].includes(event.target.name) }));
  document.querySelectorAll("[data-preview-query]").forEach((button) => button.addEventListener("click", () => {
    frame.contentWindow.postMessage({ type: "tidy-preview-query", query: button.dataset.previewQuery }, location.origin);
  }));
  document.getElementById("preview-reload").addEventListener("click", () => apply({ reload: true }));
  addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== "tidy-keyword-preview") return;
    output.textContent = JSON.stringify(event.data.summary, null, 2);
    output.dataset.qaSummary = JSON.stringify(event.data.summary);
  });
  apply();
}

const hostHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TIDY keyword search — local QA</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;padding:20px;background:#e7e9ed;color:#292c33;font:14px system-ui,sans-serif}
main{display:flex;align-items:flex-start;gap:24px}iframe{display:block;border:0;flex:none;box-shadow:0 0 0 1px #b7bcc5}
aside{width:360px;flex:none}h1{font-size:20px;margin-top:0}label{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:8px 0}
select,button,a{font:inherit}select,button{padding:5px 8px}button{margin:3px 2px 3px 0}p{line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace;background:#fff;padding:12px;border:1px solid #bbc0c8;max-height:440px;overflow:auto}
</style></head><body><main><iframe id="panel-preview" title="Real TIDY side panel preview"></iframe><aside>
<h1>TIDY keyword search QA</h1><p>Local mock data only. The frame uses the real panel markup, CSS, themes, translations, and search view. Clicking results records the target without navigation.</p>
<form id="preview-options"><label>Panel width<select name="width"><option>320</option><option selected>420</option></select></label>
<label>Panel height<select name="height"><option selected>740</option><option>900</option></select></label>
<label>Language<select name="lang"><option selected>zh-CN</option><option>zh-TW</option><option>en</option><option>ja</option></select></label>
<label>Theme<select name="theme"><option selected>light</option><option>dark</option></select></label></form>
<p>Resize keeps the current search. Language/theme changes start a fresh document.</p>
<div><button data-preview-query="codex">codex</button><button data-preview-query="slow">slow (700 ms)</button><button data-preview-query="retry">retry (fail once)</button><button data-preview-query="partial">partial</button></div>
<div><button data-preview-query="关键帧">关键帧</button><button data-preview-query="C++">C++</button><button data-preview-query="[a-z]+">[a-z]+</button><button data-preview-query="&lt;b&gt;">&lt;b&gt;</button></div>
<p>Expect 83 unique hits from 84 wire rows in 3 native batches. “retry” fails on batch 2 until you click the panel retry button. “partial” must never claim a completed total.</p>
<button id="preview-reload">Reset mock session</button> <a id="direct-preview" target="_blank">Panel-only view</a>
<h2>Read-only diagnostics</h2><pre id="preview-summary" aria-live="polite">Waiting for component…</pre>
</aside></main><script src="/preview/host.js"></script></body></html>`;

async function panelHtml() {
  const original = await fs.readFile(path.join(repository, "src/app/sidepanel/index.html"), "utf8");
  // Preserve the product shell and all views. Only extension initialization is
  // replaced: shared contracts + the isolated mock bootstrap own this document.
  return original.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    // A base URL keeps every production stylesheet and its nested imports intact.
    .replace("<head>", '<head><base href="/src/app/sidepanel/">')
    .replace("</body>", '<script src="/src/platform/protocol.js"></script><script src="/src/platform/library/library-hydration.js"></script><script src="/src/features/search/model/search.js"></script><script src="/src/platform/catalog/date-search.js"></script><script type="module" src="/preview/bootstrap.js"></script></body>');
}

const bootstrapModule = `import { createSearchView } from "/src/features/search/ui/search-view.js";
import { createTranslator } from "/src/messages/i18n.js";
import "/src/platform/theme/theme.js";
const { THEMES, NATIVE_APPEARANCE_TOKENS } = globalThis.TidyTheme;
(${panelBootstrap.toString()})({ createSearchView, createTranslator, THEMES, NATIVE_APPEARANCE_TOKENS });`;

const server = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end("Read-only preview");
      return;
    }
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    let content;
    let type = "text/html; charset=utf-8";
    if (url.pathname === "/" || url.pathname === "/preview") content = hostHtml;
    else if (url.pathname === "/preview/panel") content = await panelHtml();
    else if (url.pathname === "/preview/bootstrap.js") { content = bootstrapModule; type = MIME_TYPES[".js"]; }
    else if (url.pathname === "/preview/host.js") { content = `(${hostBootstrap.toString()})();`; type = MIME_TYPES[".js"]; }
    else {
      const decoded = decodeURIComponent(url.pathname);
      const segments = decoded.split(/[\\/]/);
      if (segments.some((segment) => segment === ".." || segment.startsWith(".")) || decoded.includes("\0")) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const filename = path.resolve(repository, `.${decoded}`);
      const relative = path.relative(repository, filename);
      type = MIME_TYPES[path.extname(filename).toLowerCase()];
      if (!type || relative.startsWith("..") || path.isAbsolute(relative)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      // Resolve symlinks too: a checked-in link must not expose files outside
      // the repository through this otherwise read-only static-file endpoint.
      const realPath = await fs.realpath(filename);
      const realRelative = path.relative(repository, realPath);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      content = await fs.readFile(realPath);
    }
    response.writeHead(200, { "Content-Type": type });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 400).end("Preview resource unavailable");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Keyword search preview: http://127.0.0.1:${port}/preview?width=420&height=740&lang=zh-CN&theme=light`);
  console.log("Local synthetic data only; no browser was opened. Ctrl+C to stop.");
});
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
