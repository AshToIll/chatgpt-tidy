const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ui = 'src/features/search/ui/';

function clock() {
  let id = 0;
  const jobs = new Map();
  return { jobs, setTimeout(fn, delay) { jobs.set(++id, { fn, delay }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    run(delay) { for (const [id, job] of [...jobs]) if (job.delay === delay) { jobs.delete(id); job.fn(); } } };
}
function environment() {
  const timer = clock();
  const context = vm.createContext({ console, structuredClone, Intl, Date, queueMicrotask,
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  const modules = new Map();
  function load(file) {
    file = path.resolve(root, file);
    if (modules.has(file)) return modules.get(file);
    let source = fs.readFileSync(file, 'utf8');
    const bindings = {};
    source = source.replace(/^import \{([^}]+)\} from ["'](.+)["'];?\r?$/gm, (_, names, from) => {
      const dependency = load(path.resolve(path.dirname(file), from));
      for (const name of names.split(',').map(n => n.trim())) bindings[name] = dependency[name];
      return '';
    }).replace(/^import ["'](.+)["'];?\r?$/gm, (_, from) => { load(path.resolve(path.dirname(file), from)); return ''; });
    const exports = [...source.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map(match => match[1]);
    source = source.replace(/^export /gm, '');
    const keys = Object.keys(bindings);
    const factory = vm.runInContext(`(function(${keys.join(',')}) { ${source}\nreturn { ${exports.join(',')} }; })`, context, { filename: file });
    const value = factory(...keys.map(key => bindings[key]));
    modules.set(file, value);
    return value;
  }
  for (const file of ['src/platform/protocol.js', 'src/features/search/model/search.js',
    'src/platform/catalog/date-search.js', 'src/platform/library/library-hydration.js']) load(file);
  return { load, timer, context };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const row = id => ({ resultId: `date:${id}`, conversationId: id, source: 'conversation', matchKind: 'conversation-date', messageId: null, title: id });
const page = (items, extra = {}) => ({ items, cursor: null, hasMore: false, readErrors: [], catalogPhase: 'settled',
  catalogRevision: 1, resultStable: true, total: items.length, accountKey: 'account:a', ...extra });

test('error slot: old timers and read epochs cannot clear or resurrect another notice', () => {
  const { load, timer } = environment();
  const { createSearchErrorSlot, SEARCH_ERROR_NOTICE_MS } = load(ui + 'search-error-slot.js');
  const context = { active: true, visible: true, mode: 'date' };
  let cleared = 0;
  const slot = createSearchErrorSlot({ readContext: () => context, onClear: () => cleared++ });
  assert.equal(SEARCH_ERROR_NOTICE_MS, 5000);
  slot.show({ code: 'READ_FAILED' }, 'date-query');
  const prior = slot.current(), oldTimer = [...timer.jobs.values()][0].fn;
  slot.show({ code: 'CATALOG_FAILED' }, 'date-catalog');
  const latest = slot.current();
  oldTimer();
  assert.equal(slot.current(), latest);
  assert.equal(slot.clear('date-query', prior), false);
  const readEpoch = slot.epoch();
  slot.invalidate();
  assert.equal(slot.show({ code: 'LATE' }, 'date-query', readEpoch), false);
  assert.equal(slot.current(), null);
  context.visible = false;
  assert.equal(slot.show({ code: 'HIDDEN' }, 'date-query'), false);
  context.visible = true;
  slot.show({ code: 'CURRENT' }, 'date-query');
  timer.run(5000);
  assert.equal(slot.current(), null);
  assert.equal(cleared, 3);
});

test('navigation: a wrong target cannot consume the later exact receipt; cancellation remains owned', () => {
  const { load } = environment();
  const actions = [];
  const owner = load(ui + 'search-result-navigation.js').createSearchResultNavigation({
    onAction: (action, payload) => actions.push({ action, payload }), createIntentId: () => 'intent:one' });
  owner.open({ conversationId: 'target', messageId: null, navigationKind: 'conversation' });
  const receipt = { navigationIntentId: 'intent:one', conversationId: 'target', messageId: null, placement: 'latest', located: false };
  assert.equal(owner.complete({ ...receipt, conversationId: 'wrong' }), false);
  assert.equal(owner.complete({ ...receipt, messageId: 'wrong' }), false);
  assert.equal(owner.complete({ ...receipt, placement: undefined }), false);
  assert.equal(owner.complete(receipt), true);
  assert.equal(owner.complete(receipt), false);
  assert.equal(owner.ownsConversationTransition(null), true);
  assert.equal(owner.ownsConversationTransition('target'), true);
  owner.cancel('route-away');
  owner.cancel('hidden');
  assert.equal(actions.filter(action => action.action === 'cancel-navigation').length, 1);
  assert.equal(owner.complete(receipt), false);
});

test('navigation: native keyword handoff is not a location receipt', () => {
  const { load } = environment();
  const owner = load(ui + 'search-result-navigation.js').createSearchResultNavigation({ onAction() {}, createIntentId: () => 'native' });
  owner.open({ conversationId: 'chat', messageId: 'message', navigationKind: 'keyword' });
  assert.equal(owner.complete({ navigationIntentId: 'native', conversationId: 'chat', messageId: 'message', accepted: true }), false);
  assert.equal(owner.complete({ navigationIntentId: 'native', conversationId: 'chat', messageId: 'message', located: true }), true);
});

test('query owner: snapshots cannot mutate query state and reads never publish export sources', async () => {
  const { load, timer } = environment();
  const sourceEvents = [], actions = [];
  const owner = load(ui + 'search-query-controller.js').createSearchQueryController({
    onAction: (action, payload) => { actions.push({ action, payload }); return page([row('chat')]); },
    onExportSourcesChange: items => sourceEvents.push(items) });
  owner.setActive(true);
  owner.changeMode('date');
  owner.changeDateRange({ startDate: '2026-09-05', endDate: '2026-09-05' });
  timer.run(0); await flush();
  const state = owner.snapshot();
  assert.equal(state.pages[0][0].conversationId, 'chat');
  state.pages[0][0].conversationId = 'mutated';
  assert.equal(owner.snapshot().pages[0][0].conversationId, 'chat');
  const before = sourceEvents.length;
  owner.snapshot(); owner.exportItems(); owner.criteria();
  assert.equal(sourceEvents.length, before);
  assert.equal(sourceEvents.at(-1)[0].accountKey, 'account:a');
  assert.equal(actions.filter(action => action.action === 'query').length, 1);
});

test('query owner: changed date criteria reject both late result and late failure', async () => {
  for (const reject of [false, true]) {
    const { load, timer } = environment();
    const pending = deferred();
    const owner = load(ui + 'search-query-controller.js').createSearchQueryController({ onAction: action => action === 'query' ? pending.promise : undefined });
    owner.setActive(true); owner.changeMode('date');
    owner.changeDateRange({ startDate: '2026-09-05', endDate: '2026-09-05' });
    timer.run(0); await flush();
    owner.changeDateRange({ startDate: '2026-09-06', endDate: '2026-09-06' });
    if (reject) pending.reject({ code: 'OLD_READ_FAILED' }); else pending.resolve(page([row('old')]));
    await flush();
    const state = owner.snapshot();
    assert.equal(state.pages.length, 0);
    assert.equal(state.error, false);
    assert.equal(state.errorNotice, null);
    assert.equal(state.startDate, '2026-09-06');
    owner.setActive(false);
  }
});

test('query owner: timezone input invalidates once, not on subsequent projection reads', async () => {
  const { load, timer } = environment();
  const actions = [];
  const owner = load(ui + 'search-query-controller.js').createSearchQueryController({ onAction: (action, payload) => { actions.push({ action, payload }); return page([row('chat')]); } });
  owner.setActive(true); owner.changeMode('date');
  owner.changeDateRange({ startDate: '2026-09-05', endDate: '2026-09-05' }); timer.run(0); await flush();
  owner.setTimeZone('Asia/Shanghai');
  const generation = owner.snapshot().generation;
  owner.setTimeZone('Asia/Shanghai'); owner.snapshot(); owner.criteria();
  assert.equal(owner.snapshot().generation, generation);
  timer.run(0); await flush();
  assert.equal(actions.filter(action => action.action === 'query').length, 2);
  assert.equal(actions.filter(action => action.action === 'query').at(-1).payload.timeZone, 'Asia/Shanghai');
});

test('pure presentation and projections cannot mutate a query or dispatch requests', () => {
  const { load, context } = environment();
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.classList = { toggle() {} }; }
    append(...items) { this.children.push(...items); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
  }
  context.document = { createElement: () => new Element(), createTextNode: text => ({ textContent: text }) };
  let calls = 0;
  const owner = load(ui + 'search-query-controller.js').createSearchQueryController({ onAction: () => calls++ });
  const state = owner.snapshot();
  const before = JSON.stringify(state);
  const { searchViewModel } = load(ui + 'search-view-model.js');
  const { createSearchMarkup } = load(ui + 'search-presentation.js');
  const model = searchViewModel(state, { active: false }, [], null);
  const markup = createSearchMarkup({ ...model, calendar: { controls: null, overlay: null } }, key => key);
  assert.ok(markup.children.length > 0);
  assert.equal(JSON.stringify(state), before);
  assert.equal(JSON.stringify(owner.snapshot()), before);
  assert.equal(calls, 0);
});

for (const dateField of ['createdAt', 'updatedAt']) {
  test(`date basis presentation selects only ${dateField}, without DOM/model shadowing`, () => {
    const { load, context } = environment();
    class Element {
      constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.classList = { toggle() {} }; }
      append(...items) { this.children.push(...items.filter(Boolean)); }
      setAttribute(key, value) { this.attributes[key] = value; }
      getAttribute(key) { return this.attributes[key]; }
    }
    context.document = { createElement: () => new Element(), createTextNode: text => ({ textContent: text }) };
    const owner = load(ui + 'search-query-controller.js').createSearchQueryController({ onAction() {} });
    owner.changeMode('date'); owner.changeDateField(dateField);
    const model = load(ui + 'search-view-model.js').searchViewModel(owner.snapshot(), { active: false }, [], null);
    const markup = load(ui + 'search-presentation.js').createSearchMarkup({ ...model, calendar: { controls: new Element(), overlay: null } }, key => key);
    const descendants = node => (node.children || []).flatMap(child => [child, ...descendants(child)]);
    const buttons = descendants(markup).filter(node => node.dataset?.searchDateField);
    assert.equal(buttons.length, 2);
    for (const button of buttons) assert.equal(button.attributes['aria-pressed'], String(button.dataset.searchDateField === dateField));
  });
}

test('calendar and interaction reads never deep-clone accumulated result pages', async () => {
  const { load, context, timer } = environment();
  let clones = 0;
  context.structuredClone = value => { clones++; return structuredClone(value); };
  const owner = load(ui + 'search-query-controller.js').createSearchQueryController({ onAction: () => page([row('chat')]) });
  owner.setActive(true); owner.changeMode('date');
  owner.changeDateRange({ startDate: '2026-09-05', endDate: '2026-09-05' }); timer.run(0); await flush();
  for (let i = 0; i < 100; i++) {
    assert.equal(owner.readContext().mode, 'date');
    assert.equal(owner.readDateSelection().startDate, '2026-09-05');
    assert.equal(owner.findResult({ resultId: 'date:chat' }).conversationId, 'chat');
  }
  assert.equal(clones, 0);
  owner.snapshot();
  assert.equal(clones, 1, 'a full detached projection is needed only when a paint requests one');
});

test('notice projection cannot lend mutable error or catalog evidence outside their owners', async () => {
  const { load, timer } = environment();
  const owner = load(ui + 'search-query-controller.js').createSearchQueryController({
    onAction: action => { if (action === 'query') return Promise.reject({ code: 'READ_FAILED', retryable: true }); } });
  owner.setActive(true); owner.changeMode('date');
  owner.changeDateRange({ startDate: '2026-09-05', endDate: '2026-09-05' }); timer.run(0); await flush();
  const notice = owner.snapshot().errorNotice;
  assert.equal(notice.error.code, 'READ_FAILED');
  notice.error.code = 'EXTERNAL_MUTATION';
  assert.equal(owner.snapshot().error.code, 'READ_FAILED');
  assert.equal(owner.snapshot().errorNotice.error.code, 'READ_FAILED');
  const slot = load(ui + 'search-error-slot.js').createSearchErrorSlot({ readContext: () => ({ mode: 'date', active: true, visible: true }) });
  const error = { code: 'CATALOG_FAILED', nested: { detail: 'before' } }, evidence = { revision: 2, accountKey: 'a' };
  slot.show(error, 'date-catalog', slot.epoch(), evidence);
  error.nested.detail = 'after'; evidence.revision = 99;
  assert.equal(slot.current().error.nested.detail, 'before');
  assert.equal(slot.current().evidence.revision, 2);
  assert.equal(Object.isFrozen(slot.current().error.nested), true);
});
