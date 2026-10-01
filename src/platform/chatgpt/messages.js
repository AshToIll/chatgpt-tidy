(function initTidyChatgptMessages(global) {
  "use strict";

  if (global.TidyChatgptMessages) return;
  const api = global.TidyChatgptApi;
  const pageSession = global.TidyPageSession;
  if (!api || !pageSession) return;

  // 目录读取的整体期限，包含认证、请求和 JSON 解析；超时后不自动重试。
  const PAGE_TIMEOUT_MS = 20_000;

  class MessageReadError extends Error {
    constructor(code, message, { status = null, retryable = false, serverCode = null } = {}) {
      super(message);
      this.name = "MessageReadError";
      this.code = code;
      this.category = code;
      this.status = status;
      this.retryable = retryable;
      this.serverCode = serverCode;
    }
  }

  function string(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  async function account({ refresh = false } = {}) {
    pageSession.assertActive();
    let session;
    try { session = await api.loadSession({ refresh }); } catch (error) {
      // A retired extension session is terminal, never an auth retry.
      pageSession.assertActive();
      // Keep HTTP evidence from the session reader; never parse error text or
      // convert rate limiting/server failure into an authentication category.
      if (Number.isInteger(error?.status)) {
        const status = error.status, auth = status === 401 || status === 403;
        throw new MessageReadError(auth ? "AUTH" : "HTTP", "ChatGPT authentication session could not be read", {
          status, retryable: auth || [408, 425, 429].includes(status) || status >= 500,
        });
      }
      throw new MessageReadError("AUTH", "ChatGPT authentication session could not be read", { retryable: true });
    }
    pageSession.assertActive();
    const identity = api.catalogIdentity(session);
    if (!identity.accountKey) {
      throw new MessageReadError("SCHEMA", "ChatGPT session has no stable account identity");
    }
    // A user ID can isolate local cache entries, but is NOT an account header.
    return identity;
  }

  function assertAccount(identity, expectedAccountKey) {
    if (expectedAccountKey !== null && identity.accountKey !== expectedAccountKey) {
      throw new MessageReadError("ACCOUNT_MISMATCH", "ChatGPT account changed while reading messages");
    }
  }

  function textValue(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return typeof value.text === "string" ? value.text
      : typeof value.content === "string" ? value.content : "";
  }

  // 已挂载原生消息的只读投影，供 MAIN 提取定位文字；不请求历史消息分页。
  function visibleMessage(message) {
    const content = message?.content || {};
    const type = String(content.content_type || "");
    const role = message?.author?.role;
    if (!message || message.metadata?.is_visually_hidden_from_conversation === true
      || ["model_editable_context", "user_editable_context"].includes(type)
      || !["user", "assistant"].includes(role)) return null;
    if (role === "assistant" && (["thoughts", "reasoning_recap"].includes(type)
      || message.metadata?.reasoning_status === "is_reasoning"
      || message.metadata?.is_thinking_preamble_message === true
      || (message.recipient != null && message.recipient !== "all")
      || (message.channel != null && message.channel !== "final"))) return null;
    const messageId = string(message.id);
    const time = typeof message.create_time === "number" ? message.create_time * 1000 : null;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    return messageId ? { messageId,
      timestampMs: Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? time : null,
      text: parts.map(textValue).filter(Boolean).join("\n")
        || textValue(content.text) || textValue(content.result) || textValue(message.text),
    } : null;
  }

  async function responseError(response) {
    pageSession.assertActive();
    let detail = null;
    try {
      const body = await response.json();
      pageSession.assertActive();
      detail = body?.detail && typeof body.detail === "object" ? body.detail : body;
    } catch (_) {
      pageSession.assertActive();
      // HTTP status remains meaningful even for an HTML or empty error body.
    }
    const status = response.status;
    const serverCode = string(detail?.code) || null;
    const inaccessible = [401, 403, 404].includes(status) || serverCode === "conversation_inaccessible";
    const retryable = typeof detail?.can_retry === "boolean" ? detail.can_retry
      : status === 408 || status === 425 || status === 429 || status >= 500;
    return new MessageReadError(inaccessible ? "INACCESSIBLE" : "HTTP",
      inaccessible ? `ChatGPT conversation is inaccessible (${status})` : `ChatGPT message page failed (${status})`,
      { status, serverCode, retryable });
  }

  // 只承担目录适配器的受认证 GET；响应结构由调用方校验，不再保留历史消息分页入口。
  async function readJson(input, query = {}) {
    pageSession.assertActive();
    if (typeof input !== "string" || !input.startsWith("/backend-api/")) {
      throw new MessageReadError("SCHEMA", "Invalid ChatGPT backend path");
    }
    query = { accountKey: null, projectId: null, ...query };
    const controller = typeof global.AbortController === "function" ? new global.AbortController() : null;
    let expired = false;
    let timer = null;
    const checkpoint = () => {
      pageSession.assertActive();
      if (expired) throw new MessageReadError("TIMEOUT", "ChatGPT message page timed out", { retryable: true });
    };
    const operation = async () => {
      const identity = await account();
      checkpoint();
      assertAccount(identity, query.accountKey);
      const headers = { Accept: "application/json" };
      if (identity.accountId) headers["chatgpt-account-id"] = identity.accountId;
      if (query.projectId) headers["chatgpt-project-id"] = query.projectId;
      const response = await api.fetchAuthenticated(input, {
        method: "GET", headers, ...(controller ? { signal: controller.signal } : {}),
      });
      checkpoint();
      // The auth helper may refresh a 401 session. Reject cross-account results
      // rather than writing them into the previous account's local index.
      const responseIdentity = await account();
      checkpoint();
      assertAccount(responseIdentity, query.accountKey || identity.accountKey);
      if (!response.ok) {
        const error = await responseError(response);
        checkpoint();
        throw error;
      }
      let raw;
      try { raw = await response.json(); } catch (_) {
        checkpoint();
        throw new MessageReadError("SCHEMA", "ChatGPT message page is not valid JSON");
      }
      checkpoint();
      const finalIdentity = await account();
      checkpoint();
      assertAccount(finalIdentity, query.accountKey || identity.accountKey);
      return raw;
    };
    // Abort fetch and reject the whole read, including a body/session promise
    // which ignores AbortSignal. Late continuations still hit checkpoints.
    let unsubscribe = () => {};
    const stopped = new Promise((_, reject) => {
      unsubscribe = pageSession.onDispose(() => {
        controller?.abort();
        reject(pageSession.error());
      });
    });
    // A fetch abort alone does not bound loadSession() or a stalled JSON body.
    // Race the entire authenticated read and abort any in-flight fetch as well.
    const timeout = new Promise((_, reject) => {
      timer = global.setTimeout(() => {
        expired = true;
        controller?.abort();
        reject(new MessageReadError("TIMEOUT", "ChatGPT message page timed out", { retryable: true }));
      }, PAGE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([operation(), timeout, stopped]);
      checkpoint();
      return result;
    } catch (error) {
      pageSession.assertActive();
      if (expired) throw new MessageReadError("TIMEOUT", "ChatGPT message page timed out", { retryable: true });
      if (error instanceof MessageReadError) throw error;
      const category = ["TypeError", "AbortError"].includes(error?.name) ? "NETWORK" : "UNKNOWN";
      throw new MessageReadError(category, "ChatGPT message page could not be read", { retryable: true });
    } finally {
      unsubscribe();
      if (timer !== null) global.clearTimeout(timer);
    }
  }

  global.TidyChatgptMessages = Object.freeze({
    PAGE_TIMEOUT_MS, MessageReadError, account, readJson, visibleMessage,
  });
})(globalThis);
