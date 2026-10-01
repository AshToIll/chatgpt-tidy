const assert = require("node:assert/strict");
const test = require("node:test");
const { createHandoffHarness, OWNER, DESTINATION } = require("./helpers/bookmark-handoff-harness.cjs");

// Same observed identity timetable in both cases. Only DOM mounting moves:
// the old implementation passed late-mount but cancelled the early first click.
test("accepted OPEN carries its owner before LOCATE, so source-page refresh does not destroy the click", async t => {
  const h = await createHandoffHarness(t);
  await h.click();
  const control = h.calls.find(c => c.lane === "worker-page" && c.type === "navigation.intent" && c.payload.phase === "active");
  assert.equal(control.payload.ownerAccountKey, OWNER);
  await h.identity("unavailable", 2); await h.identity("ready", 4);
  h.commit(); await h.identity("ready", 1); h.routeEvent(); h.snapshot(); await h.advance(3000);
  assert.equal(h.broadcasts.filter(c => c.type === "navigation.result" && c.payload.located).length, 1);
});

for (const early of [false, true]) {
  test(`one admitted click completes with ${early ? "early" : "late"} message mounting across identity refresh`, async t => {
    const h = await createHandoffHarness(t);
    await h.click(); h.commit(); await h.advance(383); await h.identity("ready", 1);
    await h.advance(18); h.routeEvent(); await h.flush();
    await h.advance(670);
    if (early) { h.snapshot(); await h.flush(); }
    await h.advance(5); await h.identity("unavailable", 2);
    await h.advance(278); await h.identity("unavailable", 3);
    await h.advance(469); await h.identity("ready", 4);
    h.snapshot(); await h.advance(3000);

    const sent = h.calls.filter(c => c.lane === "worker-page" && c.type === "snapshot.message-locate" && c.documentId === DESTINATION);
    const finished = h.broadcasts.filter(c => c.type === "navigation.result" && c.payload.located);
    assert.equal(sent.length, 1, "Do not replay the click or restart its scroll");
    assert.equal(finished.length, 1, "The original MAIN verifier must finish successfully");
    assert.equal(sent[0].documentId, DESTINATION);
    assert.equal(sent[0].payload.navigationControl.ownerAccountKey, OWNER);
    assert.ok(sent[0].payload.deadlineAt <= 1789000032400);
    assert.equal(h.panel.library.isCurrent(h.initialLease), false, "Data leases still expire normally");
  });
}

test("LOCATE consumes the admitted target without another account or full snapshot read", async t => {
  const h = await createHandoffHarness(t);
  await h.click(); h.commit(); await h.identity("ready", 1); await h.flush();
  const before = h.calls.length;
  h.snapshot(); await h.advance(2000);
  const pageCalls = h.calls.slice(before).filter(c => c.lane === "worker-page");
  assert.deepEqual(pageCalls.filter(c => c.type !== "navigation.intent").map(c => c.type), []);
  assert.ok(pageCalls.filter(c => c.type === "navigation.intent").every(c => c.payload.phase === "cancelled"));
  assert.equal(h.broadcasts.filter(c => c.type === "navigation.result" && c.payload.located).length, 1);
});
