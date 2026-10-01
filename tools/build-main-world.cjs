const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
// MAIN 世界没有模块加载器：按依赖顺序拼接本仓库源码，结果由 manifest 直接加载。
// 新增页面侧模块时更新此清单并重新构建，不手改生成的 main-world.bundle.js。
const sourceFiles = [
  "src/platform/protocol.js",
  "src/platform/session/shared/page-session.js",
  "src/platform/session/chatgpt/page-session.js",
  "src/platform/navigation/navigation-identity.js",
  "src/platform/snapshot.js",
  "src/features/search/model/search.js",
  "src/platform/catalog/date-search.js",
  "src/features/export/model/export.js",
  "src/platform/ui/dom-ownership.js",
  "src/platform/time-format.js",
  "src/features/titles/model/title-dates.js",
  "src/platform/chatgpt/route.js",
  "src/platform/chatgpt/binding.js",
  "src/platform/chatgpt/message-dom.js",
  "src/platform/chatgpt/sidebar-dom.js",
  "src/platform/chatgpt/active-branch.js",
  "src/platform/chatgpt/native-message-references.js",
  "src/platform/chatgpt/native-message-content.js",
  "src/platform/chatgpt/native-message-process.js",
  "src/platform/chatgpt/conversation-projection.js",
  "src/platform/chatgpt/api.js",
  "src/platform/chatgpt/messages.js",
  "src/features/search/chatgpt/search.js",
  "src/platform/navigation/chatgpt/navigation-intent.js",
  "src/platform/navigation/chatgpt/virtual-message-target.js",
  "src/platform/navigation/chatgpt/message-location.js",
  "src/platform/navigation/chatgpt/message-navigation.js",
  "src/platform/catalog/chatgpt/date-index.js",
  "src/features/export/chatgpt/export.js",
  "src/features/titles/chatgpt/titles.js",
  "src/features/titles/chatgpt/title-sync.js",
  "src/platform/navigation/chatgpt/library-navigation.js",
  "src/platform/chatgpt/native-appearance.js",
  "src/platform/chatgpt/native-snapshot-reader.js",
  "src/platform/chatgpt/snapshot-metadata.js",
  "src/platform/chatgpt/snapshot-projection.js",
  "src/platform/chatgpt/snapshot-publisher.js",
  "src/platform/chatgpt/page-navigation-runtime.js",
  "src/app/page/request-router.js",
  "src/platform/chatgpt/native-observer.js",
  "src/app/page/main-world.js",
];
// 显式装配依赖用于架构门禁；require 本文件只读此元数据，不会写 bundle。
const sourceDependencies = Object.freeze({
  "src/platform/chatgpt/native-snapshot-reader.js": [
    "src/platform/chatgpt/sidebar-dom.js"
  ],
  "src/platform/chatgpt/native-message-content.js": [
    "src/platform/chatgpt/native-message-references.js"
  ],
  "src/platform/chatgpt/native-message-process.js": [
    "src/platform/chatgpt/native-message-references.js",
    "src/platform/chatgpt/native-message-content.js"
  ],
  "src/platform/chatgpt/conversation-projection.js": [
    "src/platform/chatgpt/active-branch.js",
    "src/platform/chatgpt/native-message-content.js",
    "src/platform/chatgpt/native-message-process.js"
  ],
  "src/features/export/chatgpt/export.js": [
    "src/platform/chatgpt/conversation-projection.js"
  ],
  "src/platform/chatgpt/snapshot-metadata.js": [
    "src/platform/chatgpt/conversation-projection.js"
  ],
  "src/platform/chatgpt/snapshot-projection.js": [
    "src/platform/chatgpt/native-appearance.js",
    "src/platform/chatgpt/native-snapshot-reader.js",
    "src/platform/chatgpt/snapshot-metadata.js"
  ],
  "src/app/page/main-world.js": [
    "src/platform/chatgpt/native-snapshot-reader.js",
    "src/platform/chatgpt/snapshot-metadata.js",
    "src/platform/chatgpt/snapshot-projection.js",
    "src/platform/chatgpt/snapshot-publisher.js",
    "src/platform/chatgpt/page-navigation-runtime.js",
    "src/app/page/request-router.js",
    "src/platform/chatgpt/native-observer.js"
  ]
});

function build({ check = false } = {}) {
  const outputFile = "src/app/page/main-world.bundle.js";

  const banner = [
    "// GENERATED FILE. Do not edit by hand.",
    "// Run `node tools/build-main-world.cjs` after changing protocol, snapshot, route, or adapter sources.",
    "",
  ].join("\n");

  const bundle =
    banner +
    sourceFiles
      .map((relativePath) => {
        const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8").replace(/\r\n?/g, "\n").trimEnd();
        return `// Source: ${relativePath}\n${source}`;
      })
      .join("\n\n") +
    "\n";

  const outputPath = path.join(projectRoot, outputFile);
  if (check) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").replace(/\r\n?/g, "\n") : "";
    if (current !== bundle) {
      console.error(`${outputFile} is stale. Run node tools/build-main-world.cjs.`);
      process.exitCode = 1;
    }
  } else {
    fs.writeFileSync(outputPath, bundle, "utf8");
    console.log(`Built ${outputFile}`);
  }

}

module.exports = Object.freeze({ sourceFiles: Object.freeze(sourceFiles), sourceDependencies, build });
if (require.main === module) build({ check: process.argv.includes("--check") });
