import { createTitleOrganizationView } from "/src/features/titles/ui/title-organization-view.js";
import { createTitleService } from "/src/features/titles/background/title-service.js";
import { createTitleBatchService } from "/src/features/titles/background/title-batch-service.js";
import { createTranslator } from "/src/messages/i18n.js";
import { createTitleRulesController } from "/src/features/titles/ui/title-rules.js";
import "/src/platform/theme/theme.js";
const { NATIVE_APPEARANCE_TOKENS, THEMES } = globalThis.TidyTheme;

const params = new URLSearchParams(location.search);
document.documentElement.style.setProperty("--qa-width", params.get("width") === "320" ? "320px" : "360px");
if (params.get("dark") === "1") {
  document.documentElement.dataset.nativeColorScheme = "dark";
  const theme = THEMES["mist-indigo"].dark, native = NATIVE_APPEARANCE_TOKENS.dark;
  for (const [name, value] of Object.entries({ surface: native.surface, "surface-subtle": native.surfaceSubtle,
    "surface-hover": theme.hoverSurface, "text-primary": native.textPrimary, "text-secondary": native.textSecondary,
    "text-tertiary": native.textTertiary, accent: theme.accent, "accent-ink": theme.accentInk,
    "accent-foreground": theme.accentForeground, "accent-soft": theme.accentSoft, border: native.border, "border-subtle": native.borderSubtle })) {
    document.documentElement.style.setProperty(`--${name}`, value);
  }
}
const identity = { accountKey: "synthetic-user", workspaceKey: "personal" };
const createdAt = "2026-08-18T00:00:00.000Z", updatedAt = "2026-09-09T00:00:00.000Z";
const rows = ["ChatGPT Tidy UI 设计讨论", "2026/08/18 | 功能需求整理", "2025-07-01 | 项目进展汇总",
  "标题整理的批量体验与非常非常长的中文标题测试用例", "项目资料整理", "2026/08/18", "搜索性能讨论", "批量导出验证", "暂停恢复验证"]
  .map((title, index) => ({ conversationId: index ? `qa-${index}` : "qa", title, createdAt, updatedAt,
    projectId: index === 4 ? "g-p-project" : null }));
const targetRows = new Map(rows.map((row) => [row.conversationId, row]));
const owner = { tabId: 1, conversationId: "qa", pathname: "/c/qa", projectId: null };
const records = new Map();
// 普通本地网页没有扩展后台；设置同样使用内存替身，避免出现无关的连接报错。
let savedRules = { mode: "created", dateFormat: "slash" };
const rulesController = createTitleRulesController({ read: async () => ({ ...savedRules }),
  write: async patch => ({ ...(savedRules = { ...savedRules, ...patch }) }), listen: () => () => {} });
const storage = { get: async (key) => structuredClone(records.get(key) || null),
  set: async (key, value) => { records.set(key, structuredClone(value)); },
  remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key); } };
let reads = 0, replans = 0, writes = 0, uncertain = false, service, batch, view;
let catalogReads = 0, statusReads = 0;
let panelActive = true, hideAfterStep = false;
// Default exercises the real catalog's epoch-ms contract and local fast path.
// ?catalogDates=missing proves missing dates remain local skipped rows.
const catalogRows = (selected) => selected.map((row) => ({ ...structuredClone(row),
  createdAt: params.get("catalogDates") === "missing" ? null : Date.parse(row.createdAt),
  updatedAt: params.get("catalogDates") === "missing" ? null : Date.parse(row.updatedAt),
}));
const delay = () => new Promise((resolve) => setTimeout(resolve, Number(params.get("delay")) || 120));
const metrics = () => { document.querySelector("#qa-read").value = reads;
  document.querySelector("#qa-replan").value = replans; document.querySelector("#qa-write").value = writes; };
const field = (value) => ({ value, source: "synthetic", status: "available" });
function snapshot() { const row = targetRows.get("qa"); return {
  schemaVersion: "chatgpt-tidy.snapshot.v1", route: { pathname: owner.pathname, kind: "conversation", status: "available" },
  appearance: { colorScheme: "light", source: "synthetic", status: "available", surface: field("rgb(255, 255, 255)") },
  conversation: { conversationId: "qa", kind: "conversation", draftId: null, bindingStatus: "bound", identityStatus: "stable",
    project: null, title: field(row.title), createdAt: field(row.createdAt), updatedAt: field(row.updatedAt) },
  sidebarConversations: [], messages: [],
}; }
function services() {
  service = createTitleService({ storage, read: async (context, options = {}) => {
    reads++; metrics(); await delay();
    return options.identityOnly ? { identity } : { identity, current: structuredClone(targetRows.get(context.conversationId)) };
  }, write: async (context, plan) => {
    const row = targetRows.get(context.conversationId);
    if (row.title !== plan.before) return { status: "conflict", current: structuredClone(row), messageCode: "title_conflict" };
    // Match the production preflight contract even in this offline UI fixture:
    // catalog dates validate the reviewed output; detail dates are exact.
    if (plan.metadataSource === "catalog") {
      const checked = globalThis.TidyTitleDates.plan(row, plan.catalogIntent.rules, plan.catalogIntent);
      if (checked.after !== plan.after || !checked.canApply || checked.noOp || checked.wouldEmpty) {
        return { status: "conflict", current: structuredClone(row), messageCode: "dates_changed" };
      }
    } else if (plan.metadataSource !== "detail" || row.createdAt !== plan.expectedCreatedAt || row.updatedAt !== plan.expectedUpdatedAt) {
      return { status: "conflict", current: structuredClone(row), messageCode: "dates_changed" };
    }
    writes++; metrics(); await delay(); row.title = plan.after; row.updatedAt = new Date().toISOString();
    if (uncertain) { uncertain = false; return { status: "uncertain", current: null }; }
    return { status: "verified", current: structuredClone(row) };
  } });
  batch = createTitleBatchService({ titleService: service, storage,
    beginExecution: async () => ({ identity, catalogAccountKey: "synthetic-catalog" }),
    endExecution: async () => ({ ended: true }),
    resolveSelection: async (_context, payload) => ({ identity, accountKey: "synthetic-catalog",
      rows: catalogRows(payload.conversationIds.map((id) => targetRows.get(id))) }),
  });
}
function update() { view.update({ active: panelActive, snapshot: snapshot(),
  preferences: { timeZone: "UTC", dateFormat: "slash", conversationTimeMode: "created", language: params.get("lang") || "zh-CN" },
  translator: createTranslator(params.get("lang") || "zh-CN") }); }
