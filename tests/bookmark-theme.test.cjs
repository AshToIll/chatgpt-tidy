const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const read = name => fs.readFileSync(name, 'utf8');

test('content and Side Panel share the only theme catalog, loaded before bookmarks', async () => {
  const context = vm.createContext({ Object });
  vm.runInContext(read('src/platform/theme/theme.js'), context);
  const { THEMES, DEFAULT_THEME, resolve } = context.TidyTheme;
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const scheme of ['light', 'dark']) assert.equal(resolve(name, scheme), theme[scheme]);
  }
  for (const name of [null, undefined, '', 'unknown', '__proto__', 'constructor']) {
    assert.equal(resolve(name, 'dark'), THEMES[DEFAULT_THEME].dark);
  }
  assert.equal(resolve(DEFAULT_THEME, 'unknown'), THEMES[DEFAULT_THEME].light);
  const preferences = await import('../src/platform/preferences/preferences.js');
  assert.equal(preferences.DEFAULT_PREFERENCES.theme, DEFAULT_THEME);
  assert.doesNotMatch(read('src/platform/preferences/preferences.js'), /export const THEMES|#[0-9a-f]{6}/i);
  assert.match(read('src/app/sidepanel/shell-presentation.js'), /theme\.resolve\(themeName, colorScheme\)/);
  const scripts = JSON.parse(read('src/manifest.json')).content_scripts.find(entry => entry.world !== 'MAIN').js;
  assert.ok(scripts.indexOf('platform/theme/theme.js') >= 0);
  assert.ok(scripts.indexOf('platform/theme/theme.js') < scripts.indexOf('features/bookmarks/chatgpt/bookmarks-presentation.js'));
});

test('bookmark accent stays on message buttons; stars and sidebar counts keep native grays', () => {
  const bookmarks = read('src/features/bookmarks/chatgpt/bookmarks-presentation.js');
  assert.doesNotMatch(bookmarks, /#6d68ad|--tidy-accent/);
  assert.match(bookmarks, /\.tidy-message-bookmark\.is-bookmarked \{ color: var\(--tidy-bookmark-accent\); \}/);
  assert.match(bookmarks, /\.tidy-message-bookmark\.is-bookmarked svg \{ fill: currentColor; \}/);
  assert.match(bookmarks, /\.tidy-message-bookmark\.is-error \{ color: #c45b66; \}/);
  assert.doesNotMatch(bookmarks, /document\.documentElement\.style/);
  const countRule = bookmarks.match(/\.tidy-sidebar-bookmark-count \{([^}]+)\}/)[1];
  assert.doesNotMatch(countRule, /accent/);
  assert.match(countRule, /--text-tertiary/);
  const favorites = read('src/features/favorites/chatgpt/favorites-presentation.js');
  assert.doesNotMatch(favorites, /TidyTheme|--tidy-bookmark-accent/);
  assert.match(favorites, /\.tidy-sidebar-favorite\.is-starred \{ color: var\(--text-secondary/);
});
