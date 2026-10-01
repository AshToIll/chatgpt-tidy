// Real-time geometry regression in a NEW, isolated Chromium profile. This
// runner never attaches to the user's browser and never reads account data.
// Unlike --dump-dom/virtual time, CDP real time preserves native smooth-scroll
// animation, so a dispatched scroll cannot masquerade as a stable landing.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { browserArtifactRoot } = require('./browser-fixture.cjs');
const root = path.resolve(__dirname, '..');
const executable = process.argv[2] || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(fs.existsSync);
if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) {
  throw new Error('Pass an existing absolute Chrome or Edge executable path.');
}
if (typeof WebSocket !== 'function') throw new Error('Node with native WebSocket support is required (Node 22 or newer).');
fs.mkdirSync(browserArtifactRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(browserArtifactRoot, 'bookmark-landing-browser-'));
const profile = path.join(output, 'profile');
const fixtureUrl = pathToFileURL(path.join(root, 'tests/browser/bookmark-landing.html')).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        message.error ? waiting.reject(new Error(`${waiting.method}: ${message.error.message}`)) : waiting.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
    socket.addEventListener('close', () => {
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('Isolated browser CDP closed.')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Isolated CDP connection timed out.')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Isolated CDP connection failed.')); }, { once: true });
    });
    return new Cdp(socket);
  }
  call(method, params = {}, sessionId, timeoutMs = 5000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.socket.close(); }
}

(async () => {
  let browser, cdp, exitPromise, exitResult, browserExited = false, stderr = '', sessionId, report;
  const remoteRequests = [], pageErrors = [], inputErrors = [], localRequests = [];
  try {
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
      '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
      '--allow-file-access-from-files', '--window-size=1100,950', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-30000); });
    let spawnError;
    browser.on('error', error => { spawnError = error; });
    exitPromise = new Promise(resolve => browser.once('exit', (code, signal) => {
      browserExited = true; exitResult = { code, signal }; resolve(exitResult);
    }));
    const portFile = path.join(profile, 'DevToolsActivePort'), startupDeadline = Date.now() + 12000;
    while (!fs.existsSync(portFile)) {
      if (spawnError) throw spawnError;
      if (browserExited || Date.now() >= startupDeadline) throw new Error(`Isolated browser did not start. ${stderr.slice(-1000)}`);
      await sleep(50);
    }
    const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || !endpoint.startsWith('/devtools/browser/')) throw new Error('Unexpected isolated CDP endpoint.');
    cdp = await Cdp.connect(`ws://127.0.0.1:${port}${endpoint}`);
    const version = await cdp.call('Browser.getVersion');
    const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true }));
    cdp.listeners.add(message => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Network.requestWillBeSent') {
        const url = message.params.request.url;
        (/^(https?|wss?):/i.test(url) ? remoteRequests : localRequests).push(url);
      }
      if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails);
      if (message.method === 'Runtime.bindingCalled' && message.params.name === 'bookmarkLandingInput') {
        void (async () => {
          let request;
          try {
            request = JSON.parse(message.params.payload);
            if (typeof request.id !== 'string' || ![request.x, request.y, request.deltaY].every(Number.isFinite)) throw new Error('Invalid synthetic input request.');
            await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: request.x, y: request.y,
              deltaX: 0, deltaY: request.deltaY, pointerType: 'mouse' }, sessionId);
            await cdp.call('Runtime.evaluate', { expression: `globalThis.completeBookmarkLandingInput(${JSON.stringify(request.id)})` }, sessionId);
          } catch (error) {
            inputErrors.push(error.stack || String(error));
            if (request?.id) await cdp.call('Runtime.evaluate', { expression: `globalThis.completeBookmarkLandingInput(${JSON.stringify(request.id)}, ${JSON.stringify(String(error))})` }, sessionId).catch(() => {});
          }
        })();
      }
    });
    await cdp.call('Page.enable', {}, sessionId);
    await cdp.call('Runtime.enable', {}, sessionId);
    await cdp.call('Network.enable', {}, sessionId);
    await cdp.call('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] }, sessionId);
    await cdp.call('Runtime.addBinding', { name: 'bookmarkLandingInput' }, sessionId);
    await cdp.call('Page.navigate', { url: fixtureUrl }, sessionId);
    const readyDeadline = Date.now() + 10000;
    while (true) {
      const ready = await cdp.call('Runtime.evaluate', { expression: 'globalThis.bookmarkLandingReady === true', returnByValue: true }, sessionId);
      if (ready.result?.value === true) break;
      if (Date.now() >= readyDeadline) throw new Error(`Local fixture did not load: ${JSON.stringify(pageErrors)}`);
      await sleep(50);
    }
    const evaluation = await cdp.call('Runtime.evaluate', { expression: 'globalThis.runBookmarkLandingChecks()',
      awaitPromise: true, returnByValue: true }, sessionId, 45000);
    if (evaluation.exceptionDetails) throw new Error(`Fixture rejected: ${JSON.stringify(evaluation.exceptionDetails)}`);
    report = evaluation.result?.value;
    if (!report || !Array.isArray(report.tests)) throw new Error('Fixture returned no structured report.');
    report.runner = { browser: version.product, executable, syntheticProfile: profile, realTime: true,
      remoteRequestCount: remoteRequests.length, remoteRequests, localRequestCount: localRequests.length,
      pageErrors, inputErrors, noRealAccountOrUserBrowser: true };
    report.ok = report.ok && remoteRequests.length === 0 && pageErrors.length === 0 && inputErrors.length === 0;
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    fs.writeFileSync(path.join(output, 'final.png'), Buffer.from(screenshot.data, 'base64'));
  } catch (error) {
    report = { ok: false, runnerError: error.stack || String(error), remoteRequests, pageErrors, inputErrors };
  } finally {
    // Close exactly the process/profile started above; never enumerate, attach
    // to, or terminate any pre-existing Chrome/Edge process or user profile.
    if (cdp) await cdp.call('Browser.close', {}, undefined, 2000).catch(() => {});
    if (browser?.pid && !browserExited) await Promise.race([exitPromise, sleep(3000)]);
    if (browser?.pid && !browserExited) {
      try { browser.kill(); } catch (error) { report.cleanupError = String(error); }
      await Promise.race([exitPromise, sleep(3000)]);
    }
    cdp?.close();
    report.runner = { ...report.runner, spawnedProcessClosed: browserExited,
      browserExit: exitResult || null, artifacts: output };
    if (browser?.pid && !browserExited) { report.ok = false; report.cleanupError ||= 'The isolated browser process did not exit within the cleanup deadline.'; }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(browserArtifactRoot, 'bookmark-landing-browser.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(output, 'browser-stderr.log'), stderr);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    console.error(`Isolated fixture artifacts: ${output}`);
  }
})();
