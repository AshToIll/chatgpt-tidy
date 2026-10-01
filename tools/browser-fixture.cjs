// 文件页夹具共用真实时间的完成回执，避免虚拟时间抢在动态模块和动画前结束。
// 每次只启动全新隔离浏览器，禁止外网；不接触用户的浏览器或账号。
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Keep screenshots, isolated profiles and receipts together when a run supplies an output directory.
const browserArtifactRoot = path.resolve(root, process.env.TIDY_BROWSER_ARTIFACT_ROOT || '.tmp');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function nativeKeyDownParams(request) {
  const params = { key: request.key, code: request.code, windowsVirtualKeyCode: request.vk, modifiers: request.modifiers || 0 };
  // CDP 的 Enter 还需要字符信息才触发原生 keypress / button click；
  // 仅发 keyDown + keyUp 会得到假阴性，不能据此改产品的原生按钮行为。
  return request.key === 'Enter' ? { ...params, text: '\r', unmodifiedText: '\r' } : params;
}
async function runBrowserFixture({ fixture, prefix, windowSize = '1300,1000', focusEmulation = false, nativeInput = false, timeoutMs = 30000, executable = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe' }) {
  fs.mkdirSync(browserArtifactRoot, { recursive: true });
  const profile = fs.mkdtempSync(path.join(browserArtifactRoot, prefix));
  const screenshot = path.join(profile, 'preview.png');
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--allow-file-access-from-files', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--window-size=' + windowSize, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket, spawnError, report = { ok: false }, id = 0;
  child.on('error', error => { spawnError = error; });
  const pending = new Map(), pageErrors = [];
  const deadline = Date.now() + timeoutMs;
  async function waitFor(read) {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const value = await read(); if (value) return value; await sleep(100);
    }
    throw new Error(`Browser fixture did not complete in ${timeoutMs / 1000} seconds`);
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 5000);
    pending.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  try {
    const port = await waitFor(() => { try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { return null; } });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated browser connection timed out')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true });
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), receive = pending.get(message.id);
      if (receive) { pending.delete(message.id); receive(message); }
      else if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails);
    });
    await call('Page.enable');
    // Module-loading/runtime exceptions explain a missing completion receipt; never treat timeout as success.
    await call('Runtime.enable');
    // 焦点样式夹具需显式模拟前台标签；默认不改变其他生命周期测试的焦点。
    if (focusEmulation) await call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await call('Page.navigate', { url: pathToFileURL(path.join(root, 'tests/browser/' + fixture + '.html')).href });
    report = await waitFor(async () => {
      // 键盘夹具必须走浏览器真实输入，dispatchEvent 不会执行 Tab/空格等默认行为。
      // 只处理隔离测试页的请求；不连接用户现有浏览器。
      if (nativeInput) {
        const input = await call('Runtime.evaluate', { expression: 'globalThis.fixtureInputRequest || null', returnByValue: true });
        const request = input.result?.value;
        if (request) {
          if (request.kind === 'key') {
            const params = { key: request.key, code: request.code, windowsVirtualKeyCode: request.vk, modifiers: request.modifiers || 0 };
            await call('Input.dispatchKeyEvent', { ...nativeKeyDownParams(request), type: 'keyDown' });
            await call('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
          } else if (request.kind === 'text') await call('Input.insertText', { text: request.text });
          else if (request.kind === 'composition') {
            // 原生候选输入/取消；只用于独立测试页，不连接用户浏览器或系统输入法。
            await call('Input.imeSetComposition', { text: request.text, selectionStart: request.selectionStart, selectionEnd: request.selectionEnd });
          }
          else if (request.kind === 'pointer') {
            for (const step of request.steps) await call('Input.dispatchMouseEvent', step);
          } else throw new Error('Unknown fixture input kind');
          await call('Runtime.evaluate', { expression: `globalThis.completeFixtureInput(${JSON.stringify(request.id)})` });
        }
      }
      const result = await call('Runtime.evaluate', { expression: `document.querySelector('#results')?.dataset.complete === 'true' ? JSON.parse(document.querySelector('#results').textContent) : null`, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    });
    // 页面明确给出完成回执才验收；截图与回执来自同一次运行。
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(screenshot, Buffer.from(capture.data, 'base64'));
  } catch (error) { report = { ok: false, error: error.message }; }
  finally {
    if (socket?.readyState === WebSocket.OPEN) { try { await call('Browser.close'); } catch {} socket.close(); }
    if (child.exitCode === null) child.kill();
  }
  report.screenshot = screenshot;
  report.pageErrors = pageErrors;
  fs.writeFileSync(path.join(profile, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
module.exports = { runBrowserFixture, browserArtifactRoot, nativeKeyDownParams };
