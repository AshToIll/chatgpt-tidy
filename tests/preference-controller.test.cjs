const assert = require('node:assert/strict');
const test = require('node:test');
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(setImmediate);
async function harness() {
  const { createPreferenceController } = await import('../src/platform/preferences/preference-controller.js');
  const { DEFAULT_PREFERENCES } = await import('../src/platform/preferences/preferences.js');
  let stored = { ...DEFAULT_PREFERENCES }, readGate = null;
  const paints = [], errors = [], errorStages = [], writes = []; let reads = 0, loaded = 0;
  const controller = createPreferenceController({
    read: () => { reads++; return readGate ? readGate.promise : Promise.resolve({ ...stored }); },
    write: patch => { const gate = defer(); writes.push({ patch, ...gate }); return gate.promise; },
    onChanged: (value, changed) => paints.push({ value, changed }),
    onError: (error, stage) => { errors.push(error); errorStages.push(stage); }, onLoaded: () => loaded++,
  });
  return { controller, paints, errors, errorStages, writes, get reads() { return reads; }, get loaded() { return loaded; },
    event(patch) { stored = { ...stored, ...patch }; controller.observe(stored); },
    stored(patch) { stored = { ...stored, ...patch }; return { ...stored }; },
    readGate(gate) { readGate = gate; }, defaults: DEFAULT_PREFERENCES };
}

test('one theme choice paints once despite storage notification and save receipt', async () => {
  const h = await harness(); const saved = h.controller.save({ theme: 'sage' });
  assert.deepEqual(h.paints.map(p => p.changed), [['theme']]);
  h.event({ theme: 'sage' }); h.event({ theme: 'sage' });
  h.writes[0].resolve(h.stored({ theme: 'sage' }));
  assert.equal(await saved, true); assert.equal(h.paints.length, 1); assert.equal(h.reads, 0);
  await h.controller.save({ theme: 'sage' }); assert.equal(h.writes.length, 1);
});
test('rapid choices remain immediate and older notifications cannot roll the latest choice back', async () => {
  const h = await harness(); const first = h.controller.save({ theme: 'sage' });
  const second = h.controller.save({ theme: 'amber' });
  h.event({ theme: 'sage', language: 'en' });
  assert.equal(h.controller.current().theme, 'amber'); assert.equal(h.controller.current().language, 'en');
  h.writes[0].resolve(h.stored({ theme: 'sage' })); await first; await flush();
  assert.equal(h.controller.current().theme, 'amber');
  h.event({ theme: 'amber' }); h.writes[1].resolve(h.stored({ theme: 'amber' })); await second;
  assert.deepEqual(h.paints.map(p => p.value.theme), ['sage', 'amber', 'amber']);
  assert.equal(h.writes.length, 2);
});
test('a delayed receipt cannot overwrite a newer external change', async () => {
  const h = await harness(); const saved = h.controller.save({ theme: 'sage' });
  const oldReceipt = h.stored({ theme: 'sage' }); h.event({ theme: 'wineberry' });
  h.writes[0].resolve(oldReceipt); assert.equal(await saved, true);
  assert.equal(h.controller.current().theme, 'wineberry'); assert.equal(h.reads, 1);
});
test('receipt before notification reads back once and the late duplicate does not repaint', async () => {
  const h = await harness(); const saved = h.controller.save({ theme: 'sage' });
  h.writes[0].resolve(h.stored({ theme: 'sage' })); await saved;
  h.event({ theme: 'sage' }); assert.equal(h.paints.length, 1); assert.equal(h.reads, 1);
});
test('late initial read cannot override a storage notification or pending user choice', async () => {
  const h = await harness(), gate = defer(); h.readGate(gate);
  const load = h.controller.load(), save = h.controller.save({ theme: 'sage' });
  h.event({ language: 'en', theme: 'sage' }); gate.resolve(h.defaults); await load;
  assert.equal(h.controller.current().language, 'en'); assert.equal(h.controller.current().theme, 'sage');
  h.writes[0].resolve(h.stored({})); await save; assert.equal(h.paints.length, 2);
});
test('write failure restores saved values without discarding a later queued choice', async () => {
  const h = await harness(); const first = h.controller.save({ theme: 'sage' });
  const second = h.controller.save({ theme: 'amber' });
  h.writes[0].reject(Error('storage failed')); assert.equal(await first, false); await flush();
  assert.equal(h.controller.current().theme, 'amber');
  h.event({ theme: 'amber' }); h.writes[1].resolve(h.stored({})); await second;
  assert.equal(h.errors.length, 1); assert.deepEqual(h.paints.map(p => p.value.theme), ['sage', 'amber']);
});
test('single failed write rolls back and a later click can still save', async () => {
  const h = await harness(); const save = h.controller.save({ theme: 'sage' });
  h.writes[0].reject(Error('failed')); assert.equal(await save, false);
  assert.equal(h.controller.current().theme, 'mist-indigo');
  const next = h.controller.save({ theme: 'amber' }); h.event({ theme: 'amber' }); h.writes[1].resolve(h.stored({}));
  assert.equal(await next, true);
});

