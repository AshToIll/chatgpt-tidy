const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodeTest = require('node:test');
// Bad fake-clock implementations must fail, not keep the whole suite waiting.
const test = (name, run) => nodeTest(name, { timeout: 3000 }, run);

function harness({ smoothMs = 300, budgetMs = 5000, missingReason = 'message-not-present', prepareAnchor, resolveLoadTarget } = {}) {
  let clock = 0, counter = 0, currentId = 'first', owner = true, ready = true, mounted = true, contentReady = true, shift = 0, height = 40, smoothTimer = null;
  const timers = new Map(), listeners = new Map(), commands = [], cancellations = [];
  const setTimer = (fn, ms) => { const id = ++counter; timers.set(id, { at: clock + ms, fn }); return id; };
  const clearTimer = id => timers.delete(id);
  const viewport = { scrollTop: 0, scrollHeight: 5000, clientHeight: 600, clientWidth: 800, clientTop: 0, clientLeft: 0,
    contains: value => value === element,
    getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 100, right: 900, width: 800, height: 600 }),
    scrollTo(value) {
      commands.push({ at: clock, ...value });
      if (smoothTimer != null) clearTimer(smoothTimer);
      if (value.behavior === 'smooth' && smoothMs) smoothTimer = setTimer(() => { viewport.scrollTop = value.top; smoothTimer = null; }, smoothMs);
      else viewport.scrollTop = value.top;
    } };
  let element = { isConnected: true, parentElement: viewport,
    getBoundingClientRect: () => ({ top: 1500 + shift - viewport.scrollTop, bottom: 1500 + shift - viewport.scrollTop + height,
      height, left: 120, right: 620, width: 500 }), animate() {} };
  const document = { body: {}, documentElement: { clientHeight: 900, clientWidth: 1000 }, readyState: 'complete',
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const context = vm.createContext({ document, innerHeight: 900, innerWidth: 1000,
    getComputedStyle: node => ({ overflowY: node === viewport ? 'auto' : 'visible', overflowX: 'visible' }) });
  vm.runInContext(fs.readFileSync('src/platform/navigation/navigation-identity.js', 'utf8') + fs.readFileSync('src/platform/navigation/chatgpt/message-location.js', 'utf8'), context);
  const nav = context.TidyChatgptMessageLocation.create({ document, now: () => clock, setTimer, clearTimer,
    resolveTarget: () => mounted ? { element, contentReady } : { element: null, reason: missingReason }, prepareAnchor, resolveLoadTarget,
    assertCurrent(payload) { if (!owner || payload.navigationIntentId !== currentId) throw Error('revoked'); return ready; },
    onCancelled: (payload, reason) => cancellations.push({ id: payload.navigationIntentId, reason }) });
  async function advance(ms) {
    const end = clock + ms;
    for (let i = 0; i < 1000; i++) {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
      if (!timer || timer.at > end) break;
      timers.delete(id); clock = timer.at; timer.fn(); await Promise.resolve();
      if (i === 999) throw Error('unbounded timer loop');
    }
    clock = end; await Promise.resolve();
  }
  return { nav, viewport, get element() { return element; }, document, context, timers, commands, cancellations, advance, setTimer,
    start: (id = currentId) => nav.start({ navigationIntentId: id, deadlineAt: clock + Math.min(2400, budgetMs) }),
    owner: value => { owner = value; }, ready: value => { ready = value; }, current: value => { currentId = value; },
    mounted: value => { mounted = value; }, contentReady: value => { contentReady = value; }, shift: value => { shift = value; }, height: value => { height = value; },
    replaceElement() { const previous = element; element = { ...element }; previous.isConnected = false; return element; },
    manual: (type, fields = {}) => listeners.get(type)?.({ type, target: element, ...fields }),
    block(ms) { clock += ms; for (const timer of timers.values()) if (timer.at < clock) timer.at = clock; },
    now: () => clock };
}

test('one bound virtual turn reveal precedes exact-message settlement, never counts as a landing', async () => {
  let placeholder;
  const h = harness({ smoothMs: 0, resolveLoadTarget: () => ({ element: placeholder }) });
  placeholder = { ...h.element }; h.mounted(false);
  let result;
  const pending = h.start().then(value => { result = value; });
  assert.equal(h.commands.length, 1); assert.equal(h.commands[0].behavior, 'instant');
  await h.advance(300);
  assert.equal(result, undefined); assert.equal(h.commands.length, 1, 'Do not repeatedly pull a virtual placeholder');
  h.mounted(true); h.shift(60);
  await h.advance(1500); await pending;
  assert.equal(result.located, true); assert.equal(result.loads, 1); assert.equal(result.scrolls, 2);
  assert.equal(h.timers.size, 0);
});

