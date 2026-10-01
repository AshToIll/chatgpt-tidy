import { assertAccountKey } from "../../storage/database.js";
import { isValidTabId } from "../../navigation/panel-owner.js";
import "../../protocol.js";
import "../../navigation/navigation-identity.js";

// 统一管理当前页面与账号归属，并合并同时发生的初始化请求。
// 不按固定时间轮询登录、不每点一次就重新鉴权；归属改变时让旧凭证失效。
// 对外只给只读快照，实际消息路由和资料存储仍由各自模块负责。
export function createLibraryIdentity({ chrome, isChatgptUrl, beforeIdentityChange, afterIdentityChange }) {
  const protocol = globalThis.TidyProtocol;
  const navigationIdentity = globalThis.TidyNavigationIdentity;
  const libraryAccountReads = new Map();
  const libraryDocuments = new Map();
  const leases = new WeakMap();

  // The immutable identity is also an in-process lease capability. A serialized
  // or copied identity is only routing data, not authority to finish an action.
  function admitOwner(tabId, record) {
    const identity = Object.freeze(libraryLease(record));
    leases.set(identity, { tabId, record });
    return Object.freeze({ accountKey: record.accountKey, identity });
  }

  function snapshot(record) {
    return record?.documentId ? Object.freeze({ ...libraryLease(record), accountKey: record.accountKey,
      phase: record.phase, ...(record.transition ? { transition: record.transition } : {}) }) : null;
  }

  const documentRecord = documentId => ({ documentId, epoch: 0, accountKey: null, phase: "unavailable" });

  function reserveDocument(tabId) {
    // Reserve ownership BEFORE an asynchronous browser lookup. Closing a tab
    // deletes this record, so a late getFrame cannot recreate a closed owner.
    if (!libraryDocuments.has(tabId)) libraryDocuments.set(tabId, documentRecord(null));
    return libraryDocuments.get(tabId);
  }

  function libraryError(message) {
    return Object.assign(new Error(message), { tidyCode: protocol.ErrorCode.CONTEXT_MISMATCH });
  }

  async function libraryDocument(tab) {
    const before = reserveDocument(tab.id);
    if (before.documentId) return before;
    const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
    const current = libraryDocuments.get(tab.id);
    // A commit/event may win while getFrame resolves. Reuse its proven record,
    // but never recreate one after close or overwrite a newer pending lookup.
    if (current?.documentId) return current;
    if (current !== before) throw libraryError("The bound ChatGPT document changed during initialization.");
    if (!frame?.documentId || !isChatgptUrl(frame.url) || frame.documentLifecycle !== "active") {
      throw libraryError("The bound ChatGPT document is unavailable.");
    }
    current.documentId = frame.documentId;
    return current;
  }

  function libraryLease(record) {
    return { documentId: record.documentId, epoch: record.epoch };
  }

  function broadcastLibraryIdentity(tabId, record) {
    const envelope = protocol.event(protocol.Type.LIBRARY_IDENTITY_CHANGED, {
      tabId, ...libraryLease(record), accountKey: record.accountKey, phase: record.phase,
      ...(record.transition ? { transition: record.transition } : {}),
    });
    chrome.runtime.sendMessage(envelope).catch(() => {});
    // Unlike storage revision events, identity events belong to ONE document.
    chrome.tabs.sendMessage(tabId, envelope, { documentId: record.documentId }).catch(() => {});
  }

  async function readLibraryAccount(tab, { retry = false } = {}) {
    if (!isValidTabId(tab?.id) || !isChatgptUrl(tab.url)) throw libraryError("Open the bound ChatGPT tab to read this library.");
    const record = await libraryDocument(tab);
    if (libraryDocuments.get(tab.id) !== record) throw libraryError("The bound ChatGPT document changed during initialization.");
    if (record.phase === "ready") return admitOwner(tab.id, record);
    if (libraryAccountReads.has(tab.id)) return libraryAccountReads.get(tab.id);
    const boundary = record.hardBoundary || 0;
    const startedEpoch = record.epoch;
    const pending = (async () => {
      const request = protocol.request(protocol.Type.LIBRARY_ACCOUNT, { retry });
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, request, { documentId: record.documentId });
      } catch (error) {
        // Keep the failed transport distinct from account rejection. A panel
        // may consume a NEW ready event once; it may not retry auth by guessing.
        throw Object.assign(new Error("The library content connection was interrupted."), {
          tidyCode: protocol.ErrorCode.ADAPTER_UNAVAILABLE,
          details: { stage: "service-worker.library-account-transport", documentId: record.documentId,
            disconnect: protocol.runtimeDisconnectReason(error) }, cause: error,
        });
      }
      if (!protocol.isResponse(response, request.requestId) || response.type !== request.type) {
        throw libraryError("The current ChatGPT library account could not be verified.");
      }
      if (!response.ok) {
        // Preserve a real auth/network refusal rather than disguising it as an
        // account switch or runtime reconnect. Neither status authorizes replay.
        throw Object.assign(new Error(response.error?.message || "The library account could not be verified."), {
          tidyCode: response.error?.code || "LIBRARY_ACCOUNT_UNAVAILABLE",
          details: { ...response.error?.details, stage: response.error?.details?.stage || "service-worker.library-account-response" },
        });
      }
      let accountKey;
      try { accountKey = assertAccountKey(response.payload?.accountKey); }
      catch { throw libraryError("The current ChatGPT library account could not be verified."); }
      const epoch = response.payload?.epoch;
      // Identity initialization is not an admitted operation lease yet. A newer
      // worker-verified ready can overtake this valid account reply on the other
      // IPC channel. Consume that ready, not the obsolete reply, exactly as the
      // ready fast path above does. Never bridge a document or hard owner change.
      if (Number.isInteger(epoch) && epoch >= startedEpoch && libraryDocuments.get(tab.id) === record
        && record.phase === "ready" && record.accountKey === accountKey && record.epoch > epoch
        && (record.hardBoundary || 0) === boundary) {
        return admitOwner(tab.id, record);
      }
      // Revocation can strengthen without advancing the epoch. An older read
      // cannot turn that same unavailable epoch back into ready. A reply at a
      // newer epoch (or matching a verified ready) remains valid initialization,
      // including a restarted Worker discovering an already-initialized page.
      if (!Number.isInteger(epoch) || epoch < 0 || libraryDocuments.get(tab.id) !== record || epoch < record.epoch
        || (epoch === record.epoch && record.phase === "unavailable" && (record.hardBoundary || 0) !== boundary)
        || (epoch === record.epoch && record.phase === "ready" && accountKey !== record.accountKey)) {
        throw Object.assign(libraryError("The ChatGPT document or identity changed during initialization."), {
          details: { stage: "service-worker.library-account-initialization" },
        });
      }
      Object.assign(record, { accountKey, lastReadyAccountKey: accountKey, epoch, phase: "ready", transition: null });
      return admitOwner(tab.id, record);
    })();
    libraryAccountReads.set(tab.id, pending);
    try { return await pending; }
    finally { if (libraryAccountReads.get(tab.id) === pending) libraryAccountReads.delete(tab.id); }
  }

  function assertLibraryContext(context) {
    const record = libraryDocuments.get(context.tab.id);
    const lease = leases.get(context.identity);
    if (!lease || lease.tabId !== context.tab.id || record !== lease.record || record.phase !== "ready" || record.accountKey !== context.accountKey
      || record.documentId !== context.identity.documentId || record.epoch !== context.identity.epoch) {
      throw libraryError("The ChatGPT account changed while this library operation was running.");
    }
  }

  async function acceptLibraryIdentityEvent(payload, sender) {
    // The MAIN-world payload supplies only the observed epoch/owner. Browser
    // sender metadata, never page-supplied IDs, establishes the live document.
    if (!isValidTabId(sender?.tab?.id) || sender.frameId !== 0 || !sender.documentId
      || sender.documentLifecycle !== "active" || !isChatgptUrl(sender.url)
      || !Number.isInteger(payload?.epoch) || payload.epoch < 0
      || !["ready", "unavailable"].includes(payload.phase)) return;
    let accountKey = null;
    if (payload.phase === "ready") {
      try { accountKey = assertAccountKey(payload.accountKey); } catch { return; }
    } else if (payload.accountKey !== null) return;
    let record = reserveDocument(sender.tab.id);
    if (record.documentId !== sender.documentId) {
      // A document may activate without a new onCommitted event (for example a
      // prerender swap). Only this exceptional document signal queries Chrome;
      // ordinary actions keep their cached lease. Late old documents fail here.
      const before = record;
      const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
      if (frame?.documentId !== sender.documentId || frame.documentLifecycle !== "active" || !isChatgptUrl(frame.url)) return;
      record = libraryDocuments.get(sender.tab.id);
      if (record?.documentId !== sender.documentId) {
        if (record !== before) return;
        record = documentRecord(sender.documentId);
        libraryAccountReads.delete(sender.tab.id);
        libraryDocuments.set(sender.tab.id, record);
      }
    }
    if (record.documentId !== sender.documentId || payload.epoch < record.epoch
      || (payload.epoch === record.epoch && record.phase === "ready" && record.accountKey !== accountKey)) return;
    const transition = payload.phase === "unavailable" && ["workspace-unconfirmed", "workspace-restored",
      "context-changed", "session-revoked", "document-hidden"].includes(payload.transition) ? payload.transition : null;
    // A soft unavailable can acquire hard revocation evidence without changing
    // its already-revoked lease epoch. Do not deduplicate away that evidence.
    if (record.epoch === payload.epoch && record.phase === payload.phase && record.accountKey === accountKey
      && (record.transition || null) === transition) return;
    beforeIdentityChange(payload, sender, record.epoch);
    // Retain only revocation provenance, never old credentials or a usable lease.
    // Equal owners before/after do not prove continuity (A -> B -> A is hard).
    // Missing epochs / a ready-to-ready epoch jump are unknown continuity, not
    // evidence of a harmless refresh. Require the complete observed soft chain.
    if (payload.epoch > record.epoch + 1
      || (payload.phase === "ready" && record.phase === "ready" && payload.epoch !== record.epoch)
      || (payload.phase === "unavailable" && (!navigationIdentity.isInitializing(transition) || !record.lastReadyAccountKey))
      || (payload.phase === "ready" && record.lastReadyAccountKey && record.lastReadyAccountKey !== accountKey)) {
      record.hardBoundary = (record.hardBoundary || 0) + 1;
    }
    if (payload.phase === "ready") record.lastReadyAccountKey = accountKey;
    Object.assign(record, { accountKey, epoch: payload.epoch, phase: payload.phase, transition });
    if (record.phase !== "ready") libraryAccountReads.delete(sender.tab.id);
    broadcastLibraryIdentity(sender.tab.id, record);
    afterIdentityChange(sender.tab.id);
  }

  function committed(details) {
    libraryAccountReads.delete(details.tabId);
    if (!details.documentId) { libraryDocuments.delete(details.tabId); return; }
    const record = documentRecord(details.documentId);
    libraryDocuments.set(details.tabId, record);
    broadcastLibraryIdentity(details.tabId, record);
  }

  function closeTab(tabId) {
    libraryAccountReads.delete(tabId);
    libraryDocuments.delete(tabId);
  }

  return Object.freeze({
    document: async tab => snapshot(await libraryDocument(tab)),
    peek: tabId => snapshot(libraryDocuments.get(tabId)),
    readAccount: readLibraryAccount,
    assertCurrent: assertLibraryContext,
    acceptEvent: acceptLibraryIdentityEvent,
    committed, closeTab,
  });
}
