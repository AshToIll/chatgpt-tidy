// Background composition root: instantiate capabilities, then register browser listeners synchronously.
// Request policy, page IPC, feature actions and browser lifetimes each have one narrow owner.
import { createConversationCatalogRepository } from "../../platform/catalog/storage/conversation-catalog.js";
import { createLibraryIdentity } from "../../platform/library/background/library-identity.js";
import { createWorkerNavigation } from "../../platform/navigation/background/worker-navigation.js";
import { createNavigationEpochAllocator } from "../../platform/navigation/storage/navigation-epoch.js";
import { createPanelHost } from "../../platform/navigation/background/panel-host.js";
import { createToolbarTheme } from "../../platform/theme/background/toolbar-theme.js";
import { createPageSession } from "../../platform/session/background/page-session.js";
import { createRequestBinding, isChatgptUrl } from "../../platform/session/background/request-binding.js";
import { createPageGateway } from "../../platform/session/background/page-gateway.js";
import { createPageEvents } from "../../platform/session/background/page-events.js";
import { createDiagnosticsService } from "../../platform/diagnostics/worker-service.js";
import { createFavoriteFilingContextRegistry } from "../../features/favorites/background/favorites-filing-context.js";
import { createBookmarkFilingContextRegistry } from "../../features/bookmarks/background/bookmarks-filing-context.js";
import { createSearchGateway } from "./adapters/search-gateway.js";
import { createCatalogSelection } from "./catalog-selection.js";
import { createLibraryWorkflow } from "./library-workflow.js";
import { createExportJobs } from "./export-jobs.js";
import { createTitleCatalogObserver } from "./title-catalog-observer.js";
import { createTitlesHandler } from "./handlers/titles.js";
import { createFavoritesHandler } from "./handlers/favorites.js";
import { createBookmarksHandler } from "./handlers/bookmarks.js";
import { createExportHandler } from "./handlers/export.js";
import { createLibraryHandler } from "./handlers/library.js";
import { createPreferencesHandler } from "./handlers/preferences.js";
import { createSearchHandler } from "./handlers/search.js";
import { createNavigationHandler } from "./handlers/navigation.js";
import { createRequestRouter } from "./request-router.js";
import { createWorkerMessageListener } from "./runtime-messages.js";
import { createBrowserLifecycle } from "./browser-lifecycle.js";
import "../../platform/protocol.js";
import "../../features/search/model/search.js";
import "../../platform/time-format.js";
import "../../features/titles/model/title-dates.js";

const protocol = globalThis.TidyProtocol;
const toolbarTheme = createToolbarTheme(chrome);
const pageSession = createPageSession({ chrome, isChatgptUrl });
const pageGateway = createPageGateway({ chrome });
const favoriteFilingContexts = createFavoriteFilingContextRegistry();
const bookmarkFilingContexts = createBookmarkFilingContextRegistry();
const conversationCatalogRepository = createConversationCatalogRepository();

// Only libraryIdentity owns the mutable document/account cache. Lifecycle hooks retire
// the old navigation before mutation, then resume only after the new identity is published.
const libraryIdentity = createLibraryIdentity({
  chrome, isChatgptUrl,
  beforeIdentityChange: (payload, sender, epoch) => navigation.identityChanged(payload, sender, epoch),
  afterIdentityChange: tabId => {
    libraryHandler.revoke(tabId);
    void navigation.resume(tabId);
    void exportJobs.observeOwner(tabId, libraryIdentity.peek(tabId)).catch(() => {});
  },
});
const binding = createRequestBinding({ chrome, libraryIdentity });
const navigation = createWorkerNavigation({
  chrome, searchContract: globalThis.TidySearch,
  allocateNavigationEpoch: createNavigationEpochAllocator(),
  navigationSenderTab: binding.navigationSenderTab, getBoundTab: binding.getBoundTab,
  libraryDocument: libraryIdentity.document, readLibraryAccount: libraryIdentity.readAccount,
  readLibraryIdentity: libraryIdentity.peek, assertLibraryContext: libraryIdentity.assertCurrent,
  requestTabMessageLocation: pageGateway.locate,
});
const panelHost = createPanelHost({ chrome, protocol, binding, favoriteFilingContexts, bookmarkFilingContexts });
const library = createLibraryWorkflow({ chrome, identity: libraryIdentity, pageGateway });
const libraryHandler = createLibraryHandler({ library });
const exportJobs = createExportJobs({ chrome, identity: libraryIdentity });
const search = createSearchGateway({ binding, pageGateway });
const catalog = createCatalogSelection({ repository: conversationCatalogRepository, search });
const requests = createRequestRouter({ binding, pageSession, navigation, panelHost, handlers: [
  createTitlesHandler({ chrome, binding, pageGateway, catalog }),
  createFavoritesHandler({ binding, library, navigation, filingContexts: favoriteFilingContexts }),
  createBookmarksHandler({ binding, library, navigation, filingContexts: bookmarkFilingContexts, panelHost }),
  createExportHandler({ binding, pageGateway, library, catalog, exportJobs }),
  libraryHandler,
  createPreferencesHandler({ binding, pageGateway, panelHost }),
  createSearchHandler({ search }),
  createNavigationHandler({ navigation }),
] });
const lifecycle = createBrowserLifecycle({ chrome, binding, navigation, identity: libraryIdentity,
  libraryHandler, exportJobs, panelHost, pageGateway });
const messageListener = createWorkerMessageListener({ toolbarTheme, exportJobs, navigation,
  identity: libraryIdentity, requests,
  diagnostics: createDiagnosticsService({ chrome }),
  titleCatalog: createTitleCatalogObserver({ chrome, identity: libraryIdentity, repository: conversationCatalogRepository }),
  pageEvents: createPageEvents({ chrome, identity: libraryIdentity }),
});

// These registrations must run during module evaluation, never behind startup/network awaits.
chrome.runtime.onInstalled.addListener(panelHost.initialize);
chrome.runtime.onStartup.addListener(panelHost.initialize);
chrome.tabs.onUpdated.addListener(lifecycle.updated);
chrome.tabs.onActivated.addListener(lifecycle.activated);
chrome.webNavigation.onHistoryStateUpdated.addListener(lifecycle.history);
chrome.webNavigation.onCommitted.addListener(lifecycle.committed);
chrome.storage.onChanged.addListener(lifecycle.storageChanged);
chrome.tabs.onRemoved.addListener(lifecycle.removed);
chrome.runtime.onConnect.addListener(panelHost.acceptPort);
chrome.runtime.onMessage.addListener(messageListener);
// Browser download receipts must wake a sleeping worker independently of a live panel.
chrome.downloads?.onChanged.addListener(delta => { void exportJobs.downloadChanged(delta.id).catch(() => {}); });
chrome.downloads?.onCreated.addListener(item => { void exportJobs.downloadChanged(item.id).catch(() => {}); });

void panelHost.startBehavior();
void toolbarTheme.start().catch(error => {
  console.error("ChatGPT Tidy toolbar theme setup failed", String(error?.message || error));
});
