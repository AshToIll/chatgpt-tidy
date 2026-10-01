// 自动生成，请勿直接修改。唯一文案源：src/messages/catalogs/*.json
// 修改文案后运行 npm run build:messages；npm run check:messages 检查生成文件同步。
(function initTidyMessages(global) {
  "use strict";
  const pageLabels = Object.freeze({
  time: {
    "zh-CN": {
      created: "创建",
      updated: "更新"
    },
    "zh-TW": {
      created: "建立",
      updated: "更新"
    },
    en: {
      created: "Created",
      updated: "Updated"
    },
    ja: {
      created: "作成",
      updated: "更新"
    }
  },
  favorites: {
    "zh-CN": {
      add: "收藏",
      remove: "取消收藏",
      failed: "结果未明，请查收藏"
    },
    "zh-TW": {
      add: "收藏",
      remove: "取消收藏",
      failed: "結果未明，請查收藏"
    },
    en: {
      add: "Favorite",
      remove: "Remove favorite",
      failed: "Result unknown. Check your favorites."
    },
    ja: {
      add: "お気に入りに追加",
      remove: "お気に入りを解除",
      failed: "お気に入りの保存結果を確認してください"
    }
  },
  bookmarks: {
    "zh-CN": {
      add: "添加消息书签",
      remove: "取消消息书签",
      open: "打开书签",
      failed: "结果未明，请查书签",
      openFailed: "未能打开，请再点"
    },
    "zh-TW": {
      add: "新增訊息書籤",
      remove: "取消訊息書籤",
      open: "開啟書籤",
      failed: "結果未明，請查書籤",
      openFailed: "未能開啟，請再點"
    },
    en: {
      add: "Bookmark message",
      remove: "Remove message bookmark",
      open: "Open bookmarks",
      failed: "Result unknown. Check your bookmarks.",
      openFailed: "Could not open. Try again."
    },
    ja: {
      add: "メッセージをブックマーク",
      remove: "ブックマークを解除",
      open: "ブックマークを開く",
      failed: "ブックマークの保存結果を確認してください",
      openFailed: "もう一度開いてください"
    }
  }
});
  for (const labels of Object.values(pageLabels)) Object.freeze(labels);
  global.TidyMessages = Object.freeze({ pageLabels });
})(globalThis);
