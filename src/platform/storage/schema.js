// 存储分工：全局显示设置可同步；账号资料和会话目录放在同一个 IndexedDB 中，以事务整体保存。
// chrome.storage 不存会话正文或消息。标题规则另存 local，不能据此承诺所有设置都会跨设备同步。
export const STORAGE_BOUNDARIES = Object.freeze({
  sync: Object.freeze({
    preferences: "tidy.v1.preferences",
  }),
  indexedDb: Object.freeze({
    // 正式数据库名称固定；结构升级只调整 version。运行时不打开、搬迁或删除旧开发库。
    databaseName: "chatgpt-tidy-storage",
    version: 1,
    stores: Object.freeze({
      bookmarks: "bookmarks",
      bookmarkGroups: "bookmark-groups",
      favorites: "favorites",
      favoriteGroups: "favorite-groups",
      moduleState: "module-state",
      conversationIndex: "conversation-index",
    }),
    purpose: "conversation, message, bookmark, search, and export payloads",
  }),
});
