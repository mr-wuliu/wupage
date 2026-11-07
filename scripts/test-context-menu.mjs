// Real content scripts and browser menu updates against an isolated local service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const executablePath = process.env.CHROME_TEST_BROWSER || process.env.PDF_TEST_BROWSER;
const output = path.join(root, '.npm-cache/context-menu', /msedge/i.test(executablePath || '') ? 'edge' : 'chrome');
await fs.mkdir(output, { recursive: true });
let delayed = false;
const pending = [], errors = [], checks = [];
const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/translate') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const { texts } = JSON.parse(raw);
    const finish = () => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      translations: texts.map(text => `译文：${text.replace(/(⟪WUPAGESEGMENT\d+⟫\n)/gu, '$1译文：')}`)
    }));
    if (delayed) pending.push(finish); else finish();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Context menu test</title></head><body><main><h1>A quiet place to read</h1><p>A complete paragraph for page translation.</p><p>Another paragraph remains in the same page.</p></main></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
  });
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  await worker.evaluate(() => {
    globalThis.menuUpdates = [];
    const update = chrome.contextMenus.update.bind(chrome.contextMenus);
    chrome.contextMenus.update = (id, properties, ...args) => {
      globalThis.menuUpdates.push({ id, ...properties });
      return update(id, properties, ...args);
    };
  });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await options.locator('#save:enabled').waitFor();
  await options.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.providers.push({ type: 'http-template', id: 'menu-test', label: 'Menu test', method: 'POST',
      url: `${origin}/translate`, headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    settings.activeProviderId = 'menu-test'; settings.contextMenuTranslationEnabled = true;
    settings.floatingBallEnabled = false; settings.cacheEnabled = false;
    settings.sourceLang = 'en'; settings.targetLang = 'zh-CN'; settings.translationDisplayMode = 'bilingual';
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  }, origin);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/article`);
  await page.waitForSelector('#wupage-floating-hitbox', { state: 'attached' });
  const tabId = await options.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  const toggle = () => options.evaluate(async tabId => chrome.tabs.sendMessage(tabId,
    { type: 'EXECUTE_TRANSLATION_SHORTCUT', command: 'toggle-page-translation' }, { frameId: 0 }), tabId);
  const waitTitle = async expected => {
    await assert.doesNotReject(async () => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const menu = await worker.evaluate(() => globalThis.menuUpdates.filter(item => item.id === 'wupage-toggle-page-translation').at(-1));
        if (menu?.title === expected) {
          assert.deepEqual(menu.contexts, ['page']); assert.equal(menu.parentId, undefined); return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Menu title did not become ${expected}`);
    });
  };
  await waitTitle('全文翻译');
  await toggle(); await page.locator('.wupage-translation').first().waitFor(); await waitTitle('恢复原文');
  await toggle(); await page.waitForFunction(() => !document.querySelector('.wupage-translation')); await waitTitle('全文翻译');
  checks.push('one root menu, full-page translation and restoration with the floating ball disabled');
  await toggle(); await waitTitle('恢复原文');
  const other = await context.newPage(); await other.goto(`${origin}/other`); await waitTitle('全文翻译');
  await page.bringToFront(); await waitTitle('恢复原文');
  await other.bringToFront(); await waitTitle('全文翻译');
  await page.bringToFront(); await waitTitle('恢复原文');
  checks.push('translated and untranslated tabs have independent menu labels');
  await page.reload(); await waitTitle('全文翻译');
  delayed = true;
  const running = toggle();
  await waitTitle('恢复原文');
  const untilRequest = Date.now() + 10000;
  while (!pending.length && Date.now() < untilRequest) await page.waitForTimeout(50);
  assert.ok(pending.length, 'translation request is in flight before restoring');
  await toggle(); await waitTitle('全文翻译');
  pending.splice(0).forEach(finish => finish()); await running;
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.wupage-translation').count(), 0);
  await waitTitle('全文翻译');
  checks.push('navigation resets the label; restoring cancels a pending translation and ignores late results');
  await options.evaluate(async () => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { ...settings, contextMenuTranslationEnabled: false } });
  });
  await page.waitForTimeout(100);
  assert.equal(await worker.evaluate(() => globalThis.menuUpdates.filter(item => item.id === 'wupage-toggle-page-translation').at(-1).visible), false);
  assert.deepEqual(errors, []);
  checks.push('saved switch hides the menu');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  pending.splice(0).forEach(finish => finish());
  await context?.close(); await new Promise(resolve => server.close(resolve));
}
