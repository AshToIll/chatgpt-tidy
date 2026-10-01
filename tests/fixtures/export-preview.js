import { createExportView } from "/src/features/export/ui/export-view.js";
import { createTranslator } from "/src/messages/i18n.js";
import "/src/platform/theme/theme.js";
const { NATIVE_APPEARANCE_TOKENS, THEMES } = globalThis.TidyTheme;

// Exercise the production component and serializers with entirely synthetic
// documents. Download/PDF engines and extension APIs are deliberately absent.
const options = new URLSearchParams(location.search);
document.documentElement.style.setProperty("--qa-width", options.get("width") === "420" ? "420px" : "320px");
if (options.get("dark") === "1") {
  document.documentElement.dataset.nativeColorScheme = "dark";
  const theme = THEMES["mist-indigo"].dark, native = NATIVE_APPEARANCE_TOKENS.dark;
  for (const [name, value] of Object.entries({ surface: native.surface, "surface-subtle": native.surfaceSubtle,
    "surface-hover": theme.hoverSurface, "text-primary": native.textPrimary, "text-secondary": native.textSecondary,
    "text-tertiary": native.textTertiary, accent: theme.accent, "accent-ink": theme.accentInk,
    "accent-foreground": theme.accentForeground, "accent-soft": theme.accentSoft, border: native.border, "border-subtle": native.borderSubtle })) {
    document.documentElement.style.setProperty(`--${name}`, value);
  }
}

const createdAt = "2026-09-09T01:00:00.000Z", updatedAt = "2026-09-09T02:00:00.000Z";
function documentFor(id, title) {
  return {
    schemaVersion: "chatgpt-tidy.export-source.v2",
    conversation: { id, title, createdAt, updatedAt, sourceUrl: `https://chatgpt.com/c/${id}`, resources: [],
      messages: ["user", "assistant"].map((role, index) => ({
        id: `${id}-${role}`, messageNumber: index + 1, role, timestamp: updatedAt,
        segments: [{ type: "content", sourceMessageId: `${id}-${role}`, timestamp: updatedAt,
          blocks: [{ type: "paragraph", text: index === 0 ? "一起看看导出页面的布局。" : "当前会话与批量导出共享格式和内容选项。这是用于界面验收的合成消息。" }] }],
      })),
    },
    warnings: [],
  };
}
const documents = new Map([
  ["qa-export-a", documentFor("qa-export-a", "2026/09/09｜生成自拍图")],
  ["qa-export-b", documentFor("qa-export-b", "2026/09/09｜TIDY 界面讨论")],
]);
const current = documents.get("qa-export-a").conversation;
const field = (value) => ({ value, source: "qa", status: "available" });
const snapshot = {
  route: { pathname: `/c/${current.id}`, kind: "conversation", status: "available" },
  conversation: { conversationId: current.id, kind: "conversation", identityStatus: "stable", bindingStatus: "bound",
    title: field(current.title), createdAt: field(createdAt), updatedAt: field(updatedAt) },
  messages: current.messages,
};
const favorites = { accountKey: "qa-library", revision: 1, items: Object.fromEntries([...documents].map(([id, value]) => [id, {
  conversationId: id, title: value.conversation.title, createdAt, updatedAt, routePath: `/c/${id}`,
}])), groups: [], view: { groupId: "all" } };
const bookmarks = { accountKey: "qa-library", revision: 1, items: {}, groups: [], view: { groupId: "all", query: "" } };
const feedback = (message) => { document.querySelector("#qa-feedback").textContent = message; };
const root = document.querySelector("#export-view");

// Keep the real visual affordances but suppress external-page/download actions
// before the production bubble handler. This fixture never claims a file saved.
root.addEventListener("click", (event) => {
  if (event.target.closest("[data-export-action], [data-export-full-preview]")) {
    event.preventDefault();
    event.stopImmediatePropagation();
    feedback("此页仅验收布局：下载和完整预览已停用，未执行保存。");
  }
}, true);
const view = createExportView({
  root,
  requestDocument: async ({ expectedConversationId }) => structuredClone(documents.get(expectedConversationId)),
  requestDocuments: async ({ conversationIds }) => ({ schemaVersion: "chatgpt-tidy.export-source-collection.v2",
    documents: conversationIds.map((id) => structuredClone(documents.get(id))) }),
  presentFullPreview: async () => { throw new Error("QA fixture does not open external previews"); },
  dismissFullPreview: async () => {},
  formatTimestamp: (value) => value ? value.slice(0, 10).replaceAll("-", "/") : "",
  onToast: feedback,
  onSourceRequest: () => feedback("这是合成数据预览；批量列表已预置两条测试会话。"),
});
const model = { accountKey: "qa-library", snapshot, favorites, bookmarks, preferences: { language: "zh-CN", timeZone: "UTC" }, translator: createTranslator("zh-CN") };
// Populate via the public selection coordinator, not private component state.
view.update({ ...model, active: false });
view.beginSelection("favorites", "source");
for (const id of documents.keys()) view.toggleSelection("favorites", id);
view.submitSelection("favorites");
view.setMode("current");
view.update({ ...model, active: true });
