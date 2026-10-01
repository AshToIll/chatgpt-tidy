// MAIN 组合根：只接线工厂、消息出口和文档生命周期；具体读取/请求/观察均有单一所有者。
(function initTidyChatgptMainWorld(global) {
  "use strict";
  const protocol = global.TidyProtocol;
  const session = global.TidyPageSession;
  const api = global.TidyChatgptApi;
  const titleProjection = global.TidyChatgptTitleSync;
  if (!protocol || !session || !api || !global.TidySnapshot || !global.TidyDomOwnership
    || !global.TidyChatgptRoute || !global.TidyChatgptBinding || !global.TidyChatgptMessageDom
    || !global.TidyChatgptNativeAppearance || !global.TidyChatgptConversationProjection
    || !global.TidyChatgptSearch || !global.TidyChatgptDateIndex
    || !global.TidyChatgptExport || !global.TidyChatgptNativeSnapshotReader
    || !global.TidyChatgptSnapshotMetadata || !global.TidyChatgptSnapshotProjection
    || !global.TidyChatgptSnapshotPublisher || !global.TidyChatgptPageNavigationRuntime
    || !global.TidyPageRequestRouter || !global.TidyChatgptNativeObserver
    || global.__tidyMainWorldStarted) return;
  global.__tidyMainWorldStarted = true;
  session.assertActive();
  global.document.documentElement.dataset.tidyMainWorld = "ready";

  function postEnvelope(envelope) {
    if (!session.check()) return;
    global.postMessage({ channel: protocol.WINDOW_CHANNEL, source: "chatgpt-main-world", envelope }, global.location.origin);
  }
  // 回调只在装配结束后执行；无需向模块泄露可写共享 state。
  const metadata = global.TidyChatgptSnapshotMetadata.create({
    routeStillOwnsConversation: id => reader.routeStillOwnsConversation(id),
    onChanged: (reason, delay) => publisher.schedule(reason, delay),
  });
  const reader = global.TidyChatgptNativeSnapshotReader.create({ readMessageNumbers: metadata.messageNumbers });
  const snapshot = global.TidyChatgptSnapshotProjection.create({ reader, metadata, titleProjection });
  const publisher = global.TidyChatgptSnapshotPublisher.create({ readSnapshot: snapshot.read, postEnvelope });
  const navigation = global.TidyChatgptPageNavigationRuntime.create({ reader, postEnvelope });
  const router = global.TidyPageRequestRouter.create({
    readSnapshot: snapshot.read, publishSnapshot: publisher.publish, postEnvelope, navigation,
    routeStillOwnsConversation: reader.routeStillOwnsConversation,
    searchAdapter: global.TidyChatgptSearch, dateIndexAdapter: global.TidyChatgptDateIndex,
    exportAdapter: global.TidyChatgptExport, titleAdapter: global.TidyChatgptTitles, titleProjection,
  });
  const unsubscribeIdentity = api.onLibraryIdentityChanged(identity => {
    if (!session.check()) return;
    navigation.observeIdentity(identity);
    postEnvelope(protocol.event(protocol.Type.LIBRARY_IDENTITY_CHANGED, identity));
  });
  const unsubscribeTitle = api.onTitleChanged(change => {
    postEnvelope(protocol.event(protocol.Type.TITLE_CHANGED, change));
  });
  const observer = global.TidyChatgptNativeObserver.create({
    onRefresh: publisher.schedule, onHidden: navigation.hidden, onMessage: router.handleMessage,
    onRoute: () => { navigation.routeChanged(); titleProjection?.refresh(); publisher.resetRetry(); },
  });
  session.onDispose(() => {
    // 先停触发器，再清理投影；已排队回调仍由同步 page-session 闸门拒绝。
    observer.dispose(); publisher.dispose(); unsubscribeIdentity(); unsubscribeTitle();
    navigation.dispose(); reader.dispose(); metadata.dispose();
    delete global.document.documentElement.dataset.tidyMainWorld;
  });
})(globalThis);
