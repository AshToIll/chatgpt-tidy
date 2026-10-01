"use strict";

// Local-only visual QA for the shared search status slot. This server never
// starts a browser, accesses an account, or dispatches a real search/export.
// Usage: node tools/search-status-preview.cjs [port]  (default: 4190)
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const repository = path.resolve(__dirname, "..");
const port = Number(process.argv[2] || 4190);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
});

// Executed only in the synthetic frame. Rendering remains the actual product
// component; these fixtures change its state, not its markup or styling.
function panelBootstrap({ createSearchView, createTranslator, THEMES, NATIVE_APPEARANCE_TOKENS }) {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") === "date" ? "date" : "keyword";
  const language = ["zh-CN", "zh-TW", "en", "ja"].includes(params.get("lang")) ? params.get("lang") : "zh-CN";
  const translator = createTranslator(language);
  let appearance = params.get("theme") === "dark" ? "dark" : "light";
  let selectedPhase = params.get("phase") || "searching";
  const record = { synthetic: true, requests: 0, opens: 0, exports: 0, accountReads: 0, messageHistoryReads: 0 };
  const root = document.getElementById("search-view");
  const phases = new Set(["waiting", "searching", "refreshing", "complete", "paused", "error"]);

  function applyTheme(next) {
    appearance = next === "dark" ? "dark" : "light";
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
  }

  document.querySelector(".time-panel__body").dataset.activeRoute = "search";
  document.querySelectorAll(".module-view").forEach((node) => node.classList.toggle("is-active", node === root));
  document.querySelectorAll(".dock-button").forEach((node) => node.classList.toggle("is-active", node.dataset.route === "search"));
  document.getElementById("time-display-control").hidden = true;
  document.getElementById("panel-title").textContent = translator("globalSearch");
  document.getElementById("panel-subtitle").textContent = translator("searchSubtitle");
  root.setAttribute("aria-label", translator("globalSearch"));

  const titles = ["TIDY 搜索模块：稳定与克制", "ChatGPT 与 Codex 协作流程", "消息预览与精确定位", "窄侧栏中的统一视觉语言"];
  const items = Array.from({ length: 36 }, (_, index) => ({
    resultId: `synthetic-${mode}-${index}`, source: "conversation", conversationId: `synthetic-conversation-${index}`,
    messageId: mode === "date" ? null : `synthetic-message-${index}`,
    title: `${String(index + 1).padStart(2, "0")} · ${titles[index % titles.length]}`,
    snippet: mode === "date" ? "" : `这是一条本地合成消息。Codex 关键词命中应当清晰可见，六瓣花在固定状态槽中显示，不挤压结果总数，也不会改变本来的消息定位目标。`,
    messageTimestamp: mode === "date" ? null : "2026-09-07T08:12:30.000Z",
    conversationCreatedAt: "2026-09-06T08:00:00.000Z", conversationUpdatedAt: "2026-09-07T09:30:00.000Z",
    matchKind: mode === "date" ? "conversation-date" : "message", dateField: "createdAt",
  }));

  async function onAction(action, payload = {}) {
    if (action === "pause" || action === "resume") return;
    if (action === "open") { record.opens += 1; publish(); return; }
    if (action !== "query") return;
    record.requests += 1;
    // Clicking a real control remains harmless: return local fixture DTOs only.
    if (payload.mode === "keyword") return { schemaVersion: "tidy.search.v1", query: payload.query,
      items, cursor: null, hasMore: false, partialResults: false };
    return { items: items.slice(0, payload.limit || 7), total: items.length, hasMore: true,
      cursor: "synthetic-next", phase: "settled", resultStable: true, revision: 1,
      accountKey: "synthetic-account", readErrors: [] };
  }

  const view = createSearchView({ root, onAction, onExportAction: () => { record.exports += 1; publish(); } });
  view.setTabId(1, { renderNow: false });
  view.render({ translator, timeZone: "Asia/Singapore", formatTimestamp: (value) => value });

  function applyPhase(phase) {
    selectedPhase = phases.has(phase) ? phase : "searching";
    const waiting = selectedPhase === "waiting";
    const complete = selectedPhase === "complete";
    const busy = selectedPhase === "searching" || selectedPhase === "refreshing";
    const failed = selectedPhase === "error";
    const visibleItems = waiting ? [] : items;
    const error = failed ? { code: "SEARCH_UNAVAILABLE", message: "Synthetic visual QA error" } : null;
    const nativePhase = failed ? "error" : selectedPhase === "paused" ? "paused" : complete ? "complete" : busy ? "loading" : "idle";
    view.__previewSetState({
      mode, active: true, visible: true, query: mode === "keyword" && !waiting ? "Codex" : "",
      startDate: mode === "date" && !waiting ? "2026-09-06" : "",
      endDate: mode === "date" && !waiting ? "2026-09-07" : "",
      sessionId: waiting ? null : `synthetic-${mode}`, searched: !waiting, loading: busy, error,
      pages: [visibleItems.slice(0, mode === "date" ? 7 : 6)], page: 1, scrollTop: 0,
      hasMore: !waiting && !complete, cursor: null, dateError: false,
      catalogRefreshing: mode === "date" && selectedPhase === "refreshing",
      keywordRefreshing: mode === "keyword" && selectedPhase === "refreshing",
      dateAccountKey: "synthetic-account",
      resultStatus: { total: visibleItems.length, resultStable: complete, revision: 1,
        phase: busy ? "loading" : complete ? "settled" : "paused", readErrors: failed ? [{ code: "SYNTHETIC_ERROR" }] : [] },
      indexStatus: null,
      keywordStatus: { query: waiting ? "" : "Codex", sessionId: `synthetic-${mode}`,
        items: visibleItems, total: visibleItems.length, phase: nativePhase,
        complete, hasMore: !complete, cursor: null, error },
    });
    requestAnimationFrame(publish);
  }

  function rectangle(node) {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return Object.fromEntries(["x", "y", "width", "height", "top", "right", "bottom", "left"].map((key) => [key, Number(rect[key].toFixed(2))]));
  }

  // Exclude screen-reader-only content from visible-text diagnostics without
  // assuming a particular helper class used by the real component.
  function visibleText(node) {
    if (!node) return "";
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const text = [];
    while (walker.nextNode()) {
      const parentNode = walker.currentNode.parentElement;
      const style = getComputedStyle(parentNode);
      const rect = parentNode.getBoundingClientRect();
      if (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
        && style.clipPath === "none" && (style.clip === "auto" || style.clip === "") && rect.width > 1 && rect.height > 1) {
        text.push(walker.currentNode.textContent.trim());
      }
    }
    return text.filter(Boolean).join(" ");
  }

  function publish() {
    const status = root.querySelector("[data-search-status]");
    const flower = status?.querySelector(".tidy-loading-flower");
    // The brand flower also contains a static clock-hand path. Count only
    // actual petals so the six-petal diagnostic cannot be inflated by it.
    const petals = [...(flower?.querySelectorAll(".tidy-loading-flower__petal") || [])];
    const statusRect = rectangle(status);
    const flowerRect = rectangle(flower);
    const label = status?.querySelector(".search-status__label") || status?.querySelector("span:last-child");
    const labelStyle = label ? getComputedStyle(label) : null;
    const heading = root.querySelector(".search-list-heading");
    const list = root.querySelector("[data-search-result-list]");
    const errorNotice = root.querySelector(".search-date-error, .search-keyword-error");
    const summary = { ...record, mode, theme: appearance, requestedPhase: selectedPhase,
      actualPhase: status?.dataset.searchStatus, actualWidth: innerWidth, height: innerHeight,
      overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth,
      status: statusRect, statusStyle: status ? { display: getComputedStyle(status).display,
        justifyContent: getComputedStyle(status).justifyContent, alignItems: getComputedStyle(status).alignItems,
        fontSize: getComputedStyle(status).fontSize, lineHeight: getComputedStyle(status).lineHeight } : null,
      statusText: status?.textContent.trim() || "", visibleStatusText: visibleText(status),
      label: rectangle(label), labelStyle: labelStyle ? { position: labelStyle.position,
        clipPath: labelStyle.clipPath, width: labelStyle.width, height: labelStyle.height } : null,
      labelIsScreenReaderOnly: Boolean(label?.classList.contains("search-status__label--sr-only")
        && labelStyle?.position === "absolute" && labelStyle?.clipPath !== "none"),
      flower: flowerRect, petalCount: petals.length,
      flowerTransform: flower ? getComputedStyle(flower).transform : null,
      flowerAnimation: flower ? getComputedStyle(flower).animationName : null,
      centerDeltaX: statusRect && flowerRect ? Number((flowerRect.x + flowerRect.width / 2 - statusRect.x - statusRect.width / 2).toFixed(2)) : null,
      centerDeltaY: statusRect && flowerRect ? Number((flowerRect.y + flowerRect.height / 2 - statusRect.y - statusRect.height / 2).toFixed(2)) : null,
      petals: petals.map((petal) => { const css = getComputedStyle(petal); return { animationName: css.animationName,
        animationDuration: css.animationDuration, animationDelay: css.animationDelay,
        opacity: css.opacity, transform: css.transform }; }),
      heading: rectangle(heading), headingOverflow: heading ? heading.scrollWidth > heading.clientWidth : false,
      list: rectangle(list), resultCount: heading?.querySelector("small")?.textContent || "",
      errorNotice: errorNotice ? { text: visibleText(errorNotice), code: errorNotice.dataset.searchErrorCode } : null,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
    document.body.dataset.qaSummary = JSON.stringify(summary);
    if (parent !== window) parent.postMessage({ type: "tidy-search-status-summary", summary }, location.origin);
  }

  let publishQueued = false;
  new MutationObserver(() => {
    if (publishQueued) return;
    publishQueued = true;
    requestAnimationFrame(() => { publishQueued = false; publish(); });
  }).observe(root, { childList: true, subtree: true, characterData: true });
  addEventListener("resize", publish);
  addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.type !== "tidy-search-status-control") return;
    if (event.data.theme) applyTheme(event.data.theme);
    if (event.data.phase) applyPhase(event.data.phase);
    if (event.data.render) view.render();
    requestAnimationFrame(publish);
  });
  // Read-only inspection shortcut for a directly opened local frame.
  globalThis.tidySearchStatusPreview = Object.freeze({ diagnostics: () => JSON.parse(document.body.dataset.qaSummary || "{}") });
  applyTheme(appearance);
  applyPhase(selectedPhase);
}

