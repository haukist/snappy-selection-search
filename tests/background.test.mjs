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
  const created = [], menus = new Map(), injections = [];
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
    commands: { onCommand: new Event() }, webNavigation: { onDOMContentLoaded: new Event() },
    tabs: { query: async () => [{ id: 1, index: 0, windowId: 1, url: 'https://fixture.test/', active: true }],
      get: async () => ({ id: 1, url: 'https://fixture.test/' }),
      create: async options => { created.push(options); return { id: created.length + 1, index: 0, windowId: 1 }; },
      update: async (id, options) => { created.push(options); return { id }; },
      sendMessage: async () => 'alive', remove: async () => {},
    },
    windows: { create: async options => { created.push(options); return { id: 1 }; } },
  };
  const context = vm.createContext({ browser, chrome: { scripting: { executeScript: async options => { injections.push(options); return [{ frameId: 0, result: true }]; } } },
    console, URL, navigator: {}, setTimeout, clearTimeout });
  for (const name of ['libs/iconv-lite.js', 'browser-compat.js', 'search-variable-modifications.js', 'swift-selection-search.js']) vm.runInContext(read(name), context, { filename: name });
  const message = (type, extra = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No response to ${type}`)), 5000);
    onMessage.listeners[0]({ type, ...extra }, { id: 'test' }, response => { clearTimeout(timer); resolve(response); });
  });
  return { browser, context, created, menus, injections, message, stored: () => storage };
}
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
  await bg.message('engineClick', { engine: firefox, selection: 'hello', href: 'https://fixture.test/', openingBehaviour: 'new-bg-tab' });
  assert.equal(bg.created.length, 0);
  await bg.message('engineClick', { engine: group, selection: 'hello world', href: 'https://fixture.test/', openingBehaviour: 'new-bg-tab' });
  assert.equal(bg.created.at(-1).url, 'https://results.test/?q=hello%20world');
  const empty = { ...group, enginesUniqueIds: ['firefox'] };
  const count = bg.created.length;
  await bg.message('engineClick', { engine: empty, selection: 'hello', href: 'https://fixture.test/', openingBehaviour: 'new-bg-tab' });
  await bg.message('engineClick', { engine: custom(), selection: '  ', href: 'https://fixture.test/', openingBehaviour: 'new-bg-tab' });
  assert.equal(bg.created.length, count);
});

test('search substitutions and non-UTF8 encodings execute through the real background', async () => {
  const bg = background();
  await bg.message('getPopupSettings');
  await bg.message('engineClick', { engine: { ...custom(), searchUrl: 'https://results.test/?q={searchTerms}&site={hostname}' }, selection: ' a b\n', href: 'https://fixture.test/path', openingBehaviour: 'new-bg-tab' });
  assert.equal(bg.created.at(-1).url, 'https://results.test/?q=a%20b&site=fixture.test');
  await bg.message('engineClick', { engine: { ...custom(), encoding: 'shiftjis' }, selection: '日本語', href: 'https://fixture.test/', openingBehaviour: 'new-bg-tab' });
  assert.equal(bg.created.at(-1).url, 'https://results.test/?q=%93%FA%96%7B%8C%EA');
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
