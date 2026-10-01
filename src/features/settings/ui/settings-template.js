// 设置栏：原设置与备份保留在表单内；底部排查日志独立，断连时仍可使用。
export const SETTINGS_VIEW_TEMPLATE = String.raw`
            <form id="settings-form" class="settings-panel">
              <section class="settings-item"><label for="language-select" data-i18n="language">界面语言</label><div class="settings-select"><select id="language-select"><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option></select><i aria-hidden="true"></i></div></section>
              <section class="settings-item"><label for="timezone-select" data-i18n="timeZone">全局时区</label><div class="settings-select"><select id="timezone-select"></select><i aria-hidden="true"></i></div></section>
              <fieldset class="settings-item settings-theme"><legend data-i18n="themeSets">主题色套装</legend><div id="theme-grid" class="settings-theme-grid"></div></fieldset>
              <section id="library-backup" class="library-backup"></section>
            </form>
            <!-- 排查日志只属于设置底部；不放入依赖网页连接的业务表单。 -->
            <section id="settings-diagnostics" class="settings-diagnostics"></section>
`;
