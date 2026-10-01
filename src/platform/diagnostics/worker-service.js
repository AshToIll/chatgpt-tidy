// 唯一 worker listener 的诊断分支；不注册第二个 onMessage，也不调用业务准入。
import "../../messages/build-info.js";
import "../../messages/notice-registry.js";
import "../../messages/notice-lifecycle.js";
import "../../messages/diagnostics.js";
import "./wire.js";
import { parsePanelOwnerTabId } from "../navigation/panel-owner.js";
import { createDiagnosticsSessionStore } from "./session-store.js";

export function createDiagnosticsService({ chrome, buildInfo = globalThis.ChatGPTTidyBuildInfo,
  registry = globalThis.ChatGPTTidyNoticeRegistry, diagnostics = globalThis.ChatGPTTidyDiagnostics,
  crypto = globalThis.crypto }) {
  const wire = globalThis.TidyDiagnosticsWire;
  const contract = wire.createContract({ buildInfo, registry, sanitizeCause: input => diagnostics.cause(input) });
  const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const store = createDiagnosticsSessionStore({ storage: chrome.storage.session, contract, wire, randomToken });
  const panelBase = chrome.runtime.getURL("app/sidepanel/index.html");
  function senderKind(sender) {
    try {
      if (!sender || sender.id !== chrome.runtime.id) return null;
      if (sender.tab === undefined && parsePanelOwnerTabId(sender.url, panelBase) !== null) {
        // Chrome仅在sender.tab存在时保证frameId；缺省可接受，但明确的子框架/非活跃文档不可接受。
        if (sender.frameId !== undefined && sender.frameId !== 0) return null;
        if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active") return null;
        if (sender.documentId !== undefined && (typeof sender.documentId !== "string" || !sender.documentId || sender.documentId.length > 128)) return null;
        return "panel";
      }
      if (!sender.tab || !wire.integer(sender.tab.id) || sender.frameId !== 0
        || typeof sender.documentId !== "string" || !sender.documentId || sender.documentId.length > 128
        || sender.documentLifecycle !== "active") return null;
      const url = new URL(sender.url);
      return url.protocol === "https:" && url.hostname === "chatgpt.com" && url.port === ""
        && !url.username && !url.password ? "content" : null;
    } catch { return null; }
  }
  return Object.freeze({
    matches(message) { try { return message?.channel === wire.CHANNEL; } catch { return false; } },
    async handle(message, sender) {
      try {
        const kind = senderKind(sender);
        if (!kind || (message?.operation !== "record" && kind !== "panel")) return { ok: false, code: "DIAGNOSTICS_FORBIDDEN" };
        if (!contract.validRequest(message)) return { ok: false, code: "DIAGNOSTICS_INVALID_REQUEST" };
        if (message.operation === "read") return { ok: true, snapshot: await store.read() };
        if (message.operation === "clear") return { ok: true, snapshot: await store.clear() };
        const result = await store.record(message);
        if (result.stale) return { ok: false, code: "DIAGNOSTICS_STALE_GENERATION", generation: result.generation };
        return { ok: true, ...result };
      } catch (error) { return { ok: false, code: error?.code === "DIAGNOSTICS_CAPACITY"
        ? "DIAGNOSTICS_CAPACITY" : "DIAGNOSTICS_STORAGE_FAILED" }; }
    },
  });
}
