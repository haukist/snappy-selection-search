import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/chrome/manifest.json'), 'utf8'));
const zip = unzipSync(await fs.readFile(path.join(root, 'dist', `swift-selection-search-chrome-${manifest.version}.zip`)));
const unpacked = await fs.mkdtemp(path.join(results, 'unpacked-'));
for (const [name, bytes] of Object.entries(zip)) {
  const file = path.resolve(unpacked, name);
  if (!file.startsWith(unpacked + path.sep)) throw new Error('Unsafe ZIP path');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}
const requests = [];
const server = http.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
server.on('request', (req, res) => {
  requests.push(req.url);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url !== '/plain') res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'none'; img-src data:; frame-src 'self'");
  res.end(`<!doctype html><title>${req.url === '/native-menu' ? 'SSS native menu fixture' : 'SSS fixture'}</title><p id="selection">Chrome search 日本語</p><input id="editable" value="Editable selection">${req.url === '/' ? '<iframe src="/frame"></iframe>' : ''}`);
});
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sss-chrome-'));
const checks = [];
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--enable-extension-targets', process.env.SSS_NATIVE_MENU ? '--window-position=50,50' : '--window-position=-2000,-2000'],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const runtimeErrors = [];
  context.on('console', msg => { if ((msg.type() === 'error' || msg.type() === 'warning') && !msg.text().startsWith('Page does not allow')) console.log(`BROWSER ${msg.type()}: ${msg.text()}`); });
  context.on('weberror', error => { runtimeErrors.push(error.error().message); console.log(`BROWSER ERROR: ${error.error().message}`); });
  const existing = await context.newPage();
  await existing.goto(origin);
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: unpacked });
  record('unpacked ZIP loads in installed Chrome Stable with a fresh profile');
  const options = await context.newPage();
  const pageErrors = [];
  options.on('pageerror', error => { pageErrors.push(error.message); console.log(`OPTIONS ERROR: ${error.message}`); });
  await options.goto(`chrome-extension://${id}/settings/settings.html`);
  await options.waitForFunction(() => document.body.style.display !== 'none' && document.querySelector('#engines')?.children.length > 0);
  assert.deepEqual(pageErrors, []);
  record('options page initializes from worker and displays default engines');
  const send = (type, extra = {}) => options.evaluate(({ type, extra }) => browser.runtime.sendMessage({ type, ...extra }), { type, extra });
  options.on('dialog', dialog => dialog.accept());
  const data = await send('getDataForSettingsPage');
  const settings = structuredClone(data.defaultSettings);
  settings.popupDelay = 0;
  settings.popupAnimationDuration = 0;
  settings.shortcutBehaviour = 'new-bg-tab';
  settings.mouseLeftButtonBehaviour = 'new-bg-tab';
  settings.searchEngines = [
    { type: 'custom', uniqueId: 'local', name: 'Local', searchUrl: `${origin}/search?q={searchTerms}`, iconUrl: '', isEnabled: true, isEnabledInContextMenu: true, shortcut: 'G' },
    { type: 'browser-search-api', uniqueId: 'firefox', name: 'Firefox engine', iconUrl: '', isEnabled: true, isEnabledInContextMenu: true },
    { type: 'group', uniqueId: 'group', name: 'Mixed group', enginesUniqueIds: ['firefox', 'local'], iconUrl: '', isEnabled: true, isEnabledInContextMenu: true },
  ];
  await options.evaluate(settings => browser.storage.local.set(settings), settings);
  const popup = await send('getPopupSettings');
  assert.equal(popup.settings.searchEngines.some(engine => engine.uniqueId === 'firefox'), false);
  assert.equal((await options.evaluate(() => browser.storage.local.get('searchEngines'))).searchEngines.length, 3);
  record('unsupported Firefox engines are preserved in storage and excluded from popup');
  await options.reload();
  await options.waitForSelector('text=[Unsupported in Chrome]', { state: 'attached' });
  await options.locator('#section_searchEngines .section-name').click();
  assert.equal(await options.locator('text=[Unsupported in Chrome]').isVisible(), true);
  assert.equal(await options.locator('[name="importBrowserEnginesButton"]').isVisible(), false);
  record('options explicitly label imported Firefox engines as unsupported');
  const search = async (engine, selection = 'Chrome search 日本語', openingBehaviour = 'new-bg-tab') => {
    const count = requests.length;
    await send('engineClick', { engine, selection, href: origin, openingBehaviour });
    await options.waitForTimeout(200);
    assert(requests.slice(count).some(url => url.startsWith('/search?q=')), `Expected local search; requests: ${requests.slice(count)}`);
  };
  await search(settings.searchEngines[0]);
  record('custom URL search opens an actual local results tab');
  await search(settings.searchEngines[2]);
  record('mixed group skips unsupported engine and executes custom engine');
  await existing.bringToFront();
  const fixtureTab = await options.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url === origin + '/').id, origin);
  const select = async page => {
    const loc = page.locator('#selection');
    await loc.click({ position: { x: 110, y: 8 } });
    await loc.dblclick({ position: { x: 25, y: 8 } });
    const frames = await options.evaluate(tabId => chrome.webNavigation.getAllFrames({ tabId }), fixtureTab);
    const frameId = frames.find(frame => frame.url === page.url()).frameId;
    for (let attempt = 0; attempt < 200; attempt++) {
      const shown = await options.evaluate(async ({ tabId, frameId }) => {
      const result = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: () => {
        const popup = document.querySelector('sss-popup');
        if (!popup || typeof popup.isShown !== 'function' || !popup.isShown() || getComputedStyle(popup.content).visibility !== 'visible') return false;
        const rect = popup.enginesContainer.firstElementChild.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      } });
      return result[0].result;
      }, { tabId: fixtureTab, frameId });
      if (shown) return shown;
      await delay(50);
    }
    console.log('CONTENT DIAG', await options.evaluate(async ({ tabId, frameId }) => (await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: () => ({ selection: document.getSelection()?.toString(), popup: !!document.querySelector('sss-popup'), installed: globalThis.__sssContentInstalled }) }))[0].result, { tabId: fixtureTab, frameId }));
    throw new Error(`Popup not visible in ${page.url()}`);
  };
  await select(existing);
  record('existing tab receives popup under strict CSP');
  const frame = existing.frames().find(frame => frame.url().endsWith('/frame'));
  await select(frame);
  record('iframe receives and displays popup');
  await existing.reload();
  const clickPoint = await select(existing);
  record('popup works after page reload');
  let baseline = requests.length;
  await existing.mouse.click(clickPoint.x, clickPoint.y);
  await options.waitForTimeout(200);
  assert(requests.slice(baseline).some(url => url.startsWith('/search?q=')));
  record('trusted popup mouse click opens a search');
  await existing.bringToFront();
  await select(existing);
  baseline = requests.length;
  await existing.keyboard.press('g');
  await options.waitForTimeout(200);
  assert(requests.slice(baseline).some(url => url.startsWith('/search?q=')));
  record('trusted engine keyboard shortcut opens a search');
  await existing.bringToFront();
  await select(existing);
  baseline = requests.length;
  await existing.evaluate(() => {
    document.documentElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', keyCode: 71, bubbles: true }));
    document.dispatchEvent(new CustomEvent('customselectionchange'));
  });
  await options.waitForTimeout(100);
  assert.equal(requests.length, baseline);
  record('synthetic keyboard and selection notifications cannot trigger a search');
  const downloadPromise = options.waitForEvent('download');
  await options.locator('#section_storageAndBackup .section-name').click();
  await options.locator('[name="exportSettingsToFileButton"]').click();
  const download = await downloadPromise;
  const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert(exported.searchEngines.some(engine => engine.uniqueId === 'firefox'));
  await options.locator('[name="importSettingsFromFileButton_real"]').setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  assert.equal((await send('getPopupSettings')).settings.searchEngines.some(engine => engine.uniqueId === 'firefox'), false);
  record('actual file export and import retain unsupported engines without enabling them');
  await existing.bringToFront();
  await options.evaluate(async () => {
    await Promise.all([BrowserCompat.copyText('first copy'), BrowserCompat.copyText('Chrome offscreen copy')]);
  });
  const input = existing.locator('#editable');
  await input.click();
  await existing.keyboard.press('Control+a');
  await existing.keyboard.press('Control+v');
  assert.equal(await input.inputValue(), 'Chrome offscreen copy');
  record('offscreen clipboard requests serialize and paste the copied text');
  await select(existing);
  await send('engineClick', { engine: { type: 'sss', id: 'copyToClipboard', isPlainText: true }, selection: 'Chrome', href: existing.url() });
  await input.click();
  await existing.keyboard.press('Control+a');
  await existing.keyboard.press('Control+v');
  assert.equal((await input.inputValue()).trim(), 'Chrome');
  record('content-script plain-text copy preserves actual selected text');
  await existing.goto(origin + '/plain');
  await existing.bringToFront();
  await select(existing);
  record('popup also works on an ordinary page without CSP');
  const sessions = await context.newCDPSession(existing);
  const workerVersions = [];
  sessions.on('ServiceWorker.workerVersionUpdated', event => workerVersions.push(...event.versions));
  await sessions.send('ServiceWorker.enable');
  await sessions.send('ServiceWorker.stopAllWorkers');
  await delay(100);
  assert(workerVersions.some(version => version.scriptURL.startsWith(`chrome-extension://${id}/`) && version.runningStatus === 'stopped'));
  // No worker.evaluate or worker DevTools session is used for the wake-up request.
  const woke = await send('getPopupSettings');
  assert.equal(woke.settings.searchEngines[0].uniqueId, 'local');
  await search(settings.searchEngines[0]);
  record('first settings request and search succeed after forced worker stop');
  if (process.env.SSS_NATIVE_MENU) {
    await existing.goto(origin + '/native-menu');
    await existing.bringToFront();
    await select(existing);
    const count = requests.length;
    await existing.keyboard.press('Escape');
    await existing.locator('#selection').click({ button: 'right', position: { x: 25, y: 8 } });
    console.log('WAITING FOR NATIVE CONTEXT MENU CLICK');
    for (let attempt = 0; attempt < 2400 && !requests.slice(count).some(url => url.startsWith('/search?q=')); attempt++) await delay(50);
    assert(requests.slice(count).some(url => url.startsWith('/search?q=')), 'Native menu did not execute a search');
    record('actual native context-menu click opens a custom search');
  }
  for (const openingBehaviour of ['this-tab', 'new-tab', 'new-bg-tab', 'new-tab-next', 'new-bg-tab-next', 'new-window', 'new-bg-window']) {
    await existing.bringToFront();
    await search(settings.searchEngines[0], 'opening', openingBehaviour);
  }
  record('all seven result-opening modes create or update real tabs/windows');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(runtimeErrors, []);
  await fs.writeFile(path.join(results, 'chrome.json'), JSON.stringify({ browser: context.browser().version(), extensionId: id, checks, pageErrors, runtimeErrors, workerStopObserved: true }, null, 2));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  // Both directories were created by this invocation, never a user's browser profile.
  if (profile.startsWith(path.join(os.tmpdir(), 'sss-chrome-'))) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  if (unpacked.startsWith(results + path.sep + 'unpacked-')) await fs.rm(unpacked, { recursive: true, force: true });
}
