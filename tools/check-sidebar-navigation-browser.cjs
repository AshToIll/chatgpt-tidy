// Optional native Chromium DOM/focus/scroll regression. Uses a brand-new profile
// and file-only fixtures, never the user's browser, cookies or ChatGPT account.
// Run: node tools/check-sidebar-navigation-browser.cjs [path-to-chromium] [--native]
const fs = require("node:fs"), path = require("node:path"), { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { browserArtifactRoot } = require('./browser-fixture.cjs');
const root = path.resolve(__dirname, "..");
const fixture = process.argv.includes("--native") ? "native-sidebar-navigation" : "sidebar-navigation";
const executable = process.argv.slice(2).find(arg => arg !== "--native") || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find(candidate => fs.existsSync(candidate));
if (!executable || !fs.existsSync(executable)) throw new Error("Pass an installed Chromium executable path.");
fs.mkdirSync(browserArtifactRoot, { recursive: true });
const profile = fs.mkdtempSync(path.join(browserArtifactRoot, 'sidebar-browser-'));
const result = spawnSync(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--disable-background-networking",
  "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
  "--allow-file-access-from-files", `--user-data-dir=${profile}`, "--dump-dom", "--virtual-time-budget=10000",
  pathToFileURL(path.join(root, `tests/browser/${fixture}.html`)).href,
], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
const html = result.stdout || "";
fs.writeFileSync(path.join(browserArtifactRoot, `${fixture}-browser.html`), html);
const content = /<pre id="results" data-complete="true">([\s\S]*?)<\/pre>/.exec(html)?.[1];
if (!content) {
  console.error("Browser fixture did not finish.", result.error?.message || "", (result.stderr || "").slice(-1600));
  process.exitCode = 1;
} else {
  const report = JSON.parse(content.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
