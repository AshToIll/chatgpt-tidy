(function initTidyChatgptMessageLocation(global) {
  "use strict";
  if (global.TidyChatgptMessageLocation) return;

  // Product tuning: scroll immediately, but acknowledge only a stable landing.
  // One executor for explicit search/bookmark commands. Waiting for a target
  // consumes the worker's original deadline; landing has its own smaller cap.
  // Neither phase starts from a snapshot, focus or background heartbeat.
  const SAMPLE_MS = 60;
  const QUIET_MS = 180;
  const SMOOTH_GRACE_MS = 600;
  const STABLE_MS = 360;
  const OBSERVE_MS = 1_200;
  const WINDOW_MS = 2_400;
  const MAX_SCROLLS = 3; // exact-message initial move + at most two corrections
  const MAX_LOAD_SCROLLS = 2; // reveal + one measured native anchor-restoration correction
  const TOLERANCE_PX = 6;
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  // Passive, bounded local evidence for the last click. No account, message
  // ID/text, network, storage or background sampler is involved. A live recheck
  // can distinguish an unstarted/cancelled verifier from a false landing.
  let lastDiagnostic = null;

  function create({ resolveTarget, assertCurrent, resolveLoadTarget = () => null, prepareAnchor = () => null, onCancelled = () => {}, document = global.document,
    now = () => Date.now(), setTimer = (fn, ms) => global.setTimeout(fn, ms), clearTimer = id => global.clearTimeout(id) }) {
    let active = null;
    function record(intent, phase, found = null, movement = null) {
      const diagnostic = intent.diagnostic;
      diagnostic.phase = phase;
      diagnostic.elapsedMs = now() - intent.startedAt;
      diagnostic.scrolls = intent.scrolls;
      diagnostic.loads = intent.loads;
      if (found) diagnostic.geometry = { targetTop: found.targetTop, visibleTop: found.visibleTop,
        visibleBottom: found.visibleBottom, visible: found.visible, aligned: found.aligned,
        documentReady: found.ready, ports: found.portMetrics };
      if (phase !== "sample") {
        diagnostic.events.push({ phase, elapsedMs: diagnostic.elapsedMs, scrolls: diagnostic.scrolls,
          geometry: diagnostic.geometry || null, ...(movement ? { movement } : {}) });
        if (diagnostic.events.length > 32) diagnostic.events.shift();
      }
    }
    function stopMotion(intent) {
      // Stop an in-progress native smooth animation at its CURRENT position;
      // this is not another attempt to pull the user back to the bookmark.
      for (const viewport of intent.touched) {
        // A native-wrapper callback can synchronously start a new intent.
        // Never let the old multi-port cleanup stop that newer animation.
        if (active) break;
        try { viewport.scrollTo({ top: viewport.scrollTop, left: viewport.scrollLeft || 0, behavior: "instant" }); }
        catch { /* A retired scrollport must not prevent stopping the others. */ }
      }
    }
    function finish(intent, result, stop = false) {
      if (active !== intent) return;
      active = null;
      if (intent.timer !== null) clearTimer(intent.timer);
      if (stop) stopMotion(intent);
      record(intent, "finished");
      Object.assign(intent.diagnostic, { pending: false, located: result.located, reason: result.reason });
      intent.resolve({ ...result, scrolls: intent.scrolls, loads: intent.loads });
    }
    function cancel(reason = "cancelled", notify = false) {
      const intent = active;
      if (!intent) return;
      finish(intent, { located: false, reason }, true);
      if (notify) onCancelled(intent.payload, reason);
    }
    const clipsAxis = value => /^(auto|scroll|overlay|hidden|clip)$/.test(value);
    const scrollsAxis = value => /^(auto|scroll|overlay|hidden)$/.test(value);
    function intersect(box, clip, x = true, y = true) {
      return { left: x ? Math.max(box.left, clip.left) : box.left, right: x ? Math.min(box.right, clip.right) : box.right,
        top: y ? Math.max(box.top, clip.top) : box.top, bottom: y ? Math.min(box.bottom, clip.bottom) : box.bottom };
    }
    const hasArea = box => box.right > box.left && box.bottom > box.top;
    function containsAnchor(rect, box) {
      // Short messages must be fully visible, not merely intersect by one
      // pixel. For long messages the beginning must remain in the real view.
      return hasArea(box) && rect.left < box.right && rect.right > box.left
        && rect.top >= box.top - TOLERANCE_PX
        && rect.top + Math.min(rect.height, box.bottom - box.top) <= box.bottom + TOLERANCE_PX;
    }
    function geometry(element, anchor = null, placement = null) {
      if (element.isConnected !== true) return null;
      // Search may anchor a range INSIDE the exact message, never another node.
      if (anchor && (!element.contains?.(anchor.startContainer) || !element.contains?.(anchor.endContainer))) return null;
      const rect = anchor?.getBoundingClientRect() || element.getBoundingClientRect();
      const visual = global.visualViewport;
      const width = visual?.width || global.innerWidth || document.documentElement.clientWidth;
      const height = visual?.height || global.innerHeight || document.documentElement.clientHeight;
      const screen = { left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0,
        right: (visual?.offsetLeft || 0) + width, bottom: (visual?.offsetTop || 0) + height };
      if (!hasArea(screen) || !(rect.width > 0) || !(rect.height > 0)) return null;
      const clips = [], ports = [], nodes = [element], seen = new Set();
      let viewportFixed = false;
      // A local scrollport can itself sit outside another clipping ancestor.
      // Read the entire bounded ancestor chain and the browser visual viewport;
      // being centered inside the nearest overflow:auto is NOT a landing.
      for (let node = element, depth = 0; node; node = node.parentElement, depth++) {
        if (depth >= 100 || seen.has(node)) return null;
        seen.add(node);
        const style = global.getComputedStyle(node);
        if (style.display === "none" || /^(hidden|collapse)$/.test(style.visibility)
          || node.hidden || node.getAttribute?.("aria-hidden") === "true" || node.hasAttribute?.("inert")) return null;
        // A viewport-fixed subtree is not moved or clipped by DOM ancestors
        // above its fixed boundary. offsetParent supplies the browser's actual
        // containing-block proof: transformed fixed descendants have a non-null
        // containing block, so we must NOT stop at those. Still check hidden
        // DOM ancestors even after the geometric chain has ended.
        if (viewportFixed) continue;
        if (style.position === "fixed" && node.offsetParent === null) {
          viewportFixed = true;
          if (!nodes.includes(node)) nodes.push(node);
        }
        if (!depth) continue;
        const root = node === document.scrollingElement;
        const border = root ? null : node.getBoundingClientRect();
        const box = root ? { ...screen } : { top: border.top + node.clientTop, left: border.left + node.clientLeft,
          bottom: border.top + node.clientTop + node.clientHeight, right: border.left + node.clientLeft + node.clientWidth };
        const x = root || clipsAxis(style.overflowX), y = root || clipsAxis(style.overflowY);
        if (x || y) { clips.push({ node, box, x, y, depth }); nodes.push(node); }
        if ((root || scrollsAxis(style.overflowY)) && node.scrollHeight > node.clientHeight + 1) {
          // column-reverse uses a bottom-origin scroll range: latest is 0,
          // and older content has negative scrollTop. Keep real per-port bounds
          // for both latest placement and exact bookmark/placeholder geometry.
          const extent = Math.max(0, node.scrollHeight - node.clientHeight);
          const reversed = /^(inline-)?flex$/.test(style.display) && style.flexDirection === "column-reverse";
          ports.push({ viewport: node, box, depth, minTop: reversed ? -extent : 0, maxTop: reversed ? 0 : extent });
          if (!nodes.includes(node)) nodes.push(node);
        }
      }
      if (!ports.length && placement !== "latest") return null;
      if (placement === "latest") {
        // 收藏会话的目标是正文滚动区域的末尾，不是当前可见/被收藏的某条消息。
        // 复用同一个有截止时间、可被用户打断的落稳器，避免两套滚动逻辑抢位置。
        for (const port of ports) {
          let usable = screen;
          for (const clip of clips) if (clip.depth >= port.depth) usable = intersect(usable, clip.box, clip.x, clip.y);
          port.top = port.maxTop;
          port.canMove = hasArea(usable) && Math.abs(port.viewport.scrollTop - port.top) > TOLERANCE_PX;
        }
        let visibleBox = screen;
        for (const clip of clips) visibleBox = intersect(visibleBox, clip.box, clip.x, clip.y);
        const move = ports.find(port => port.canMove) || null;
        const visible = hasArea(visibleBox), aligned = visible && ports.every(port => Math.abs(port.viewport.scrollTop - port.top) <= TOLERANCE_PX);
        return { element, viewport: ports.at(-1)?.viewport || null, move, visible, aligned,
          ready: document.readyState === "complete", nodes,
          targetTop: visibleBox.bottom, visibleTop: visibleBox.top, visibleBottom: visibleBox.bottom,
          portMetrics: ports.map(port => ({ top: port.box.top, bottom: port.box.bottom, scrollTop: port.viewport.scrollTop,
            root: port.viewport === document.scrollingElement })),
          values: [visibleBox.top, visibleBox.bottom, document.readyState === "complete" ? 1 : 0,
            ...ports.flatMap(port => [port.top - port.viewport.scrollTop, port.viewport.scrollHeight, port.box.top, port.box.bottom])] };
      }
      let visibleBox = screen;
      for (const clip of clips) visibleBox = intersect(visibleBox, clip.box, clip.x, clip.y);
      for (const port of ports) {
        let usable = screen;
        // A scroller cannot move its own box. If that box is off screen, an
        // outer scroller has to move first; never scroll its hidden contents.
        for (const clip of clips) if (clip.depth >= port.depth) usable = intersect(usable, clip.box, clip.x, clip.y);
        port.usable = usable;
        const anchorHeight = Math.min(rect.height, usable.bottom - usable.top);
        const wanted = port.viewport.scrollTop + rect.top - usable.top - (usable.bottom - usable.top - anchorHeight) / 2;
        port.top = Math.max(port.minTop, Math.min(wanted, port.maxTop));
        port.canMove = hasArea(usable) && Math.abs(port.viewport.scrollTop - port.top) > TOLERANCE_PX;
      }
      const primary = ports.at(-1);
      // Unclip the innermost blocker before centering in the outer live view.
      // Each actual command still consumes its loading or placement budget.
      const move = ports.find(port => !containsAnchor(rect, port.box) && port.canMove)
        || (primary.canMove ? primary : null);
      const visible = containsAnchor(rect, visibleBox);
      return { element, viewport: primary.viewport, move, visible,
        aligned: visible && !primary.canMove, ready: document.readyState === "complete", nodes,
        targetTop: rect.top, visibleTop: visibleBox.top, visibleBottom: visibleBox.bottom,
        portMetrics: ports.map(port => ({ top: port.box.top, bottom: port.box.bottom,
          scrollTop: port.viewport.scrollTop, root: port.viewport === document.scrollingElement })),
        values: [rect.top, rect.height, rect.left, rect.width, visibleBox.top, visibleBox.bottom, visibleBox.left, visibleBox.right,
          // Native virtualization can rebase scrollTop and content coordinates
          // together while the visible message stays still. Compare viewport
          // geometry and correction DELTA, not that invisible absolute origin.
          document.readyState === "complete" ? 1 : 0, ...ports.flatMap(port => [port.top - port.viewport.scrollTop,
            port.box.top, port.box.bottom, port.box.left, port.box.right])] };
    }
    function waitForIdentity(intent) {
      if (active !== intent) return;
      // A suspended command retains its original deadline and scroll budget.
      // Geometry observed before suspension cannot count toward a new receipt.
      intent.geometry = null; intent.stableAt = null; intent.changedAt = now();
      if (intent.diagnostic.phase !== "waiting-identity") record(intent, "waiting-identity");
      intent.timer = setTimer(() => sample(intent), Math.min(SAMPLE_MS, Math.max(0, intent.deadline - now())));
    }
    function sample(intent) {
      if (active !== intent) return;
      intent.timer = null;
      let ready;
      try { ready = assertCurrent(intent.payload) !== false; }
      catch { if (active === intent) cancel("context-changed", true); return; }
      if (active !== intent) return; // the local identity check may revoke it
      if (now() >= intent.deadline || (intent.landingAt === null && now() >= intent.loadDeadline)) {
        finish(intent, { located: false, reason: intent.landingAt === null ? "target-timeout" : "landing-timeout" }, true); return;
      }
      if (!ready) {
        waitForIdentity(intent);
        return;
      }
      // 无刷新尝试最多占用 6 秒（由后台传入绝对时间）。无动作、消息缺失、
      // 懒加载未完成都必须退出等待，让后台核对归属后整页补载一次。
      // 用户取消/离开和账号未确认已在上面拦截；补载不延长总预算。
      if (Number.isFinite(intent.payload.nativeFallbackAt) && now() >= intent.payload.nativeFallbackAt) {
        finish(intent, { located: false, reason: "native-target-missing" }, true); return;
      }
      let resolved, found, loading = false;
      try {
        resolved = resolveTarget(intent.payload);
        if (active !== intent) return;
        intent.diagnostic.targetReason = resolved?.reason || null;
        const contentReady = resolved?.contentReady !== false;
        const anchor = resolved?.element && contentReady ? prepareAnchor(resolved.element, intent.payload) : null;
        if (active !== intent) return;
        found = resolved?.element && contentReady ? geometry(resolved.element, anchor, intent.payload.placement) : null;
        // Native data hydration may restore its previous scroll anchor AFTER
        // the first reveal. A virtual target therefore uses the SAME geometry
        // controller and correction budget, not a fire-and-forget scroll or a
        // second loading retry loop. Only exact message geometry can finish.
        if (!found && intent.landingAt === null && resolved?.reason !== "conversation-mismatch") {
          const candidate = resolved?.element && !contentReady ? resolved : resolveLoadTarget(intent.payload);
          if (active !== intent) return;
          const virtual = candidate?.element ? geometry(candidate.element) : null;
          if (virtual?.ready) { found = virtual; loading = true; }
        }
      } catch { if (active === intent) cancel("target-unavailable", true); return; }
      if (active !== intent) return; // geometry may synchronously revoke/replace
      if (found) {
        if (!loading) intent.targetAt ??= now();
        // Loading includes native hydration and physical placement. An issued
        // scroll cannot start a verification window before the first visible,
        // aligned observation (cold native renders can block that next frame).
        // This boundary is crossed once; later drift/identity never renews it.
        if (!loading && found.aligned && found.ready && intent.landingAt === null) {
          intent.landingAt = now();
          intent.deadline = Math.min(intent.deadline, now() + WINDOW_MS);
          intent.observeMs = Math.min(OBSERVE_MS, Math.max(0, intent.deadline - now() - SAMPLE_MS));
        }
        // Evidence only: distinguish DOM replacement from actual numeric
        // motion. Both still invalidate stability; do not change settling
        // semantics until a live failure proves which one prevented landing.
        const initial = !intent.geometry;
        const nodesChanged = !initial && (found.nodes.length !== intent.nodes.length
          || found.nodes.some((node, index) => node !== intent.nodes[index]));
        const valuesChanged = !initial && (found.values.length !== intent.geometry.length
          || found.values.some((value, i) => Math.abs(value - intent.geometry[i]) > 1));
        const moved = initial || nodesChanged || valuesChanged;
        if (nodesChanged) intent.diagnostic.nodeReplacements++;
        if (valuesChanged) intent.diagnostic.geometryMoves++;
        if (moved) { intent.changedAt = now(); intent.stableAt = null; }
        intent.geometry = found.values;
        intent.nodes = found.nodes;
        intent.viewport = found.viewport;
        record(intent, moved ? "geometry-changed" : "sample", found,
          moved ? { initial, nodesChanged, valuesChanged } : null);
        // A smooth command is not a success receipt. Let its animation stop;
        // only correct a quiet but wrong position, not every intermediate frame.
        if ((loading ? !found.visible : !found.aligned) && found.move && (!intent.scrolls || (now() - intent.changedAt >= QUIET_MS
          && (intent.scrolls !== 1 || now() - intent.lastScrollAt >= SMOOTH_GRACE_MS)))) {
          if (loading ? intent.loads >= MAX_LOAD_SCROLLS : intent.scrolls - intent.loads >= MAX_SCROLLS) {
            finish(intent, { located: false, reason: loading ? "loading-unstable" : "landing-unstable" }, true); return;
          }
          try { ready = assertCurrent(intent.payload) !== false; }
          catch { if (active === intent) cancel("context-changed", true); return; }
          if (active !== intent) return;
          if (!ready) { waitForIdentity(intent); return; }
          intent.touched.add(found.move.viewport);
          found.move.viewport.scrollTo({ top: found.move.top, behavior: loading || intent.scrolls ? "instant" : "smooth" });
          if (active !== intent) return;
          intent.scrolls++;
          if (loading) intent.loads++;
          record(intent, loading ? "target-load" : "scroll", found);
          intent.lastScrollAt = now();
          intent.changedAt = now(); intent.stableAt = null;
        } else if (!loading && found.aligned && found.visible && found.ready && !moved) {
          intent.stableAt ??= now();
          if (now() - intent.stableAt >= STABLE_MS && now() - intent.targetAt >= intent.observeMs) {
            // Re-read exact DOM/Fiber + owner immediately before receipt; no
            // full message scan or authentication is necessary for this read.
            try { ready = assertCurrent(intent.payload) !== false; }
            catch { if (active === intent) cancel("context-changed", true); return; }
            if (active !== intent) return;
            if (!ready) { waitForIdentity(intent); return; }
            let presentation = {};
            const allowed = () => active === intent && now() < intent.deadline && assertCurrent(intent.payload) !== false && active === intent;
            try { if (intent.present) presentation = intent.present(found.element, allowed); }
            catch { if (active === intent) finish(intent, { located: false, reason: "presentation-failed" }, true); return; }
            if (active !== intent) return;
            try { ready = allowed(); }
            catch { if (active === intent) cancel("context-changed", true); return; }
            if (active !== intent) return;
            if (!ready) { waitForIdentity(intent); return; }
            if (intent.payload.placement !== "latest") found.element.animate?.([
              { outline: "2px solid color-mix(in srgb, currentColor 30%, transparent)", outlineOffset: "5px" },
              { outline: "2px solid transparent", outlineOffset: "12px" },
            ], { duration: 1400, easing: "ease-out" });
            finish(intent, { ...presentation, located: true, reason: null });
            return;
          }
        }
      } else {
        intent.geometry = null; intent.stableAt = null; intent.changedAt = now();
        if (intent.diagnostic.phase !== "waiting-target") record(intent, "waiting-target");
        // A DOM node can mount before its exact Fiber record. Missing binding
        // is a definite no-scroll state, not permission to guess its owner.
        // Wait within this same budget; an actual route/owner change cancels.
        if (resolved?.reason === "conversation-mismatch") {
          cancel(resolved.reason, true); return;
        }
      }
      intent.timer = setTimer(() => sample(intent), Math.min(SAMPLE_MS, Math.max(0, intent.deadline - now())));
    }
    function start(payload, { present = null } = {}) {
      // A delayed old START is not allowed to cancel a newer animation.
      try { assertCurrent(payload); }
      catch { return Promise.resolve({ located: false, reason: "context-changed", scrolls: 0 }); }
      cancel("superseded");
      const policy = global.TidyNavigationIdentity;
      const windowMs = Number.isFinite(payload?.deadlineAt) ? policy.LOAD_WINDOW_MS + policy.LANDING_WINDOW_MS : WINDOW_MS;
      const duration = Math.min(windowMs,
        Number.isFinite(payload?.deadlineAt) ? Math.max(0, payload.deadlineAt - now()) : windowMs);
      return new Promise(resolve => {
        const intent = { payload, present, resolve, startedAt: now(), targetAt: null, landingAt: null, deadline: now() + duration,
          loadDeadline: Number.isFinite(payload?.loadDeadlineAt) ? Math.min(payload.loadDeadlineAt, now() + duration) : now() + duration,
          observeMs: Math.min(OBSERVE_MS, Math.max(0, duration - SAMPLE_MS)), changedAt: now(), stableAt: null,
          timer: null, geometry: null, nodes: [], touched: new Set(), viewport: null, loads: 0, scrolls: 0, lastScrollAt: null,
          diagnostic: { navigationIntentId: payload.navigationIntentId, startedAt: now(), pending: true,
            nodeReplacements: 0, geometryMoves: 0, events: [] } };
        active = intent;
        lastDiagnostic = intent.diagnostic;
        record(intent, "started");
        sample(intent);
      });
    }
    function manual(event) {
      if (!active) return;
      if (event.type === "keydown") {
        if (!SCROLL_KEYS.has(event.key) || event.target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return;
      } else if (active.viewport && event.target !== active.viewport && !active.viewport.contains?.(event.target)) return;
      cancel("user-cancelled", true);
    }
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) document.addEventListener?.(type, manual, { capture: true, passive: true });
    return Object.freeze({ start, cancel,
      cancelId(id, reason = "cancelled") { if (active?.payload.navigationIntentId === id) cancel(reason); },
      dispose() {
        cancel("page-hidden", true);
        for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) document.removeEventListener?.(type, manual, { capture: true });
      } });
  }
  global.TidyChatgptMessageLocation = Object.freeze({ create, WINDOW_MS, MAX_SCROLLS, STABLE_MS, OBSERVE_MS,
    getLastDiagnostic: () => lastDiagnostic ? JSON.parse(JSON.stringify(lastDiagnostic)) : null });
})(globalThis);
