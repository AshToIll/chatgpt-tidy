// This fixture imports the unmodified production modules through its HTML.
// Every scroll, rectangle and layout below belongs to real Chromium DOM. The
// scrollTo wrapper records calls and delegates to the original native method;
// it never supplies a fabricated position or success result.
const resultsElement = document.getElementById('qa-results');
const sceneElement = document.getElementById('scene');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const round = value => Math.round(value * 100) / 100;
const network = { fetch: 0, xhr: 0, webSocket: 0, authReads: 0 };

// Independent receipt oracle: test the painted target against the actual
// browser screen and every clipping ancestor, not the controller's centering
// formula. A locally centered message can still be outside an outer scroller.
function screenEvidence(element) {
  if (!element?.isConnected) return { connected: false, visible: false };
  const rect = element.getBoundingClientRect(), visual = window.visualViewport;
  const bounds = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const clips = [];
  function clip(box, x = true, y = true) {
    if (x) { bounds.left = Math.max(bounds.left, box.left); bounds.right = Math.min(bounds.right, box.right); }
    if (y) { bounds.top = Math.max(bounds.top, box.top); bounds.bottom = Math.min(bounds.bottom, box.bottom); }
  }
  if (visual) clip({ left: visual.offsetLeft, top: visual.offsetTop,
    right: visual.offsetLeft + visual.width, bottom: visual.offsetTop + visual.height });
  let painted = true;
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    painted &&= style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && Number(style.opacity) !== 0;
    if (node === element) continue;
    const x = /^(auto|scroll|overlay|hidden|clip)$/.test(style.overflowX);
    const y = /^(auto|scroll|overlay|hidden|clip)$/.test(style.overflowY);
    if (!x && !y) continue;
    const border = node.getBoundingClientRect();
    const box = { left: border.left + node.clientLeft, top: border.top + node.clientTop,
      right: border.left + node.clientLeft + node.clientWidth, bottom: border.top + node.clientTop + node.clientHeight };
    clips.push({ node: node.className || node.tagName, ...box, x, y });
    clip(box, x, y);
  }
  const visibleWidth = Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left);
  const visibleHeight = Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top);
  const x = (Math.max(rect.left, bounds.left) + Math.min(rect.right, bounds.right)) / 2;
  const y = (Math.max(rect.top, bounds.top) + Math.min(rect.bottom, bounds.bottom)) / 2;
  const hit = visibleWidth > 0 && visibleHeight > 0 ? document.elementFromPoint(x, y) : null;
  // Require the start and the entire short message (or a viewportful of a
  // long message), rather than accepting a one-pixel intersection.
  const anchorVisible = rect.top >= bounds.top - 1 &&
    rect.top + Math.min(rect.height, bounds.bottom - bounds.top) <= bounds.bottom + 1;
  return { connected: true, visible: painted && visibleWidth > 0 && visibleHeight > 0 && anchorVisible && !!hit && element.contains(hit),
    targetTop: round(rect.top), targetBottom: round(rect.bottom), screen: { width: innerWidth, height: innerHeight },
    bounds, clips, anchorVisible, hitTarget: !!hit && element.contains(hit), hitMessageId: hit?.closest('[data-message-id]')?.dataset.messageId || null };
}

// An accidental account or remote-I/O dependency fails this local-only fixture.
globalThis.fetch = () => { network.fetch++; throw new Error('Network is forbidden in this fixture.'); };
globalThis.XMLHttpRequest = class { constructor() { network.xhr++; throw new Error('XHR is forbidden.'); } };
globalThis.WebSocket = class { constructor() { network.webSocket++; throw new Error('WebSocket is forbidden.'); } };
globalThis.TidyChatgptApi = new Proxy({}, { get() { network.authReads++; throw new Error('Authentication is forbidden.'); } });

