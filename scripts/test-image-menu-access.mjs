// Real store restrictions, a local ordinary-page fixture and an isolated profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
if (target.kind === 'firefox') throw new Error('This fixture requires Chromium extension loading.');
const output = path.join(root, '.npm-cache/image-menu-access', target.kind);
const extension = path.join(output, `extension-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
await fs.cp(path.join(root, 'dist'), extension, { recursive: true });
await fs.writeFile(path.join(extension, 'menu-test.html'), '<!doctype html><meta charset="utf-8"><title>Image menu regression</title><script src="menu-test.js"></script>');
// Exercise the production click listener, including its rejected-message path.
// The harness is bundled into the temporary copy, never the distributed build.
await build({ stdin: { resolveDir: root, contents: `
  import { initImageContextMenu, refreshImageContextMenu } from './src/background/image-context-menu';
  const listeners = [];
  const add = chrome.contextMenus.onClicked.addListener.bind(chrome.contextMenus.onClicked);
  chrome.contextMenus.onClicked.addListener = listener => { listeners.push(listener); add(listener); };
  const update = chrome.contextMenus.update.bind(chrome.contextMenus);
  globalThis.menuUpdates = []; globalThis.createdTabs = [];
  chrome.contextMenus.update = (id, properties, ...args) => {
    if (id === 'wupage-translate-image') globalThis.menuUpdates.push(properties);
    return update(id, properties, ...args);
  };
  const create = chrome.tabs.create.bind(chrome.tabs);
  chrome.tabs.create = properties => { globalThis.createdTabs.push(properties); return create(properties); };
  initImageContextMenu();
  globalThis.refreshMenu = refreshImageContextMenu;
  globalThis.clickMenu = (info, tab) => listeners[0](info, tab);
` }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', outfile: path.join(extension, 'menu-test.js') });

const store = target.kind === 'edge'
  ? 'https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home'
  : 'https://chromewebstore.google.com/';
const ordinary = 'https://example.com/image-menu-test';
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160"><text y="80">Image menu test</text></svg>');
const html = `<!doctype html><meta charset="utf-8"><title>Image menu access fixture</title><img id="sample" src="${image}">`;
let context;
try {
  const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
  });
  await context.route(ordinary, route => route.fulfill({ contentType: 'text/html', body: html }));
  const session = await context.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: extension }); await session.detach();
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${id}/menu-test.html`);
  await harness.waitForFunction(() => globalThis.clickMenu);
  await harness.evaluate(async () => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    Object.assign(settings, { imageTranslationEnabled: true, imageTranslationContextMenuEnabled: true, imageTranslationFloatingEnabled: false,
      ocr: { mode: 'http', endpoint: 'http://127.0.0.1:9/ocr', model: 'fixture', apiKey: '', modelRevision: '1' } });
    const result = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    assertResult(result);
    function assertResult(result) { if (!result.ok) throw new Error(result.error); }
  });
  const page = await context.newPage(); await page.goto(store, { waitUntil: 'domcontentloaded' });
  const identity = verifyBrowserIdentity(target, await page.evaluate(() => navigator.userAgent));
  const access = await harness.evaluate(async store => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const target = (await chrome.tabs.query({})).find(tab => tab.url === store);
    if (!target) throw new Error('Store tab metadata is unavailable');
    let receiverError;
    try { await chrome.tabs.sendMessage(target.id, { type: 'GET_TRANSLATION_STATE' }, { frameId: 0 }); }
    catch (error) { receiverError = error.message; }
    await globalThis.refreshMenu();
    return { target, activeUrl: tab?.url, receiverError, menu: globalThis.menuUpdates.at(-1) };
  }, store);
  assert.ok(access.receiverError, 'the browser must really block the store content listener');
  await harness.evaluate(({ tab, srcUrl, pageUrl }) => globalThis.clickMenu({ menuItemId: 'wupage-translate-image', editable: false, srcUrl, pageUrl, frameId: 0 }, tab),
    { tab: access.target, srcUrl: image, pageUrl: store });
  assert.equal(access.menu.visible, true);
  assert.equal(access.menu.enabled, false);
  assert.match(access.menu.title, /此页面不支持|unavailable on this page/u);
  await harness.waitForTimeout(250);
  assert.deepEqual(await harness.evaluate(() => globalThis.createdTabs), []);
  // A normal tab and the extension-store tab must update the existing menu.
  await page.goto(ordinary);
  await harness.waitForFunction(() => globalThis.menuUpdates.at(-1)?.enabled === true);
  const before = await harness.evaluate(() => globalThis.menuUpdates.length);
  await page.goto(store, { waitUntil: 'domcontentloaded' });
  await harness.waitForFunction(before => globalThis.menuUpdates.length > before && globalThis.menuUpdates.at(-1)?.enabled === false, before);
  const report = { ...identity, passed: true, store, receiverError: access.receiverError,
    menu: access.menu, createdTabs: await harness.evaluate(() => globalThis.createdTabs),
    settings: await harness.evaluate(async () => {
      const { data } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      return { imageTranslationEnabled: data.imageTranslationEnabled, imageTranslationContextMenuEnabled: data.imageTranslationContextMenuEnabled,
        imageTranslationFloatingEnabled: data.imageTranslationFloatingEnabled };
    }) };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await context?.close(); }