test('latest placement uses the conversation scrollport end, not the old bookmarked message', async () => {
  const h = harness({ smoothMs: 0 });
  const pending = h.nav.start({ navigationIntentId: 'first', placement: 'latest', deadlineAt: 4000 });
  assert.equal(h.commands[0].top, 4400);
  await h.advance(500);
  h.viewport.scrollTop = 1200; // 原生会话恢复旧书签附近的位置。
  await h.advance(2000);
  const result = await pending;
  assert.equal(result.located, true); assert.equal(h.viewport.scrollTop, 4400);
  assert.ok(result.scrolls <= 3); assert.equal(h.timers.size, 0);
  h.viewport.scrollTop = 1000; await h.advance(10000);
  assert.equal(h.viewport.scrollTop, 1000, 'completion retires the tail effect permanently');
});

test('a newer latest navigation cancels the old bookmark settling loop and itself yields to manual input', async () => {
  const h = harness({ smoothMs: 0 });
  const old = h.start(); h.current('favorite');
  const latest = h.nav.start({ navigationIntentId: 'favorite', placement: 'latest', deadlineAt: 4000 });
  assert.equal((await old).located, false); assert.equal(h.viewport.scrollTop, 4400);
  await h.advance(300); h.manual('wheel');
  assert.equal((await latest).reason, 'user-cancelled');
  h.viewport.scrollTop = 500; await h.advance(10000);
  assert.equal(h.viewport.scrollTop, 500);
});

test('latest placement follows bounded late content growth but cannot scroll a revoked owner', async () => {
  const h = harness({ smoothMs: 0 });
  const latest = h.nav.start({ navigationIntentId: 'first', placement: 'latest', deadlineAt: 4000 });
  await h.advance(400); h.viewport.scrollHeight += 500;
  await h.advance(2000); assert.equal((await latest).located, true);
  assert.equal(h.viewport.scrollTop, 4900);
  h.owner(false); const before = h.commands.length;
  assert.equal((await h.nav.start({ navigationIntentId: 'first', placement: 'latest' })).located, false);
  assert.equal(h.commands.length, before);
});

test('a revealed placeholder that never mounts ends within the original deadline with no successful receipt', async () => {
  let placeholder;
  const h = harness({ resolveLoadTarget: () => ({ element: placeholder }) });
  placeholder = { ...h.element }; h.mounted(false);
  const pending = h.start(); await h.advance(2500);
  const result = await pending;
  assert.equal(result.located, false); assert.equal(result.loads, 1); assert.equal(result.scrolls, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.commands.filter(c => c.at < 2400).length, 1);
});

test('native restore during a cold virtual reveal uses the same geometry correction budget before exact mounting', async () => {
  let placeholder;
  const h = harness({ smoothMs: 0, resolveLoadTarget: () => ({ element: placeholder }) });
  placeholder = { ...h.element }; h.mounted(false);
  const pending = h.start();
  // Observed native hydration restores the old anchor after the first reveal.
  // A later stable position change is geometry evidence, not a blind retry.
  h.setTimer(() => { h.viewport.scrollTop = 0; }, 40);
  h.setTimer(() => { if (h.commands.length === 2 && h.viewport.scrollTop > 1000) h.mounted(true); }, 800);
  await h.advance(2500); await pending;
  const result = h.context.TidyChatgptMessageLocation.getLastDiagnostic();
  assert.equal(result.located, true); assert.equal(result.loads, 2);
  assert.equal(result.scrolls, 2, 'Loading and landing share the same physical command counter');
});

test('native virtual restore cannot create another budget or exceed the shared physical command cap', async () => {
  let placeholder;
  const h = harness({ smoothMs: 0, resolveLoadTarget: () => ({ element: placeholder }) });
  placeholder = { ...h.element }; h.mounted(false);
  const scroll = h.viewport.scrollTo;
  h.viewport.scrollTo = value => { scroll(value); h.setTimer(() => { h.viewport.scrollTop = 0; }, 40); };
  const pending = h.start(); await h.advance(2500); const result = await pending;
  assert.equal(result.located, false); assert.equal(result.scrolls, 2); assert.equal(result.loads, 2);
  assert.equal(result.reason, 'loading-unstable');
  assert.equal(h.timers.size, 0);
});

test('native virtual-height rebasing is not visible motion when the exact target and viewport stay fixed', async () => {
  const h = harness({ smoothMs: 0 }); let result;
  const pending = h.start().then(value => { result = value; });
  const base = h.viewport.scrollTop;
  for (let time = 100; time <= 2000; time += 60) h.setTimer(() => {
    h.shift(time); h.viewport.scrollTop = base + time;
  }, time);
  await h.advance(1400);
  assert.equal(result?.located, true, 'Offscreen virtual-height bookkeeping must not restart visible stability');
  assert.equal(h.commands.length, 1); await pending;
});

test('identity waiting and inert virtual placeholders cannot cause a loading scroll', async () => {
  let placeholder;
  const h = harness({ resolveLoadTarget: () => ({ element: placeholder }) });
  placeholder = { ...h.element, hasAttribute: name => name === 'inert' };
  h.mounted(false); h.ready(false);
  const pending = h.start(); await h.advance(200); h.ready(true); await h.advance(300);
  assert.equal(h.commands.length, 0);
  h.current('new'); await h.advance(60); await pending;
  assert.equal(h.commands.length, 0); assert.equal(h.timers.size, 0);
});

