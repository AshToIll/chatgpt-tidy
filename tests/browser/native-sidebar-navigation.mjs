import { results, sleep, assert, equal, check, history, viewport, items, row, publish, height, field, currentSnapshot, runtimeCalls } from "./native-sidebar-fixture.mjs";
import "../../src/features/time/chatgpt/time-presentation.js";
import "../../src/features/favorites/chatgpt/favorites-presentation.js";
import "../../src/features/bookmarks/chatgpt/bookmarks-presentation.js";
await sleep(100);
await check("native class refresh and selection keep row geometry, viewport and nodes stable", async () => {
  const rows = [...history.children], node = rows[8], time = node.querySelector('[data-tidy-owned="sidebar-time"]');
  assert(time, "real presentation must mount the date"); viewport.scrollTop = 220;
  const scroll = viewport.scrollTop, top = node.getBoundingClientRect().top, callsBefore = runtimeCalls.length;
  try {
    for (const current of [1, 8, 3]) {
      rows.forEach((item, index) => {
        // React owns native attributes. Replacing className must not remove
        // the only rule reserving space until TIDY's debounced render catches up.
        item.className = "native-row";
        if (index === current) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
      });
      equal(height(node), 52, "height immediately after native class update");
      equal(node.getBoundingClientRect().top, top, "row jumped before observer repair");
      equal(viewport.scrollTop, scroll, "viewport jumped before observer repair");
      publish({ ...currentSnapshot(), route: { pathname: `/c/fixture-${current}` }, conversation: { ...items[current], draftId: null } });
      await sleep(90);
      assert(history.children[8] === node && node.querySelector('[data-tidy-owned="sidebar-time"]') === time, "navigation remounted TIDY/native nodes");
      equal(node.getBoundingClientRect().top, top, "row jumped after presentation");
      equal(viewport.scrollTop, scroll, "viewport jumped after presentation");
    }
    equal(runtimeCalls.length, callsBefore, "native navigation must not initiate extension I/O");
  } finally { publish(currentSnapshot()); await sleep(90); }
});
await check("missing metadata removes unproven labels but does not collapse the native list", async () => {
  const rows = [...history.children], node = rows[8]; viewport.scrollTop = 200;
  const scroll = viewport.scrollTop, top = node.getBoundingClientRect().top;
  try {
    publish({ ...currentSnapshot(), sidebarConversations: items.map(item => ({ ...item, bindingStatus: "route-only", createdAt: field(null), updatedAt: field(null) })) });
    await sleep(90);
    equal(document.querySelectorAll('[data-tidy-owned="sidebar-time"]').length, 0, "unproven dates must not be cached into view");
    for (const item of rows) equal(height(item), 52, "missing metadata collapsed row");
    equal(viewport.scrollTop, scroll, "missing metadata changed scroll");
    equal(node.getBoundingClientRect().top, top, "missing metadata changed row position");
  } finally { publish({ ...currentSnapshot(), sidebarConversations: items }); await sleep(90); }
});
await check("a native row remount has its final height before TIDY repaints", async () => {
  const node = row(items[8], 8), previous = history.children[8], top = previous.getBoundingClientRect().top;
  previous.replaceWith(node);
  equal(height(node), 52, "new native node collapsed before metadata paint");
  equal(node.getBoundingClientRect().top, top, "remount moved row");
  await sleep(100);
  assert(node.querySelector('[data-tidy-owned="sidebar-time"]'), "presentation must bind the new native host");
  equal(height(node), 52, "decoration expanded row");
});
await check("top navigation, project folders and content links retain native geometry", () => {
  for (const node of document.querySelectorAll('#native-top a, a[href$="/project"], main a')) equal(height(node), 36, "non-conversation sidebar/content node resized");
});


