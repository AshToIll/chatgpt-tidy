import { createExportJobService } from "../../features/export/background/export-job-service.js";
import { libraryError } from "../../platform/session/background/request-binding.js";
import "../../platform/protocol.js";

// Browser downloads can wake the worker; the original job service remains lazy.
export function createExportJobs({ chrome, identity }) {
  const protocol = globalThis.TidyProtocol;
  const readLibraryAccount = identity.readAccount;
  let exportJobService = null;
  function getExportJobService() {
    if (!exportJobService) exportJobService = createExportJobService({
      chrome,
      verifyOwner: async owner => {
        const tab = await chrome.tabs.get(owner.tabId);
        const current = await readLibraryAccount(tab);
        if (current.accountKey !== owner.accountKey || current.identity?.documentId !== owner.documentId
          || current.identity?.epoch !== owner.epoch) throw libraryError("The export source identity changed.");
      },
      notify: payload => { void chrome.runtime.sendMessage(protocol.event(protocol.Type.EXPORT_JOB_CHANGED, payload)).catch(() => {}); },
    });
    return exportJobService;
  }

  return Object.freeze({ get: getExportJobService,
    observeOwner: (tabId, owner) => getExportJobService().observeOwner(tabId, owner),
    revoke: tabId => getExportJobService().revoke(tabId),
    acceptHost: (envelope, sender) => getExportJobService().acceptHost(envelope, sender),
    downloadChanged: id => getExportJobService().downloadChanged(id) });
}
