// 时间栏的静态骨架。IDs、class 和节点顺序与迁移前一致；交互由同目录 view 管理。
// data-time-control 只标记受时间开关管理的区域；消息编号独立控制，不加入时间关闭时的灰显分组。
export const TIME_VIEW_TEMPLATE = String.raw`
            <div id="status-card" class="status-card" aria-live="polite" hidden></div>

            <section class="setting-section setting-section--date" data-time-control>
              <div class="setting-label" data-i18n="dateFormat">日期格式</div>
              <div class="option-stack" role="group" aria-label="日期格式" data-i18n-aria="dateFormat">
                <button class="option option--wide" type="button" data-preference="dateFormat" data-value="locale"><span data-i18n="regional">跟随地区格式</span><i data-i18n="defaultLabel">默认</i></button>
                <button class="option option--wide" type="button" data-preference="dateFormat" data-value="iso"></button>
                <button class="option option--wide" type="button" data-preference="dateFormat" data-value="slash"></button>
                <button class="option option--wide" type="button" data-preference="dateFormat" data-value="dot"></button>
                <button class="option option--wide" type="button" data-preference="dateFormat" data-value="compact"></button>
              </div>
            </section>

            <section class="setting-section setting-section--disclosure setting-section--no-border" data-time-control>
              <button class="setting-disclosure" type="button" data-disclosure-toggle="list" aria-expanded="false" aria-controls="conversation-list-panel">
                <span class="setting-disclosure__label" data-i18n="conversationListTime">会话列表时间</span>
                <span class="setting-disclosure__summary setting-disclosure__summary--token" id="conversation-list-summary"></span>
                <span class="setting-disclosure__chevron" aria-hidden="true">›</span>
              </button>
              <div class="disclosure-panel" id="conversation-list-panel" hidden>
                <div class="disclosure-setting-row disclosure-setting-row--list-time">
                  <span class="disclosure-setting-label" data-i18n="displayTime">显示时间</span>
                  <div class="option-grid option-grid--list" role="group">
                    <button class="option" type="button" data-preference="conversationTimeMode" data-value="range" data-i18n="timeRange">时间范围</button>
                    <button class="option" type="button" data-preference="conversationTimeMode" data-value="created" data-i18n="createdTime">创建时间</button>
                    <button class="option" type="button" data-preference="conversationTimeMode" data-value="updated" data-i18n="updatedTime">更新时间</button>
                  </div>
                </div>
                <div class="disclosure-setting-row"><span class="disclosure-setting-label" data-i18n="precision">精度</span><div class="mini-options mini-options--conversation-precision"><button class="mini-option" type="button" data-preference="conversationTimePrecision" data-value="date" data-i18n="datePrecision">日期</button><button class="mini-option" type="button" data-preference="conversationTimePrecision" data-value="hour" data-i18n="hour">小时</button><button class="mini-option" type="button" data-preference="conversationTimePrecision" data-value="minute" data-i18n="minute">分钟</button></div></div>
              </div>
            </section>

            <section class="setting-section setting-section--disclosure setting-section--no-border" data-time-control>
              <button class="setting-disclosure" type="button" data-disclosure-toggle="message" aria-expanded="false" aria-controls="message-time-panel">
                <span class="setting-disclosure__label" data-i18n="messageTime">消息时间</span>
                <span class="setting-disclosure__summary" id="message-time-summary"></span>
                <span class="setting-disclosure__chevron" aria-hidden="true">›</span>
              </button>
              <div class="disclosure-panel" id="message-time-panel" hidden>
                <div class="disclosure-setting-row"><span class="disclosure-setting-label" data-i18n="position">位置</span><div class="mini-options mini-options--position"><button class="mini-option" type="button" data-preference="messageTimePosition" data-value="before" data-i18n="before">正文前</button><button class="mini-option" type="button" data-preference="messageTimePosition" data-value="after" data-i18n="after">正文后</button></div></div>
                <div class="disclosure-setting-row"><span class="disclosure-setting-label" data-i18n="precision">精度</span><div class="mini-options"><button class="mini-option" type="button" data-preference="messageTimePrecision" data-value="minute" data-i18n="minute">分钟</button><button class="mini-option" type="button" data-preference="messageTimePrecision" data-value="second" data-i18n="second">秒</button></div></div>
              </div>
            </section>

            <section class="setting-section setting-section--toggle setting-section--no-border">
              <div class="setting-toggle-row"><span class="setting-disclosure__label" data-i18n="messageNumbers">消息编号</span><label class="toggle-control toggle-control--compact"><input id="message-numbers" type="checkbox" role="switch" /><span class="toggle-track" aria-hidden="true"></span></label></div>
            </section>

            <div class="setting-divider" aria-hidden="true"></div>
            <section class="live-preview" aria-label="实时预览" data-i18n-aria="preview">
              <div class="live-preview__label" data-i18n="preview">实时预览</div>
              <div class="preview-line"><span class="preview-key" data-i18n="conversationList">会话列表</span><span id="conversation-preview">—</span></div>
              <div class="preview-line"><span class="preview-key" data-i18n="messagePreview">消息</span><span id="message-preview">—</span></div>
            </section>
`;
