import { createTitleView } from "/src/features/titles/ui/title-view.js";
import { createTranslator } from "/src/messages/i18n.js";
import { createTitleService } from "/src/features/titles/background/title-service.js";
import "/src/platform/theme/theme.js";
const { NATIVE_APPEARANCE_TOKENS, THEMES } = globalThis.TidyTheme;

// Real view and model: authenticated reads are deliberately slow, while option
// changes ask the real title service to replan its frozen metadata. The
// counter is outside the product UI so reviewers can see the I/O distinction.
// All reads/writes below are synthetic and in-memory. No extension API,
// account, network metadata, or real ChatGPT rename is involved.
const options = new URLSearchParams(location.search);
document.documentElement.style.setProperty("--qa-width", options.get("width") === "420" ? "420px" : "320px");
if (options.get("dark") === "1") {
  document.documentElement.dataset.nativeColorScheme = "dark";
  const theme = THEMES["mist-indigo"].dark, native = NATIVE_APPEARANCE_TOKENS.dark;
  // Use production tokens, especially foreground contrast on confirmation.
  for (const [name, value] of Object.entries({ surface: native.surface, "surface-subtle": native.surfaceSubtle,
    "surface-hover": theme.hoverSurface, "text-primary": native.textPrimary, "text-secondary": native.textSecondary,
    "text-tertiary": native.textTertiary, accent: theme.accent, "accent-ink": theme.accentInk,
    "accent-foreground": theme.accentForeground, "accent-soft": theme.accentSoft, border: native.border, "border-subtle": native.borderSubtle })) {
    document.documentElement.style.setProperty(`--${name}`, value);
  }
}
const current = { conversationId: "qa", title: "2026/09/04 ~ 09/09｜界面设计讨论", createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z" };
const field = (value) => ({ value, source: "qa", status: "available" });
const snapshot = { schemaVersion: "chatgpt-tidy.snapshot.v1", route: { pathname: "/c/qa", kind: "conversation", status: "available" },
  appearance: { colorScheme: "light", source: "qa", status: "available", surface: field("rgb(255, 255, 255)") },
  conversation: { conversationId: "qa", draftId: null, kind: "conversation", identityStatus: "stable", bindingStatus: "bound", project: null,
    title: field(current.title), createdAt: field(current.createdAt), updatedAt: field(current.updatedAt) }, sidebarConversations: [], messages: [] };
let reads = 0, replans = 0, writes = 0;
function renderMetrics() {
  document.querySelector("#qa-reads").textContent = String(reads);
  document.querySelector("#qa-replans").textContent = String(replans);
  document.querySelector("#qa-writes").textContent = String(writes);
}
const records = new Map();
const identity = { accountKey: "qa-account", workspaceKey: "qa-workspace" };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Opt-in one-shot failure lets QA verify that Refresh appears only when needed.
let failNextRead = options.get("failRead") === "1";
let clockOffsetMs = 0;
const service = createTitleService({
  now: () => Date.now() + clockOffsetMs,
  storage: { get: async (key) => structuredClone(records.get(key)), set: async (key, value) => records.set(key, structuredClone(value)) },
  read: async (_context, intent) => {
    reads += 1;
    renderMetrics();
    await delay(intent?.identityOnly ? 500 : 5000);
    if (failNextRead) { failNextRead = false; throw new Error("Synthetic read failure"); }
    return { identity, current: { ...current } };
  },
  write: async (_context, payload) => {
    writes += 1;
    renderMetrics();
    await delay(3000);
    if (payload.before !== current.title) return { status: "conflict", current: { ...current } };
    current.title = payload.after;
    return { status: "verified", current: { ...current } };
  },
});
const root = document.querySelector("#titles-view");
const view = createTitleView({ root, ownerTabId: 1,
  request: async (action, payload) => {
    if (action === "replan") {
      replans += 1;
      renderMetrics();
    }
    return service.handle(action, { tabId: 1, conversationId: "qa" }, payload);
  },
});
const update = () => view.update({ snapshot, preferences: { timeZone: "UTC", dateFormat: "slash", conversationTimeMode: "created" }, active: true, translator: createTranslator("zh-CN") });
update();

// Observable QA measurements, outside the product panel. A passive DOM update
// must keep selects attached. The frame measurement includes browser scheduling
// and rendering, not adapter or tool round-trip time (it is not an HTTP timer).
const controls = new Map();
let replacements = 0, maximumChoiceMs = 0;
new MutationObserver(() => {
  for (const control of root.querySelectorAll("[data-title-rule]")) {
    const key = control.dataset.titleRule;
    if (controls.has(key) && controls.get(key) !== control) replacements += 1;
    controls.set(key, control);
  }
  document.querySelector("#qa-replacements").textContent = String(replacements);
}).observe(root, { childList: true, subtree: true, attributes: true });
root.addEventListener("change", () => {
  const start = performance.now();
  requestAnimationFrame(() => {
    maximumChoiceMs = Math.max(maximumChoiceMs, performance.now() - start);
    document.querySelector("#qa-choice-ms").textContent = maximumChoiceMs.toFixed(1);
  });
}, true);
document.querySelector("#qa-publish").addEventListener("click", update);
// This modifies only our synthetic in-memory source and publishes its snapshot.
// No browser-side state injection or real conversation mutation is involved.
document.querySelector("#qa-external-change").addEventListener("click", () => {
  current.title += " · 更新";
  snapshot.conversation.title = field(current.title);
  snapshot.conversation.updatedAt = field(current.updatedAt);
  update();
});
// Advance only this synthetic service's clock, then change a rule in the UI:
// the real worker validation will reject its expired context and exercise renewal.
document.querySelector("#qa-expire").addEventListener("click", () => { clockOffsetMs += 10 * 60 * 1000 + 1000; });
document.querySelector("#qa-fail-next").addEventListener("click", () => { failNextRead = true; });