test('a smooth command is not acknowledged until the target actually lands and stays stable', async () => {
  const h = harness(); let result;
  const pending = h.start().then(value => { result = value; });
  assert.equal(h.commands.length, 1); assert.equal(h.viewport.scrollTop, 0); assert.equal(result, undefined);
  await h.advance(1100); assert.equal(result, undefined);
  await h.advance(200); await pending;
  assert.equal(result.located, true); assert.equal(result.scrolls, 1); assert.equal(h.viewport.scrollTop, 1120);
  await h.advance(10000); assert.equal(h.commands.length, 1); assert.equal(h.timers.size, 0);
});

test('the common executor centers a search range inside the exact message, not the message beginning', async () => {
  const text = {};
  const h = harness({ smoothMs: 0, prepareAnchor: element => ({ startContainer: text, endContainer: text,
    getBoundingClientRect: () => { const box = element.getBoundingClientRect();
      return { ...box, top: box.top + 100, bottom: box.top + 120, height: 20 }; } }) });
  h.element.contains = node => node === text;
  const pending = h.start(); await h.advance(1500);
  assert.equal((await pending).located, true);
  assert.equal(h.viewport.scrollTop, 1210, 'Keyword, rather than message top, is centered in the same scrollport');
});

test('a display anchor outside the exact message cannot redirect the common executor', async () => {
  const h = harness({ prepareAnchor: element => ({ startContainer: {}, endContainer: {},
    getBoundingClientRect: () => element.getBoundingClientRect() }) });
  h.element.contains = () => false;
  const pending = h.start(); await h.advance(2500);
  assert.equal((await pending).located, false); assert.equal(h.commands.length, 0);
  assert.equal(h.timers.size, 0);
});

test('identity initialization pauses geometry and scrolls within the original landing deadline', async () => {
  const h = harness({ smoothMs: 0 }); h.ready(false);
  const pending = h.start(); await h.advance(600);
  assert.equal(h.commands.length, 0);
  assert.equal(h.context.TidyChatgptMessageLocation.getLastDiagnostic().phase, 'waiting-identity');
  h.ready(true); await h.advance(1500);
  assert.equal((await pending).located, true); assert.equal(h.commands.length, 1);
  assert.equal(h.timers.size, 0);
});

test('identity loss during geometry blocks the imminent scroll; late ready cannot renew its deadline', async () => {
  const h = harness({ smoothMs: 0 });
  const readRect = h.element.getBoundingClientRect;
  h.element.getBoundingClientRect = () => { h.ready(false); return readRect(); };
  const pending = h.start(); await h.advance(2500);
  assert.equal(h.commands.length, 0); assert.equal((await pending).reason, 'target-timeout');
  h.ready(true); await h.advance(5000);
  assert.equal(h.commands.length, 0); assert.equal(h.timers.size, 0);
});

test('identity loss at the receipt boundary discards pre-suspension stability', async () => {
  const h = harness({ smoothMs: 0 }); let result;
  const readRect = h.element.getBoundingClientRect;
  h.element.getBoundingClientRect = () => {
    if (h.now() >= 1200 && h.now() < 1300) h.ready(false);
    return readRect();
  };
  const pending = h.start().then(value => { result = value; });
  await h.advance(1300); assert.equal(result, undefined);
  h.ready(true); await h.advance(200); assert.equal(result, undefined);
  await h.advance(500); await pending;
  assert.equal(result.located, true); assert.equal(h.timers.size, 0);
});

test('late native restore and collapsed-sidebar layout drift are corrected only inside this intent', async () => {
  const h = harness(); const pending = h.start();
  h.setTimer(() => { h.viewport.scrollTop = 1480; h.shift(250); }, 850);
  await h.advance(2100); const result = await pending;
  assert.equal(result.located, true); assert.equal(result.scrolls, 2);
  assert.equal(h.viewport.scrollTop, 1370); assert.equal(h.commands.filter(c => c.behavior === 'smooth').length, 1);
  h.viewport.scrollTop = 100; await h.advance(10000); assert.equal(h.viewport.scrollTop, 100, 'consumed click cannot pull user back');
});

test('endless layout movement fails within a fixed budget rather than claiming a landing', async () => {
  const h = harness({ smoothMs: 0 }); const pending = h.start();
  for (let time = 100; time <= 2300; time += 100) h.setTimer(() => h.shift(time), time);
  await h.advance(2500); const result = await pending;
  assert.equal(result.located, false); assert.equal(result.reason, 'landing-timeout');
  assert.ok(result.scrolls <= 3); assert.equal(h.timers.size, 0);
});

test('quiet repeated hostile restores have at most two corrections', async () => {
  const h = harness({ smoothMs: 0 }); const pending = h.start();
  for (const time of [400, 900, 1500]) h.setTimer(() => { h.viewport.scrollTop = 0; }, time);
  await h.advance(2500); const result = await pending;
  assert.equal(result.located, false); assert.equal(result.reason, 'landing-unstable'); assert.equal(result.scrolls, 3);
  // Last instant command freezes at current position; it is not another target correction.
  assert.equal(h.commands.length, 4); assert.equal(h.commands.at(-1).top, 0);
});

