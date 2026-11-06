// Touch-input regressions use a fresh profile, local content and a mock service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, '.npm-cache/mobile-interactions');
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const requests = [];
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    const { texts } = JSON.parse(body); requests.push(...texts);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ translations: texts.map(text => {
      const markers = [...text.matchAll(/⟪WUPAGESEGMENT\d+⟫/gu)];
      return markers.length ? markers.map(marker => `${marker[0]}\n这是所选段落的译文。`).join('\n') : '这是所选文字的译文。';
    }) })); return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Touch reading fixture</title><style>
    *{box-sizing:border-box}body{margin:0;background:#eef3f1;color:#172026;font:16px/1.8 system-ui}main{max-width:680px;margin:auto;padding:20px}h1{font-size:25px;margin:0 0 16px}p{margin:18px 0}img{display:block;width:100%;height:auto;border-radius:12px}input{max-width:100%;min-height:44px}#spacer{height:1200px}
    </style></head><body><main><h1>A small screen for reading</h1>
    <p id="paragraph">Translation makes ideas easier to share across different languages.</p>
    <p id="selection">Select a sentence and translate it when you are ready to read.</p>
    <p id="linked">Keep the <a href="#bottom">website navigation</a> working normally.</p>
    <input aria-label="Website search" placeholder="Website search">
    <img alt="Reading illustration" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='260'%3E%3Crect width='640' height='260' fill='%23d8e5df'/%3E%3Ctext x='40' y='145' font-size='42' fill='%2321463c'%3ERead at your own pace%3C/text%3E%3C/svg%3E">
    <div id="spacer"></div><p id="bottom">The end of the article.</p></main></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
    viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1
  });
  const session = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
  await session.detach();
  const control = await context.newPage(); await control.goto(`chrome-extension://${extensionId}/options.html`);
  await control.waitForSelector('#save');
  await control.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    Object.assign(settings, { activeProviderId: 'http-template', sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false,
      selectionTranslation: { enabled: true, provider: 'youdao', style: 'dot' }, imageTranslationEnabled: false });
    Object.assign(settings.providers.find(provider => provider.id === 'http-template'), {
      label: '本地测试服务', url: `${origin}/translate`, method: 'POST', headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations'
    });
    // Only display controls; no OCR model is downloaded and image requests are never activated.
    await chrome.storage.local.set({ 'wupage.settings': settings, 'wupage.touch-hint-seen': false });
  }, origin);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const touch = await context.newCDPSession(page);
  const ball = page.locator('#wupage-floating-ball'), menu = page.locator('#wupage-floating-menu');
  const press = (x, y) => touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  const release = () => touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const openMenu = async () => {
    const bounds = await ball.boundingBox();
    await press(Math.min(page.viewportSize().width - 10, bounds.x + bounds.width / 2), bounds.y + bounds.height / 2);
    await menu.waitFor({ state: 'visible' }); await release();
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '', 'Long press must not select the floating label');
  };
  await page.goto(origin); await ball.waitFor();
  const hint = page.locator('#wupage-touch-hint'); await hint.waitFor();
  await hint.getByRole('button', { name: '关闭悬浮球操作提示' }).tap();
  const layouts = [];
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 640 }); await page.goto(origin); await ball.waitFor();
    assert.equal(await hint.count(), 0, 'The introductory hint is only shown once');
    const ballBounds = await ball.boundingBox();
    assert(ballBounds.x >= 0 && ballBounds.x + ballBounds.width <= width && ballBounds.width >= 44, 'A docked touch ball keeps its full hit area on screen');
    await openMenu();
    const bounds = await menu.boundingBox(), primary = await menu.locator('[data-action="page-toggle"]').boundingBox();
    assert(bounds.x >= 7 && bounds.x + bounds.width <= width - 7 && bounds.y >= 7 && bounds.y + bounds.height <= 633);
    assert(primary.y >= bounds.y && primary.y + primary.height <= bounds.y + bounds.height && primary.height >= 44);
    assert.equal(await menu.evaluate(element => element.scrollWidth > element.clientWidth), false);
    assert.equal(await menu.locator('[data-action="context-menu-translation"]').isVisible(), false);
    assert.equal(await menu.locator('[data-action="paragraph-mode"]').isVisible(), true);
    await page.screenshot({ path: path.join(output, `menu-${width}.png`) }); layouts.push({ width, bounds });
  }
  assert.equal(requests.length, 0);
  await menu.locator('[data-action="paragraph-mode"]').tap();
  const picker = page.locator('#wupage-touch-paragraph'); await picker.waitFor();
  const paragraph = page.locator('#paragraph'), paragraphBounds = await paragraph.boundingBox();
  await press(paragraphBounds.x + 20, paragraphBounds.y + 12);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: paragraphBounds.x + 20, y: paragraphBounds.y + 65, id: 1 }] });
  await release(); assert.equal(requests.length, 0, 'Swiping must not pick a paragraph');
  await page.locator('input').tap(); assert.equal(requests.length, 0);
  await page.locator('input').blur();
  await paragraph.tap();
  await page.locator('.wupage-translation:not(.wupage-translation-pending)').first().waitFor();
  assert.equal(requests.length, 1); assert(requests[0].includes('Translation makes ideas'));
  await page.locator('#selection').tap(); assert.equal(requests.length, 1, 'Picking ends after one paragraph');
  await page.screenshot({ path: path.join(output, 'paragraph.png') });

  await page.reload(); await ball.waitFor();
  await page.evaluate(() => {
    document.getElementById('selection').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 1 }));
    const range = document.createRange(); range.selectNodeContents(document.getElementById('selection'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch', pointerId: 1 }));
  });
  const selectionTrigger = page.locator('#wupage-selection-tools .trigger-touch'); await selectionTrigger.waitFor();
  assert.equal(requests.length, 1, 'Selecting alone never sends text');
  assert((await selectionTrigger.boundingBox()).height >= 44);
  await page.screenshot({ path: path.join(output, 'selection-entry.png') });
  await selectionTrigger.tap();
  const card = page.locator('#wupage-selection-tools .card');
  await card.locator('.selection-translation').waitFor();
  assert.equal(requests.length, 2); assert(requests[1].includes('Select a sentence'));
  await card.locator('.word').focus(); await page.setViewportSize({ width: 360, height: 360 });
  await page.waitForFunction(() => {
    const bounds = document.querySelector('#wupage-selection-tools').shadowRoot.querySelector('.card').getBoundingClientRect();
    return bounds.right <= innerWidth - 11 && bounds.bottom <= innerHeight - 11 && bounds.left >= 11 && bounds.top >= 11;
  });
  const cardBounds = await card.boundingBox();
  assert(cardBounds.x >= 11 && cardBounds.y >= 11 && cardBounds.x + cardBounds.width <= 349 && cardBounds.y + cardBounds.height <= 349);
  await page.screenshot({ path: path.join(output, 'selection-short-viewport.png') });
  await card.locator('.close').tap();
  await page.setViewportSize({ width: 390, height: 780 }); await page.reload(); await ball.waitFor();
  // Exercise the image control's opt-in event after initialization, without installing OCR or activating a request.
  await control.evaluate(async () => {
    const { 'wupage.settings': settings } = await chrome.storage.local.get('wupage.settings');
    await chrome.storage.local.set({ 'wupage.settings': { ...settings, imageTranslationEnabled: true } });
  });
  await page.locator('img').scrollIntoViewIfNeeded();
  const imageButton = page.locator('#wupage-image-tools button'); await imageButton.waitFor();
  const imageBounds = await imageButton.boundingBox(); assert(imageBounds.width >= 44 && imageBounds.height >= 44);
  await page.locator('h1').tap(); await imageButton.waitFor();
  assert.equal(requests.length, 2); await page.screenshot({ path: path.join(output, 'image-button.png') });

  const targetTab = await control.evaluate(async origin => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin));
    return { id: tab.id, url: tab.url };
  }, origin);
  const popup = await context.newPage(); await popup.setViewportSize({ width: 320, height: 640 });
  // An action popup keeps the web tab active; opening its document as a test tab needs the same context.
  await popup.addInitScript(tab => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = options => options.active && options.currentWindow ? Promise.resolve([tab]) : query(options);
  }, targetTab);
  await popup.goto(`chrome-extension://${extensionId}/popup.html`); await popup.locator('#pageToggle').waitFor();
  const popupTouch = await context.newCDPSession(popup);
  await popupTouch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await popup.waitForFunction(() => document.querySelector('.popup').dataset.touch === 'true');
  assert.equal(await popup.locator('#debug').isVisible(), false);
  assert((await popup.locator('#pageToggle').boundingBox()).y < (await popup.locator('.language-field').boundingBox()).y);
  await popup.screenshot({ path: path.join(output, 'popup-320.png') });
  await popup.locator('#moreFeatures').tap(); assert.equal(await popup.locator('#debug').isVisible(), true);
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  // Switching providers exposes real model readiness without installing anything.
  await control.evaluate(async () => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    const provider = settings.providers.find(provider => provider.type === 'firefox-local');
    provider.enabled = true; settings.activeProviderId = provider.id;
    await chrome.storage.local.set({ 'wupage.settings': settings });
  });
  await popup.locator('#localProviderNotice[data-state="missing"] button').waitFor();
  await popup.screenshot({ path: path.join(output, 'popup-offline.png') });
  assert.deepEqual(errors, []);
  const report = { passed: true, layouts, translationRequests: requests.length, paragraphPicking: true,
    scrollingDoesNotTranslate: true, selectionAfterPointerCancel: true, imageButtonAfterRelease: true, errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  for (const [index, page] of (context?.pages() || []).entries()) {
    await page.screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => {});
  }
  throw error;
} finally {
  await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
