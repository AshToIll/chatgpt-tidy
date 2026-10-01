// 隔离浏览器、未改写生产扩展、纯本地合成页面；不读真实账号或用户 profile。
// Chrome 通过原生外观下拉框改主题，绝不 Emulation.setEmulatedMedia。
// 这是 API/生命周期回归，不冒充工具栏像素检查；Edge 无原生主题入口时明确降为 API smoke。
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const { browserArtifactRoot } = require('./browser-fixture.cjs');
const root = path.resolve(__dirname, '..'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PAGE_URL = 'https://chatgpt.com/c/synthetic-toolbar-theme';
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Offline toolbar regression</title></head><body>
<nav><a href="/c/synthetic-toolbar-theme">Synthetic conversation</a></nav><main>Local synthetic fixture. No account.</main>
<script>window.documentBootToken=crypto.randomUUID();</script></body></html>`;

async function main() {
  fs.mkdirSync(browserArtifactRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(browserArtifactRoot, 'toolbar-theme-browser-')), profile = path.join(directory, 'profile');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  // Chromium BrowserColorScheme: system=0, light=1, dark=2. Only our empty test profile is written.
  fs.writeFileSync(path.join(profile, 'Default/Preferences'), JSON.stringify({ browser: { theme: { color_scheme: 1, color_scheme2: 1 } } }));
  const executable = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const edge = /(?:msedge|microsoft.edge)/i.test(executable);
  const report = { ok: false, directory, checks: [], evidence: { mediaEmulation: false, realToolbarPixelsInspected: false }, intercepted: [] };
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let socket, sequence = 0, spawnError, extensionId, worker, page, tabId;
  const pending = new Map(), contexts = new Map();
  child.on('error', error => { spawnError = error; });
  child.stderr.on('data', bytes => { report.evidence.stderr = ((report.evidence.stderr || '') + bytes).slice(-16000); });
  child.on('exit', (code, signal) => { report.evidence.processExit = { code, signal }; });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, message => { clearTimeout(timer); report.evidence.lastCdpResponse = method;
      message.error ? reject(Error(`${method}: ${message.error.message}`)) : resolve(message.result); });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  async function waitFor(read, description, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw Error(`Browser exited before ${description}: ${child.exitCode}`);
      const value = await read(); if (value) return value; await sleep(100);
    }
    throw Error(`Timed out: ${description}`);
  }
  async function evaluate(sessionId, expression, options = {}) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...options }, sessionId);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  function check(condition, name, detail) {
    report.checks.push({ name, passed: !!condition, detail }); if (!condition) throw Error(name);
  }
  async function attach(targetId, intercept = false) {
    const sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await call('Runtime.enable', {}, sessionId);
    if (intercept) {
      await call('Page.enable', {}, sessionId);
      await call('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] }, sessionId);
    }
    return sessionId;
  }
  async function findTarget(suffix) {
    const targets = (await call('Target.getTargets')).targetInfos;
    report.evidence.lastTargets = targets.map(({ type, url, targetId }) => ({ type, url, targetId }));
    return targets.find(target => target.url === `chrome-extension://${extensionId}/${suffix}`);
  }
  async function attachWorker() {
    const target = await waitFor(() => findTarget('app/background/service-worker.js'), 'production worker');
    worker = { targetId: target.targetId, sessionId: await attach(target.targetId) };
    // Target discovery is not a readiness receipt for the worker execution context.
    await waitFor(() => evaluate(worker.sessionId, `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}`), 'production worker execution context');
    // Observe successful calls to the REAL API; never fabricate media, icons, sender identity or API replies.
    await evaluate(worker.sessionId, `(() => {
      if(globalThis.tidyThemeEvidence)return;
      globalThis.tidyThemeEvidence=[];globalThis.tidyThemeErrors=[];globalThis.tidyThemeMessages=[];
      const setIcon=chrome.action.setIcon.bind(chrome.action);
      chrome.action.setIcon=async options=>{try{await setIcon(options);tidyThemeEvidence.push(structuredClone(options));}
        catch(error){tidyThemeErrors.push(String(error));throw error;}};
      chrome.runtime.onMessage.addListener((message,sender)=>{
        if(message?.channel==='tidy.toolbar-theme.v1')tidyThemeMessages.push({message,sender:{url:sender.url,
          documentId:sender.documentId,documentLifecycle:sender.documentLifecycle,frameId:sender.frameId,tabId:sender.tab?.id}});
      });
    })()`);
  }
  const extensionContexts = type => evaluate(worker.sessionId, `chrome.runtime.getContexts(${JSON.stringify(type ? { contextTypes: [type] } : {})})`);
  const iconCalls = () => evaluate(worker.sessionId, 'tidyThemeEvidence');
  async function waitIcon(dark, label, afterCount = 0) {
    const file = dark ? 'tidy-white-16.png' : 'tidy-outlined-16.png';
    const icon = await waitFor(async () => {
      const last = (await iconCalls()).slice(afterCount).filter(item => item.tabId === tabId).at(-1);
      return last?.path?.[16]?.endsWith(`/assets/icons/${file}`) ? last : null;
    }, label);
    check(icon.tabId === tabId, label, icon);
  }
  const isolatedContext = () => [...(contexts.get(page)?.values() || [])].find(context =>
    context.origin === `chrome-extension://${extensionId}` || context.name === extensionId);
  const waitActive = () => waitFor(() => evaluate(page,
    `document.readyState==='complete'&&document.documentElement.dataset.tidyPageSession==='active'`), 'production document_start session');
  const dropdownFinder = `function find(root){const select=root.querySelector('#colorSchemeModeSelect');if(select)return select;
    for(const el of root.querySelectorAll('*'))if(el.shadowRoot){const found=find(el.shadowRoot);if(found)return found;}return null;}`;
  let settings, pageTarget, nativeTheme = false;
  async function changeNativeTheme(dark) {
    if (!nativeTheme) throw Error('Native theme operation requested in API-only mode');
    const value = dark ? '2' : '1';
    const selection = await evaluate(settings, `(() => {${dropdownFinder};const select=find(document);
      if(!select)throw Error('Native appearance selector disappeared');select.value='${value}';
      select.dispatchEvent(new Event('change',{bubbles:true}));return {value:select.value,text:select.selectedOptions[0]?.textContent.trim()};})()`);
    await waitFor(() => evaluate(page, `matchMedia('(prefers-color-scheme: dark)').matches===${dark}`), 'native appearance reaches page');
    report.evidence.nativeSelections.push(selection);
  }
  try {
    const port = await waitFor(() => { try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {} }, 'debugging port', 30000);
    const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); report.browser = browser.Browser;
    socket = new WebSocket(browser.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), receive = pending.get(message.id);
      if (receive) { pending.delete(message.id); receive(message); return; }
      if (message.method === 'Runtime.executionContextCreated') {
        const list = contexts.get(message.sessionId) || new Map(); list.set(message.params.context.id, message.params.context); contexts.set(message.sessionId, list);
      }
      if (message.method === 'Runtime.executionContextDestroyed') contexts.get(message.sessionId)?.delete(message.params.executionContextId);
      if (message.method === 'Runtime.executionContextsCleared') contexts.get(message.sessionId)?.clear();
      if (message.method === 'Fetch.requestPaused') {
        const { requestId, request, resourceType } = message.params; report.intercepted.push({ url: request.url, resourceType });
        const document = resourceType === 'Document' && request.url.startsWith('https://chatgpt.com/');
        void call('Fetch.fulfillRequest', { requestId, responseCode: document ? 200 : 404,
          responseHeaders: [{ name: 'Content-Type', value: document ? 'text/html; charset=utf-8' : 'application/json' }],
          body: Buffer.from(document ? PAGE_HTML : '{}').toString('base64') }, message.sessionId)
          .catch(error => { report.interceptionError = error.message; });
      }
    });
    // Real runtime.reload() rechecks developer mode. Use Chromium's own local settings only in this empty profile.
    const setupTarget = await call('Target.createTarget', { url: edge ? 'edge://extensions/' : 'chrome://extensions/' });
    const setup = await attach(setupTarget.targetId);
    await waitFor(() => evaluate(setup, `typeof chrome.developerPrivate?.updateProfileConfiguration==='function'`), 'isolated extension settings');
    const developerMode = await evaluate(setup, `new Promise(resolve=>chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true},()=>{
      if(chrome.runtime.lastError)return resolve({error:chrome.runtime.lastError.message});
      chrome.developerPrivate.getProfileConfiguration(value=>resolve({enabled:value.inDeveloperMode}));}))`);
    check(developerMode.enabled, 'fresh profile permits real unpacked-extension reload', developerMode);
    await call('Target.closeTarget', { targetId: setupTarget.targetId });
    ({ id: extensionId } = await call('Extensions.loadUnpacked', { path: path.join(root, 'src') }));
    report.evidence.extensionId = extensionId; await attachWorker();
    const manifest = await evaluate(worker.sessionId, 'chrome.runtime.getManifest()');
    check(Object.values(manifest.action.default_icon).every(file => /tidy-outlined-\d+\.png$/.test(file)), 'manifest fallback is readable without a theme observer');
    await sleep(200);
    check((await extensionContexts('OFFSCREEN_DOCUMENT')).length === 0, 'startup does not create an offscreen theme watcher');
    const settingsTarget = await call('Target.createTarget', { url: edge ? 'edge://settings/appearance' : 'chrome://settings/appearance' });
    settings = await attach(settingsTarget.targetId);
    try {
      const selection = await waitFor(() => evaluate(settings, `(() => {${dropdownFinder};const s=find(document);return s&&{value:s.value,text:s.selectedOptions[0]?.textContent.trim()};})()`), 'native appearance selector', edge ? 1500 : 10000);
      nativeTheme = true; report.evidence.nativeSelections = [selection]; report.evidence.themeVerification = 'native appearance selector';
    } catch (error) {
      if (!edge) throw error;
      report.evidence.themeVerification = 'API smoke only; Edge native appearance selector unavailable'; report.evidence.nativeThemeLimitation = error.message;
    }
    pageTarget = await call('Target.createTarget', { url: 'about:blank' }); page = await attach(pageTarget.targetId, true);
    await call('Page.navigate', { url: PAGE_URL }, page); await waitActive();
    await call('Target.activateTarget', { targetId: pageTarget.targetId });
    tabId = await evaluate(worker.sessionId, `chrome.tabs.query({url:${JSON.stringify(PAGE_URL)}}).then(tabs=>tabs[0].id)`);
    check(Number.isInteger(tabId), 'offline ChatGPT fixture has a real browser tab identity', tabId);
    check((await extensionContexts('SIDE_PANEL')).length === 0, 'content updates are tested before any side panel opens');
    await waitIcon(await evaluate(page, `matchMedia('(prefers-color-scheme: dark)').matches`), 'document_start reporter sets a tab-scoped icon without opening the panel');
    if (nativeTheme) {
      for (const dark of [true, false, true]) { await changeNativeTheme(dark); await waitIcon(dark, `content reporter follows native ${dark ? 'dark' : 'light'} mode`); }
      for (const css of ['light', 'dark']) {
        const before = (await iconCalls()).length;
        await evaluate(page, `document.documentElement.className='${css}';document.documentElement.style.colorScheme='${css}';document.body.style.background='${css === 'dark' ? 'black' : 'white'}';`);
        await sleep(150);
        check(await evaluate(page, `matchMedia('(prefers-color-scheme: dark)').matches`) === true && (await iconCalls()).length === before,
          `page CSS ${css} does not recolor the browser toolbar`);
      }
    }
    // A genuine SIDE_PANEL, never an ordinary tab pretending to be a panel.
    await waitFor(async () => (await evaluate(worker.sessionId, `chrome.sidePanel.getOptions({tabId:${tabId}})`)).enabled, 'production panel configured');
    // CDP userGesture on a worker has no renderer user activation. Use a short-lived
    // ordinary extension page only to invoke the real browser API, then close it.
    // This helper is NOT the tested panel; getContexts below must return SIDE_PANEL.
    const openerTarget = await call('Target.createTarget', { url: `chrome-extension://${extensionId}/features/export/engine/offscreen.html` });
    const opener = await attach(openerTarget.targetId);
    await waitFor(() => evaluate(opener, `typeof chrome.sidePanel?.open==='function'`), 'extension renderer sidePanel API');
    await call('Target.activateTarget', { targetId: pageTarget.targetId });
    await evaluate(opener, `chrome.sidePanel.open({tabId:${tabId}})`, { userGesture: true });
    await call('Target.closeTarget', { targetId: openerTarget.targetId });
    const panelContext = await waitFor(async () => (await extensionContexts('SIDE_PANEL')).find(context => context.documentUrl && context.documentId), 'real SIDE_PANEL document');
    check(panelContext.contextType === 'SIDE_PANEL' && panelContext.documentUrl.startsWith(`chrome-extension://${extensionId}/app/sidepanel/index.html`), 'browser confirms a genuine production side panel', panelContext);
    // Chrome's true SIDE_PANEL runtime sender has URL/id but no documentId/frameId.
    // getContexts proves the actual context separately. Content sender checks remain stricter.
    const actualPanelTarget=await waitFor(async()=> (await call('Target.getTargets')).targetInfos.find(target=>target.url===panelContext.documentUrl),'actual panel target');
    const actualPanel=await attach(actualPanelTarget.targetId);
    await waitFor(()=>evaluate(actualPanel,`document.readyState==='complete'&&typeof TidyToolbarTheme==='object'`),'side panel reporter module loaded');
    report.evidence.panelWindow={contextWindowId:panelContext.windowId,
      rendererWindow:await evaluate(actualPanel,`chrome.windows.getCurrent().then(({id,type})=>({id,type}))`),
      ownerWindowId:await evaluate(worker.sessionId,`chrome.tabs.get(${tabId}).then(tab=>tab.windowId)`)};
    check(report.evidence.panelWindow.rendererWindow.id===report.evidence.panelWindow.ownerWindowId,
      'actual panel renderer belongs to its owner browser window',report.evidence.panelWindow);
    async function checkPanelAck(){
      const response=await evaluate(actualPanel,`chrome.runtime.sendMessage({channel:'tidy.toolbar-theme.v1',target:'service',type:'changed',dark:matchMedia('(prefers-color-scheme: dark)').matches})`);
      check(response?.ok===true,'real SIDE_PANEL sender passes production acceptance',response);
    }
    await checkPanelAck();
    if (nativeTheme) for (const dark of [false, true]) { await changeNativeTheme(dark); await checkPanelAck(); await waitIcon(dark, `real panel stays owner-scoped during native ${dark ? 'dark' : 'light'} mode`); }
    const panelMessages = await evaluate(worker.sessionId, `tidyThemeMessages.filter(item=>item.sender.url===${JSON.stringify(panelContext.documentUrl)})`);
    check(panelMessages.length > 0, 'real panel sends theme messages with browser-supplied sender metadata', panelMessages);
    if (await evaluate(worker.sessionId, `typeof chrome.sidePanel.close==='function'`)) await evaluate(worker.sessionId, `chrome.sidePanel.close({tabId:${tabId}})`);
    else {
      const panelTarget = (await call('Target.getTargets')).targetInfos.find(target => target.url === panelContext.documentUrl);
      if (!panelTarget) throw Error('Actual panel target missing'); await call('Target.closeTarget', { targetId: panelTarget.targetId });
    }
    await waitFor(async () => (await extensionContexts('SIDE_PANEL')).length === 0, 'side panel really closed');
    await call('Target.activateTarget', { targetId: pageTarget.targetId });
    if (nativeTheme) for (const dark of [false, true]) { await changeNativeTheme(dark); await waitIcon(dark, 'content keeps adapting after panel closes'); }
    check((await extensionContexts('OFFSCREEN_DOCUMENT')).length === 0, 'theme tracking never creates an offscreen document');
    // Actual MV3 stop/wake, not extension reload: document session must remain valid.
    await evaluate(worker.sessionId, `globalThis.qaWorkerIncarnation=crypto.randomUUID()`); const oldTarget = worker.targetId;
    await call('ServiceWorker.enable', {}, page); await call('ServiceWorker.stopAllWorkers', {}, page);
    await waitFor(async () => !(await call('Target.getTargets')).targetInfos.some(target => target.targetId === oldTarget), 'worker stopped');
    await sleep(1100); const isolated = await waitFor(isolatedContext, 'production isolated context');
    check(await evaluate(page, `TidyPageSession.check()`, { contextId: isolated.id }), 'worker sleep does not retire the page');
    const wake = await evaluate(page, `chrome.runtime.sendMessage(TidyProtocol.request(TidyProtocol.Type.PREFERENCES_GET))`, { contextId: isolated.id });
    check(wake?.ok, 'real content request wakes worker'); await attachWorker();
    check(await evaluate(worker.sessionId, `!Object.hasOwn(globalThis,'qaWorkerIncarnation')`), 'worker execution instance restarted');
    // The startup reset may finish across spy installation, leaving a correctly
    // deduplicated icon with no recorded call. Establish a NEW observed baseline
    // through real tab activation/reset/resync, rather than weaken the assertion.
    const restartBaseline=(await iconCalls()).length;
    await call('Target.activateTarget',{targetId:settingsTarget.targetId});
    await call('Target.activateTarget',{targetId:pageTarget.targetId});
    await waitIcon(await evaluate(page,`matchMedia('(prefers-color-scheme: dark)').matches`),
      'new worker observer captures a fresh activation and theme baseline',restartBaseline);
    if (nativeTheme) for (const dark of [false, true]) { await changeNativeTheme(dark); await waitIcon(dark, 'native adaptation survives worker restart'); }
    const beforeLeaving=(await iconCalls()).length;
    await call('Page.navigate', { url: 'data:text/html,<title>Outside ChatGPT</title><p>Offline outside page</p>' }, page);
    await waitFor(() => evaluate(page, `location.protocol==='data:'&&document.readyState==='complete'`), 'leaving ChatGPT');
    await waitIcon(false, 'leaving ChatGPT restores outlined fallback for the same tab',beforeLeaving);
    await call('Page.navigate', { url: PAGE_URL }, page); await waitActive();
    if (nativeTheme) { await changeNativeTheme(false); await waitIcon(false, 'new ChatGPT document reports its own current theme'); }
    const beforeReload = await evaluate(page, 'documentBootToken');
    await evaluate(worker.sessionId, `setTimeout(()=>chrome.runtime.reload(),50);'reload-scheduled'`);
    await waitFor(() => evaluate(page, `document.documentElement.dataset.tidyPageSession==='retired'`), 'old document retired after extension reload', 10000);
    await call('ServiceWorker.startWorker', { scopeURL: `chrome-extension://${extensionId}/` }, page); await attachWorker();
    await sleep(200); const beforeRetiredChanges = (await iconCalls()).length;
    if (nativeTheme) for (const dark of [true, false]) await changeNativeTheme(dark);
    await sleep(300);
    check(await evaluate(page, `documentBootToken===${JSON.stringify(beforeReload)}&&document.documentElement.dataset.tidyPageSession==='retired'`), 'extension reload neither refreshes nor hot-injects the old page');
    check((await iconCalls()).length === beforeRetiredChanges, nativeTheme
      ? 'retired content cannot update icons on appearance changes'
      : 'retired content stays quiet during the API smoke observation interval');
    await call('Page.reload', { ignoreCache: true }, page); await waitActive();
    check(await evaluate(page, `documentBootToken!==${JSON.stringify(beforeReload)}`), 'F5 creates a fresh live document');
    if (nativeTheme) for (const dark of [true, false]) { await changeNativeTheme(dark); await waitIcon(dark, 'F5 restores native theme adaptation'); }
    else await waitIcon(await evaluate(page, `matchMedia('(prefers-color-scheme: dark)').matches`), 'fresh document works in API smoke mode');
    // Export is lazy and single-host. Direct host calls avoid manufacturing a ChatGPT account.
    check((await extensionContexts('OFFSCREEN_DOCUMENT')).length === 0, 'no export host exists before actual export demand');
    // Service workers forbid dynamic import(). Import the unchanged production host
    // module in a temporary extension renderer; its concurrent ensure calls use real APIs.
    const exportSetupTarget=await call('Target.createTarget',{url:`chrome-extension://${extensionId}/features/export/engine/offscreen.html`});
    const exportSetup=await attach(exportSetupTarget.targetId);
    await waitFor(()=>evaluate(exportSetup,`typeof chrome.offscreen?.createDocument==='function'`),'extension export setup API');
    await evaluate(exportSetup, `(async()=>{const module=await import(chrome.runtime.getURL('features/export/background/offscreen-host.js'));
      await Promise.all([module.getOffscreenHost(chrome).ensure(),module.getOffscreenHost(chrome).ensure()]);})()`);
    await call('Target.closeTarget',{targetId:exportSetupTarget.targetId});
    await call('Target.activateTarget',{targetId:pageTarget.targetId});
    const exportContexts = await waitFor(async () => {const found=await extensionContexts('OFFSCREEN_DOCUMENT');return found.length&&found.every(context=>context.documentUrl)?found:null;}, 'lazy export host');
    check(exportContexts.length === 1 && exportContexts[0].documentUrl.endsWith('/features/export/engine/offscreen.html'), 'concurrent export demand creates one shared host', exportContexts);
    const hostTarget = await waitFor(() => findTarget('features/export/engine/offscreen.html'), 'export target'), host = await attach(hostTarget.targetId);
    check(await evaluate(host, `!Array.from(document.scripts).some(script=>/toolbar-theme/.test(script.src))`), 'export host no longer loads misleading media watcher');
    await evaluate(host, `(()=>{const revoke=URL.revokeObjectURL.bind(URL);globalThis.tidyRevokedBlobs=[];URL.revokeObjectURL=url=>{revoke(url);tidyRevokedBlobs.push(url)}})()`);
    const message = (type, extra={}) => evaluate(worker.sessionId, `chrome.runtime.sendMessage(${JSON.stringify({channel:'tidy.export-host.v1',target:'host',type,id:'synthetic-toolbar-check',...extra})})`);
    const run = await message('run', {spec:{plan:{format:'txt',outputName:'synthetic.txt',messages:{},files:[{kind:'conversation',path:'synthetic.txt',conversations:[{
      conversation:{id:'synthetic',title:'Local test'},messages:[{role:'user',text:'Synthetic toolbar lifecycle test',segments:[{type:'text',text:'Synthetic toolbar lifecycle test'}]}],resources:[],
    }]}]},context:{},warnings:[]}});
    check(run.ok && run.job?.state==='generating', 'real export worker starts in lazy host', run);
    const ready = await waitFor(async()=>{const reply=await message('inspect');if(reply.job?.state==='failed')throw Error(`Synthetic export failed: ${reply.job.errorCode}`);return reply.job?.state==='ready'?reply.job:null;}, 'real export Blob');
    check(ready.blobUrl?.startsWith(`blob:chrome-extension://${extensionId}/`), 'real export creates local Blob', ready);
    const stopped=await message('stop'), inspected=await message('inspect');
    check(stopped.ok && inspected.job===null && (await evaluate(host,'tidyRevokedBlobs')).includes(ready.blobUrl), 'export stop clears state and revokes Blob');
    report.evidence.exportHostAfterStop=await extensionContexts('OFFSCREEN_DOCUMENT');
    // A retained empty export host is allowed. Explicitly close this test host, rather than call it a theme watcher.
    await evaluate(worker.sessionId, 'chrome.offscreen.closeDocument()');
    check((await extensionContexts('OFFSCREEN_DOCUMENT')).length===0, 'export host closes cleanly without affecting toolbar observers');
    if(nativeTheme){await changeNativeTheme(true);await waitIcon(true,'adaptation survives export-host creation and closure');}
    const icons=await iconCalls();
    check(icons.every(icon=>Number.isInteger(icon.tabId)||Object.values(icon.path||{}).every(file=>/tidy-outlined-\d+\.png$/.test(file))), 'nonfallback icons are tab-scoped, never global', icons);
    check((await evaluate(worker.sessionId,'tidyThemeErrors')).length===0,'real action.setIcon calls have no API errors');
    check(!report.interceptionError,'all synthetic-page HTTP requests were fulfilled locally',report.interceptionError);
    report.evidence.finalIcons=icons;report.ok=true;
  } catch(error) {
    report.error=error.stack||error.message;
    try {
      report.evidence.themeMessagesAtFailure=await evaluate(worker.sessionId,'tidyThemeMessages');
      report.evidence.contextsAtFailure=await extensionContexts();
      const targets=(await call('Target.getTargets')).targetInfos;
      const panel=targets.find(target=>target.url.startsWith(`chrome-extension://${extensionId}/app/sidepanel/index.html`));
      if(panel){const session=await attach(panel.targetId);report.evidence.panelAtFailure=await evaluate(session,`({url:location.href,ready:document.readyState,reporter:typeof TidyToolbarTheme,visibility:document.visibilityState,dark:matchMedia('(prefers-color-scheme: dark)').matches})`);}
    } catch(diagnosticError) { report.evidence.failureDiagnosticError=diagnosticError.message; }
  }
  finally {
    if(socket?.readyState===WebSocket.OPEN){try{await call('Browser.close');}catch{}socket.close();}
    await sleep(200);if(child.exitCode===null)child.kill();
  }
  fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