await check("hidden project copy and visible recent copy of one href both receive dates", async () => {
  const item = items[1], visible = history.children[1], before = currentSnapshot();
  const hiddenSection = document.createElement("section");
  hiddenSection.hidden = true;
  const hiddenCopy = row(item, 1);
  hiddenSection.append(hiddenCopy);
  history.before(hiddenSection);
  const selector = '[data-tidy-owned="sidebar-time"]';

  const contentHosts = [document.querySelector("main"),
    document.querySelector("[data-message-id]"),
    document.createElement("section"), document.createElement("dialog"),
    document.createElement("section"), document.createElement("section")];
  contentHosts[2].setAttribute("data-chatgpt-search-message-ids", "synthetic-composed-message");
  contentHosts[4].setAttribute("role", "dialog");
  contentHosts[5].setAttribute("aria-modal", "true");
  document.body.append(...contentHosts.slice(2));
  const contentLinks = contentHosts.map(host => {
    const link = document.createElement("a");
    link.setAttribute("href", item.locator.value);
    link.textContent = "A conversation citation, not a sidebar row";
    host.append(link);
    return link;
  });
  const callsBefore = runtimeCalls.length;
  try {
    // Drop pre-existing labels first, then publish one canonical conversation
    // DTO. The first native anchor is hidden, just like a collapsed project.
    publish({ ...before, sidebarConversations: items.map(candidate => candidate === item
      ? { ...candidate, bindingStatus: "route-only", createdAt: field(null), updatedAt: field(null) } : candidate) });
    await sleep(90);
    publish(before);
    await sleep(90);
    const hiddenDate = hiddenCopy.querySelector(selector), visibleDate = visible.querySelector(selector);
    assert(hiddenDate && visibleDate, "both exact href copies must receive a date");
    for (const link of contentLinks) assert(!link.querySelector(selector), "same-href content and native search dialog links must remain undecorated");
    equal(visibleDate.textContent, hiddenDate.textContent, "duplicate copies disagree about canonical time");
    publish(before);
    await sleep(90);
    equal(hiddenCopy.querySelectorAll(selector).length, 1, "hidden copy duplicated its date");
    equal(visible.querySelectorAll(selector).length, 1, "visible copy duplicated its date");
    assert(visible.querySelector(selector) === visibleDate, "normal repaint remounted visible date");

    hiddenCopy.setAttribute("href", "/c/recycled-synthetic-conversation");
    publish(before);
    await sleep(90);
    assert(!hiddenCopy.querySelector(selector), "recycled hidden copy retained an unrelated old date");
    assert(visible.querySelector(selector) === visibleDate, "recycling another copy removed the live date");
    equal(runtimeCalls.length, callsBefore, "duplicate presentation must not fetch conversation metadata");
  } finally {
    hiddenSection.remove();
    contentLinks.forEach(link => link.remove());
    contentHosts.slice(2).forEach(host => host.remove());
    publish(before);
    await sleep(90);
  }
});

