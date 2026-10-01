// 隔离扩展 + 合成内容：真实 offscreen/Worker/downloads；不读取用户配置或真实会话。
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const { browserArtifactRoot } = require('./browser-fixture.cjs');
const root = path.resolve(__dirname, '..'), sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  fs.mkdirSync(browserArtifactRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(browserArtifactRoot, 'export-job-browser-'));
  const extension = path.join(dir, 'extension'), profile = path.join(dir, 'profile'), downloads = path.join(dir, 'downloads');
  fs.cpSync(path.join(root, 'src'), extension, { recursive: true }); fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'TIDY isolated export test', version: '1.0',
    default_locale: 'en', permissions: ['storage', 'offscreen', 'downloads'], background: { service_worker: 'app/background/service-worker.js', type: 'module' } }));
  fs.copyFileSync(path.join(root, 'tests/browser/export-jobs-worker.mjs'), path.join(extension, 'app/background/service-worker.js'));
  // fixture 进入隔离扩展根目录后只改资源相对路径，不改生产文件。
  for (const name of ['export-jobs.html', 'export-jobs.mjs']) fs.writeFileSync(path.join(extension, name),
    fs.readFileSync(path.join(root, 'tests/browser', name), 'utf8').replaceAll('../../src/', './'));
  const child = spawn(process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
    '--enable-unsafe-extension-debugging', '--window-size=420,1100', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket, id = 0, spawnError, report = { ok: false, checks: [] }; const pending = new Map(), versions = new Map();
  child.on('error', e => { spawnError = e; });
  async function waitFor(read, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (spawnError) throw spawnError; const result = await read(); if (result) return result; await sleep(100); }
    throw Error('Export task browser check timed out');
  }
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(requestId, m => { clearTimeout(timer); m.error ? reject(Error(method + ': ' + m.error.message)) : resolve(m.result); });
    socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
  let session, target;
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const check = (condition, name, detail) => { if (!condition) throw Error(name + ': ' + JSON.stringify(detail)); report.checks.push(name); };
  try {
    const port = await waitFor(() => { try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {} }, 30000);
    const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    socket = new WebSocket(browser.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', e => {
      const m = JSON.parse(e.data), receive = pending.get(m.id);
      if (receive) { pending.delete(m.id); receive(m); }
      if (m.method === 'ServiceWorker.workerVersionUpdated') for (const v of m.params.versions) versions.set(v.versionId, v);
    });
    await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    const { id: extensionId } = await call('Extensions.loadUnpacked', { path: extension });
    const openPage = async () => {
      target = (await call('Target.createTarget', { url: `chrome-extension://${extensionId}/export-jobs.html` })).targetId;
      session = (await call('Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
      await waitFor(() => evaluate('Boolean(window.ready)'));
    };
    await openPage();
    let job = await evaluate('startJob("background-pdf")');
    check(job.state === 'generating', 'offscreen worker admitted', job);
    job = await evaluate('startJob("repeat-click", "txt")');
    check(job.id === 'background-pdf', 'repeated click does not enqueue', job);
    await call('Target.closeTarget', { targetId: target }); await sleep(1500); await openPage();
    job = await waitFor(async () => { const j = await evaluate('requestJob("status")'); return j && !TIDY_ACTIVE.includes(j.state) ? j : null; });
    check(job.state === 'completed', 'closed and reopened panel restores actual saved receipt', job);
    check(fs.readdirSync(downloads).length === 1 && fs.readFileSync(path.join(downloads, fs.readdirSync(downloads)[0])).subarray(0, 5).toString() === '%PDF-', 'one real PDF saved');
    const { PDFDocument, PDFName } = require('../src/vendor/pdf-lib-1.17.1.min.js');
    const pdf = await PDFDocument.load(fs.readFileSync(path.join(downloads, fs.readdirSync(downloads)[0])));
    const imageObjects = pdf.context.enumerateIndirectObjects().filter(([, obj]) => obj.dict?.get(PDFName.of('Subtype'))?.toString() === '/Image');
    check(!job.warnings.length && imageObjects.length >= 4, 'PNG JPEG WebP GIF embedded as PDF image streams', { warnings: job.warnings, images: imageObjects.length });
    await evaluate('view.refreshJob()');
    const capture = await call('Page.captureScreenshot', { format: 'png' }, session);
    fs.writeFileSync(path.join(dir, 'task-preview.png'), Buffer.from(capture.data, 'base64'));
    await waitFor(() => evaluate('!document.querySelector("[data-export-job]")'));
    check(Boolean((await evaluate('requestJob("status")')).dismissedAt), 'saved notice expires and persists its dismissal');
    await call('Target.closeTarget', { targetId: target }); await openPage();
    await evaluate('view.refreshJob()');
    check(await evaluate('!document.querySelector("[data-export-job]")'), 'reopened panel does not resurrect an expired result');
    await evaluate('startJob("cancel-pdf")');
    job = await evaluate('requestJob("cancel", { id: "cancel-pdf" })');
    check(job.state === 'cancelled', 'cancel terminates generating worker', job);
    await sleep(500); check(fs.readdirSync(downloads).length === 1, 'cancelled job cannot download later');
    await evaluate('startJob("next-txt", "txt")');
    job = await waitFor(async () => { const j = await evaluate('requestJob("status")'); return j && !TIDY_ACTIVE.includes(j.state) ? j : null; });
    check(job.state === 'completed' && fs.readdirSync(downloads).length === 2, 'new export allowed after cancellation', job);
    await evaluate('view.refreshJob()');
    await evaluate('document.querySelector("[data-export-job-dismiss]").click()');
    await waitFor(async () => (await evaluate('requestJob("status")')).dismissedAt);
    check(await evaluate('!document.querySelector("[data-export-job]")'), 'manual result close hides only the notice');
    check(fs.readdirSync(downloads).length === 2, 'dismissing the result neither deletes nor duplicates saved files');
    await call('ServiceWorker.enable', {}, session);
    const version = await waitFor(() => [...versions.values()].find(v => v.scriptURL === `chrome-extension://${extensionId}/app/background/service-worker.js` && v.runningStatus === 'running'));
    await evaluate('startJob("restart-pdf")');
    await call('ServiceWorker.stopWorker', { versionId: version.versionId }, session);
    job = await waitFor(async () => { const j = await evaluate('requestJob("status")'); return j && !TIDY_ACTIVE.includes(j.state) ? j : null; });
    check(job.state === 'completed' && fs.readdirSync(downloads).length === 3, 'actual service worker restart resumes host without duplicate file', job);
    await evaluate('startJob("batch-text", "zip")');
    job = await waitFor(async () => { const j = await evaluate('requestJob("status")'); return j && !TIDY_ACTIVE.includes(j.state) ? j : null; });
    const zipFile = fs.readdirSync(downloads).find(name => name.endsWith('.zip'));
    check(job.state === 'completed' && Boolean(zipFile), 'worker generated batch TXT ZIP', job);
    const zip = await require('../src/vendor/jszip-3.10.1.min.js').loadAsync(fs.readFileSync(path.join(downloads, zipFile)));
    check(Object.values(zip.files).filter(f => !f.dir).length === 2, 'ZIP contains two complete text files');
    await evaluate(`(() => {
      document.querySelector('[data-export-format="txt"]').click();
      const field = document.querySelector('[data-export-filename="current"]');
      field.value = 'retry-kept'; field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await evaluate('requestJob("inject-lost-handoff")');
    await evaluate('view.refreshJob()');
    const failure = await evaluate(`(() => {
      const action = document.querySelector('[data-export-action]');
      const card = document.querySelector('[data-export-job]');
      return { text: card?.textContent, busy: view.hasActiveJob(), disabled: action?.disabled, action: action?.textContent,
        filename: document.querySelector('[data-export-filename="current"]')?.value,
        extraActions: Boolean(card?.querySelector('[data-export-downloads], [data-export-job-cancel]')) };
    })()`);
    check(failure.text?.includes('导出失败，请重新导出') && !failure.text.includes('正在取消')
      && !failure.busy && failure.disabled === false && failure.action === '导出 TXT'
      && failure.filename === 'retry-kept' && !failure.extraActions, 'orphan handoff shows failure and restores the unchanged export form', failure);
    const failureCapture = await call('Page.captureScreenshot', { format: 'png' }, session);
    fs.writeFileSync(path.join(dir, 'failure-recovery.png'), Buffer.from(failureCapture.data, 'base64'));
    const beforeRetry = fs.readdirSync(downloads).length;
    await evaluate('document.querySelector("[data-export-action]").click()');
    job = await waitFor(async () => { const j = await evaluate('requestJob("status")'); return j && j.id !== 'lost-handoff' && !TIDY_ACTIVE.includes(j.state) ? j : null; });
    const retrySpec = await evaluate('lastExportStart');
    // 另存为可改变最终磁盘文件名：原设置看实际提交，落盘结果按浏览器回执核对。
    check(job.state === 'completed' && fs.readdirSync(downloads).length === beforeRetry + 1
      && retrySpec.format === 'txt' && retrySpec.outputName === 'retry-kept.txt'
      && fs.readFileSync(path.join(downloads, job.outputName), 'utf8').includes('Background export.'),
    'one click after failure saves exactly one file with the retained export settings', { job, retrySpec });
    await call('Emulation.setDeviceMetricsOverride', { width: 1040, height: 920, deviceScaleFactor: 1, mobile: false }, session);
    const copy = await evaluate('checkStatusCopy()');
    check(copy.ok && copy.languages === 4 && copy.schemes === 2 && copy.cards === 24, 'concise status cards fit four languages and both themes', copy);
    const copyCapture = await call('Page.captureScreenshot', { format: 'png' }, session);
    fs.writeFileSync(path.join(dir, 'status-copy.png'), Buffer.from(copyCapture.data, 'base64'));
    report.ok = true;
  } catch (error) { report.error = error.message; }
  finally { if (socket?.readyState === WebSocket.OPEN) { try { await call('Browser.close'); } catch {} socket.close(); } if (child.exitCode === null) child.kill(); }
  report.directory = dir; fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1;
}
const TIDY_ACTIVE = ['starting', 'generating', 'saving', 'cancelling'];
main().catch(e => { console.error(e); process.exitCode = 1; });
