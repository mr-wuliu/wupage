// Real touch and device-emulation regression. Build dist/ first; no remote service is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, '.npm-cache/floating-responsive');
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
let calls = 0;
let fail = true;
const requests = [];
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { texts } = JSON.parse(body);
    requests.push(...texts);
    calls++;
    if (fail) { response.writeHead(400).end('Local test service unavailable'); return; }
    await new Promise(resolve => setTimeout(resolve, 150));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ translations: texts.map(text => {
      const markers = [...text.matchAll(/⟪WUPAGESEGMENT\d+⟫/gu)];
      return markers.length ? markers.map((marker, index) => `${marker[0]}\n这是本地模拟译文 ${index}。`).join('\n')
        : '这是本地模拟译文。';
    }) }));
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tablet reading fixture</title><style>
      body{margin:0;background:#edf2f8;color:#172026;font:18px/1.7 system-ui}
      main{max-width:760px;margin:48px auto;padding:24px;background:white;border-radius:16px}
    </style></head><body><main><h1>A quiet place to read</h1>
    <p>Good translation helps people read and understand ideas across languages.</p>
    </main></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
    viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  });
  const browserSession = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await browserSession.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
  await browserSession.detach();
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/options.html`);
  await control.waitForSelector('#save');
  await control.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.activeProviderId = 'http-template';
    settings.sourceLang = 'en';
    settings.targetLang = 'ja';
    settings.translationDisplayMode = 'replace';
    settings.cacheEnabled = false;
    Object.assign(settings.providers.find(provider => provider.id === 'http-template'), {
      label: '平板测试服务', url: `${origin}/translate`, method: 'POST',
      headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations'
    });
    const result = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (!result.ok) throw new Error(result.error);
  }, origin);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const ball = page.locator('#wupage-floating-ball');
  const menu = page.locator('#wupage-floating-menu');
  await ball.waitFor({ state: 'visible' });
  const touch = await context.newCDPSession(page);
  const touchPoint = async () => {
    const box = await ball.boundingBox();
    const viewport = page.viewportSize();
    return { x: Math.min(viewport.width - 10, box.x + box.width / 2), y: box.y + box.height / 2, id: 1 };
  };
  const press = async point => touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  const release = async () => touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await menu.isVisible(), false);
  const longPressStarted = Date.now();
  await press(await touchPoint());
  await menu.waitFor({ state: 'visible' });
  const longPressElapsed = Date.now() - longPressStarted;
  assert(longPressElapsed >= 490, `Long press opened too early: ${longPressElapsed} ms`);
  await release();
  await page.waitForTimeout(500);
  assert.equal(await menu.isVisible(), true, 'A touch menu stays open after the finger lifts');
  assert.equal(calls, 0, 'A long press and its release must not translate');
  await page.locator('h1').tap();
  assert.equal(await menu.isVisible(), false, 'Tapping outside dismisses the menu');

  const dragPoint = await touchPoint();
  await press(dragPoint);
  await page.waitForTimeout(150);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
    ...dragPoint, x: dragPoint.x - 80, y: dragPoint.y - 80
  }] });
  await page.waitForTimeout(600);
  assert.equal(await menu.isVisible(), false, 'Moving the finger cancels the long press');
  await release();
  assert.equal(calls, 0, 'Dragging must not translate');
  await page.reload();
  await ball.waitFor({ state: 'visible' });
  // A real tap cannot trigger the mouse-hover initialization path.
  assert.equal(await menu.isVisible(), false);
  await ball.tap();
  await menu.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-role="translation-status"]').dataset.tone === 'error');
  assert(calls > 0);
  assert.equal(await menu.locator('.wupage-provider-name').first().textContent(), '平板测试服务');
  assert.equal(await menu.locator('[data-role="source-lang-value"]').textContent(), 'English');
  assert.equal(await menu.locator('[data-role="target-lang-value"]').textContent(), '日本語');
  assert.equal(await menu.locator('[data-role="display-mode"]').inputValue(), 'replace');

  const layouts = [];
  for (const [name, viewport] of [
    ['ipad-portrait', { width: 1032, height: 1376 }],
    ['ipad-landscape', { width: 1376, height: 1032 }]
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(({ width, height }) => {
      const box = document.querySelector('#wupage-floating-menu').getBoundingClientRect();
      return innerWidth === width && innerHeight === height && box.right <= width - 7 && box.bottom <= height - 7;
    }, viewport);
    const box = await menu.boundingBox();
    assert(box && box.x >= 8 && box.y >= 8);
    assert(box.x + box.width <= viewport.width - 8);
    assert(box.y + box.height <= viewport.height - 7); // offsetHeight rounds fractional CSS pixels.
    const trigger = menu.locator('.wupage-provider-trigger');
    const triggerBox = await trigger.boundingBox();
    const iconBox = await trigger.locator('.wupage-provider-icon').boundingBox();
    const nameBox = await trigger.locator('.wupage-provider-name').boundingBox();
    assert(triggerBox?.height >= 36 && nameBox?.width > 0 && iconBox?.width > 0);
    assert(nameBox.x >= iconBox.x + iconBox.width);
    assert.equal(await menu.evaluate(element => element.scrollWidth > element.clientWidth), false);
    assert.equal(await menu.locator('[data-action="paragraph-mode"]').textContent().then(text => text.trim()), '点选段落');
    assert.equal(await menu.locator('.wupage-menu-hint').isVisible(), false);
    await trigger.tap();
    const list = menu.locator('.wupage-provider-list');
    await list.waitFor({ state: 'visible' });
    const listBox = await list.boundingBox();
    assert(listBox && listBox.x >= 0 && listBox.y >= 0);
    assert(listBox.x + listBox.width <= viewport.width && listBox.y + listBox.height <= viewport.height);
    await list.locator('[data-value="http-template"]').tap();
    assert.equal(await list.isVisible(), false);
    if (!await menu.locator('[data-role="display-mode"]').isVisible()) await menu.locator('[data-action="more"]').tap();
    await menu.locator('[data-role="display-mode"]').selectOption('bilingual-accent');
    await page.waitForFunction(() => document.querySelector('[data-role="display-mode"]').value === 'bilingual-accent');
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    layouts.push({ name, viewport, menu: box, provider: triggerBox });
  }
  // A mouse-capable tablet keeps the desktop controls, regardless of viewport width.
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.waitForFunction(() => document.querySelector('[data-action="paragraph-mode"] span').textContent === '段落翻译');
  assert.equal(await menu.locator('.wupage-menu-hint').isVisible(), false);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await page.waitForFunction(() => document.querySelector('[data-action="paragraph-mode"] span').textContent === '点选段落');
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 320, height: 800 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const popupMedia = await context.newCDPSession(popup);
  await popupMedia.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await popup.locator('#pageToggle').waitFor({ state: 'visible' });
  await popup.waitForFunction(() => document.querySelector('#paragraphMode span').textContent === '点选段落');
  const fullPageAction = await popup.locator('#pageToggle').boundingBox();
  assert(Math.abs(fullPageAction.width - await popup.locator('[data-popup-menu-grid]').evaluate(row => row.clientWidth)) < 1, 'The page button fills the row on touch devices');
  assert.equal(await popup.locator('#floatingBall').isVisible(), false, 'Infrequent switches start folded');
  assert.equal(await popup.locator('#paragraphMode').isVisible(), true, 'Touch paragraph picking is reachable');
  assert.equal(await popup.locator('#clearCache').isVisible(), false);
  await popup.locator('#moreFeatures').tap();
  assert.equal(await popup.locator('#floatingBall').isVisible(), true);
  assert.equal(await popup.locator('#clearCache').isVisible(), true);
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await popupMedia.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await popup.waitForFunction(() => document.querySelector('#paragraphMode span').textContent === '段落翻译');
  await popup.close();

  // Feed updates must not alternate the primary action or move an already open menu.
  fail = false;
  await page.bringToFront();
  await page.setViewportSize({ width: 427, height: 952 });
  await page.reload();
  await ball.waitFor({ state: 'visible' });
  await control.evaluate(() => chrome.storage.local.set({
    'wupage.floating.position': { left: 405, top: 300, edge: 'right' }
  }));
  await page.waitForFunction(() => Math.abs(document.querySelector('#wupage-floating-ball').getBoundingClientRect().top - 300) < 1);
  await ball.tap();
  await page.waitForFunction(() => document.querySelector('#wupage-floating-ball').getAttribute('aria-busy') === 'false'
    && document.querySelector('.wupage-translation:not(.wupage-translation-pending)'));
  await press(await touchPoint());
  await menu.waitFor({ state: 'visible' });
  await release();
  const originalTop = await menu.evaluate(element => element.style.top);
  await page.evaluate(() => {
    const action = document.querySelector('[data-action="page-toggle"]');
    window.actionTextNode = action.firstChild;
    window.actionTextChanges = 0;
    new MutationObserver(records => { window.actionTextChanges += records.length; })
      .observe(action, { childList: true, subtree: true, characterData: true });
  });
  const beforeFeedUpdates = calls;
  for (let index = 0; index < 3; index++) {
    await page.evaluate(index => {
      const post = document.createElement('p');
      post.textContent = `New feed post number ${index} for incremental translation.`;
      // Keep the new post in the reading area above the mobile bottom panel.
      document.querySelector('main').prepend(post);
    }, index);
    await page.waitForFunction(() => document.querySelector('#wupage-floating-ball').getAttribute('aria-busy') === 'true');
    assert.equal(await menu.locator('[data-action="page-toggle"]').textContent(), '显示原文');
    assert.equal(await menu.evaluate(element => element.style.top), originalTop);
    await page.waitForFunction(() => document.querySelector('#wupage-floating-ball').getAttribute('aria-busy') === 'false');
    assert.equal(await menu.evaluate(element => element.style.top), originalTop);
  }
  assert.equal(calls - beforeFeedUpdates, 3, 'Only the three new posts need translation');
  assert.equal(await page.evaluate(() => window.actionTextChanges), 0);
  assert.equal(await page.evaluate(() => document.querySelector('[data-action="page-toggle"]').firstChild === window.actionTextNode), true);
  assert.equal(requests.some(text => /显示原文|翻译全文|翻译服务/u.test(text)), false);
  await page.screenshot({ path: path.join(output, 'mobile-feed-stable.png') });
  await menu.locator('[data-action="page-toggle"]').tap();
  assert.equal(await ball.textContent(), '译');
  assert.deepEqual(errors, []);
  const report = { passed: true, calls, touchWithoutHover: true, longPressElapsed,
    heldMenuAfterRelease: true, outsideTapDismissed: true, dragCancelledLongPress: true,
    touchParagraphPickerVisible: true, mouseParagraphModeVisible: true,
    stableFeedAction: true, stableFeedMenuPosition: true, errors, layouts };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
