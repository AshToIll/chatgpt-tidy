const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { loadMainModule } = require('./helpers/main-runtime.cjs');

function harness() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('src/platform/navigation/chatgpt/virtual-message-target.js', 'utf8'), context);
  const message = { id: 'message', author: { role: 'assistant' } };
  const turn = { id: 'turn', messages: [message] };
  const owner = { memoizedProps: { turnId: 'turn', conversation: { id: 'conversation' } },
    memoizedState: { memoizedState: null, next: { memoizedState: [turn, undefined], next: null } } };
  const fiber = { memoizedProps: { 'data-turn-id-container': 'turn' }, return: owner };
  const element = { __reactFiber$test: fiber };
  return { read: () => context.TidyChatgptVirtualMessageTarget.read(element, 'turn', 'conversation', 'message'),
    context, message, turn, owner, fiber, element };
}

test('a virtual turn proves an exact message from its own current conversation and turn snapshot', () => {
  const h = harness();
  assert.equal(h.read(), h.message);
  assert.equal(h.owner.memoizedState.next.memoizedState[0], h.turn, 'Reader never modifies the native snapshot');
});

test('native hook order is not a contract and an adjacent previous turn cannot identify this container', () => {
  const h = harness();
  h.owner.memoizedState.next.memoizedState = [{ id: 'turn', messages: [] }, h.turn];
  h.turn.id = 'previous';
  assert.equal(h.read(), null);
  h.turn.id = 'turn';
  h.owner.memoizedState.next.memoizedState = [h.turn, undefined];
  h.owner.memoizedState = { memoizedState: 10, next: h.owner.memoizedState };
  assert.equal(h.read(), h.message);
});

for (const [name, mutate] of [
  ['wrong conversation', h => { h.owner.memoizedProps.conversation.id = 'other'; }],
  ['wrong DOM turn', h => { h.owner.memoizedProps.turnId = 'other'; }],
  ['wrong snapshot turn', h => { h.turn.id = 'other'; }],
  ['wrong message', h => { h.message.id = 'other'; }],
  ['tool message', h => { h.message.author.role = 'tool'; }],
  ['conflicting message owner', h => { h.message.conversation_id = 'other'; }],
  ['no current Fiber', h => { delete h.element.__reactFiber$test; }],
  ['alternate-only evidence', h => { h.fiber.alternate = h.owner; h.fiber.return = null; }],
  ['no current native turn data', h => { h.owner.memoizedState = null; }],
  ['duplicate exact message records', h => { h.turn.messages.push({ ...h.message }); }],
]) test(`${name} cannot authorize target loading`, () => {
  const h = harness(); mutate(h); assert.equal(h.read(), null);
});

test('bounded Fiber and hook walks reject cyclic or unknown native structures without invoking functions', () => {
  const h = harness();
  h.owner.memoizedState = { memoizedState: () => { throw Error('must not invoke'); } };
  h.owner.memoizedState.next = h.owner.memoizedState;
  assert.equal(h.read(), null);
  h.fiber.return = h.fiber;
  assert.equal(h.read(), null);
});

test('MAIN loading resolver rejects inert/hidden/ambiguous trees and TIDY-owned nodes', () => {
  const h = harness();
  const element = Object.assign(h.element, { isConnected: true, getClientRects: () => [{}],
    getAttribute: name => name === 'data-turn-id-container' ? 'turn' : null, closest: () => null });
  let nodes = [element], route = { supported: true, conversationId: 'conversation' };
  Object.assign(h.context, { global: h.context, routeAdapter: { parse: () => route },
    document: { querySelectorAll: selector => { assert.equal(selector, 'main [data-turn-id-container]'); return nodes; } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  let resolveLoadTarget;
  h.context.TidyChatgptRoute = { parse: () => route };
  h.context.TidyChatgptMessageLocation = { create(options) { resolveLoadTarget = options.resolveLoadTarget; return {}; } };
  loadMainModule(h.context, 'src/platform/chatgpt/page-navigation-runtime.js');
  h.context.TidyChatgptPageNavigationRuntime.create({ reader: {}, postEnvelope() {} });
  const read = () => resolveLoadTarget({ conversationId: 'conversation', messageId: 'message' });
  assert.equal(read().element, element);
  element.parentElement = { hasAttribute: name => name === 'inert' }; assert.equal(read(), null);
  element.parentElement = { hidden: true }; assert.equal(read(), null);
  element.parentElement = null;
  const duplicate = { ...element }; nodes = [element, duplicate]; assert.equal(read(), null);
  duplicate.isConnected = false; assert.equal(read().element, element);
  element.closest = () => ({}); assert.equal(read(), null);
  route = { supported: true, conversationId: 'other' }; assert.equal(read(), null);
});

test('a bookmark can load a proven virtual target in the source document without a native deep-link reload', async () => {
  const h = harness();
  let calls = 0, received;
  vm.runInContext(fs.readFileSync('src/platform/navigation/chatgpt/message-navigation.js', 'utf8'), h.context);
  Object.assign(h.context, { location: { href: 'https://chatgpt.com/c/conversation' } });
  const nav = h.context.TidyChatgptMessageNavigation.create({
    resolveTarget: () => ({ element: null, reason: 'message-not-present' }), resolveLoadTarget: () => ({ element: h.element }),
    isIntentCurrent: () => true, canPresent: () => true,
    locate: payload => { calls++; received = payload; return new Promise(() => {}); },
  });
  const result = nav.start({ navigationIntentId: 'intent', conversationId: 'conversation', messageId: 'message' });
  assert.equal(result.pending, true); assert.equal(result.targetPresent, true); assert.equal(result.reason, 'loading-target');
  assert.equal(result.located, false); assert.equal(calls, 1); assert.equal(received.messageId, 'message'); assert.equal(Object.hasOwn(received, 'query'), false);
});

test('a bookmark uses the same pending execution and final result contract without a fabricated query', async () => {
  const h = harness(); let finish, calls = 0;
  Object.assign(h.context, { location: { href: 'https://chatgpt.com/c/conversation' } });
  vm.runInContext(fs.readFileSync('src/platform/navigation/chatgpt/message-navigation.js', 'utf8'), h.context);
  const nav = h.context.TidyChatgptMessageNavigation.create({
    resolveTarget: () => ({ element: h.element }), isIntentCurrent: () => true, canPresent: () => true,
    locate: payload => { calls++; assert.equal(Object.hasOwn(payload, 'query'), false); return new Promise(resolve => { finish = resolve; }); },
  });
  const result = nav.start({ navigationIntentId: 'bookmark-intent', conversationId: 'conversation', messageId: 'message' });
  assert.equal(result.pending, true); assert.equal(result.located, false); assert.equal(calls, 1);
  finish({ located: true, reason: null }); await new Promise(setImmediate);
  assert.equal(nav.getStatus().located, true); assert.equal(nav.getStatus().pending, false);
});
