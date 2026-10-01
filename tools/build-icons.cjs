// Rebuild the transparent PNGs from the checked-in SVGs using an isolated browser.
// No image library or user browser profile is needed. Usage: npm run build:icons
// Optional: --browser /path/to/chrome, BROWSER_BIN, --preview, or --check.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const iconDir = path.join(root, 'src/assets/icons');
// Keep these sizes aligned with manifest.icons and action.default_icon.
const sizes = [16, 32, 48, 128];
const variants = [
  { source: 'tidy-outlined.svg', prefix: 'tidy-outlined', label: 'Black + white outline' },
  { source: 'tidy-white.svg', prefix: 'tidy-white', label: 'White + black outline' },
];

function findBrowser(explicit) {
  if (explicit) return explicit;
  const candidates = process.platform === 'win32'
    ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).flatMap(base => [
        path.join(base, 'Google/Chrome/Application/chrome.exe'),
        path.join(base, 'Microsoft/Edge/Application/msedge.exe'),
      ])
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const browser = candidates.find(candidate => fs.existsSync(candidate));
  if (!browser) throw new Error('Chrome or Edge not found. Set BROWSER_BIN or pass --browser <executable>.');
  return browser;
}

function makeFixture(inputs) {
  return `<!doctype html><meta charset="utf-8"><title>Icon build</title><pre id="result"></pre>
<script>
  (async () => {
    const inputs = ${JSON.stringify(inputs)};
    const result = { ok: true, pngs: {} };
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const loaded = [];
    for (const input of inputs) {
      const image = new Image();
      image.src = input.url;
      await image.decode();
      loaded.push({ ...input, image });
      for (const size of ${JSON.stringify(sizes)}) {
        canvas.width = canvas.height = size;
        context.clearRect(0, 0, size, size);
        context.drawImage(image, 0, 0, size, size);
        result.pngs[input.prefix + '-' + size + '.png'] = canvas.toDataURL('image/png').split(',')[1];
      }
    }
    // Inspect both variants on neutral and tinted browser toolbars. The 16px
    // samples use actual exported PNGs, without enlargement or interpolation.
    const backgrounds = [
      { color: '#ffffff', ink: '#202124', label: 'White' },
      { color: '#252727', ink: '#ffffff', label: 'Dark' },
      { color: '#d5ebe7', ink: '#202124', label: 'Mint' },
    ];
    canvas.width = 1040; canvas.height = 370;
    context.fillStyle = '#eef0f3'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = 'bold 20px sans-serif'; context.fillStyle = '#202124';
    context.fillText('ChatGPT Tidy | two variants, solid hands, contrasting outlines', 24, 34);
    for (let row = 0; row < loaded.length; row++) {
      const y = 55 + row * 154;
      for (let column = 0; column < backgrounds.length; column++) {
        const x = 20 + column * 340;
        const background = backgrounds[column];
        context.fillStyle = background.color;
        context.fillRect(x, y, 330, 142);
        context.fillStyle = background.ink;
        context.font = '14px sans-serif';
        context.fillText(loaded[row].label + ' / ' + background.label, x + 12, y + 23);
        for (const [index, size] of [16, 32, 48, 64].entries()) {
          const drawSize = size === 64 ? 128 : size;
          // Use the actual PNG output for the small icons; scale only the 128px preview.
          const png = new Image();
          png.src = 'data:image/png;base64,' + result.pngs[loaded[row].prefix + '-' + drawSize + '.png'];
          await png.decode();
          const left = x + 20 + index * 76;
          context.drawImage(png, left, y + 42, size, size);
          context.font = '12px sans-serif';
          context.fillText(size === 64 ? '128px / 50%' : size + 'px', left, y + 121);
        }
      }
    }
    result.preview = canvas.toDataURL('image/png').split(',')[1];
    document.getElementById('result').textContent = JSON.stringify(result);
  })().catch(error => { document.getElementById('result').textContent = JSON.stringify({ ok: false, error: error.message }); });
</script>`;
}