function open() {
  panelActive = true; hideAfterStep = false;
  catalogReads = 0; statusReads = 0;
  document.querySelector("#qa-visibility").textContent = "模拟侧栏隐藏";
  document.querySelector("#qa-visibility-state").textContent = "侧栏可见";
  view?.dispose(); services();
  view = createTitleOrganizationView({ root: document.querySelector("#titles-view"), ownerTabId: 1, rulesController,
    request: async (action, payload) => {
      // First receipt lookup fails in this opt-in scenario. Only a real second
      // status request may recover it; rereading the directory is unrelated.
      if (action === "batch-status" && ++statusReads === 1 && params.get("receiptError") === "1") {
        throw Object.assign(new Error("Synthetic receipt storage failure"), { code: "STORAGE_ERROR" });
      }
      if (action.includes("replan")) { replans++; metrics(); }
      const result = await (action.startsWith("batch-") ? batch.handle(action.slice(6), owner, payload) : service.handle(action, owner, payload));
      // Deterministic late-receipt boundary: the worker has persisted one step,
      // but visibility invalidates its UI callback before it can dispatch next.
      if (hideAfterStep && action === "batch-step") {
        hideAfterStep = false; setPanelActive(false);
      }
      return result;
    },
    loadCatalog: async ({ onUpdate, retry = false }) => {
      catalogReads++;
      // The side-panel catalog projects raw epoch-ms dates to ISO strings.
      // Keep that view boundary distinct from resolveSelection's worker rows.
      const projected = structuredClone(rows).map((row) => params.get("catalogDates") === "missing"
        ? { ...row, createdAt: null, updatedAt: null } : row);
      const result = { accountKey: "synthetic-catalog", rows: projected, loading: false, partial: false };
      // Offline failure UI QA only. No endpoint or real account is contacted;
      // the first click on Read again clears this deterministic synthetic error.
      if (params.has("catalogError") && !retry) {
        result.errorOrigin = "current";
        result.readErrors = params.get("catalogError") === "storage"
          ? [{ source: "catalog", code: "STORAGE_ERROR", category: "UNKNOWN", name: "ConstraintError", stage: "final-checkpoint", retryable: false }]
          : params.get("catalogError") === "schema"
          ? [{ source: "projects", code: "SCHEMA", category: "SCHEMA", retryable: false }]
          : [{ source: "project:synthetic-private-id", code: "INACCESSIBLE", category: "INACCESSIBLE", status: 404, retryable: false }];
      }
      // A concurrent reader's checkpoint is not a failed endpoint. Resuming
      // follows the existing checkpoint rather than asking for a fresh scan.
      if (params.get("catalogState") === "superseded" && catalogReads === 1) {
        Object.assign(result, { phase: "paused", pauseReason: "catalog-superseded", readErrors: [],
          resultStable: false, coverageReasons: ["catalog-pending"] });
      }
      onUpdate(result); return result;
    },
    onChanged: update, onBusyChange: (busy) => { document.querySelector("#qa-state").textContent = busy ? "批量执行中" : ""; },
  }); update();
}
document.querySelector("#qa-reopen").addEventListener("click", open);
document.querySelector("#qa-uncertain").addEventListener("click", () => { uncertain = true; });
function setPanelActive(active) {
  panelActive = active;
  document.querySelector("#qa-visibility").textContent = active ? "模拟侧栏隐藏" : "模拟切回侧栏";
  document.querySelector("#qa-visibility-state").textContent = active ? "侧栏可见" : "侧栏已隐藏（仅夹具模拟）";
  update();
}
document.querySelector("#qa-visibility").addEventListener("click", () => setPanelActive(!panelActive));
document.querySelector("#qa-hide-step").addEventListener("click", () => { hideAfterStep = true; });
document.querySelector("#qa-date-drift").addEventListener("click", () => {
  // Synthetic metadata only; no real account, network or page state is touched.
  const row = targetRows.get("qa"); row.updatedAt = new Date(Date.parse(row.updatedAt) + 1752).toISOString();
});
open();