function hostBootstrap() {
  const frames = [...document.querySelectorAll("iframe")];
  const summaries = {};
  let loop = null;
  let phaseIndex = 0;
  const phases = ["waiting", "searching", "complete", "refreshing", "complete", "paused", "error"];
  function apply(phase) {
    document.querySelectorAll("[data-phase]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.phase === phase)));
    for (const frame of frames) frame.contentWindow.postMessage({ type: "tidy-search-status-control", phase }, location.origin);
    document.getElementById("current-phase").textContent = phase;
  }
  document.querySelectorAll("[data-phase]").forEach((button) => button.addEventListener("click", () => apply(button.dataset.phase)));
  document.getElementById("cycle").addEventListener("click", (event) => {
    if (loop) { clearInterval(loop); loop = null; event.target.textContent = "自动循环（每 3 秒）"; return; }
    event.target.textContent = "停止循环";
    apply(phases[phaseIndex++ % phases.length]);
    loop = setInterval(() => apply(phases[phaseIndex++ % phases.length]), 3000);
  });
  document.getElementById("snapshot").addEventListener("click", () => {
    for (const frame of frames) frame.contentWindow.postMessage({ type: "tidy-search-status-control" }, location.origin);
  });
  // Re-render without applying fixtures again: this checks that incremental
  // native-page rendering keeps the running animation phase rather than resets it.
  document.getElementById("rerender").addEventListener("click", () => {
    for (const frame of frames) frame.contentWindow.postMessage({ type: "tidy-search-status-control", render: true }, location.origin);
  });
  addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "tidy-search-status-summary") return;
    const frame = frames.find((candidate) => candidate.contentWindow === event.source);
    if (!frame) return;
    summaries[frame.id] = event.data.summary;
    const summary = event.data.summary;
    document.getElementById(`${frame.id}-diagnostics`).textContent = `${summary.actualWidth}px · ${summary.actualPhase} · 槽高 ${summary.status?.height}px · 花瓣 ${summary.petalCount} · 水平溢出 ${summary.overflowX || summary.headingOverflow ? "有" : "无"}`;
    document.getElementById("diagnostics").textContent = JSON.stringify(summaries, null, 2);
    document.body.dataset.qaSummary = JSON.stringify(summaries);
  });
}

