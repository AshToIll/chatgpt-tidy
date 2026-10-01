(function initTidyChatgptLibraryNavigation(global) {
  "use strict";

  if (global.TidyChatgptLibraryNavigation) return;

  const ORIGIN = "https://chatgpt.com";
  // 同一目标在 1.5 秒内的连续点击只发起一次原生路由切换；不是重试计时。
  const DUPLICATE_WINDOW_MS = 1500;
  // 这里只等待站点接收路由，不接管官方搜索的消息定位/高亮。
  const NATIVE_SEARCH_WINDOW_MS = 30_000;

  function targetFor(payload, location) {
    if (typeof payload?.conversationId !== "string" || !/^[A-Za-z0-9_-]+$/.test(payload.conversationId)
      || typeof payload.pathname !== "string"
      || typeof payload.expectedAccountKey !== "string" || !payload.expectedAccountKey
      || payload.expectedAccountKey.trim() !== payload.expectedAccountKey
      || !Number.isSafeInteger(payload.expectedEpoch) || payload.expectedEpoch < 0) return null;

    // 导航边界比只读解析严格：不自动修补路径，不接受查询/锚点、编码分隔符、
    // 草稿、自定义 GPT、分享和群组路径，避免把其他页面误当作普通会话打开。
    const ordinary = /^\/c\/([A-Za-z0-9_-]+)$/.exec(payload.pathname);
    const project = /^\/g\/(g-p-[A-Za-z0-9_-]+)\/c\/([A-Za-z0-9_-]+)$/.exec(payload.pathname);
    if ((!ordinary && !project) || (ordinary ? ordinary[1] : project[2]) !== payload.conversationId) return null;
    const nativeSearch = payload.placement === "native-search";
    if (payload.placement != null && !["latest", "native-search"].includes(payload.placement)) return null;
    if (nativeSearch && (typeof payload.query !== "string" || !payload.query.trim() || payload.query.length > 500
      || (payload.messageId != null && (typeof payload.messageId !== "string" || !payload.messageId.trim()
        || payload.messageId.length > 256 || /[\u0000-\u001f\u007f]/.test(payload.messageId))))) return null;
    try {
      const current = new URL(location.href);
      if (current.origin !== ORIGIN || location.origin !== ORIGIN) return null;
      const destination = new URL(payload.pathname, ORIGIN);
      if (nativeSearch) {
        // 与官方搜索结果链接一致：标题命中可无消息 ID，不能据此改走日期 latest。
        destination.searchParams.set("src", "history_search");
        if (payload.messageId) destination.searchParams.set("messageId", payload.messageId);
        destination.searchParams.set("historySearchQuery", payload.query.trim());
      }
      const routeUrl = destination.pathname + destination.search;
      return { pathname: payload.pathname, fromHref: current.href,
        routeUrl,
        conversationId: payload.conversationId, placement: payload.placement,
        loadDeadlineAt: payload.loadDeadlineAt, deadlineAt: payload.deadlineAt,
        nativeFallbackAt: payload.nativeFallbackAt,
        navigationIntentId: payload.navigationIntentId,
        accountKey: payload.expectedAccountKey, epoch: payload.expectedEpoch,
        key: JSON.stringify([payload.expectedAccountKey, payload.expectedEpoch, routeUrl]) };
    } catch { return null; }
  }

  function owns(identity, target, requireReady = false) {
    return identity?.accountKey === target.accountKey && identity.epoch === target.epoch
      && (!requireReady || identity.phase === "ready");
  }

  function create({
    readAccount = () => global.TidyChatgptApi.readLibraryAccount(),
    checkIdentity = () => global.TidyChatgptApi.checkLibraryIdentity(),
    location = global.location,
    // 由站点路由更新原生左栏选中态；不手动染色、不伪造 history、不点击左栏。
    getRouter = () => global.__reactRouterDataRouter,
    now = () => Date.now(),
    isIntentCurrent = () => false,
    revealLatest = () => {},
    setTimer = (fn, delay) => global.setTimeout(fn, delay),
    clearTimer = timer => global.clearTimeout(timer),
  } = {}) {
    let inFlight = null;
    let lastDispatch = null;
    let latestIntentId = null;
    const result = (navigated, reason) => ({ navigated, reason });

    async function nativeAcknowledgement(target, dispatch) {
      const outcome = await dispatch.promise;
      if (!isIntentCurrent(target.navigationIntentId)) return result(false, "superseded");
      // 派发前严格核验 epoch；派发后的只读回执使用持续存活的意图归属。
      // 同账号暂时失联再恢复会推进 epoch，不应因此把已完成的官方跳转报错。
      const identity = checkIdentity();
      if (!isIntentCurrent(target.navigationIntentId)) return result(false, "superseded");
      // 回执仅确认官方已接收导航，不宣称消息已定位。合法的身份恢复等待
      // 不会撤销已授权命令；真实账号切换仍由共享 gate 永久撤销，不能复活。
      if (global.TidyNavigationIdentity.state(identity, target.accountKey) === "revoked") return result(false, "context-mismatch");
      if (!outcome) return result(false, "native-router-failed");
      const current = new URL(location.href);
      // 官方可能清掉一次性搜索参数，也可能把普通路径规范化为项目会话路径。
      const canonicalProject = /^\/g\/g-p-[A-Za-z0-9_-]+\/c\/([A-Za-z0-9_-]+)$/.exec(current.pathname);
      const atTarget = current.origin === ORIGIN && (current.pathname === target.pathname
        || (/^\/c\//.test(target.pathname) && canonicalProject?.[1] === target.conversationId));
      if (!atTarget) return result(false, "native-route-unconfirmed");
      const requested = new URL(target.routeUrl, ORIGIN);
      for (const parameter of ["messageId", "historySearchQuery"]) {
        if (current.searchParams.has(parameter)
          && current.searchParams.get(parameter) !== requested.searchParams.get(parameter)) return result(false, "native-route-unconfirmed");
      }
      return { navigated: true, reason: "native-router", presentationOwner: "native" };
    }

    function reveal(target) {
      if (target.placement !== "latest" || latestIntentId === target.navigationIntentId || !isIntentCurrent(target.navigationIntentId)) return;
      latestIntentId = target.navigationIntentId;
      revealLatest(target);
    }

    function unchanged(target) {
      return location.origin === ORIGIN && location.href === target.fromHref;
    }

    async function perform(target) {
      // 复用本地身份状态，不因每次跳转重新请求认证；等待后再次核对归属。
      if (!isIntentCurrent(target.navigationIntentId)) return result(false, "superseded");
      if (target.placement === "native-search" && Number.isFinite(target.loadDeadlineAt)
        && now() >= target.loadDeadlineAt) return result(false, "native-router-timeout");
      const identity = await readAccount();
      if (!isIntentCurrent(target.navigationIntentId)) return result(false, "superseded");
      if (!owns(identity, target) || !owns(checkIdentity(), target, true)) return result(false, "context-mismatch");
      if (!unchanged(target)) return result(false, "route-changed");
      const currentUrl = new URL(location.href);
      const needsCleanUrl = target.placement === "latest" && currentUrl.pathname === target.pathname && Boolean(currentUrl.search || currentUrl.hash);
      if (target.placement !== "native-search" && currentUrl.pathname === target.pathname && !needsCleanUrl) {
        // 路由相同不代表位置正确；收藏仍要滚到最新内容。
        reveal(target);
        return result(true, "already-current");
      }
      if (lastDispatch?.key === target.key && lastDispatch.fromHref === target.fromHref
        && now() - lastDispatch.at < DUPLICATE_WINDOW_MS) {
        if (lastDispatch.failed) return result(false, "native-router-failed");
        if (target.placement === "native-search") return nativeAcknowledgement(target, lastDispatch);
        // 新点击可以接管正在切换的会话，但旧点击的定位效果不会一起继承。
        reveal(target);
        return result(true, "navigation-pending");
      }

      let router, navigate;
      try { router = getRouter(); navigate = router?.navigate; } catch { /* 按能力缺失处理，仍须完成下面的归属检查。 */ }
      // 获取站点对象后再封口：任何旧账号、旧点击或用户手动离开都不能触发导航。
      if (!owns(checkIdentity(), target, true)) return result(false, "context-mismatch");
      if (!unchanged(target)) return result(false, "route-changed");
      if (!isIntentCurrent(target.navigationIntentId)) return result(false, "superseded");
      if (typeof navigate !== "function") return result(false, "native-router-unavailable");

      const remaining = Number.isFinite(target.loadDeadlineAt)
        ? Math.min(NATIVE_SEARCH_WINDOW_MS, target.loadDeadlineAt - now()) : NATIVE_SEARCH_WINDOW_MS;
      if (target.placement === "native-search" && remaining <= 0) return result(false, "native-router-timeout");

      const dispatch = lastDispatch = { key: target.key, fromHref: target.fromHref, at: now() };
      try {
        if (target.placement === "native-search") {
          // 搜索只委托一次官方路由，不运行 Tidy 定位器，也不进行整页补载。
          let timer;
          dispatch.promise = Promise.race([
            Promise.resolve(navigate.call(router, target.routeUrl)).then(() => true, () => false),
            new Promise(resolve => { timer = setTimer(() => resolve(false), remaining); }),
          ]).then(accepted => { dispatch.failed = !accepted; return accepted; }).finally(() => clearTimer(timer));
          return nativeAcknowledgement(target, dispatch);
        }
        // 日期/收藏仍使用已有 latest 定位；书签仍使用既有消息定位器。
        // 不等待站点 Promise（它可能永不结束）；定位器在有限时间内确认落点，
        // 搜索禁止整页补载；其它模块是否允许由后台各自的导航合同决定。
        // 异步拒绝须接住，不能成为未处理异常。
        Promise.resolve(navigate.call(router, target.pathname)).catch(() => { dispatch.failed = true; });
        reveal(target);
        return result(true, "native-router");
      } catch {
        // 同步抛错也可能已经改变 URL。后台必须重新核对当前文档、账号和路由，
        // 不能直接把失败当作再次打开任意页面的许可。
        dispatch.failed = true;
        return result(false, "native-router-failed");
      }
    }

    function navigate(payload) {
      const target = targetFor(payload, location);
      if (!target) return Promise.resolve(result(false, "invalid-target"));
      if (!isIntentCurrent(target.navigationIntentId)) return Promise.resolve(result(false, "superseded"));
      // 只有同一点击才共用 Promise；新点击不能加入已经过期的旧操作。
      if (inFlight && inFlight.id === target.navigationIntentId) return inFlight.key === target.key
        ? inFlight.promise : Promise.resolve(result(false, "navigation-in-progress"));
      const request = { key: target.key, id: target.navigationIntentId, promise: null };
      // 先登记再调用依赖，防止原生回调重入造成重复派发。
      request.promise = Promise.resolve().then(() => perform(target)).finally(() => {
        if (inFlight === request) inFlight = null;
      });
      inFlight = request;
      return request.promise;
    }

    return Object.freeze({ navigate });
  }

  global.TidyChatgptLibraryNavigation = Object.freeze({ create, DUPLICATE_WINDOW_MS, NATIVE_SEARCH_WINDOW_MS });
})(globalThis);