let wheelSequence = 0;
const wheelWaiters = new Map();
globalThis.completeBookmarkLandingInput = (id, error = null) => {
  const callback = wheelWaiters.get(id);
  if (!callback) return;
  wheelWaiters.delete(id);
  callback(error);
};
function nativeWheel(viewport, deltaY = 160) {
  // The runner receives a CDP binding event and dispatches a trusted Chromium
  // wheel input. A synthetic WheelEvent would not test the native input path.
  assert(typeof globalThis.bookmarkLandingInput === 'function', 'Runner wheel binding is missing.');
  const rect = viewport.getBoundingClientRect(), id = `wheel-${++wheelSequence}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { wheelWaiters.delete(id); reject(new Error('Native wheel input timed out.')); }, 2000);
    wheelWaiters.set(id, error => { clearTimeout(timeout); error ? reject(new Error(error)) : resolve(); });
    globalThis.bookmarkLandingInput(JSON.stringify({ id, x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2, deltaY }));
  });
}

function createScene() {
  sceneElement.replaceChildren();
  sceneElement.className = '';
  const left = document.createElement('aside'), right = document.createElement('aside');
  left.className = right.className = 'sidebar';
  const viewport = document.createElement('section');
  viewport.className = 'viewport';
  viewport.tabIndex = -1;
  const messages = new Map();
  for (let index = 0; index < 24; index++) {
    const article = document.createElement('article');
    article.dataset.messageId = `message-${index}`;
    const paragraph = document.createElement('p');
    paragraph.textContent = `Synthetic message ${index}. ` +
      'This locally generated paragraph wraps naturally when either sidebar changes width. '.repeat(5 + index % 3);
    article.append(paragraph);
    viewport.append(article);
    messages.set(article.dataset.messageId, article);
  }
  sceneElement.append(left, viewport, right);
  const startedAt = performance.now(), calls = [], revocations = [], cancellations = [], restores = [], timers = new Set();
  const nativeScrollTo = viewport.scrollTo, trackedPorts = [];
  let sequence = 0, route = 'synthetic-conversation', scroll, navigation, onTargetScroll = null;
  const ownerStamp = Object.freeze({ accountKey: 'synthetic-account-only', documentEpoch: 7 });
  const recordTime = () => round(performance.now() - startedAt);
  function later(callback, ms) {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
    timers.add(timer);
    return timer;
  }
  navigation = globalThis.TidyChatgptNavigationIntent.create({
    parseRoute: () => ({ conversationId: route }),
    onRevoked(event) {
      revocations.push({ ...event, atMs: recordTime() });
      scroll?.cancelId(event.navigationIntentId, event.reason);
    },
  });
  function trackScrollport(port, name) {
    const native = port.scrollTo;
    trackedPorts.push({ port, native });
    port.scrollTo = function (...args) {
      const options = typeof args[0] === 'object' ? args[0] : { left: args[0], top: args[1] };
      const before = port.scrollTop, top = options.top ?? before;
      const call = { port: name, atMs: recordTime(), intentId: navigation.getCurrent()?.navigationIntentId,
        behavior: options.behavior || 'auto', before: round(before), requestedTop: round(top),
        targetMovement: Math.abs(before - top) > 1 };
      calls.push(call);
      const result = native.apply(this, args);
      if (call.targetMovement) onTargetScroll?.(call);
      return result;
    };
  }
  trackScrollport(viewport, 'inner');
  scroll = globalThis.TidyChatgptMessageLocation.create({ document,
    resolveTarget(payload) {
      const element = messages.get(payload.messageId);
      return element?.isConnected ? { element } : { reason: 'message-not-mounted' };
    },
    assertCurrent(payload) {
      if (!navigation.isCurrent(payload.navigationIntentId) || payload.accountKey !== ownerStamp.accountKey
        || payload.documentEpoch !== ownerStamp.documentEpoch) throw new Error('Synthetic context no longer current.');
    },
    onCancelled(payload, reason) {
      cancellations.push({ id: payload.navigationIntentId, reason, atMs: recordTime() });
      if (navigation.isCurrent(payload.navigationIntentId)) navigation.cancel(reason);
    },
  });
  function start(index, options = {}) {
    const navigationIntentId = `synthetic-intent-${++sequence}`, messageId = `message-${index}`;
    messages.get(messageId)?.setAttribute('data-target', '');
    const packet = { navigationIntentId, workerEpoch: 100, sequence, phase: 'active', conversationId: route };
    assert(navigation.observe(packet).accepted, 'Current synthetic intent must install.');
    const payload = { navigationIntentId, conversationId: route, messageId, ...ownerStamp, ...options };
    const began = performance.now();
    let settled = false;
    const promise = scroll.start(payload).then(result => {
      settled = true;
      return { ...result, elapsedMs: round(performance.now() - began), errorPx: alignmentError(index),
        screen: screenEvidence(messages.get(messageId)), diagnostic: globalThis.TidyChatgptMessageLocation.getLastDiagnostic?.() || null };
    });
    return { packet, payload, promise, settled: () => settled };
  }
  function alignmentError(index) {
    const element = messages.get(`message-${index}`);
    if (!element?.isConnected || !viewport.isConnected) return null;
    const rect = element.getBoundingClientRect(), box = viewport.getBoundingClientRect();
    const wanted = viewport.scrollTop + rect.top - box.top - (viewport.clientHeight - Math.min(rect.height, viewport.clientHeight)) / 2;
    return round(Math.abs(viewport.scrollTop - Math.max(0, Math.min(wanted, viewport.scrollHeight - viewport.clientHeight))));
  }
  function restore(top, reason = 'synthetic-native-restore') {
    restores.push({ reason, atMs: recordTime(), top: round(top) });
    nativeScrollTo.call(viewport, { top, behavior: 'instant' });
  }
  return { viewport, left, right, messages, navigation, scroll, calls, revocations, cancellations, restores,
    later, start, restore, alignmentError, trackScrollport, setOnTargetScroll(callback) { onTargetScroll = callback; },
    routeChanged(value) { route = value; navigation.routeChanged(); },
    report() { return { targetMovements: calls.filter(call => call.targetMovement).length,
      scrollToCalls: [...calls], nativeRestores: [...restores], revocations: [...revocations], cancellations: [...cancellations] }; },
    dispose() { for (const timer of timers) clearTimeout(timer); timers.clear(); scroll.dispose();
      for (const { port, native } of trackedPorts) port.scrollTo = native; },
  };
}

function assertLanded(result) {
  assert(result.located === true, `Expected a stable landing, received ${JSON.stringify({ located: result.located,
    reason: result.reason, scrolls: result.scrolls, elapsedMs: result.elapsedMs, screen: result.screen })}.`);
  assert(result.screen.visible, `Receipt is not painted inside the real screen and all clipping ancestors: ${JSON.stringify(result.screen)}.`);
  assert(result.scrolls <= 3, 'Production exceeded its three-scroll correction budget.');
}

globalThis.runBookmarkLandingChecks = async () => {
  const tests = [], startedAt = performance.now();
  async function test(name, run) {
    const scene = createScene(), began = performance.now();
    try {
      const detail = await run(scene);
      tests.push({ name, ok: true, durationMs: round(performance.now() - began), ...detail, ...scene.report() });
    } catch (error) {
      tests.push({ name, ok: false, durationMs: round(performance.now() - began), error: error.stack || String(error), ...scene.report() });
    } finally { scene.dispose(); }
    resultsElement.textContent = JSON.stringify({ completed: tests.length, tests }, null, 2);
  }

  await test('Native smooth scroll does not immediately acknowledge success', async scene => {
    const intent = scene.start(13);
    await wait(40);
    const early = { settled: intent.settled(), scrollTop: round(scene.viewport.scrollTop), errorPx: scene.alignmentError(13) };
    assert(!early.settled, 'Smooth dispatch was incorrectly treated as a success receipt.');
    assert(early.errorPx > 6, 'The early sample must exercise an unfinished native animation.');
    const result = await intent.promise;
    assertLanded(result);
    assert(result.elapsedMs >= 1150, 'The stable observation window was skipped.');
    return { early, result };
  });

  await test('Both sidebar width changes reflow real text before a stable receipt', async scene => {
    const before = scene.messages.get('message-13').getBoundingClientRect().top;
    const intent = scene.start(13);
    scene.later(() => { scene.left.style.width = '235px'; }, 150);
    scene.later(() => { scene.right.style.width = '265px'; }, 350);
    const result = await intent.promise;
    assertLanded(result);
    assert(Math.abs(scene.viewport.getBoundingClientRect().width - 540) <= 1, 'The fixture did not apply both sidebar widths.');
    assert(result.scrolls >= 2, 'A real responsive reflow should need a corrective target scroll.');
    return { initialTargetTop: round(before), finalViewportWidth: scene.viewport.clientWidth,
      finalOuterWidth: round(scene.viewport.getBoundingClientRect().width), result };
  });

  await test('Delayed native restoration is corrected before acknowledgement', async scene => {
    const intent = scene.start(13);
    scene.later(() => scene.restore(50), 900);
    const result = await intent.promise;
    assertLanded(result);
    assert(result.scrolls >= 2 && result.elapsedMs >= 1350, 'Receipt did not wait for the delayed restoration to settle.');
    return { result };
  });

  await test('A target mounted after the click uses the remaining bounded window', async scene => {
    const element = scene.messages.get('message-13'), placeholder = document.createElement('div');
    placeholder.style.height = `${element.getBoundingClientRect().height}px`;
    element.replaceWith(placeholder);
    const intent = scene.start(13);
    await wait(130);
    assert(!intent.settled() && scene.calls.length === 0, 'Unmounted messages must neither scroll nor acknowledge.');
    placeholder.replaceWith(element);
    const result = await intent.promise;
    assertLanded(result);
    return { mountedAfterMs: 130, result };
  });

  await test('A newer shared navigation intent wins and delayed old START cannot act', async scene => {
    const older = scene.start(19);
    await wait(100);
    const newer = scene.start(4), callsBeforeStale = scene.calls.length;
    const staleStart = await scene.scroll.start(older.payload);
    assert(scene.calls.length === callsBeforeStale, 'Delayed old START dispatched a physical scroll.');
    assert(!scene.navigation.observe(older.packet).accepted, 'Old navigation control packet was revived.');
    const olderResult = await older.promise, result = await newer.promise;
    assert(olderResult.located === false && olderResult.reason === 'superseded', 'Replacement must revoke the old landing.');
    assert(staleStart.located === false && staleStart.reason === 'context-changed', 'Old START did not fail closed.');
    assertLanded(result);
    return { olderResult, staleStart, result };
  });

  await test('Trusted native wheel input cancels and does not pull the user back', async scene => {
    let trustedWheel = false;
    scene.viewport.addEventListener('wheel', event => { trustedWheel ||= event.isTrusted; }, { once: true });
    const intent = scene.start(13);
    await wait(140);
    await nativeWheel(scene.viewport, 180);
    const result = await intent.promise;
    assert(trustedWheel, 'This case requires trusted Chromium wheel input, not a synthetic DOM event.');
    assert(!result.located && result.reason === 'user-cancelled', 'Manual wheel input did not cancel the landing.');
    assert(!scene.navigation.isCurrent(intent.payload.navigationIntentId), 'Cancelled shared intent remained active.');
    await wait(180);
    const afterInput = scene.viewport.scrollTop, afterCalls = scene.calls.length;
    await wait(600);
    assert(Math.abs(scene.viewport.scrollTop - afterInput) <= 1, 'Cancelled landing pulled the user back.');
    assert(scene.calls.length === afterCalls, 'Cancelled landing retained a later scroll timer.');
    return { trustedWheel, finalScrollTop: round(scene.viewport.scrollTop), result };
  });

  await test('A short total deadline expires without an early success receipt', async scene => {
    const element = scene.messages.get('message-13');
    element.remove();
    const intent = scene.start(13, { remainingMs: 430, deadlineAt: Date.now() + 430 });
    const result = await intent.promise;
    // No target ever mounted, so this exhausts loading, not the landing phase.
    // Keep the real elapsed-time and zero-scroll assertions below unchanged.
    assert(!result.located && result.reason === 'target-timeout', 'Missing target did not exhaust its total deadline.');
    assert(result.elapsedMs >= 380 && result.elapsedMs < 900, 'Total deadline was restarted or ignored.');
    assert(result.scrolls === 0 && scene.calls.length === 0, 'Missing target generated a fabricated scroll.');
    return { suppliedDeadlineMs: 430, result };
  });

  await test('Repeated native restorations stop at three target scrolls', async scene => {
    scene.setOnTargetScroll(() => scene.later(() => scene.restore(35, 'repeated-native-restore'), 80));
    const intent = scene.start(13);
    const result = await intent.promise;
    assert(!result.located && result.reason === 'landing-unstable', 'Repeated restoration should fail as unstable.');
    assert(result.scrolls === 3, `Expected exactly three bounded target attempts, received ${result.scrolls}.`);
    assert(scene.calls.filter(call => call.targetMovement).length === 3, 'Physical target movements exceeded the budget.');
    assert(result.elapsedMs < 2400, 'Correction budget did not terminate within the bounded window.');
    const count = scene.calls.length;
    await wait(450);
    assert(scene.calls.length === count, 'Failed landing continued to issue target scrolls.');
    return { result };
  });

  await test('After completion ordinary scrolling has no bookmark rebound', async scene => {
    const result = await scene.start(13).promise;
    assertLanded(result);
    const count = scene.calls.length;
    scene.restore(120, 'ordinary-scroll-after-completion');
    await wait(650);
    assert(Math.abs(scene.viewport.scrollTop - 120) <= 1, 'Completed bookmark navigation bounced back.');
    assert(scene.calls.length === count, 'Completed landing left a live correction loop.');
    return { result, ordinaryScrollTop: round(scene.viewport.scrollTop) };
  });

  await test('Favorite latest destination supersedes a bookmark and settles at the conversation end after native restoration', async scene => {
    const bookmark = scene.start(3);
    await wait(120);
    const latest = scene.start(3, { placement: 'latest' });
    scene.later(() => scene.restore(500, 'restore-old-bookmark-position'), 800);
    const old = await bookmark.promise, result = await latest.promise;
    assert(!old.located, 'Old bookmark must not win after the Favorite click');
    assert(result.located, `Latest destination did not settle: ${JSON.stringify(result)}`);
    assert(Math.abs(scene.viewport.scrollHeight - scene.viewport.clientHeight - scene.viewport.scrollTop) <= 6,
      'Latest destination was centered on the old bookmark instead of the actual conversation bottom');
    assert(result.scrolls <= 3, 'Latest placement exceeded the shared scroll budget');
    const before = scene.calls.length;
    scene.restore(600, 'user-scroll-after-favorite'); await wait(900);
    assert(scene.viewport.scrollTop === 600 && scene.calls.length === before, 'Completed Favorite kept pulling the user back');
    return { old, latest: result };
  });

  await test('Leaving the destination cancels and its tombstone cannot revive', async scene => {
    const intent = scene.start(13);
    await wait(100);
    scene.routeChanged('synthetic-other-conversation');
    const result = await intent.promise;
    assert(!result.located && result.reason === 'route-changed', 'Manual route change did not revoke the landing.');
    assert(!scene.navigation.observe(intent.packet).accepted, 'Cancelled intent tombstone was revived.');
    const count = scene.calls.length, positions = [{ afterCancelMs: 0, top: scene.viewport.scrollTop }];
    // Chromium can commit one already-queued compositor frame after an instant
    // stop. Record that residue rather than confusing it with a live timer or
    // another target attempt; movement must cease after the first 60 ms.
    for (const afterCancelMs of [60, 180, 400]) {
      await wait(afterCancelMs - positions.at(-1).afterCancelMs);
      positions.push({ afterCancelMs, top: scene.viewport.scrollTop });
    }
    assert(scene.calls.length === count, 'Old route dispatched another physical scroll command.');
    assert(positions.slice(2).every(position => Math.abs(position.top - positions[1].top) <= 1),
      `Old route continued scrolling after cancellation: ${JSON.stringify(positions)}.`);
    assert(scene.alignmentError(13) > 6, 'Revoked navigation nevertheless reached the old target.');
    return { result, positionsAfterCancellation: positions };
  });

  await test('First click corrects the outer nested clip when the inner-centered target starts at top -2', async scene => {
    // Real DOM analogue of the first-click counterexample: inner is centered,
    // but its outer scroll position clips the target above the actual screen.
    sceneElement.className = 'nested-scene';
    const outer = document.createElement('section'), tail = document.createElement('div');
    outer.className = 'nested-outer';
    tail.style.height = '1600px';
    scene.viewport.className = 'nested-inner';
    const before = document.createElement('div'), after = document.createElement('div');
    before.style.height = '1000px'; after.style.height = '2960px';
    const target = document.createElement('article');
    target.dataset.messageId = 'message-13'; target.className = 'nested-target';
    target.textContent = 'Synthetic nested target, first click only';
    scene.viewport.replaceChildren(before, target, after);
    scene.messages.set('message-13', target);
    outer.append(scene.viewport, tail);
    sceneElement.replaceChildren(outer);
    scene.trackScrollport(outer, 'outer');
    scene.viewport.scrollTop = 720;
    outer.scrollTop = 382;
    const initial = screenEvidence(target), initialInner = scene.viewport.scrollTop;
    assert(initial.targetTop === -2 && !initial.visible, `Counterexample did not start at the real clipped -2px position: ${JSON.stringify(initial)}.`);
    const result = await scene.start(13).promise;
    assertLanded(result);
    const moves = scene.calls.filter(call => call.targetMovement);
    assert(moves.length > 0 && moves[0].port === 'outer', 'First click must correct the outer scrollport, not merely recenter hidden inner content.');
    assert(scene.viewport.scrollTop === initialInner && outer.scrollTop < 382, 'The inner-centered target should be exposed by outer scrolling.');
    assert(result.screen.hitMessageId === 'message-13', 'Actual screen hit testing did not reach the requested target.');
    return { initial, finalOuterScrollTop: outer.scrollTop, finalInnerScrollTop: scene.viewport.scrollTop, result };
  });

  await test('A local scrollport extending above the window cannot acknowledge an offscreen target', async scene => {
    // No fabricated viewport metrics: the fixed DOM scrollport really crosses
    // the top of Chromium's window, with its lower portion still visible.
    sceneElement.className = 'window-clipped-scene';
    const target = scene.messages.get('message-13');
    const box = scene.viewport.getBoundingClientRect(), rect = target.getBoundingClientRect();
    scene.viewport.scrollTop += rect.top - box.top - (scene.viewport.clientHeight - rect.height) / 2;
    const initial = screenEvidence(target);
    assert(initial.targetTop < 0 && !initial.visible, 'Window-clipping setup must hide the locally centered message start.');
    const result = await scene.start(13).promise;
    assertLanded(result);
    assert(result.scrolls > 0 && result.screen.targetTop >= 0 && result.screen.hitTarget,
      'The first receipt must follow a real correction into the visible browser window.');
    return { initial, result };
  });

  await test('Same-rectangle target and clipping-ancestor replacements each restart stability', async scene => {
    const intent = scene.start(13), began = performance.now(), replacements = [];
    function replace(kind) {
      const oldNode = kind === 'target' ? scene.messages.get('message-13') : scene.viewport;
      const before = oldNode.getBoundingClientRect(), replacement = oldNode.cloneNode(kind === 'target');
      const savedTop = oldNode.scrollTop;
      if (kind === 'ancestor') replacement.append(...oldNode.childNodes);
      oldNode.replaceWith(replacement);
      replacement.scrollTop = savedTop;
      if (kind === 'target') scene.messages.set('message-13', replacement);
      else scene.trackScrollport(replacement, 'replacement-inner');
      const after = replacement.getBoundingClientRect();
      replacements.push({ kind, atMs: round(performance.now() - began), oldConnected: oldNode.isConnected,
        sameRectangle: ['top', 'left', 'width', 'height'].every(key => Math.abs(before[key] - after[key]) < 0.1) });
    }
    // Both replacements occur after native scrolling has settled. Geometry is
    // unchanged; only actual node identity can invalidate the old stable age.
    scene.later(() => replace('target'), 950);
    scene.later(() => replace('ancestor'), 1250);
    const result = await intent.promise;
    assertLanded(result);
    assert(replacements.length === 2 && replacements.every(item => !item.oldConnected && item.sameRectangle),
      `The fixture must replace both live DOM identities without changing their rectangles: ${JSON.stringify(replacements)}.`);
    assert(result.elapsedMs >= replacements[1].atMs + 360,
      'A receipt inherited the previous target/ancestor stable age instead of observing the replacement DOM.');
    assert(result.screen.hitMessageId === 'message-13', 'Receipt did not refer to the live replacement target.');
    return { replacements, result };
  });

  await test('A scrolled document cannot move a viewport-fixed conversation subtree', async scene => {
    const pageContent = document.createElement('div');
    pageContent.style.height = '2500px';
    document.body.append(pageContent);
    const root = document.scrollingElement;
    try {
      root.scrollTop = 800;
      scene.trackScrollport(root, 'document-root');
      const fixedTop = scene.viewport.getBoundingClientRect().top;
      assert(root.scrollTop === 800 && fixedTop === 25, 'The document must scroll independently of the fixed conversation.');
      const result = await scene.start(13).promise;
      assertLanded(result);
      assert(!scene.calls.some(call => call.port === 'document-root' && call.targetMovement),
        'Document scrolling was used to correct a fixed descendant which it cannot move.');
      return { fixedTop, documentScrollTop: root.scrollTop, result };
    } finally { pageContent.remove(); root.scrollTop = 0; }
  });

  const report = { ok: tests.every(test => test.ok) && Object.values(network).every(count => count === 0),
    fixture: 'production message-location.js + navigation-intent.js; real Chromium layout and native scrolling',
    isolatedSyntheticData: true, realTime: true, elapsedMs: round(performance.now() - startedAt),
    browser: navigator.userAgent, network, passed: tests.filter(test => test.ok).length, total: tests.length, tests };
  resultsElement.dataset.complete = 'true';
  resultsElement.textContent = JSON.stringify(report, null, 2);
  globalThis.bookmarkLandingReport = report;
  return report;
};
globalThis.bookmarkLandingReady = true;