test('failed write plus failed readback emits only one error and retains the last confirmed value', async () => {
  const h = await harness(), gate = defer(), failure = Error('write failed'); h.readGate(gate);
  const save = h.controller.save({ theme: 'sage' });
  h.writes[0].reject(failure); await flush(); gate.reject(Error('read failed'));
  assert.equal(await save, false); assert.equal(h.controller.current().theme, h.defaults.theme);
  assert.deepEqual(h.errors, [failure]);
  assert.deepEqual(h.errorStages, ['save']);
});

test('a successful retry clears a read notice even when saved preferences are unchanged', async () => {
  const h = await harness(), gate = defer(); h.readGate(gate);
  const loading = h.controller.load(); gate.reject(Error('Read failed'));
  assert.equal(await loading, false); assert.deepEqual(h.errorStages, ['read']); assert.equal(h.loaded, 0);
  h.readGate(null); assert.equal(await h.controller.load(), true);
  assert.equal(h.loaded, 1); assert.equal(h.paints.length, 0); assert.equal(h.writes.length, 0);
});

for (const outcome of ['resolve', 'reject']) {
  test(`suspend retires queued choices immediately and ignores a late write ${outcome}`, async () => {
    const h = await harness();
    const first = h.controller.save({ theme: 'sage' });
    const queued = h.controller.save({ theme: 'amber' });
    h.controller.suspend(); h.controller.suspend();
    assert.deepEqual(await Promise.all([first, queued]), [false, false]);
    assert.equal(await h.controller.save({ theme: h.defaults.theme }), false, 'A blocked no-op is not an accepted command');
    assert.equal(h.controller.current().theme, h.defaults.theme);
    const paints = h.paints.length;
    h.writes[0][outcome](outcome === 'resolve' ? { ...h.defaults, theme: 'sage' } : Error('Retired write'));
    await flush();
    assert.equal(h.writes.length, 1); assert.equal(h.reads, 0);
    assert.equal(h.paints.length, paints); assert.equal(h.loaded, 0); assert.deepEqual(h.errors, []);
  });

  test(`resume admits only new choices; an old ${outcome} cannot drain or shift their queue`, async () => {
    const h = await harness();
    const retired = h.controller.save({ theme: 'sage' });
    const abandoned = h.controller.save({ language: 'ja' });
    h.controller.suspend(); assert.deepEqual(await Promise.all([retired, abandoned]), [false, false]);
    assert.equal(h.controller.resume(), true); await flush();
    assert.equal(h.writes.length, 1, 'Resume does not replay old choices');
    const next = h.controller.save({ theme: 'amber' });
    const last = h.controller.save({ theme: 'wineberry' });
    assert.equal(h.writes.length, 2, 'A retired unresolved write must not block a new manual choice');
    h.writes[0][outcome](outcome === 'resolve' ? { ...h.defaults, theme: 'sage' } : Error('Retired write'));
    await flush();
    assert.equal(h.writes.length, 2); assert.equal(h.reads, 0);
    h.event({ theme: 'amber' }); h.writes[1].resolve(h.stored({}));
    assert.equal(await next, true); assert.equal(h.writes.length, 3);
    assert.deepEqual(h.writes[2].patch, { theme: 'wineberry' });
    h.event({ theme: 'wineberry' }); h.writes[2].resolve(h.stored({}));
    assert.equal(await last, true); assert.equal(h.controller.current().language, h.defaults.language);
    assert.deepEqual(h.errors, []);
  });

  test(`a read begun before suspend cannot publish its late ${outcome}`, async () => {
    const h = await harness(), gate = defer(); h.readGate(gate);
    const loading = h.controller.load(); h.controller.suspend(); h.controller.resume();
    gate[outcome](outcome === 'resolve' ? { ...h.defaults, language: 'en' } : Error('Retired read'));
    assert.equal(await loading, false); assert.equal(h.loaded, 0);
    assert.deepEqual(h.paints, []); assert.deepEqual(h.errors, []);
  });

  test(`suspend retires an in-flight write readback before its late ${outcome}`, async () => {
    const h = await harness(), gate = defer(); h.readGate(gate);
    const saved = h.controller.save({ theme: 'sage' });
    h.writes[0].resolve({ ...h.defaults, theme: 'sage' }); await flush();
    assert.equal(h.reads, 1, 'The write already entered reconciliation');
    h.controller.suspend(); assert.equal(await saved, false); h.controller.resume();
    const next = h.controller.save({ theme: 'amber' });
    const paints = h.paints.length;
    gate[outcome](outcome === 'resolve' ? { ...h.defaults, language: 'en', theme: 'wineberry' } : Error('Retired readback'));
    await flush();
    assert.equal(h.paints.length, paints); assert.equal(h.loaded, 0); assert.deepEqual(h.errors, []);
    assert.equal(h.writes.length, 2); assert.equal(h.controller.current().theme, 'amber');
    h.event({ theme: 'amber' }); h.writes[1].resolve(h.stored({}));
    assert.equal(await next, true); assert.equal(h.reads, 1);
  });
}