for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) test(`manual ${type} cancels the animation and does not retry`, async () => {
  const h = harness(); const pending = h.start(); await h.advance(100);
  h.manual(type, { key: 'PageDown' }); await h.advance(5000); const result = await pending;
  assert.equal(result.located, false); assert.equal(result.reason, 'user-cancelled');
  assert.equal(h.viewport.scrollTop, 0); assert.equal(h.cancellations.length, 1); assert.equal(h.timers.size, 0);
});

test('typing scroll keys in the composer is not mistaken for scrolling the conversation', async () => {
  const h = harness(); const pending = h.start();
  h.manual('keydown', { key: ' ', target: { closest: () => ({}) } }); await h.advance(1500);
  assert.equal((await pending).located, true); assert.equal(h.cancellations.length, 0);
});

test('unmounted target may remount within the same budget; no page-wide snapshots are requested', async () => {
  const h = harness(); h.mounted(false); const pending = h.start();
  await h.advance(400); assert.equal(h.commands.length, 0); h.mounted(true);
  await h.advance(1300); assert.equal((await pending).located, true); assert.equal(h.commands.length, 1);
});

test('DOM mounted before Fiber ownership never scrolls until the exact binding arrives', async () => {
  const h = harness({ missingReason: 'message-not-bound' }); h.mounted(false); const pending = h.start();
  await h.advance(400); assert.equal(h.commands.length, 0); h.mounted(true);
  await h.advance(1300); assert.equal((await pending).located, true); assert.equal(h.commands.length, 1);
});

test('identity revocation stops motion and a new owner never inherits this click', async () => {
  const h = harness(); const pending = h.start(); await h.advance(80); h.owner(false);
  await h.advance(100); assert.equal((await pending).reason, 'context-changed');
  h.owner(true); await h.advance(5000); assert.equal(h.viewport.scrollTop, 0);
});

test('a delayed stale START cannot cancel the newer intent', async () => {
  const h = harness(); h.current('new'); const newer = h.start('new'); await h.advance(80);
  const old = await h.start('old'); assert.equal(old.located, false);
  await h.advance(1500); assert.equal((await newer).located, true); assert.equal(h.cancellations.length, 0);
});

test('cancelId and page disposal stop only the correct physical work', async () => {
  const h = harness(); const pending = h.start(); h.nav.cancelId('other', 'superseded');
  await h.advance(100); h.nav.dispose(); await h.advance(5000);
  assert.equal((await pending).reason, 'page-hidden'); assert.equal(h.viewport.scrollTop, 0); assert.equal(h.timers.size, 0);
});

test('the original absolute budget is not extended before the first observed landing', async () => {
  const h = harness({ budgetMs: 250, smoothMs: 600 }); const pending = h.start();
  await h.advance(250); assert.equal((await pending).reason, 'target-timeout');
  await h.advance(5000); assert.equal(h.viewport.scrollTop, 0); assert.equal(h.timers.size, 0);
});

test('tall messages land on the beginning rather than an arbitrary middle section', async () => {
  const h = harness({ smoothMs: 0 }); h.height(2000); const pending = h.start(); await h.advance(1500);
  assert.equal((await pending).located, true); assert.equal(h.element.getBoundingClientRect().top, 100);
});

