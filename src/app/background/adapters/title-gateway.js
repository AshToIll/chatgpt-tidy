import { getPreferences } from "../../../platform/preferences/preferences.js";
import { parseConversationRoute } from "../../../platform/navigation/conversation-route.js";
import { titleSnapshotContext } from "../../../features/titles/model/title-context.js";
import "../../../platform/protocol.js";

// Durable dispatch belongs to the original title service. This adapter never replays writes.
export function createTitleGateway({ chrome, pageGateway }) {
  const protocol = globalThis.TidyProtocol;
  const requestTabSnapshot = pageGateway.snapshot;
  function titleContext(tab, snapshot, expectedConversationId) {
    const context = titleSnapshotContext(snapshot, tab.id);
    const route = parseConversationRoute(tab.url);
    if (!context || !route || context.conversationId !== expectedConversationId
      || context.pathname !== route.pathname || context.projectId !== route.projectId) {
      throw Object.assign(new Error("The saved title conversation context changed."), { tidyCode: "CONTEXT_MISMATCH" });
    }
    return { ...context, targetProjectId: context.projectId };
  }

  async function requestTitleAdapter(context, type, plan = {}, beforeDispatch) {
    const isWrite = type === protocol.Type.TITLE_WRITE_CURRENT;
    try {
      const tab = await chrome.tabs.get(context.tabId);
      const { snapshot } = await requestTabSnapshot(tab, { scope: "title-owner" });
      const owner = context.ownerContext || context;
      const actual = titleContext(tab, snapshot, owner.conversationId);
      if ((owner.pathname && owner.pathname.replace(/\/$/, "") !== actual.pathname)
        || (Object.hasOwn(owner, "projectId") && (owner.projectId || null) !== actual.projectId)) {
        throw Object.assign(new Error("The title owner route changed."), { tidyCode: "CONTEXT_MISMATCH" });
      }
      if (isWrite && plan.expectedTimeZone) {
        const preferences = await getPreferences();
        const timeZone = new Intl.DateTimeFormat("en", {
          ...(preferences.timeZone && preferences.timeZone !== "system" ? { timeZone: preferences.timeZone } : {}),
        }).resolvedOptions().timeZone;
        // Another panel can change the global timezone before this panel receives
        // the preference event. Do not send that now-stale date preview.
        if (timeZone !== plan.expectedTimeZone) {
          return { status: "failed", current: null, messageCode: "rules_changed" };
        }
      }
    } catch (error) {
      // No write envelope has left this worker yet, so this is a provable
      // rejection rather than an unknown POST. It must not lock recovery forever.
      if (isWrite) return { status: "failed", current: null, messageCode: "context_changed" };
      throw error;
    }
    const envelope = protocol.request(type, { ...plan, conversationId: context.conversationId,
      ...(context.ownerContext ? { ownerContext: context.ownerContext } : {}),
      ...(Object.hasOwn(context, "targetProjectId") ? { targetProjectId: context.targetProjectId } : {}),
      ...(context.batchScopeId ? { batchScopeId: context.batchScopeId } : {}),
    });
    // 只有标题服务可签发本次派发许可，不能从面板 payload 传入。
    // 存储失败就停在本机；存好之后的中断一律保留“可能发出”，不冒充失败重试。
    if (isWrite) {
      if (typeof beforeDispatch !== "function") throw new Error("Title write requires its durable dispatch checkpoint.");
      await beforeDispatch();
    }
    const result = await pageGateway.send(context.tabId, envelope);
    if (!protocol.isResponse(result, envelope.requestId) || result.type !== type) {
      throw Object.assign(new Error("The title adapter response is unavailable."), {
        tidyCode: protocol.ErrorCode.TITLE_UNAVAILABLE,
      });
    }
    if (!result.ok) {
      if (isWrite && ["CONTEXT_MISMATCH", "TITLE_INVALID_PLAN", "TITLE_BUSY"].includes(result.error?.code)) {
        // The adapter documents these codes only for rejection before dispatch.
        return { status: "failed", current: null, messageCode: "context_changed" };
      }
      throw Object.assign(new Error("The title operation could not be completed."), {
        tidyCode: result.error?.code || protocol.ErrorCode.TITLE_UNAVAILABLE,
        details: result.error?.details || null,
      });
    }
    return result.payload;
  }

  return Object.freeze({ context: titleContext, request: requestTitleAdapter });
}