// CDP avoids Chrome's unreliable --dump-dom stdout on Windows. The debugging
// port belongs to a fresh temporary profile, never the user's running browser.
async function render(browser, temporary, fixture) {
  const profile = path.join(temporary, 'profile');
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let socket, spawnError, nextId = 0;
  child.on('error', error => { spawnError = error; });
  const pending = new Map();
  const deadline = Date.now() + 30000;
  const waitFor = async read => {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Icon renderer exited (${child.exitCode}).`);
      const value = await read();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Icon renderer timed out after 30 seconds.');
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Icon renderer timeout: ${method}`)); }, 5000);
    pending.set(id, message => {
      clearTimeout(timer);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    const port = await waitFor(() => {
      try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; }
      catch { return null; }
    });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(5000),
    })).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Icon renderer connection timed out.')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true });
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), receive = pending.get(message.id);
      if (receive) { pending.delete(message.id); receive(message); }
    });
    await call('Page.navigate', { url: pathToFileURL(fixture).href });
    return await waitFor(async () => {
      const output = await call('Runtime.evaluate', {
        expression: `document.getElementById('result')?.textContent || null`, returnByValue: true,
      });
      if (output.exceptionDetails) throw new Error(output.exceptionDetails.text);
      return output.result?.value ? JSON.parse(output.result.value) : null;
    });
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      try { await call('Browser.close'); } catch {}
      socket.close();
    }
    if (child.exitCode === null) {
      // Let Browser.close finish releasing profile handles before cleanup.
      await new Promise(resolve => {
        let finalTimer;
        const timer = setTimeout(() => {
          child.kill();
          finalTimer = setTimeout(resolve, 2000);
        }, 2000);
        child.once('exit', () => { clearTimeout(timer); clearTimeout(finalTimer); resolve(); });
      });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let explicit = process.env.BROWSER_BIN, check = false, preview = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--browser' && args[i + 1]) explicit = args[++i];
    else if (args[i] === '--check') check = true;
    else if (args[i] === '--preview') preview = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  const browser = findBrowser(explicit);
  const tmpRoot = path.join(root, '.tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(tmpRoot, 'icon-build-'));
  try {
    const inputs = variants.map(variant => ({ ...variant,
      url: 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(iconDir, variant.source)).toString('base64'),
    }));
    const fixture = path.join(temporary, 'render.html');
    fs.writeFileSync(fixture, makeFixture(inputs));
    const result = await render(browser, temporary, fixture);
    if (!result.ok) throw new Error(result.error);
    for (const [name, data] of Object.entries(result.pngs)) {
      const filename = path.join(iconDir, name);
      const bytes = Buffer.from(data, 'base64');
      if (check) {
        if (!fs.existsSync(filename) || !fs.readFileSync(filename).equals(bytes)) {
          throw new Error(`${name} differs from this browser's SVG render. Rebuild and review the artwork before updating it.`);
        }
      } else fs.writeFileSync(filename, bytes);
    }
    if (preview) {
      const filename = path.join(tmpRoot, 'logo-preview.png');
      fs.writeFileSync(filename, Buffer.from(result.preview, 'base64'));
      console.log(`Preview: ${filename}`);
    }
    console.log(`${check ? 'Checked' : 'Built'} ${Object.keys(result.pngs).length} transparent PNGs from ${variants.length} SVGs.`);
  } finally {
    // Only remove the exact directory created above, never a caller-provided path.
    // Chromium may briefly hold files open on Windows after its main process exits.
    if (path.dirname(path.resolve(temporary)) !== path.resolve(tmpRoot)) {
      throw new Error('Refusing to remove an icon build directory outside the workspace temporary folder.');
    }
    try { await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { console.warn(`Temporary browser files could not be removed: ${temporary} (${error.code})`); }
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { sizes, variants };
