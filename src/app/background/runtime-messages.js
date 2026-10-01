import { TOOLBAR_THEME_CHANNEL } from "../../platform/theme/background/toolbar-theme.js";
import "../../platform/protocol.js";

// One runtime listener decides who owns a response; events never compete with business requests.
export function createWorkerMessageListener({ toolbarTheme, exportJobs, titleCatalog, navigation, identity, pageEvents, requests, diagnostics }) {
  const protocol = globalThis.TidyProtocol;
  function onMessage(envelope, sender, sendResponse) {
    // Diagnostic envelopes have narrow sender/shape admission but acquire no business authority.
    if (diagnostics.matches(envelope)) {
      diagnostics.handle(envelope, sender).then(sendResponse).catch(() => sendResponse({ ok: false, code: "DIAGNOSTICS_UNAVAILABLE" }));
      return true;
    }
    if (envelope?.channel === TOOLBAR_THEME_CHANNEL && envelope.target === "service") {
      toolbarTheme.acceptReport(envelope, sender).then(ok => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (envelope?.channel === "tidy.export-host.v1" && envelope.target === "service") {
      exportJobs.acceptHost(envelope, sender).then(ok => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (!protocol.isEnvelope(envelope)) return false;
    if (envelope.kind === protocol.Kind.EVENT && envelope.type === protocol.Type.TITLE_CHANGED) {
      titleCatalog.accept(envelope.payload, sender).then(ok => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (envelope.kind === protocol.Kind.EVENT) {
      if (envelope.type === protocol.Type.NAVIGATION_CANCELLED) {
        try { navigation.cancel(envelope.payload || {}, sender); } catch { /* Reject unrelated page senders. */ }
      } else if (envelope.type === protocol.Type.NAVIGATION_RESULT) {
        try { navigation.acceptResult(envelope.payload, sender); } catch { /* Only the bound page may finish this execution. */ }
      } else if (envelope.type === protocol.Type.LIBRARY_IDENTITY_CHANGED) {
        void identity.acceptEvent(envelope.payload, sender).catch(() => {});
      } else if (envelope.type === protocol.Type.SNAPSHOT_UPDATED) {
        pageEvents.snapshot(envelope, sender);
      } else if (envelope.type === protocol.Type.EXPORT_PREVIEW_CLOSED) {
        pageEvents.previewClosed(envelope, sender);
      }
      return false;
    }

    if (envelope.kind !== protocol.Kind.REQUEST) return false;
    requests.handle(envelope, sender)
      .then((payload) => sendResponse(protocol.response(envelope, payload)))
      .catch((error) =>
        sendResponse(
          protocol.failure(
            envelope,
            error.tidyCode || protocol.ErrorCode.INTERNAL_ERROR,
            error.message || "Unexpected extension error",
            error.details || (error.stage ? { stage: error.stage } : null),
          ),
        ),
      );
    return true;
  }

  return onMessage;
}