function nestedHarness({ innerTop = 720, outerOverflow = 'auto' } = {}) {
  let clock = 0, sequence = 0, result;
  const timers = new Map(), listeners = new Map(), commands = [];
  const setTimer = (fn, ms) => { const id = ++sequence; timers.set(id, { at: clock + ms, fn }); return id; };
  const clearTimer = id => timers.delete(id);
  const rect = (top, left, width, height) => ({ top, left, width, height, right: left + width, bottom: top + height });
  const root = { clientHeight: 900, clientWidth: 1000, clientTop: 0, clientLeft: 0, scrollHeight: 900, scrollTop: 0,
    getBoundingClientRect: () => rect(0, 0, 1000, 900), parentElement: null, style: { overflowY: 'visible', overflowX: 'visible' } };
  const outer = { clientHeight: 600, clientWidth: 800, clientTop: 0, clientLeft: 0, scrollHeight: 2200, scrollTop: 382,
    getBoundingClientRect: () => rect(100, 100, 800, 600), parentElement: root, style: { overflowY: outerOverflow, overflowX: 'hidden' } };
  const inner = { clientHeight: 600, clientWidth: 700, clientTop: 0, clientLeft: 0, scrollHeight: 4000, scrollTop: innerTop,
    getBoundingClientRect: () => rect(100 - outer.scrollTop, 150, 700, 600), parentElement: outer, style: { overflowY: 'auto', overflowX: 'hidden' } };
  const element = { isConnected: true, parentElement: inner, style: {},
    getBoundingClientRect: () => rect(100 - outer.scrollTop + 1000 - inner.scrollTop, 180, 600, 40), animate() {} };
  for (const [name, port] of [['inner', inner], ['outer', outer]]) {
    let animation = null;
    port.contains = node => node === element || (name === 'outer' && node === inner);
    port.scrollTo = ({ top, behavior }) => {
      commands.push({ name, top, behavior, at: clock });
      if (animation != null) clearTimer(animation);
      if (behavior === 'smooth') animation = setTimer(() => { port.scrollTop = top; animation = null; }, 300);
      else port.scrollTop = top;
    };
  }
  const document = { documentElement: root, scrollingElement: root, readyState: 'complete',
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const context = vm.createContext({ document, innerWidth: 1000, innerHeight: 900, getComputedStyle: node => node.style });
  vm.runInContext(fs.readFileSync('src/platform/navigation/navigation-identity.js', 'utf8') + fs.readFileSync('src/platform/navigation/chatgpt/message-location.js', 'utf8'), context);
  const controller = context.TidyChatgptMessageLocation.create({ document, now: () => clock, setTimer, clearTimer,
    resolveTarget: () => ({ element }), assertCurrent: () => {} });
  async function advance(ms) {
    const end = clock + ms;
    for (let n = 0; n < 1000; n++) {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
      if (!timer || timer.at > end) break;
      timers.delete(id); clock = timer.at; timer.fn(); await Promise.resolve();
      if (n === 999) throw Error('Unbounded nested fixture timers');
    }
    clock = end; await Promise.resolve();
  }
  return { inner, outer, element, context, commands, timers, advance,
    start: (navigationIntentId = 'first-cross-conversation') => controller.start({ navigationIntentId }).then(value => { result = value; return value; }),
    result: () => result, manual: () => listeners.get('wheel')({ type: 'wheel', target: element }) };
}

test('first-click nested landing must move the outer viewport when an inner-centered target is at screen top -2', async () => {
  const h = nestedHarness();
  assert.equal(h.element.getBoundingClientRect().top, -2);
  const pending = h.start();
  assert.deepEqual(h.commands.map(command => command.name), ['outer']);
  await h.advance(3000);
  assert.equal((await pending).located, true);
  const rect = h.element.getBoundingClientRect();
  // Independent screen/outer-clip oracle, not the production scroll formula.
  assert.ok(rect.top >= 100 && rect.bottom <= 700 && rect.top >= 0 && rect.bottom <= 900);
  assert.equal(rect.top, 380); assert.equal(h.commands.length, 1); assert.equal(h.inner.scrollTop, 720);
});

test('non-scrollable outer clipping is respected instead of accepting inner-local visibility', async () => {
  const h = nestedHarness({ outerOverflow: 'clip' }); const pending = h.start();
  await h.advance(3000); assert.equal((await pending).located, true);
  const rect = h.element.getBoundingClientRect();
  assert.ok(rect.top >= 100 && rect.bottom <= 318, 'the entire short target must fit the actual clip intersection');
  assert.deepEqual(h.commands.map(command => command.name), ['inner']);
  assert.equal(h.outer.scrollTop, 382, 'overflow:clip is not a scroll destination');
});

test('manual cancellation stops both scrollports touched by the same bounded intent', async () => {
  const h = nestedHarness({ innerTop: 0 }); const pending = h.start(); await h.advance(700);
  assert.deepEqual(h.commands.map(command => command.name), ['inner', 'outer']);
  const before = [h.inner.scrollTop, h.outer.scrollTop]; h.manual(); await h.advance(5000);
  assert.equal((await pending).reason, 'user-cancelled');
  assert.deepEqual([h.inner.scrollTop, h.outer.scrollTop], before);
  assert.deepEqual(h.commands.slice(2).map(command => command.name), ['inner', 'outer']);
  assert.equal(h.timers.size, 0);
});

test('an old multi-viewport stop cannot stop a newer animation started inside the first stop command', async () => {
  const h = nestedHarness({ innerTop: 0 }); const older = h.start(); await h.advance(700);
  assert.deepEqual(h.commands.map(command => command.name), ['inner', 'outer']);
  let newer;
  const stopInner = h.inner.scrollTo;
  h.inner.scrollTo = value => {
    stopInner(value);
    if (!newer) {
      h.outer.scrollTop = 382; // restoration gives the new click real work
      newer = h.start('newer-click');
    }
  };
  h.manual();
  assert.deepEqual(h.commands.slice(2).map(command => [command.name, command.behavior]),
    [['inner', 'instant'], ['outer', 'smooth']], 'old fanout must end as soon as new physical work owns the viewport');
  await h.advance(2500);
  assert.equal((await older).reason, 'user-cancelled');
  assert.equal((await newer).located, true); assert.equal((await newer).scrolls, 1);
  assert.equal(h.timers.size, 0);
});

test('same-coordinate DOM replacement invalidates old stability and covers its later restoration without a longer timeout', async () => {
  const h = harness(); let result; const pending = h.start().then(value => { result = value; });
  h.setTimer(() => h.replaceElement(), 1100);
  h.setTimer(() => { h.viewport.scrollTop = 1480; }, 1400);
  await h.advance(1300); assert.equal(result, undefined, 'a replacement cannot inherit the retired node stable interval');
  await h.advance(1100); await pending;
  assert.equal(result.located, true); assert.equal(result.scrolls, 2);
  assert.equal(h.element.getBoundingClientRect().top, 380); assert.equal(h.timers.size, 0);
});

test('an incompletely loaded document cannot acknowledge before load and its following restore settle', async () => {
  const h = harness(); h.document.readyState = 'interactive'; let result;
  const pending = h.start().then(value => { result = value; });
  h.setTimer(() => { h.document.readyState = 'complete'; }, 1300);
  h.setTimer(() => { h.viewport.scrollTop = 1480; }, 1400);
  await h.advance(1300); assert.equal(result, undefined);
  await h.advance(1100); await pending;
  assert.equal(result.located, true); assert.equal(result.scrolls, 2); assert.equal(h.element.getBoundingClientRect().top, 380);
});

test('diagnostics distinguish repeated same-coordinate nodes from numeric movement without relaxing landing', async () => {
  const h = harness({ smoothMs: 0 });
  const pending = h.start();
  for (let time = 600; time < 2400; time += 60) h.setTimer(() => h.replaceElement(), time);
  await h.advance(2500);
  assert.equal((await pending).reason, 'landing-timeout', 'diagnostic collection must not turn unstable nodes into success');
  const trace = h.context.TidyChatgptMessageLocation.getLastDiagnostic();
  assert.ok(trace.nodeReplacements >= 25);
  assert.ok(trace.events.some(event => event.movement?.nodesChanged && !event.movement.valuesChanged));
  assert.ok(trace.geometryMoves >= 1, 'the initial physical scroll remains separately visible');
  assert.ok(trace.events.length <= 32);
  assert.equal(h.timers.size, 0);

  const moving = harness({ smoothMs: 0 });
  const motion = moving.start();
  moving.setTimer(() => moving.shift(100), 600);
  await moving.advance(2500); await motion;
  const numeric = moving.context.TidyChatgptMessageLocation.getLastDiagnostic();
  assert.equal(numeric.nodeReplacements, 0);
  assert.ok(numeric.events.some(event => event.movement?.valuesChanged && !event.movement.nodesChanged));
});

test('window clipping cannot be bypassed by a locally aligned offscreen viewport', async () => {
  const h = harness({ smoothMs: 0 });
  h.context.innerHeight = 80; const pending = h.start(); await h.advance(2500);
  assert.equal((await pending).located, false); assert.equal(h.commands.length, 0);
  assert.equal(h.timers.size, 0);
});

test('document scrollingElement is a real candidate rather than an unsupported body fallback', async () => {
  const h = harness({ smoothMs: 0 }); h.document.scrollingElement = h.viewport; h.context.innerHeight = 600;
  const pending = h.start(); await h.advance(1500);
  assert.equal((await pending).located, true); assert.equal(h.element.getBoundingClientRect().top, 280);
  assert.equal(h.context.TidyChatgptMessageLocation.getLastDiagnostic().geometry.ports[0].root, true);
});

test('a viewport-fixed scrollport ignores a tall document root that cannot move its contents', async () => {
  const h = harness({ smoothMs: 0 }), rootCommands = [];
  const root = { scrollTop: 800, scrollHeight: 3000, clientHeight: 900,
    scrollTo(value) { rootCommands.push(value); root.scrollTop = value.top; } };
  h.viewport.parentElement = root; h.viewport.offsetParent = null;
  h.document.scrollingElement = root;
  h.context.getComputedStyle = node => ({ overflowY: node === h.viewport ? 'auto' : 'visible', overflowX: 'visible',
    position: node === h.viewport ? 'fixed' : 'static' });
  const pending = h.start(); await h.advance(2500);
  assert.equal((await pending).located, true);
  assert.equal(h.element.getBoundingClientRect().top, 380);
  assert.equal(root.scrollTop, 800); assert.deepEqual(rootCommands, []);
  assert.equal(h.commands.length, 1);
});

test('fixed positioning inside an ancestor containing block retains that ancestor scrollport', async () => {
  const h = nestedHarness(); h.inner.style.position = 'fixed'; h.inner.offsetParent = h.outer;
  const pending = h.start(); await h.advance(2500);
  assert.equal((await pending).located, true);
  assert.deepEqual(h.commands.map(command => command.name), ['outer']);
  assert.equal(h.element.getBoundingClientRect().top, 380);
});

test('a fixed geometric boundary does not bypass a hidden DOM ancestor', async () => {
  const h = harness({ smoothMs: 0 }), hidden = { hidden: true };
  h.viewport.parentElement = hidden; h.viewport.offsetParent = null;
  h.context.getComputedStyle = node => ({ overflowY: node === h.viewport ? 'auto' : 'visible', overflowX: 'visible',
    position: node === h.viewport ? 'fixed' : 'static' });
  const pending = h.start(); await h.advance(2500);
  assert.equal((await pending).located, false); assert.equal(h.commands.length, 0);
});

test('last-click diagnostics are bounded, passive, copied and contain no account or message data', async () => {
  const h = harness({ smoothMs: 0 });
  const pending = h.nav.start({ navigationIntentId: 'first',
    accountKey: 'private-account', messageId: 'private-message', text: 'private-content' });
  for (let time = 10; time < 2400; time += 10) h.setTimer(() => h.shift(time), time);
  await h.advance(2500); await pending;
  const first = h.context.TidyChatgptMessageLocation.getLastDiagnostic();
  assert.ok(first.events.length <= 32); assert.equal(first.pending, false); assert.equal(h.timers.size, 0);
  assert.ok(!/private-account|private-message|private-content/.test(JSON.stringify(first)));
  const saved = JSON.stringify(first); first.events.length = 0; first.pending = true;
  assert.equal(JSON.stringify(h.context.TidyChatgptMessageLocation.getLastDiagnostic()), saved);
  await h.advance(10000); assert.equal(JSON.stringify(h.context.TidyChatgptMessageLocation.getLastDiagnostic()), saved);
});

for (const throws of [false, true]) test(`geometry replacement${throws ? ' followed by an old getter error' : ''} cannot cancel or execute over the newer intent`, async () => {
  const h = harness({ smoothMs: 0 }); let newer, replaced = false;
  const readRect = h.element.getBoundingClientRect;
  h.element.getBoundingClientRect = () => {
    if (!replaced) {
      replaced = true; h.current('second'); newer = h.start('second');
      if (throws) throw Error('Retired geometry reader');
    }
    return readRect();
  };
  const old = h.start('first'); await h.advance(1500);
  assert.equal((await old).reason, 'superseded'); assert.equal((await newer).located, true);
  assert.equal(h.commands.length, 1); assert.equal(h.context.TidyChatgptMessageLocation.getLastDiagnostic().navigationIntentId, 'second');
});

test('an exact message shell is loading, not rendered content: body hydration owns the landing boundary', async () => {
  const h = harness({ smoothMs: 0 }); h.contentReady(false);
  let result;
  const pending = h.nav.start({ navigationIntentId: 'first', loadDeadlineAt: 30000, deadlineAt: 32400 }).then(value => { result = value; });
  await h.advance(3500);
  assert.equal(result, undefined, 'Buttons, metadata and shell dimensions must not start the 2.4 second landing window');
  assert.equal(h.context.TidyChatgptMessageLocation.getLastDiagnostic().loads, 1);
  h.contentReady(true); h.height(347);
  await h.advance(1800); await pending;
  assert.equal(result.located, true); assert.equal(result.loads, 1); assert.equal(result.scrolls, 2);
});

test('an empty message shell cannot succeed or renew the original target-loading deadline', async () => {
  const h = harness({ smoothMs: 0 }); h.contentReady(false);
  const pending = h.nav.start({ navigationIntentId: 'first', loadDeadlineAt: 3000, deadlineAt: 5400 });
  await h.advance(3100);
  const result = await pending;
  assert.equal(result.located, false); assert.equal(result.reason, 'target-timeout'); assert.equal(h.timers.size, 0);
});

test('the verification window starts at observed placement, not before native rendering lets a scroll land', async () => {
  const h = harness({ smoothMs: 0 }); h.mounted(false); let result;
  const pending = h.nav.start({ navigationIntentId: 'first', loadDeadlineAt: 30000, deadlineAt: 32400 }).then(value => { result = value; });
  await h.advance(10000); h.mounted(true); await h.advance(60);
  assert.equal(h.commands.length, 1);
  // A cold native render blocks the main thread after placement is requested.
  // We have not observed an actual landing yet. Absolute load time still runs.
  h.block(2600); await h.advance(1);
  assert.equal(result, undefined);
  await h.advance(1500); await pending;
  assert.equal(result.located, true); assert.equal(result.scrolls, 1);
});

for (const reason of ['message-not-present', 'conversation-loading', 'message-not-bound']) test(`native attempt has a bounded fallback even when ${reason}`, async () => {
  const h = harness({ missingReason: reason }); h.mounted(false);
  let result;
  const pending = h.nav.start({ navigationIntentId: 'first', loadDeadlineAt: 30000, deadlineAt: 32400, nativeFallbackAt: 6000 }).then(value => { result = value; });
  await h.advance(5900); assert.equal(result, undefined);
  await h.advance(200);
  await pending; assert.equal(result.reason, 'native-target-missing');
  assert.equal(h.commands.length, 0);
});

test('a disappearing target cannot leave the native attempt waiting forever', async () => {
  const h = harness();
  const pending = h.nav.start({ navigationIntentId: 'first', loadDeadlineAt: 30000, deadlineAt: 32400, nativeFallbackAt: 6000 });
  await h.advance(100); h.mounted(false); await h.advance(6100);
  assert.equal(h.context.TidyChatgptMessageLocation.getLastDiagnostic().pending, false);
  assert.equal((await pending).reason, 'native-target-missing');
});

function reverseHarness(start = 0) {
  const h = harness({ smoothMs: 0 });
  const computedStyle = h.context.getComputedStyle;
  h.context.getComputedStyle = element => ({ ...computedStyle(element),
    ...(element === h.viewport ? { display: 'flex', flexDirection: 'column-reverse' } : {}) });
  const scroll = h.viewport.scrollTo;
  h.viewport.scrollTo = value => {
    scroll(value);
    h.viewport.scrollTop = Math.max(-(h.viewport.scrollHeight - h.viewport.clientHeight), Math.min(0, value.top));
  };
  h.viewport.scrollTop = start;
  return h;
}

for (const start of [0, -1800]) test(`column-reverse latest settles at zero from ${start} without false warning`, async () => {
  const h = reverseHarness(start);
  const pending = h.nav.start({ navigationIntentId: 'first', placement: 'latest', deadlineAt: 4000 });
  await h.advance(1800);
  const result = await pending;
  assert.equal(result.located, true); assert.equal(result.reason, null);
  assert.equal(h.viewport.scrollTop, 0);
  assert.equal(result.scrolls, start === 0 ? 0 : 1);
  assert.ok(h.commands.every(command => command.top <= 0));
});

test('normal latest still requires max: zero is not a universal success shortcut', async () => {
  const h = harness({ smoothMs: 0 });
  const pending = h.nav.start({ navigationIntentId: 'first', placement: 'latest', deadlineAt: 4000 });
  await h.advance(1800);
  assert.equal((await pending).located, true);
  assert.equal(h.viewport.scrollTop, 4400);
  assert.equal(h.commands.length, 1);
});

test('exact bookmark in reversed viewport can land at a negative position rather than clamp to zero', async () => {
  const h = reverseHarness();
  h.shift(-2200); // Bookmark's native coordinate is -700 at the bottom origin.
  const pending = h.start();
  await h.advance(1800);
  assert.equal((await pending).located, true);
  assert.equal(h.viewport.scrollTop, -1080);
  assert.equal(h.commands.length, 1);
});

test('reverse-flow latest yields to user input and never revives the cancelled click', async () => {
  const h = reverseHarness(-1800);
  const pending = h.nav.start({ navigationIntentId: 'first', placement: 'latest', deadlineAt: 4000 });
  await h.advance(300); h.manual('wheel');
  assert.equal((await pending).reason, 'user-cancelled');
  const commands = h.commands.length;
  h.viewport.scrollTop = -900; await h.advance(15000);
  assert.equal(h.viewport.scrollTop, -900); assert.equal(h.commands.length, commands);
});

test('nested normal outer and reverse inner scrollports use their own origins and settle together', async () => {
  const h = reverseHarness(-1800);
  const outerCommands = [];
  const outer = {
    parentElement: null, scrollTop: 0, scrollHeight: 1800, clientHeight: 900,
    clientWidth: 1000, clientTop: 0, clientLeft: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 900, left: 0, right: 1000, height: 900, width: 1000 }),
    scrollTo(value) { outerCommands.push(value); this.scrollTop = Math.max(0, Math.min(900, value.top)); },
  };
  h.viewport.parentElement = outer;
  h.viewport.getBoundingClientRect = () => ({ top: 1000 - outer.scrollTop, bottom: 1600 - outer.scrollTop,
    left: 100, right: 900, height: 600, width: 800 });
  const computedStyle = h.context.getComputedStyle;
  h.context.getComputedStyle = element => element === outer
    ? { overflowY: 'auto', overflowX: 'hidden', display: 'block' } : computedStyle(element);
  const pending = h.nav.start({ navigationIntentId: 'first', placement: 'latest', deadlineAt: 4000 });
  await h.advance(2200);
  const result = await pending;
  assert.equal(result.located, true);
  assert.equal(outer.scrollTop, 900);
  assert.equal(h.viewport.scrollTop, 0);
  assert.equal(result.scrolls, 2);
  assert.equal(outerCommands.length, 1);
  assert.equal(h.commands.length, 1);
});

test('column-reverse property on a non-flex block cannot change the native scroll origin', async () => {
  const h = harness({ smoothMs: 0 });
  const computedStyle = h.context.getComputedStyle;
  h.context.getComputedStyle = element => ({ ...computedStyle(element),
    ...(element === h.viewport ? { display: 'block', flexDirection: 'column-reverse' } : {}) });
  const pending = h.nav.start({ navigationIntentId: 'first', placement: 'latest', deadlineAt: 4000 });
  await h.advance(1800);
  assert.equal((await pending).located, true);
  assert.equal(h.viewport.scrollTop, 4400);
});

test('reverse exact commands clamp to the real negative extent and cannot claim an unreachable target', async () => {
  const h = reverseHarness(); h.shift(-10000);
  const pending = h.start();
  assert.equal(h.commands[0].top, -4400);
  await h.advance(2500);
  assert.equal((await pending).located, false);
  assert.ok(h.commands.every(command => command.top >= -4400 && command.top <= 0));
  assert.equal(h.timers.size, 0);
});