// Reproduce the current native DOM without real titles, IDs or account data.
function wrappedRow(item, options = {}) {
  const container = document.createElement('div'); container.setAttribute('role', 'listitem');
  const native = document.createElement('div'); native.className = 'sidebar-item wrapped-native-row'; native.setAttribute('role', 'group');
  const content = document.createElement('div'); content.className = 'wrapped-content';
  const middle = document.createElement('div'); middle.className = 'wrapped-middle';
  const trigger = document.createElement('div'); trigger.dataset.threadTitleTrigger = 'true';
  const titleContent = document.createElement('span'); titleContent.className = 'wrapped-title-content';
  const linkShell = document.createElement('span'); linkShell.className = 'wrapped-link-shell';
  const anchor = document.createElement('a'); anchor.dataset.interactiveRowLink = 'true'; anchor.setAttribute('href', item.locator.value);
  const title = document.createElement('span'); title.className = 'wrapped-title'; title.dataset.threadTitle = 'true';
  const leaf = document.createElement('span');
  leaf.textContent = item.conversationId === 'fixture-4' ? 'A long synthetic conversation title that must remain truncated beside Work' : item.title.value;
  title.append(leaf);
  // Reproduce the observed span nesting; all labels and IDs remain synthetic.
  const badgeLabel = options.badgeLabel ?? ({ 'fixture-3': 'Work', 'fixture-4': '\u5de5\u4f5c' }[item.conversationId]);
  if (badgeLabel) {
    const badge = document.createElement('span'); badge.className = 'wrapped-work-badge'; badge.textContent = badgeLabel;
    titleContent.append(linkShell, badge);
  } else titleContent.append(linkShell);
  const menu = document.createElement('button'); menu.className = 'wrapped-menu'; menu.textContent = '…';
  menu.setAttribute('aria-haspopup', 'menu'); menu.setAttribute('aria-label', 'Chat actions');
  const pin = document.createElement('button'); pin.className = 'wrapped-pin'; pin.textContent = 'Pin';
  const rail = document.createElement('div'); rail.className = 'wrapped-actions'; rail.append(menu, pin);
  const actions = document.createElement('div'); actions.dataset.hoverCardOpenImmediately = 'true'; actions.append(rail);
  const spacer = document.createElement('div'); spacer.className = 'wrapped-spacer';
  anchor.append(title); linkShell.append(anchor); trigger.append(titleContent); middle.append(trigger); content.append(middle, spacer); native.append(content, actions); container.append(native);
  return container;
}
history.replaceChildren(...items.map(item => wrappedRow(item)));
await check('wrapped native rows reserve outer height before dates are mounted', () => {
  for (const node of history.children) equal(height(node), 52, 'outer row must reserve the full decorated height');
});
await sleep(100);
function assertWrappedGeometry() {
  const rows = [...history.children];
  for (const [index, node] of rows.entries()) {
    const rect = node.getBoundingClientRect(), anchor = node.querySelector('a'), title = node.querySelector('.wrapped-title > span');
    const date = node.querySelector('[data-tidy-owned="sidebar-time"]');
    assert(date, 'real time presentation must mount in the nested anchor');
    const dateRect = date.getBoundingClientRect(), titleRect = title.getBoundingClientRect();
    equal(height(node), 52, 'decorating the nested anchor changed outer row height');
    equal(height(anchor), 40, 'nested anchor must fit inside the native row padding');
    assert(titleRect.top >= rect.top && titleRect.bottom <= dateRect.top, 'title/date overlap inside the row');
    assert(dateRect.bottom <= rect.bottom, 'date leaked into the next row');
    equal(dateRect.left, titleRect.left, 'date must align with the title, including nested project rows');
    if (rows[index + 1]) assert(dateRect.bottom <= rows[index + 1].getBoundingClientRect().top, 'date overlaps the following title');
  }
}
await check('nested ordinary, project and group conversation dates stay within their own row', assertWrappedGeometry);
function assertWorkBadge(row, visible) {
  const badge = row.querySelector('.wrapped-work-badge');
  assert(badge, 'synthetic Work row must include the observed native badge');
  equal(getComputedStyle(badge).display !== 'none', visible, 'native Work badge visibility changed');
  if (!visible) return;
  const title = row.querySelector('.wrapped-title > span').getBoundingClientRect();
  const label = badge.getBoundingClientRect();
  const date = row.querySelector('.tidy-sidebar-time').getBoundingClientRect();
  const menu = row.querySelector('.wrapped-menu').getBoundingClientRect();
  assert(Math.abs((label.top + label.height / 2) - (title.top + title.height / 2)) < 2,
    'native Work badge lies between title and date');
  assert(label.bottom <= date.top, 'native Work badge overlaps the date row');
  assert(title.right <= label.left, 'long native title overlaps Work badge');
  assert(label.right <= menu.left, 'native Work badge overlaps the menu rail');
}
await check('native Work badges stay on the title row and appear for hover, not keyboard focus alone', () => {
  const callsBefore = runtimeCalls.length;
  for (const width of [260, 220]) {
    viewport.style.width = `${width}px`;
    for (const index of [3, 4]) {
      const row = history.children[index], native = row.querySelector('.sidebar-item');
      const star = row.querySelector('.tidy-sidebar-favorite');
      row.scrollIntoView({ block: 'nearest' });
      try {
        native.classList.remove('qa-hover'); star.blur(); assertWorkBadge(row, false);
        star.focus(); assertWorkBadge(row, false);
        native.classList.add('qa-hover'); assertWorkBadge(row, true);
        assertWrappedGeometry();
      } finally { native.classList.remove('qa-hover'); star.blur(); }
    }
  }
  viewport.style.width = '';
  equal(runtimeCalls.length, callsBefore, 'Work badge hover/focus initiated extension requests');
});
await check('native actions align with titles; real TIDY controls stay fixed on the date row during hover and focus', async () => {
  const center = e => { const r=e.getBoundingClientRect(); return r.top+r.height/2; };
  const callsBefore = runtimeCalls.length;
  for (const width of [260, 220]) {
    viewport.style.width = `${width}px`;
    for (const index of [0, 1, 3, 4]) {
      const row = history.children[index], native = row.querySelector('.sidebar-item');
      row.scrollIntoView({ block:'nearest' });
      const title = row.querySelector('.wrapped-title > span'), date = row.querySelector('.tidy-sidebar-time');
      const star = row.querySelector('.tidy-sidebar-favorite'), count = row.querySelector('.tidy-sidebar-bookmark-count');
      assert(star && count, 'production favorites and bookmarks must really be mounted');
      const x = star.getBoundingClientRect().x, dateWidth = date.getBoundingClientRect().width;
      for (const focused of [false, true, false]) {
        native.classList.toggle('qa-hover', !focused); if (focused) star.focus(); else star.blur();
        equal(star.getBoundingClientRect().x, x, 'hover/focus shifted the star');
        equal(date.getBoundingClientRect().width, dateWidth, 'native buttons squeezed the date');
        assert(Math.abs(center(star)-center(count)) < 1, 'bookmark count and star do not share a row');
        assert(Math.abs(center(star)-center(date)) < 3, 'star must align with the date');
        for (const button of row.querySelectorAll('.wrapped-menu,.wrapped-pin')) {
          assert(Math.abs(center(button)-center(title)) < 2, 'native button lies between title and date');
          assert(button.getBoundingClientRect().bottom <= star.getBoundingClientRect().top, 'native and TIDY click areas overlap');
        }
        const r=star.getBoundingClientRect();
        assert(star.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)), 'star is covered by native controls');
        assert(date.getBoundingClientRect().right <= count.getBoundingClientRect().left, 'date overlaps bookmarks');
        assertWrappedGeometry();
        if (row.querySelector('.wrapped-work-badge')) assertWorkBadge(row, !focused);
      }
      native.classList.remove('qa-hover'); star.blur();
    }
  }
  viewport.style.width='';
  equal(runtimeCalls.length, callsBefore, 'hover/focus initiated extension requests');
});
await check('native selection rewrites and late metadata keep wrapped geometry stable', async () => {
  const rows = [...history.children]; viewport.scrollTop = 220;
  const scroll = viewport.scrollTop, top = rows[8].getBoundingClientRect().top, callsBefore = runtimeCalls.length;
  for (const current of [1, 8, 3]) {
    rows.forEach((node, index) => { node.querySelector('.sidebar-item').className = 'sidebar-item wrapped-native-row' + (index === current ? ' is-selected' : ''); });
    equal(rows[8].getBoundingClientRect().top, top, 'native selection moved the row');
    equal(viewport.scrollTop, scroll, 'native selection changed scroll');
    assertWrappedGeometry();
  }
  publish({ ...currentSnapshot(), sidebarConversations: items.map(item => ({ ...item, bindingStatus:'route-only', createdAt:field(null), updatedAt:field(null) })) });
  await sleep(90);
  for (const node of rows) equal(height(node), 52, 'metadata loss collapsed outer row');
  publish({ ...currentSnapshot(), sidebarConversations:items }); await sleep(90);
  assertWrappedGeometry(); equal(runtimeCalls.length, callsBefore, 'layout changes caused extension I/O');
});
await check('Work badge alignment survives native remount and late date metadata without replacing native nodes', async () => {
  const previous = history.children[3], beforeTop = previous.getBoundingClientRect().top;
  const replacement = wrappedRow(items[3]); previous.replaceWith(replacement);
  const native = replacement.querySelector('.sidebar-item'), trigger = replacement.querySelector('[data-thread-title-trigger]');
  const badge = replacement.querySelector('.wrapped-work-badge');
  equal(height(replacement), 52, 'native Work remount changed row height');
  equal(replacement.getBoundingClientRect().top, beforeTop, 'native Work remount moved the row');
  await sleep(100);
  native.classList.add('qa-hover');
  try {
    assertWorkBadge(replacement, true);
    publish({ ...currentSnapshot(), sidebarConversations: items.map(item => ({ ...item, bindingStatus: 'route-only', createdAt: field(null), updatedAt: field(null) })) });
    await sleep(90);
    equal(height(replacement), 52, 'missing Work metadata collapsed the row');
    assert(!replacement.querySelector('.tidy-sidebar-time'), 'unproven Work date remained visible');
    publish({ ...currentSnapshot(), sidebarConversations: items }); await sleep(90);
    assertWorkBadge(replacement, true);
    assert(replacement.querySelector('[data-thread-title-trigger]') === trigger && replacement.querySelector('.wrapped-work-badge') === badge,
      'date presentation replaced a native tooltip trigger or badge');
  } finally {
    native.classList.remove('qa-hover');
    publish({ ...currentSnapshot(), sidebarConversations: items }); await sleep(90);
  }
});
// Synthetic replica of the observed task row; no real titles, IDs or SVG payloads.
function taskRow(item, auxiliaryFirst = false) {
  const row = wrappedRow(item), native = row.querySelector('.sidebar-item');
  const rail = document.createElement('div'); rail.className = 'wrapped-task-rail';
  rail.dataset.hoverCardOpenImmediately = 'true';
  const link = document.createElement('a'); link.className = 'wrapped-task-link';
  link.dataset.interactiveRowLink = 'true'; link.setAttribute('href', item.locator.value);
  link.setAttribute('aria-hidden', 'true'); link.setAttribute('tabindex', '-1');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.classList.add('wrapped-task-icon'); icon.setAttribute('width', '16'); icon.setAttribute('height', '16');
  icon.setAttribute('aria-hidden', 'false');
  link.append(icon); rail.append(link);
  if (auxiliaryFirst) native.prepend(rail); else native.append(rail);
  return row;
}
await check('task auxiliary links keep native height and never receive dates, stars or bookmark counts', async () => {
  const originals = [history.children[0], history.children[1]];
  const taskRows = originals.map((node, index) => {
    const replacement = taskRow(items[index], index === 0); node.replaceWith(replacement); return replacement;
  });
  const hidden = document.createElement('section'); hidden.hidden = true; hidden.setAttribute('aria-hidden', 'true');
  const hiddenCopy = taskRow(items[1]); hidden.append(hiddenCopy); history.after(hidden);
  const recentCopy = taskRow(items[1], true); history.after(recentCopy);
  const auxiliaryOnly = taskRow(items[2], true);
  auxiliaryOnly.querySelector('[data-thread-title-trigger] a').remove(); history.after(auxiliaryOnly);
  const callsBefore = runtimeCalls.length;
  const selector = '[data-tidy-owned="sidebar-time"]';
  try {
    await sleep(110);
    for (const row of [...taskRows, hiddenCopy, recentCopy]) {
      const title = row.querySelector('[data-thread-title-trigger] a'), task = row.querySelector('.wrapped-task-link');
      equal(title.querySelectorAll(selector).length, 1, 'each independent title copy needs exactly one date');
      equal(task.querySelectorAll('[data-tidy-owned]').length, 0, 'task clock acquired a TIDY decoration');
      equal(task.getAttribute('aria-hidden'), 'true', 'presentation changed native task semantics');
      equal(task.getAttribute('tabindex'), '-1', 'presentation changed native task navigation');
    }
    for (const row of [...taskRows, recentCopy]) {
      const task = row.querySelector('.wrapped-task-link');
      equal(height(task), 16, 'task clock link must not inherit conversation row height or date padding');
      equal(getComputedStyle(task).paddingBottom, '0px', 'task clock inherited date space');
      const titleRect = row.querySelector('.wrapped-title > span').getBoundingClientRect();
      const taskRect = task.getBoundingClientRect();
      assert(Math.abs(taskRect.top + taskRect.height / 2 - titleRect.top - titleRect.height / 2) < 2,
        'task clock must align with the title, not the middle of the two-line conversation row');
      assert(taskRect.bottom <= row.querySelector(selector).getBoundingClientRect().top,
        'native task clock overlaps the date row');
      equal(height(row), 52, 'conversation row lost its reserved height');
    }
    for (const row of taskRows) {
      const title = row.querySelector('[data-thread-title-trigger] a');
      const date = title.querySelector(selector), count = title.querySelector('.tidy-sidebar-bookmark-count');
      assert(title.querySelector('.tidy-sidebar-favorite') && count, 'auxiliary-first row stole star/bookmark hosts');
      assert(date.getBoundingClientRect().right <= count.getBoundingClientRect().left, 'date overlaps the bookmark control');
    }
    equal(height(auxiliaryOnly), 36, 'an auxiliary-only group must not become a decorated conversation row');
    equal(height(auxiliaryOnly.querySelector('.wrapped-task-rail')), 36,
      'title alignment must require a genuine primary conversation link');
    assert(!auxiliaryOnly.querySelector(selector), 'auxiliary-only group acquired a date');
    // Reproduce a date left by the previous build: the next ordinary repaint cleans only the auxiliary node.
    const task = taskRows[0].querySelector('.wrapped-task-link');
    const stale = document.createElement('div'); stale.dataset.tidyOwned = 'sidebar-time'; stale.dataset.tidyKey = items[0].conversationId;
    stale.textContent = 'Synthetic stale date'; task.append(stale);
    publish(currentSnapshot()); await sleep(90);
    assert(!task.contains(stale), 'auxiliary old-build date survived repaint');
    // An attribute-only React reuse must not wait for a changed canonical DTO.
    const primary = recentCopy.querySelector('[data-thread-title-trigger] a');
    primary.setAttribute('aria-hidden', 'true'); await sleep(100);
    assert(!primary.querySelector(selector), 'attribute-only demotion retained the old date');
    primary.removeAttribute('aria-hidden'); await sleep(100);
    equal(primary.querySelectorAll(selector).length, 1, 'restored primary link failed to regain its date');
    equal(runtimeCalls.length, callsBefore, 'native task decoration performed extension I/O');
  } finally {
    hidden.remove(); recentCopy.remove(); auxiliaryOnly.remove();
    taskRows.forEach((row, index) => row.replaceWith(originals[index]));
    publish(currentSnapshot()); await sleep(100);
  }
});