const cards = ["keyword", "date"].flatMap((mode) => ["light", "dark"].flatMap((theme) => [320, 420].map((width) => {
  const id = `${mode}-${theme}-${width}`;
  const query = `mode=${mode}&theme=${theme}&phase=searching`;
  return `<section style="width:${width}px"><h2>${mode === "keyword" ? "关键词" : "日期"} · ${theme === "light" ? "浅色" : "深色"} · ${width}px</h2>
    <iframe id="${id}" title="${id}" width="${width}" height="850" src="/preview/panel?${query}"></iframe>
    <p id="${id}-diagnostics">等待真实组件…</p><a href="/preview/panel?${query}" target="_blank">单独打开本地组件</a></section>`;
}))).join("");
const hostHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>TIDY 搜索状态 · 本地合成 UI 验收</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;padding:20px;background:#e7e9ed;color:#292c33;font:13px/1.5 system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;padding:12px;background:#e7e9efee;backdrop-filter:blur(8px);border-bottom:1px solid #bbc0c8}
h1{font-size:18px;margin:0 0 6px}h2{font-size:13px;margin:14px 0 6px}p{margin:5px 0}button{font:inherit;margin:3px;padding:5px 9px;cursor:pointer}
button[aria-pressed=true]{background:#596274;color:white;border-color:#596274}main{display:grid;grid-template-columns:320px 420px 320px 420px;gap:22px;align-items:start;width:max-content}
iframe{display:block;border:0;box-shadow:0 0 0 1px #adb3bd;background:white}section>p{font-size:11px}a{color:#41495a}
details{margin-top:24px}pre{white-space:pre-wrap;font:11px/1.5 ui-monospace,monospace;background:white;padding:12px;max-height:550px;overflow:auto}
</style></head><body><header><h1>TIDY 六瓣花 · 实际组件验收矩阵</h1>
<p>真实 Side Panel HTML / CSS / search-view；只注入合成状态，无真实账号、API、消息历史、导出或页面跳转。</p>
<div><button data-phase="waiting">未开始</button><button data-phase="searching" aria-pressed="true">搜索中</button><button data-phase="refreshing">刷新中</button>
<button data-phase="complete">完成</button><button data-phase="paused">暂停</button><button data-phase="error">错误</button>
<button id="cycle">自动循环（每 3 秒）</button><button id="rerender">原状态重新渲染</button><button id="snapshot">采集当前诊断</button>当前：<strong id="current-phase">searching</strong></div>
<p>每个 iframe 高 850px；窄屏可水平滚动整个验收矩阵，组件内部水平溢出单独记录。暂停/错误不应继续动画。错误提示在 5 秒后消失；原状态重绘不重启计时，重新选择“错误”才代表一次新失败。减少动态效果使用系统设置验收。</p>
</header><main>${cards}</main><details><summary>完整只读 DOM 诊断</summary><pre id="diagnostics">等待组件…</pre></details>
<script src="/preview/host.js"></script></body></html>`;

async function panelHtml() {
  const original = await fs.readFile(path.join(repository, "src/app/sidepanel/index.html"), "utf8");
  return original.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    // A base URL keeps every production stylesheet and its nested imports intact.
    .replace("<head>", '<head><base href="/src/app/sidepanel/">')
    .replace("</body>", '<script src="/src/platform/protocol.js"></script><script src="/src/features/search/model/search.js"></script><script src="/src/platform/catalog/date-search.js"></script><script src="/src/platform/library/library-hydration.js"></script><script type="module" src="/preview/bootstrap.js"></script></body>');
}

// Fixture setters exist only in modules served by this local QA server. The view
// delegates to the real controller; it never regains query state or lifecycle.
// Exact unique markers fail closed when the production boundary changes.
async function previewSearchView() {
  const original = await fs.readFile(path.join(repository, "src/features/search/ui/search-view.js"), "utf8");
  const marker = "return Object.freeze({ render, setTabId, setIndexStatus, setActive, setVisible, prepareDateExport, exportItems, setConversationId, cancelId, completeNavigation });";
  if (original.split(marker).length !== 2) throw new Error("Search-view preview seam no longer matches source");
  return original.replace(marker, marker.replace(" });",
    ", __previewSetState: value => controller.__previewSetState(value) });"));
}

async function previewSearchQueryController() {
  const original = await fs.readFile(path.join(repository, "src/features/search/ui/search-query-controller.js"), "utf8");
  const marker = "prepareDateExport, setTimeZone, selectResult, setScrollTop, setConversationId, beginInteraction });";
  if (original.split(marker).length !== 2) throw new Error("Search-query-controller preview seam no longer matches source");
  return original.replace(marker, marker.replace(" });", `,
    __previewSetState(value) {
      // A fixture selection is a new interaction; ordinary paint keeps the same
      // notice timer and calendar lifecycle owned by the real controller.
      onCalendarClose(); beginInteraction(); Object.assign(state, value);
      synchronizePageSize();
      if (state.mode === "keyword") paginateKeywordItems(state.keywordStatus?.items || []);
      if (value.error) notices.show(value.error, state.mode === "keyword" ? "keyword" : "date-query");
      publish();
    }
  });`));
}

const bootstrapModule = `import { createSearchView } from "/src/features/search/ui/search-view.js";
import { createTranslator } from "/src/messages/i18n.js";
import "/src/platform/theme/theme.js";
const { THEMES, NATIVE_APPEARANCE_TOKENS } = globalThis.TidyTheme;
(${panelBootstrap.toString()})({ createSearchView, createTranslator, THEMES, NATIVE_APPEARANCE_TOKENS });`;

const server = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'");
  try {
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end("Read-only preview"); return; }
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    let content;
    let type = MIME_TYPES[".html"];
    if (url.pathname === "/" || url.pathname === "/preview") content = hostHtml;
    else if (url.pathname === "/preview/panel") content = await panelHtml();
    else if (url.pathname === "/preview/bootstrap.js") { content = bootstrapModule; type = MIME_TYPES[".js"]; }
    else if (url.pathname === "/preview/host.js") { content = `(${hostBootstrap.toString()})();`; type = MIME_TYPES[".js"]; }
    else if (url.pathname === "/src/features/search/ui/search-view.js") { content = await previewSearchView(); type = MIME_TYPES[".js"]; }
    else if (url.pathname === "/src/features/search/ui/search-query-controller.js") { content = await previewSearchQueryController(); type = MIME_TYPES[".js"]; }
    else {
      const decoded = decodeURIComponent(url.pathname);
      const segments = decoded.split(/[\\/]/);
      if (!decoded.startsWith("/src/") || segments.some((segment) => segment === ".." || segment.startsWith(".")) || decoded.includes("\0")) {
        response.writeHead(403).end("Forbidden"); return;
      }
      const filename = path.resolve(repository, `.${decoded}`);
      const realPath = await fs.realpath(filename);
      const relative = path.relative(path.join(repository, "src"), realPath);
      type = MIME_TYPES[path.extname(realPath).toLowerCase()];
      if (!type || relative.startsWith("..") || path.isAbsolute(relative)) { response.writeHead(403).end("Forbidden"); return; }
      content = await fs.readFile(realPath);
    }
    response.writeHead(200, { "Content-Type": type });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 400).end("Preview resource unavailable");
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Search status preview: http://127.0.0.1:${port}/preview`);
  console.log("Local synthetic data only; no browser was opened. Ctrl+C to stop.");
});
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
