import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['scripts/build.mjs', 'chrome'], { cwd: root, stdio: 'pipe' });
const read = name => fs.readFileSync(path.join(root, 'dist/chrome', name), 'utf8');
class Event {
  listeners = [];
  addListener = fn => this.listeners.push(fn);
  removeListener = fn => { this.listeners = this.listeners.filter(listener => listener !== fn); };
  hasListener = fn => this.listeners.includes(fn);
  emit(...args) { for (const listener of this.listeners) listener(...args); }
}
function background(initial = {}, gate = Promise.resolve()) {
  let storage = structuredClone(initial);
  const created = [], menus = new Map(), injections = [], tabMessages = [];
  const onMessage = new Event(), onChanged = new Event();
  const browser = {
    runtime: { id: 'test', getManifest: () => ({ manifest_version: 3 }), getURL: name => `chrome-extension://test/${name}`, onMessage, onInstalled: new Event(), onStartup: new Event() },
    storage: { onChanged, local: {
      get: async () => { await gate; return structuredClone(storage); },
      set: async settings => { Object.assign(storage, structuredClone(settings)); onChanged.emit({ settings: {} }, 'local'); }
    } },
    contextMenus: { onClicked: new Event(), removeAll: async () => menus.clear(), create: (options, done) => {
      assert(options.id !== undefined); assert(!('icons' in options));
      assert(!menus.has(options.id), 'duplicate menu id'); menus.set(options.id, options); done(); return options.id;
    } },
    commands: { onCommand: new Event() }, webNavigation: { onDOMContentLoaded: new Event(), onHistoryStateUpdated: new Event(), onReferenceFragmentUpdated: new Event() },
    tabs: { query: async () => [{ id: 1, index: 0, windowId: 1, url: 'https://fixture.test/', active: true }],
      get: async () => ({ id: 1, url: 'https://fixture.test/' }),
      create: async options => { created.push(options); return { id: created.length + 1, index: 0, windowId: 1 }; },
      update: async (id, options) => { created.push(options); return { id }; },
      sendMessage: async (tabId, message, options) => { tabMessages.push({ tabId, message, options }); return 'alive'; }, remove: async () => {},
    },
    windows: { create: async options => { created.push(options); return { id: 1 }; } },
  };
  const context = vm.createContext({ browser, chrome: { scripting: { executeScript: async options => { injections.push(options); return [{ frameId: 0, result: true }]; } } },
    console, URL, navigator: {}, setTimeout, clearTimeout });
  for (const name of ['libs/iconv-lite.js', 'browser-compat.js', 'search-variable-modifications.js', 'swift-selection-search.js']) vm.runInContext(read(name), context, { filename: name });
  const optionsPage = { id: 'test', url: 'chrome-extension://test/settings/settings.html' };
  const message = (type, extra = {}, sender = optionsPage) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No response to ${type}`)), 5000);
    const handled = onMessage.listeners[0]({ type, ...extra }, sender, response => { clearTimeout(timer); resolve(response); });
    if (handled !== true) { clearTimeout(timer); resolve(undefined); }
  });
  return { browser, context, created, menus, injections, tabMessages, message, stored: () => storage };
}
const contentScript = { id: 'test', url: 'https://fixture.test/', tab: { id: 1 } };
const custom = (id = 'local') => ({ uniqueId: id, type: 'custom', name: id, searchUrl: 'https://results.test/?q={searchTerms}', isEnabled: true, isEnabledInContextMenu: true, iconUrl: '' });

test('existing search-variable examples run as automated assertions', () => {
  const output = [];
  const context = vm.createContext({ console: { log: text => output.push(text) },
    document: { body: { appendChild() {} }, createTextNode() {}, createElement() {} } });
  vm.runInContext(read('search-variable-modifications.js'), context);
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'tests/tests.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2015 } }).outputText;
  vm.runInContext(code, context);
  assert(output.some(line => line.startsWith('/////////////')));
  assert.deepEqual(output.filter(line => line.startsWith('FAIL')), []);
});

test('wake-up listeners exist before asynchronous initialization; concurrent requests receive settings', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const bg = background({}, gate);
  assert.equal(bg.browser.commands.onCommand.listeners.length, 1);
  assert.equal(bg.browser.webNavigation.onDOMContentLoaded.listeners.length, 1);
  assert.equal(bg.browser.contextMenus.onClicked.listeners.length, 1);
  let responded = false;
  const first = bg.message('getPopupSettings').then(value => { responded = true; return value; });
  const second = bg.message('getDataForSettingsPage');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(responded, false);
  release();
  assert((await first).settings.searchEngines.length > 0);
  assert((await second).defaultSettings.searchEngines.length > 0);
  assert(bg.menus.size > 0);
});

test('Firefox-only engines survive import but never appear or execute, including in cyclic groups', async () => {
  const bg = background();
  const defaults = (await bg.message('getDataForSettingsPage')).defaultSettings;
  const firefox = { ...custom('firefox'), type: 'browser-search-api' };
  const group = { ...custom('group'), type: 'group', enginesUniqueIds: ['firefox', 'missing', 'group', 'local'] };
  await bg.browser.storage.local.set({ ...defaults, searchEngines: [firefox, custom(), group] });
  const popup = await bg.message('getPopupSettings');
  assert.deepEqual(Array.from(popup.settings.searchEngines, engine => engine.uniqueId), ['local', 'group']);
  assert.equal(bg.stored().searchEngines[0].type, 'browser-search-api');
  assert(!Array.from(bg.menus.values()).some(menu => menu.title === 'firefox'));
  const click = (engineId, selection) => bg.message('engineClick', { engineId, selection, href: 'https://fixture.test/', openingBehaviour: 'new-bg-tab' }, contentScript);
  await click('firefox', 'hello');
  assert.equal(bg.created.length, 0);
  await click('group', 'hello world');
  assert.equal(bg.created.at(-1).url, 'https://results.test/?q=hello%20world');
  const count = bg.created.length;
  await bg.browser.storage.local.set({ searchEngines: [firefox, custom(), group, { ...group, uniqueId: 'empty', enginesUniqueIds: ['firefox'] }] });
  await click('empty', 'hello');
  await click('local', '  ');
  assert.equal(bg.created.length, count);
});

test('search substitutions and non-UTF8 encodings execute through the real background', async () => {
  const bg = background();
  const defaults = (await bg.message('getDataForSettingsPage')).defaultSettings;
  await bg.browser.storage.local.set({ ...defaults, searchEngines: [
    { ...custom('site'), searchUrl: 'https://results.test/?q={searchTerms}&site={hostname}' }, { ...custom('sjis'), encoding: 'shiftjis' }] });
  await bg.message('engineClick', { engineId: 'site', selection: ' a b\n', href: 'https://fixture.test/path', openingBehaviour: 'new-bg-tab' }, contentScript);
  assert.equal(bg.created.at(-1).url, 'https://results.test/?q=a%20b&site=fixture.test');
  await bg.message('engineClick', { engineId: 'sjis', selection: '日本語', href: 'https://fixture.test/', openingBehaviour: 'new-bg-tab' }, contentScript);
  assert.equal(bg.created.at(-1).url, 'https://results.test/?q=%93%FA%96%7B%8C%EA');
});

test('content scripts cannot supply engine definitions, unknown behaviours or settings-page requests', async () => {
  const bg = background();
  const defaults = (await bg.message('getDataForSettingsPage')).defaultSettings;
  await bg.browser.storage.local.set({ ...defaults, searchEngines: [custom(), { ...custom('off'), isEnabled: false }] });
  const forged = { ...custom('local'), searchUrl: 'https://attacker.test/?q={searchTerms}', discardOnOpen: true };
  const click = extra => bg.message('engineClick', { selection: 'secret', href: 'https://fixture.test/', openingBehaviour: 'new-bg-tab', ...extra }, contentScript);
  await click({ engine: forged });
  await click({ engineId: 'missing' });
  await click({ engineId: 'off' });
  await click({ engineId: '__proto__' });
  await click({ engineId: 'local', openingBehaviour: 'javascript:alert(1)' });
  await click({ engineId: 'local', href: 'not a url' });
  assert.equal(bg.created.length, 0);
  await click({ engineId: 'local', engine: forged });
  assert.equal(bg.created.at(-1).url, 'https://results.test/?q=secret');
  for (const type of ['getDataForSettingsPage', 'runBackwardsCompatibilityUpdates', 'generateUniqueEngineId']) {
    assert.equal(await bg.message(type, { settings: { searchEngines: [] } }, contentScript), undefined, type);
  }
  assert.equal(await bg.message('getPopupSettings', {}, { id: 'other-extension', url: 'https://fixture.test/' }), undefined);
  assert.equal((await bg.message('getPopupSettings', {}, contentScript)).settings.searchEngines.length, 1);
});

test('website blocklist expands every wildcard and is re-checked after same-document navigation', async () => {
  const bg = background();
  const defaults = (await bg.message('getDataForSettingsPage')).defaultSettings;
  await bg.browser.storage.local.set({ ...defaults, websiteBlocklist: ['*.example.com/*', '*bank*', 'exact.test', '/^regex\\.test\\/private/'].join('\n') });
  await bg.message('getPopupSettings');
  const blocked = async url => {
    bg.tabMessages.length = 0;
    bg.browser.webNavigation.onHistoryStateUpdated.listeners[0]({ tabId: 7, frameId: 0, url });
    await new Promise(resolve => setTimeout(resolve, 10));
    const activation = bg.tabMessages.find(entry => entry.message.type === 'activate');
    assert(activation, url);
    assert.equal(activation.tabId, 7);
    assert.equal(Object.keys(activation.options).length, 0);	// no frameId: every frame of the tab
    return activation.message.isPageBlocked;
  };
  assert.equal(await blocked('https://www.example.com/inbox'), true);
  assert.equal(await blocked('https://mybank.com/login'), true);
  assert.equal(await blocked('https://exact.test/anything'), true);
  assert.equal(await blocked('https://regex.test/private/x'), true);
  assert.equal(await blocked('https://example.com/'), false);
  assert.equal(await blocked('https://regex.test/public'), false);
  bg.tabMessages.length = 0;
  bg.browser.webNavigation.onReferenceFragmentUpdated.listeners[0]({ tabId: 7, frameId: 3, url: 'https://www.example.com/#x' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(bg.tabMessages.length, 0, 'subframe navigations do not re-activate the tab');
});

test('rapid settings writes serialize menu rebuilding and worker recreation restores saved state', async () => {
  const bg = background();
  const defaults = (await bg.message('getDataForSettingsPage')).defaultSettings;
  await Promise.all(['one', 'two', 'three'].map(id => bg.browser.storage.local.set({ ...defaults, searchEngines: [custom(id)] })));
  assert.equal((await bg.message('getPopupSettings')).settings.searchEngines[0].uniqueId, 'three');
  assert.equal(Array.from(bg.menus.values()).filter(menu => menu.title === 'three').length, 1);
  const restored = background(bg.stored());
  assert.equal((await restored.message('getPopupSettings')).settings.searchEngines[0].uniqueId, 'three');
});

test('context-menu listener restores the selected engine and uses the default mouse button', async () => {
  const bg = background();
  const defaults = (await bg.message('getDataForSettingsPage')).defaultSettings;
  await bg.browser.storage.local.set({ ...defaults, contextMenuItemBehaviour: 'new-bg-tab', searchEngines: [custom()] });
  await bg.browser.contextMenus.onClicked.listeners[0]({ menuItemId: '0', selectionText: 'menu search', pageUrl: 'https://fixture.test/' }, { id: 1 });
  assert.equal(bg.created.at(-1).url, 'https://results.test/?q=menu%20search');
});

test('denied script injection is contained and does not break subsequent settings requests', async () => {
  const bg = background();
  await bg.message('getPopupSettings');
  bg.context.chrome.scripting.executeScript = async () => { throw new Error('Host permission denied'); };
  await bg.browser.webNavigation.onDOMContentLoaded.listeners[0]({ tabId: 1, frameId: 0 });
  assert((await bg.message('getPopupSettings')).settings.searchEngines.length > 0);
});

test('a failed settings refresh recovers on the next message and subsequent writes still run', async () => {
  const bg = background();
  const defaults = (await bg.message('getDataForSettingsPage')).defaultSettings;
  const get = bg.browser.storage.local.get;
  let fail = true;
  bg.browser.storage.local.get = async () => {
    if (fail) { fail = false; throw new Error('Transient storage failure'); }
    return get();
  };
  await bg.browser.storage.local.set({ ...defaults, searchEngines: [custom('recovered')] });
  const responses = await Promise.all([bg.message('getPopupSettings'), bg.message('getPopupSettings')]);
  for (const response of responses) assert.equal(response.settings.searchEngines[0].uniqueId, 'recovered');
  await bg.browser.storage.local.set({ searchEngines: [custom('next')] });
  assert.equal((await bg.message('getPopupSettings')).settings.searchEngines[0].uniqueId, 'next');
});

test('a failed first startup can retry without restarting the extension', async () => {
  const bg = background({}, Promise.reject(new Error('Initial storage failure')));
  await new Promise(resolve => setTimeout(resolve, 0));
  bg.browser.storage.local.get = async () => structuredClone(bg.stored());
  assert((await bg.message('getDataForSettingsPage')).defaultSettings.searchEngines.length > 0);
  assert((await bg.message('getPopupSettings')).settings.searchEngines.length > 0);
});

test('persistent startup failures return errors without unhandled rejections and can later recover', async () => {
  const bg = background({}, Promise.reject(new Error('Storage remains unavailable')));
  await new Promise(resolve => setTimeout(resolve, 0));
  const responses = await Promise.all([bg.message('getPopupSettings'), bg.message('getDataForSettingsPage')]);
  for (const response of responses) assert.match(response.error, /Storage remains unavailable/);
  assert.match((await bg.message('getPopupSettings')).error, /Storage remains unavailable/);
  bg.browser.storage.local.get = async () => structuredClone(bg.stored());
  assert((await bg.message('getPopupSettings')).settings.searchEngines.length > 0);
});

test('clipboard cleanup respects existing document ownership and menu arguments remain intact', async () => {
  const bg = background();
  await bg.message('getPopupSettings');
  const menu = { id: 'owned', title: 'Owned', icons: { '32': 'icon.png' } };
  await bg.context.BrowserCompat.createMenu(menu);
  assert.equal(menu.icons['32'], 'icon.png');
  const api = bg.context.chrome;
  let existing = true, created = 0, closed = 0;
  api.runtime = { getContexts: async () => existing ? [{}] : [] };
  api.offscreen = { createDocument: async () => { created++; }, closeDocument: async () => { closed++; } };
  bg.browser.runtime.sendMessage = async () => ({ ok: true });
  await bg.context.BrowserCompat.copyText('existing');
  assert.equal(created, 0);
  assert.equal(closed, 0);
  existing = false;
  await bg.context.BrowserCompat.copyText('new');
  assert.equal(created, 1);
  assert.equal(closed, 1);
  bg.browser.runtime.sendMessage = async () => { throw new Error('Copy failed'); };
  await assert.rejects(bg.context.BrowserCompat.copyText('failure'), /Copy failed/);
  assert.equal(closed, 2);
  bg.browser.runtime.sendMessage = async () => ({ ok: true });
  await bg.context.BrowserCompat.copyText('after failure');
  assert.equal(closed, 3);
});

test('all default engines have verified 96px+ bundled icons and HTTPS source URLs', async () => {
  const bg = background();
  const defaults = (await bg.message('getDataForSettingsPage')).defaultSettings;
  const engines = defaults.searchEngines.filter(engine => engine.type === 'custom');
  assert.equal(engines.length, 14);
  assert.equal(new Set(engines.map(engine => engine.iconUrl)).size, 13);
  for (const engine of engines) {
    assert.equal(new URL(engine.iconUrl).protocol, 'https:');
    const cached = new URL(defaults.searchEnginesCache[engine.iconUrl]);
    assert(cached.pathname.startsWith('/res/default-engine-icons/'));
    const png = fs.readFileSync(path.join(root, 'src', cached.pathname.slice(1)));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert(png.readUInt32BE(16) >= 96 && png.readUInt32BE(20) >= 96, engine.name);
  }
});

test('legacy default icon URLs migrate without changing engine identities or customized records', async () => {
  const current = background();
  const settings = structuredClone((await current.message('getDataForSettingsPage')).defaultSettings);
  const oldIcons = {
    'www.bing.com': 'https://www.bing.com/sa/simg/favicon-2x.ico',
    'duckduckgo.com': 'https://duckduckgo.com/favicon.ico',
    'yandex.ru': 'https://yastatic.net/iconostasis/_/8lFaTHLDzmsEZz-5XaQg9iTWZGE.png',
    'www.baidu.com': 'https://www.baidu.com/favicon.ico',
    'www.youtube.com': 'https://www.youtube.com/yts/img/favicon_144-vfliLAfaB.png',
    'www.imdb.com': 'https://www.imdb.com/favicon.ico',
    'en.wikipedia.org': 'https://www.wikipedia.org/favicon.ico',
    'www.amazon.com': 'https://www.amazon.com/favicon.ico',
    'www.ebay.com': 'https://www.ebay.com/favicon.ico',
    'translate.google.com': 'https://translate.google.com/favicon.ico',
    'store.steampowered.com': 'https://store.steampowered.com/favicon.ico',
  };
  const expected = new Map();
  for (const engine of settings.searchEngines.filter(engine => engine.type === 'custom')) {
    expected.set(engine.uniqueId, engine.iconUrl);
    const url = new URL(engine.searchUrl);
    engine.iconUrl = url.hostname === 'www.google.com'
      ? url.pathname.startsWith('/maps/') ? 'https://www.google.com/images/branding/product/ico/maps15_bnuw3a_32dp.ico' : 'https://www.google.com/favicon.ico'
      : oldIcons[url.hostname];
    assert(engine.iconUrl, engine.name);
  }
  const google = settings.searchEngines.find(engine => engine.name === 'Google');
  const customizedIcon = { ...google, uniqueId: 'custom-icon', name: 'My Google', iconUrl: 'https://custom.test/icon.png' };
  const customizedSearch = { ...google, uniqueId: 'custom-search', searchUrl: 'https://custom.test/?q={searchTerms}' };
  settings.searchEngines.push(customizedIcon, customizedSearch);
  settings.searchEnginesCache = { [customizedIcon.iconUrl]: 'data:image/png;base64,user-icon', [customizedSearch.iconUrl]: 'data:image/png;base64,legacy-icon' };
  const before = structuredClone(settings.searchEngines);
  const migrated = background(settings);
  await migrated.message('getPopupSettings');
  const stored = migrated.stored();
  for (let index = 0; index < before.length; index++) {
    const original = before[index], actual = stored.searchEngines[index];
    const { iconUrl: originalIcon, ...originalFields } = original;
    const { iconUrl: actualIcon, ...actualFields } = actual;
    assert.deepEqual(actualFields, originalFields);
    if (expected.has(actual.uniqueId)) assert.equal(actual.iconUrl, expected.get(actual.uniqueId));
  }
  assert.equal(stored.searchEngines.at(-2).iconUrl, customizedIcon.iconUrl);
  assert.equal(stored.searchEngines.at(-1).iconUrl, customizedSearch.iconUrl);
  assert.equal(stored.searchEnginesCache[customizedIcon.iconUrl], 'data:image/png;base64,user-icon');
  assert.equal(stored.searchEnginesCache[customizedSearch.iconUrl], 'data:image/png;base64,legacy-icon');
  const restarted = background(stored);
  await restarted.message('getPopupSettings');
  assert.deepEqual(restarted.stored(), stored);
  const imported = await current.message('runBackwardsCompatibilityUpdates', { settings });
  assert.equal(imported.searchEngines.find(engine => engine.name === 'Google').iconUrl, expected.get(google.uniqueId));
  const migratedIconsSource = await current.message('runBackwardsCompatibilityUpdates', { settings: { ...structuredClone(settings), searchEngineIconsSource: 'favicon-kit' } });
  assert.equal(migratedIconsSource.searchEngineIconsSource, 'google');
});