await check('nested new-chat, project-folder and message links keep their native height', () => {
  const controls = [
    [viewport, '/'], [viewport, '/g/g-p-fixture/project'],
    [document.querySelector('main nav'), '/c/body-link'],
    [document.querySelector('#message-nav'), '/c/message-nav-link'],
  ].map(([parent, href]) => { const node = wrappedRow({ title:field('Non-conversation control'), locator:{value:href} }, { badgeLabel: 'Work' }); parent.append(node); return node; });
  try {
    for (const node of controls) {
      equal(height(node), 36, 'non-sidebar-conversation row was resized');
      const badge = node.querySelector('.wrapped-work-badge');
      equal(getComputedStyle(badge).alignSelf, 'auto', 'non-conversation badge acquired TIDY alignment');
      equal(getComputedStyle(badge).lineHeight, '16px', 'non-conversation badge acquired TIDY title height');
    }
  }
  finally { controls.forEach(node => node.remove()); }
});

await check('retired page removes decorations and releases all native sidebar geometry without a reload', async () => {
  const workRow = history.children[3], native = workRow.querySelector('.sidebar-item');
  native.classList.add('qa-hover');
  const oldCount = workRow.querySelector('[data-tidy-owned="sidebar-bookmark-count"]');
  assert(oldCount, 'live page must start with a bookmark count');
  const nativeTrigger = workRow.querySelector('[data-thread-title-trigger]');
  const callsBefore = runtimeCalls.length;
  chrome.runtime.id = undefined;
  oldCount.click();
  equal(TidyPageSession.check(), false, 'old click must synchronously retire the page');
  equal(document.documentElement.getAttribute('data-tidy-page-session'), 'retired', 'layout gate was not retired');
  equal(document.querySelectorAll('[data-tidy-owned]').length, 0, 'retirement left a decoration or dynamic style');
  equal(document.querySelectorAll('.tidy-sidebar-favorite-host, .tidy-sidebar-bookmark-host, .tidy-message-meta-host').length, 0, 'retirement left native host classes');
  for (const node of history.children) equal(height(node), 36, 'retired row kept TIDY reserved height');
  equal(getComputedStyle(workRow.querySelector('.wrapped-work-badge')).alignSelf, 'auto', 'retired Work badge retained TIDY alignment');
  assert(workRow.querySelector('[data-thread-title-trigger]') === nativeTrigger, 'retirement replaced the native tooltip trigger');
  publish({ ...currentSnapshot(), sidebarConversations: items });
  native.classList.remove('qa-hover');
  await sleep(120);
  equal(document.querySelectorAll('[data-tidy-owned]').length, 0, 'late snapshot/observer revived an old decoration');
  equal(runtimeCalls.length, callsBefore, 'retired click or callback dispatched runtime I/O');
});

document.querySelector("#results").textContent = JSON.stringify({ ok: results.every(result => result.ok), checks: results }, null, 2);
document.querySelector("#results").dataset.complete = "true";