test('suspended bootstrap reads and storage notifications still hydrate language without admitting writes', async () => {
  const h = await harness(), gate = defer(); h.readGate(gate);
  h.controller.suspend(); const loading = h.controller.load(); h.controller.suspend();
  gate.resolve({ ...h.defaults, language: 'en' });
  assert.equal(await loading, true); assert.equal(h.controller.current().language, 'en'); assert.equal(h.loaded, 1);
  h.event({ language: 'ja' }); assert.equal(h.controller.current().language, 'ja');
  assert.equal(await h.controller.save({ theme: 'sage' }), false);
  assert.equal(h.writes.length, 0); assert.equal(h.reads, 1);
});

test('dispose is terminal and silences queued work, storage notifications, reads and late failures', async () => {
  const h = await harness(), gate = defer(); h.readGate(gate);
  const loading = h.controller.load(), first = h.controller.save({ theme: 'sage' });
  const queued = h.controller.save({ theme: 'amber' });
  h.controller.dispose(); h.controller.dispose();
  assert.deepEqual(await Promise.all([first, queued]), [false, false]);
  const paints = h.paints.length;
  assert.equal(h.controller.resume(), false); h.controller.suspend(); h.event({ language: 'en' });
  assert.equal(await h.controller.load(), false); assert.equal(await h.controller.save({ theme: 'wineberry' }), false);
  gate.reject(Error('Disposed read')); h.writes[0].reject(Error('Disposed write'));
  assert.equal(await loading, false); await flush();
  assert.equal(h.reads, 1); assert.equal(h.writes.length, 1); assert.equal(h.paints.length, paints);
  assert.equal(h.loaded, 0); assert.deepEqual(h.errors, []);
});

test('a synchronous suspend from optimistic rendering prevents dispatch and settles the choice', async () => {
  const { createPreferenceController } = await import('../src/platform/preferences/preference-controller.js');
  let writes = 0;
  const controller = createPreferenceController({ read: async () => ({}),
    write: async () => { writes++; return {}; }, onChanged: () => controller.suspend() });
  assert.equal(await controller.save({ theme: 'sage' }), false); assert.equal(writes, 0);
});
