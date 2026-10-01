// Real browser lifecycle regression: an unmodified unpacked extension, an isolated
// profile and an offline synthetic ChatGPT page. No account, user profile or UI.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { browserArtifactRoot } = require('./browser-fixture.cjs');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PAGE_URL = 'https://chatgpt.com/c/synthetic-page-session';
const STYLE_IDS = ['tidy-time-presentation-style', 'tidy-favorites-presentation-style', 'tidy-bookmarks-presentation-style'];
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Offline page-session regression</title>
<style>.sidebar-item{height:36px;padding:6px;box-sizing:border-box}nav a{display:block}</style></head><body>
<nav><div id="native-row" class="sidebar-item" role="group"><a data-interactive-row-link="true" href="/c/synthetic-page-session"><span>Synthetic conversation</span></a></div></nav>
<main id="native-main"><p id="native-sentinel">Synthetic page; no account and no backend</p></main>
<script>window.documentBootToken=crypto.randomUUID();window.nativeClicks=0;document.getElementById('native-sentinel').addEventListener('click',()=>nativeClicks++);</script>
</body></html>`;

async function main() {
  fs.mkdirSync(browserArtifactRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(browserArtifactRoot, 'page-session-browser-'));
  const profile = path.join(directory, 'profile');
  const executable = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const report = { ok: false, directory, checks: [], observations: {}, intercepted: [], reloadMethod: 'chrome.runtime.reload()' };
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket, sequence = 0, spawnError;
  const pending = new Map(), contexts = new Map();
  child.on('error', error => { spawnError = error; });

  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, message => { clearTimeout(timer); message.error
      ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result); });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  async function waitFor(read, description, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const value = await read(); if (value) return value;
      await sleep(100);
    }
    throw new Error(`Timed out: ${description}`);
  }
  async function evaluate(sessionId, expression, contextId) {
    const result = await call('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  function check(condition, name, detail) {
    report.checks.push({ name, passed: !!condition, detail });
    if (!condition) throw new Error(name);
  }
  const pageState = `({boot:window.documentBootToken, main:!!globalThis.__tidyMainWorldStarted,
    dataset:{...document.documentElement.dataset}, nativeSentinel:!!document.getElementById('native-sentinel'),
    styles:${JSON.stringify(STYLE_IDS)}.filter(id=>document.getElementById(id)),
    owned:[...document.querySelectorAll('[data-tidy-owned]')].map(node=>node.dataset.tidyOwned),
    nativeRowHeight:document.getElementById('native-row')?.getBoundingClientRect().height})`;
  const isolatedState = `(()=>{const value={started:!!globalThis.__tidyIsolatedStarted,
    active:globalThis.TidyPageSession?.check(),aborted:globalThis.TidyPageSession?.signal?.aborted};
    try{value.runtimeId=chrome.runtime.id??null;value.listener=chrome.runtime.onMessage.hasListeners()}catch(error){value.error=String(error)}return value})()`;

  try {
    const port = await waitFor(() => {
      try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
    }, 'isolated browser debugging port', 30000);
    const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); report.browser = browser.Browser;
    socket = new WebSocket(browser.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), receive = pending.get(message.id);
      if (receive) { pending.delete(message.id); receive(message); return; }
      if (message.method === 'Runtime.executionContextCreated') {
        const list = contexts.get(message.sessionId) || new Map();
        list.set(message.params.context.id, message.params.context); contexts.set(message.sessionId, list);
      }
      if (message.method === 'Runtime.executionContextDestroyed') contexts.get(message.sessionId)?.delete(message.params.executionContextId);
      if (message.method === 'Runtime.executionContextsCleared') contexts.get(message.sessionId)?.clear();
      if (message.method === 'Fetch.requestPaused') {
        const { requestId, request, resourceType } = message.params;
        report.intercepted.push({ url: request.url, resourceType });
        const documentRequest = resourceType === 'Document' && request.url.startsWith('https://chatgpt.com/');
        const nativeFetch = new URL(request.url).pathname === '/synthetic-native-fetch';
        void call('Fetch.fulfillRequest', { requestId, responseCode: documentRequest || nativeFetch ? 200 : 404,
          responseHeaders: [{ name: 'Content-Type', value: documentRequest ? 'text/html; charset=utf-8' : 'application/json' }],
          body: Buffer.from(documentRequest ? PAGE_HTML : nativeFetch ? '{"synthetic":true}' : '{}').toString('base64'),
        }, message.sessionId).catch(error => { report.interceptionError = error.message; });
      }
    });
    const attachPage = async targetId => {
      const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
      await call('Runtime.enable', {}, sessionId); await call('Page.enable', {}, sessionId);
      // Fulfill every HTTP(S) request locally, including attempts by the adapter.
      // The browser-wide DNS rule separately prevents background external traffic.
      await call('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] }, sessionId);
      return sessionId;
    };
    const firstTarget = (await call('Target.getTargets')).targetInfos.find(target => target.type === 'page' && target.url === 'about:blank');
    const page = await attachPage(firstTarget.targetId);
    // Chrome rechecks developer mode when runtime.reload() reloads an unpacked
    // extension. Use its own local settings API only in this empty test profile;
    // do not patch protected preferences or touch a user's running browser.
    const setupTarget = await call('Target.createTarget', { url: 'chrome://extensions/' });
    const setup = (await call('Target.attachToTarget', { targetId: setupTarget.targetId, flatten: true })).sessionId;
    await call('Runtime.enable', {}, setup);
    await waitFor(() => evaluate(setup, `typeof chrome.developerPrivate?.updateProfileConfiguration==='function'`), 'isolated extensions settings');
    report.observations.developerProfile = await evaluate(setup, `new Promise(resolve=>{
      chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true},()=>{
        if(chrome.runtime.lastError){resolve({error:chrome.runtime.lastError.message});return}
        chrome.developerPrivate.getProfileConfiguration(value=>resolve({inDeveloperMode:value.inDeveloperMode}));
      });
    })`);
    check(report.observations.developerProfile.inDeveloperMode === true,
      'fresh test profile explicitly permits unpacked extension reload', report.observations.developerProfile);
    await call('Target.closeTarget', { targetId: setupTarget.targetId });
    await call('Page.navigate', { url: PAGE_URL }, page);
    await waitFor(() => evaluate(page, `document.readyState==='complete'&&!!window.documentBootToken`), 'first offline page');
    report.observations.beforeInstall = await evaluate(page, pageState);
    const { id: extensionId } = await call('Extensions.loadUnpacked', { path: path.join(root, 'src') });
    report.extensionId = extensionId;
    const findWorker = async () => {
      const targets = (await call('Target.getTargets')).targetInfos;
      report.observations.lastTargets = targets.map(({ targetId, type, url }) => ({ targetId, type, url }));
      return targets.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${extensionId}/app/background/service-worker.js`);
    };
    const attachWorker = async () => {
      const target = await waitFor(findWorker, 'production service worker');
      const sessionId = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
      await call('Runtime.enable', {}, sessionId);
      // A worker target can appear before its extension execution context is ready.
      await waitFor(() => evaluate(sessionId, `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}`), 'production worker execution context');
      return { targetId: target.targetId, sessionId };
    };
    let worker = await attachWorker();
    const tabId = await evaluate(worker.sessionId, `chrome.tabs.query({url:${JSON.stringify(PAGE_URL)}}).then(tabs=>tabs[0].id)`);
    const probe = () => evaluate(worker.sessionId, `chrome.tabs.sendMessage(${tabId},{protocol:'tidy.protocol.v1',kind:'request',
      type:'page-session.probe',requestId:crypto.randomUUID(),payload:null}).then(value=>({value})).catch(error=>({error:String(error)}))`);
    const ready = result => result?.value?.ok === true && result.value.payload?.ready === true;
    const isolatedContext = () => [...(contexts.get(page)?.values() || [])].find(context =>
      context.origin === `chrome-extension://${extensionId}` || context.name === extensionId);
    const waitUntilActive = async sessionId => waitFor(() => evaluate(sessionId,
      `document.readyState==='complete'&&document.documentElement.dataset.tidyPageSession==='active'`), 'active content session');

    await sleep(500);
    report.observations.firstInstall = await evaluate(page, pageState);
    report.observations.firstInstallProbe = await probe();
    check(!report.observations.firstInstall.main && !report.observations.firstInstall.dataset.tidyIsolated,
      'first install does not retroactively inject an already-open page', report.observations.firstInstall);
    check(report.observations.firstInstall.styles.length === 0 && report.observations.firstInstall.owned.length === 0
      && report.observations.firstInstall.nativeRowHeight === report.observations.beforeInstall.nativeRowHeight,
    'first-install old page keeps its untouched native DOM and layout');
    check(/Receiving end does not exist/.test(report.observations.firstInstallProbe.error),
      'first-install old page cannot pass a real runtime probe', report.observations.firstInstallProbe);

    await call('Page.reload', { ignoreCache: true }, page); await waitUntilActive(page);
    report.observations.afterRefresh = await evaluate(page, pageState);
    report.observations.activeProbe = await probe();
    check(ready(report.observations.activeProbe), 'refresh establishes a live ISOLATED-to-MAIN probe', report.observations.activeProbe);
    check(report.observations.afterRefresh.styles.length === STYLE_IDS.length,
      'production time/favorite/bookmark presenters install their styles', report.observations.afterRefresh.styles);
    check(report.observations.afterRefresh.nativeRowHeight > report.observations.beforeInstall.nativeRowHeight,
      'active page session enables the manifest sidebar layout', report.observations.afterRefresh.nativeRowHeight);

    // A newly opened page needs no extra refresh: its document_start runs normally.
    const newTarget = await call('Target.createTarget', { url: 'about:blank' });
    const newPage = await attachPage(newTarget.targetId);
    await call('Page.navigate', { url: 'https://chatgpt.com/c/synthetic-new-page' }, newPage); await waitUntilActive(newPage);
    report.observations.newPage = await evaluate(newPage, pageState);
    check(report.observations.newPage.dataset.tidyIsolated === 'ready', 'page opened after installation becomes active directly');
    const newContext = [...(contexts.get(newPage)?.values() || [])].find(context =>
      context.origin === `chrome-extension://${extensionId}` || context.name === extensionId);
    if (!newContext) throw new Error('No isolated context for the new-page cleanup check');
    // Seed and stop synchronously in one evaluation. Otherwise normal presenter
    // observers could remove synthetic controls before retirement and give a
    // misleading cleanup pass. This tests real disposal separately from the
    // real browser runtime-invalidation test below; no account is manufactured.
    report.observations.synchronousCleanup = await evaluate(newPage, `(()=>{
      const host=document.getElementById('native-main');
      const favorite=document.createElement('div'); favorite.className='native-host tidy-sidebar-favorite-host';
      favorite.innerHTML='<button data-tidy-owned="sidebar-favorite" class="tidy-sidebar-favorite is-starred">Synthetic favorite<span data-tidy-feedback>stale feedback</span></button>';
      const bookmark=document.createElement('div'); bookmark.className='native-host tidy-sidebar-bookmark-host'; bookmark.dataset.tidyBookmarkCountSize='1';
      bookmark.innerHTML='<button data-tidy-owned="sidebar-bookmark-count" class="tidy-sidebar-bookmark-count">Synthetic count</button>';
      const message=document.createElement('div'); message.className='native-host tidy-message-meta-host';
      message.innerHTML='<span data-tidy-owned="message-meta"><button data-tidy-owned="message-bookmark">Synthetic message bookmark</button></span>';
      for(const node of [favorite,bookmark,message]){const native=document.createElement('span');native.className='native-child';node.append(native)}
      host.append(favorite,bookmark,message);
      const before=document.querySelectorAll('[data-tidy-owned="sidebar-favorite"],[data-tidy-owned="sidebar-bookmark-count"],[data-tidy-owned="message-bookmark"]').length;
      TidyPageSession.stop();
      return {before,owned:document.querySelectorAll('[data-tidy-owned]').length,
        styles:${JSON.stringify(STYLE_IDS)}.filter(id=>document.getElementById(id)),
        hostClasses:[favorite,bookmark,message].map(node=>node.className),
        hostsPreserved:[favorite,bookmark,message].every(node=>node.isConnected&&node.querySelector('.native-child')),
        bookmarkSize:bookmark.getAttribute('data-tidy-bookmark-count-size'),
        nativeSentinel:!!document.getElementById('native-sentinel')};
    })()`, newContext.id);
    const cleanup = report.observations.synchronousCleanup;
    check(cleanup.before === 3 && cleanup.owned === 0 && cleanup.styles.length === 0
      && cleanup.hostClasses.every(value => value === 'native-host') && cleanup.hostsPreserved && cleanup.bookmarkSize === null && cleanup.nativeSentinel,
    'synchronous real disposal clears synthetic stale controls, feedback, host classes and styles', cleanup);
    // Verify the shared capture boundary, not a fake favorite business handler.
    report.observations.retiredClickGate = await evaluate(newPage, `(()=>{
      let native=0,owned=0; const host=document.createElement('div'),button=document.createElement('button');
      button.dataset.tidyOwned='sidebar-favorite'; host.append(button);document.body.append(host);
      host.addEventListener('click',()=>native++);button.addEventListener('click',()=>owned++);
      const event=new MouseEvent('click',{bubbles:true,cancelable:true});button.dispatchEvent(event);host.remove();
      return {native,owned,prevented:event.defaultPrevented};
    })()`);
    check(report.observations.retiredClickGate.prevented && report.observations.retiredClickGate.owned === 0 && report.observations.retiredClickGate.native === 0,
      'retired owned clicks cannot trigger a local handler or leak into native ancestors', report.observations.retiredClickGate);
    await call('Target.closeTarget', { targetId: newTarget.targetId });

    // Stop the real background worker, not the extension. A normal MV3 worker
    // suspension must not revoke document sessions or require the user to refresh.
    const oldWorkerTarget = worker.targetId;
    await evaluate(worker.sessionId, `globalThis.qaWorkerIncarnation=crypto.randomUUID()`);
    await call('ServiceWorker.enable', {}, page);
    await call('ServiceWorker.stopAllWorkers', {}, page);
    await waitFor(async () => !(await call('Target.getTargets')).targetInfos.some(target => target.targetId === oldWorkerTarget), 'background worker stopped');
    await sleep(1400); // Longer than the local 1000 ms invalid-context check.
    report.observations.workerDuringStopWait = (await findWorker())?.targetId || null;
    const oldContext = isolatedContext();
    if (!oldContext) throw new Error('No isolated production context after refresh');
    report.observations.duringWorkerStop = await evaluate(page, isolatedState, oldContext.id);
    check(report.observations.duringWorkerStop.active === true && report.observations.duringWorkerStop.runtimeId === extensionId,
      'forced background worker stop does not retire a valid page session', report.observations.duringWorkerStop);
    report.observations.workerWake = await evaluate(page,
      `chrome.runtime.sendMessage(TidyProtocol.request(TidyProtocol.Type.PREFERENCES_GET)).then(value=>({value})).catch(error=>({error:String(error)}))`, oldContext.id);
    worker = await attachWorker();
    // Chromium may reuse the target ID for the same service-worker version.
    // A lost JS-global sentinel proves that its execution instance restarted.
    report.observations.workerRestart = { oldTarget: oldWorkerTarget, newTarget: worker.targetId,
      oldGlobalAbsent: await evaluate(worker.sessionId, `!Object.hasOwn(globalThis,'qaWorkerIncarnation')`),
      probe: await probe() };
    check(report.observations.workerRestart.oldGlobalAbsent && report.observations.workerWake.value?.ok === true && ready(report.observations.workerRestart.probe),
      'real worker restart preserves the page and live probe', report.observations.workerRestart);

    await evaluate(page, `(()=>{
      globalThis.qaSessionHooks={fetch:globalThis.fetch,pushState:history.pushState,replaceState:history.replaceState};
      globalThis.qaWindowEvents=[];
      addEventListener('message',event=>{if(event.source===window&&event.data?.channel==='chatgpt-tidy.window.v1')qaWindowEvents.push(event.data)});
    })()`);
    await evaluate(worker.sessionId, `setTimeout(()=>chrome.runtime.reload(),50); 'reload-scheduled'`);
    // Observe only DOM here: calling check() would force retirement and fail to
    // test the idle timer that must remove controls without a click or F5.
    await waitFor(() => evaluate(page, `document.documentElement.dataset.tidyPageSession==='retired'`), 'idle timer retires invalid extension context', 10000);
    await sleep(300);
    report.observations.afterReload = await evaluate(page, pageState);
    report.observations.oldContext = await evaluate(page, `({runtimeId:chrome.runtime.id??null,
      aborted:globalThis.TidyPageSession?.signal?.aborted})`, oldContext.id);
    check(report.observations.afterReload.boot === report.observations.afterRefresh.boot,
      'extension reload does not silently refresh the user page');
    check(report.observations.oldContext.runtimeId === null && report.observations.oldContext.aborted,
      'invalid isolated runtime reaches terminal retired state', report.observations.oldContext);
    check(report.observations.afterReload.styles.length === 0 && report.observations.afterReload.owned.length === 0,
      'idle invalidation removes all three presenter styles and owned decorations', report.observations.afterReload);
    check(report.observations.afterReload.nativeRowHeight === report.observations.beforeInstall.nativeRowHeight,
      'retirement disables injected layout and restores native row height', report.observations.afterReload.nativeRowHeight);
    // Do not call MAIN check(): that would itself notice the DOM marker and
    // retire a broken MAIN listener, hiding the cross-world propagation defect.
    report.observations.mainRetirement = await evaluate(page, `({aborted:globalThis.TidyPageSession?.signal?.aborted,mainMarker:document.documentElement.dataset.tidyMainWorld??null,
      fetchRestored:fetch!==qaSessionHooks.fetch,pushRestored:history.pushState!==qaSessionHooks.pushState,
      replaceRestored:history.replaceState!==qaSessionHooks.replaceState})`);
    check(report.observations.mainRetirement.aborted && report.observations.mainRetirement.mainMarker === null,
      'MAIN session retires together with ISOLATED', report.observations.mainRetirement);
    check(report.observations.mainRetirement.fetchRestored && report.observations.mainRetirement.pushRestored && report.observations.mainRetirement.replaceRestored,
      'MAIN retirement releases its fetch and history wrappers', report.observations.mainRetirement);

    // Normal page changes and native controls still work, but must not wake old
    // observers, re-create decorations, show toast feedback or emit snapshots.
    report.observations.nativeAfterRetirement = await evaluate(page, `(async()=>{
      qaWindowEvents.length=0;
      const response=await fetch('/synthetic-native-fetch'); const payload=await response.json();
      history.pushState({},'', '/c/synthetic-retired-navigation');
      history.replaceState({},'', '/c/synthetic-page-session');
      document.getElementById('native-main').append(document.createElement('p'));
      document.getElementById('native-sentinel').click();
      return {status:response.status,payload,nativeClicks};
    })()`);
    await sleep(1600);
    report.observations.quietRetirement = await evaluate(page, `({owned:document.querySelectorAll('[data-tidy-owned]').length,
      feedback:document.querySelectorAll('[data-tidy-feedback],.tidy-action-feedback').length,
      events:qaWindowEvents.filter(value=>value.source==='chatgpt-main-world'&&value.envelope?.kind==='event'),
      nativeSentinel:!!document.getElementById('native-sentinel')})`);
    check(report.observations.nativeAfterRetirement.status === 200 && report.observations.nativeAfterRetirement.payload.synthetic && report.observations.nativeAfterRetirement.nativeClicks === 1,
      'native fetch, history and native click survive retirement', report.observations.nativeAfterRetirement);
    check(report.observations.quietRetirement.owned === 0 && report.observations.quietRetirement.feedback === 0 && report.observations.quietRetirement.events.length === 0 && report.observations.quietRetirement.nativeSentinel,
      'retired document stays quiet after native navigation and DOM changes', report.observations.quietRetirement);
    // Reload may leave the new background dormant until an extension event.
    // Starting its real registration is test orchestration, not a content-side
    // reconnect. It does not inject scripts into or refresh the existing page.
    await call('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${extensionId}/` }, page);
    worker = await attachWorker();
    report.observations.retiredProbe = await probe();
    check(!ready(report.observations.retiredProbe), 'new worker rejects a retired document probe', report.observations.retiredProbe);
    await call('Page.reload', { ignoreCache: true }, page); await waitUntilActive(page);
    report.observations.recovered = await evaluate(page, pageState);
    report.observations.recoveredProbe = await probe();
    check(report.observations.recovered.boot !== report.observations.afterReload.boot && ready(report.observations.recoveredProbe),
      'F5 creates a new fully usable session after extension reload', report.observations.recoveredProbe);
    // Real extension reload, autonomous retirement and F5 recovery were verified
    // above. Test the synchronous contract separately: CDP polling cannot race a
    // 1 s watchdog reliably, because its next tick may be only milliseconds away.
    // Both genuine browser realms run the unchanged production contract below;
    // only runtime.id is synthetic, and watch:false removes timer intervention.
    const contractTarget = await call('Target.createTarget', { url: 'about:blank' });
    const contractPage = await attachPage(contractTarget.targetId);
    const { frameTree } = await call('Page.getFrameTree', {}, contractPage);
    const { executionContextId: contractIsolated } = await call('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'tidy-page-session-contract-test',
    }, contractPage);
    const contractSource = fs.readFileSync(path.join(root, 'src/platform/session/shared/page-session.js'), 'utf8');
    await evaluate(contractPage, contractSource);
    await evaluate(contractPage, contractSource, contractIsolated);
    report.observations.synchronousContractScope = {
      source: 'src/platform/session/shared/page-session.js', realms: ['MAIN', 'Page.createIsolatedWorld'],
      runtime: 'synthetic mutable id, not a second real extension reload', watch: false,
    };
    await evaluate(contractPage, `(()=>{
      globalThis.qaContractRealm='main'; globalThis.qaContractDisposals=0;
      globalThis.TidyPageSession=TidyPageSessionContract.create();
      const owned=document.createElement('button'); owned.dataset.tidyOwned='contract-main'; document.body.append(owned);
      TidyPageSession.onDispose(()=>{qaContractDisposals++;owned.remove()});
    })()`);
    await evaluate(contractPage, `(()=>{
      globalThis.qaContractRealm='isolated'; globalThis.qaContractDisposals=0;
      globalThis.qaSyntheticRuntime={id:'synthetic-page-session-runtime'};
      globalThis.TidyPageSession=TidyPageSessionContract.create({runtime:qaSyntheticRuntime,watch:false});
      const owned=document.createElement('button'); owned.dataset.tidyOwned='contract-isolated'; document.body.append(owned);
      TidyPageSession.onDispose(()=>{qaContractDisposals++;owned.remove()});
    })()`, contractIsolated);
    // Invalidate without calling check()/stop() or dispatching a lifecycle event.
    report.observations.synchronousIsolatedBefore = await evaluate(contractPage, `(()=>{
      qaSyntheticRuntime.id=null;
      return {realm:qaContractRealm,runtimeId:qaSyntheticRuntime.id,aborted:TidyPageSession.signal.aborted,
        disposals:qaContractDisposals,marker:document.documentElement.dataset.tidyPageSession};
    })()`, contractIsolated);
    report.observations.synchronousMainCheck = await evaluate(contractPage, `(()=>{
      const before=globalThis.TidyPageSession.signal.aborted;
      const ownedBefore=document.querySelectorAll('[data-tidy-owned]').length;
      const allowed=globalThis.TidyPageSession.check();
      return {realm:qaContractRealm,syntheticRuntimeVisible:Object.hasOwn(globalThis,'qaSyntheticRuntime'),
        before,ownedBefore,allowed,aborted:globalThis.TidyPageSession.signal.aborted,disposals:qaContractDisposals,
        marker:document.documentElement.dataset.tidyPageSession,
        owned:document.querySelectorAll('[data-tidy-owned]').length};
    })()`);
    // Read only: an ISOLATED check here would hide broken synchronous propagation.
    report.observations.synchronousIsolatedAfter = await evaluate(contractPage,
      `({realm:qaContractRealm,runtimeId:qaSyntheticRuntime.id,aborted:TidyPageSession.signal.aborted,disposals:qaContractDisposals})`, contractIsolated);
    const isolatedBefore = report.observations.synchronousIsolatedBefore;
    const synchronous = report.observations.synchronousMainCheck;
    const isolatedAfter = report.observations.synchronousIsolatedAfter;
    check(isolatedBefore.realm === 'isolated' && isolatedBefore.runtimeId === null && isolatedBefore.aborted === false
      && isolatedBefore.disposals === 0 && isolatedBefore.marker === 'active'
      && synchronous.realm === 'main' && synchronous.syntheticRuntimeVisible === false
      && synchronous.before === false && synchronous.ownedBefore === 2 && synchronous.allowed === false
      && synchronous.aborted === true && synchronous.marker === 'retired' && synchronous.owned === 0 && synchronous.disposals === 1
      && isolatedAfter.realm === 'isolated' && isolatedAfter.runtimeId === null && isolatedAfter.aborted === true && isolatedAfter.disposals === 1,
    'production contract synchronously retires both real browser realms and disposes owned nodes with synthetic runtime invalidation and no watchdog',
    { isolatedBefore, main: synchronous, isolatedAfter, scope: report.observations.synchronousContractScope });
    await call('Target.closeTarget', { targetId: contractTarget.targetId });
    check(!report.interceptionError, 'all synthetic page HTTP requests were fulfilled locally', report.interceptionError);
    report.ok = true;
  } catch (error) { report.error = error.stack || error.message; }
  finally {
    if (socket?.readyState === WebSocket.OPEN) {
      try { await call('Browser.close'); } catch {} socket.close();
    }
    if (child.exitCode === null) child.kill();
  }
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
