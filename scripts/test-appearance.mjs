// Real MV3 appearance regression with an isolated profile and local dictionary response.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const output = path.join(root, '.npm-cache/appearance');
await fs.mkdir(output, { recursive: true });
const errors = [], checks = [];
let translationCalls = 0;
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { texts } = JSON.parse(JSON.parse(body).messages.at(-1).content);
    translationCalls++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map(text => `译文：${text}`)) } }] }));
    return;
  }
  if (request.url === '/photo.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="160"><rect width="360" height="160" rx="10" fill="#e6e1da"/><circle cx="100" cy="80" r="38" fill="#9fb2ab"/></svg>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html style="color-scheme:light;background:#fafafa;color:#222"><body style="font:22px/1.8 system-ui;padding:40px"><h1>A quiet place to read</h1><p id="word">serendipity</p><p id="light" style="background:#fff;color:#27313a;padding:12px">A small discovery can make an ordinary day feel extraordinary.</p><p id="dark" style="background:#172026;color:#e7efec;padding:12px">Discover something wonderful while reading a new story.</p><img id="photo" src="/photo.svg" width="360" height="160" alt=""></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging'],
    viewport: { width: 1440, height: 1040 }, colorScheme: 'light'
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const base = `chrome-extension://${extensionId}`;
  await worker.evaluate(() => {
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url || String(input));
      if (url.hostname !== 'dict.youdao.com') {
        if (url.hostname !== '127.0.0.1') throw new Error(`Unexpected remote request: ${url.origin}`);
        return original(input, init);
      }
      return Response.json({ input: 'serendipity', ec: { word: [{ 'return-phrase': { l: { i: 'serendipity' } },
        ukphone: 'ˌser.ənˈdɪp.ə.ti', trs: [{ tr: [{ l: { i: ['n. 不期而遇的美好'] } }] }] }] } });
    };
  });
  const options = await context.newPage();
  await options.goto(`${base}/options.html#appearanceSettings`);
  await options.waitForFunction(() => document.querySelector('#appearanceScheme').options.length > 0);
  assert.equal(await options.locator('[name="appearanceMode"]:checked').inputValue(), 'system');
  assert.equal(await options.locator('#floatingOpacityRange').inputValue(), '100');
  assert.equal(await options.locator('#floatingOpacityRange').isEnabled(), true);
  await options.screenshot({ path: path.join(output, 'light.png'), fullPage: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await options.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.activeProviderId = 'openai-compatible'; settings.translationDisplayMode = 'bilingual-accent';
    Object.assign(settings.providers.find(provider => provider.id === 'openai-compatible'), {
      baseURL: `${origin}/v1`, apiKey: 'local-test', enabled: true
    });
    const saved = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (!saved.ok) throw new Error(saved.error);
  }, origin);
  await options.reload();
  await options.waitForFunction(() => document.querySelector('#appearanceScheme').options.length > 0);
  assert.equal(await options.locator('#translationDisplayMode').inputValue(), 'bilingual-accent');
  const site = await context.newPage();
  await site.goto(origin);
  await site.locator('#wupage-floating-ball').waitFor();
  const translated = await worker.evaluate(async origin => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
    return chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
  }, origin);
  assert.equal(translated.ok, true, JSON.stringify(translated));
  assert.ok(translationCalls > 0, 'translation uses the local test service');
  await site.locator('#light .wupage-translation').waitFor();
  await site.evaluate(() => { window.appearanceTranslation = document.querySelector('#light .wupage-translation'); });
  const popup = await context.newPage();
  await popup.goto(`${base}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('#provider').options.length > 0);

  await options.locator('[name="appearanceMode"][value="dark"]').check();
  await options.locator('#appearanceScheme').selectOption('midnight');
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent === '已保存。');
  await options.screenshot({ path: path.join(output, 'dark.png'), fullPage: true });
  await popup.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(21, 27, 43)');
  await site.waitForFunction(() => getComputedStyle(document.querySelector('#wupage-floating-ball')).backgroundColor === 'rgb(156, 188, 255)');
  await site.locator('#wupage-floating-ball').hover();
  await site.locator('#wupage-floating-menu').waitFor({ state: 'visible' });
  assert.equal(await site.locator('#wupage-floating-menu').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(32, 42, 64)');
  assert.equal(await site.locator('[data-action="page-toggle"]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(156, 188, 255)');
  assert.equal(await site.locator('[data-action="page-toggle"]').evaluate(el => getComputedStyle(el).color), 'rgb(0, 0, 0)');
  assert.equal(await site.locator('html').evaluate(el => getComputedStyle(el).colorScheme), 'light');
  checks.push('saved theme updates existing popup and page controls without changing host color scheme');

  await site.locator('#word').dblclick({ position: { x: 35, y: 16 } });
  await site.locator('#wupage-selection-tools .trigger-dot').click();
  const card = site.locator('#wupage-selection-tools .card');
  await card.waitFor({ state: 'visible' });
  await site.locator('#wupage-selection-tools .meanings').waitFor();
  assert.equal(await card.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(32, 42, 64)');
  await site.screenshot({ path: path.join(output, 'page-controls.png') });
  checks.push('shadow DOM dictionary card inherits selected colors');

  await options.locator('#duplicateScheme').click();
  await options.locator('#appearanceSchemeName').fill('我的午夜');
  await options.locator('[data-color-group="interface"] summary').click();
  await options.locator('[data-color-hex="accent"]').fill('#ffcc66');
  const componentColors = { 'floating-background': '#b83468', 'floating-foreground': '#ffffff', 'floating-hover': '#91274e',
    'translation-light': '#aa3344', 'translation-dark': '#f3c97a', 'paragraph-highlight': '#7b45bb',
    'selection-trigger': '#e87824', 'selection-background': '#fdf4e7', 'selection-foreground': '#39271b', 'selection-accent': '#93521d',
    'image-button-background': '#202c2e', 'image-button-foreground': '#f3c97a' };
  for (const group of ['selection', 'image']) await options.locator(`[data-color-group="${group}"] summary`).click();
  for (const [key, value] of Object.entries(componentColors)) await options.locator(`[data-color-hex="${key}"]`).fill(value);
  assert.equal(await options.locator('.appearance-preview-button').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 204, 102)');
  const callsBeforeColors = translationCalls;
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent === '已保存。');
  await popup.waitForFunction(() => document.documentElement.style.getPropertyValue('--wp-accent') === '#ffcc66');
  await site.waitForFunction(() => getComputedStyle(document.querySelector('#light .wupage-translation')).color === 'rgb(170, 51, 68)');
  assert.equal(await site.locator('#dark .wupage-translation').evaluate(el => getComputedStyle(el).color), 'rgb(243, 201, 122)');
  assert.equal(await site.evaluate(() => window.appearanceTranslation === document.querySelector('#light .wupage-translation')), true);
  assert.equal(await site.locator('#light').evaluate(el => getComputedStyle(el).color), 'rgb(39, 49, 58)');
  assert.equal(await card.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(253, 244, 231)');
  assert.equal(await card.evaluate(el => getComputedStyle(el).color), 'rgb(57, 39, 27)');
  await site.waitForFunction(() => getComputedStyle(document.querySelector('#wupage-floating-ball')).backgroundColor === 'rgb(184, 52, 104)');
  assert.equal(await site.locator('#wupage-floating-ball .wupage-floating-label').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
  await site.locator('#wupage-selection-tools .close').click();
  await site.locator('#wupage-floating-ball').hover();
  await site.waitForFunction(() => getComputedStyle(document.querySelector('#wupage-floating-ball')).backgroundColor === 'rgb(145, 39, 78)');
  await site.locator('#photo').hover();
  // Inspect the image button without downloading a model or sending an OCR request.
  await popup.evaluate(async () => {
    const stored = await chrome.storage.local.get('wupage.settings');
    stored['wupage.settings'].imageTranslationEnabled = true;
    await chrome.storage.local.set(stored);
  });
  await site.locator('#wupage-image-tools').waitFor({ state: 'attached' });
  await site.mouse.move(1, 1);
  await site.locator('#photo').hover();
  await site.locator('#wupage-image-tools button').waitFor({ state: 'visible' });
  assert.equal(await site.locator('#wupage-image-tools button').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(32, 44, 46)');
  assert.equal(await site.locator('#wupage-image-tools button').evaluate(el => getComputedStyle(el).color), 'rgb(243, 201, 122)');
  await popup.evaluate(async () => {
    const stored = await chrome.storage.local.get('wupage.settings');
    stored['wupage.settings'].imageTranslationEnabled = false;
    await chrome.storage.local.set(stored);
  });
  assert.equal(translationCalls, callsBeforeColors);
  await site.screenshot({ path: path.join(output, 'component-colors.png'), fullPage: true });
  checks.push('independent floating, hover, dictionary and image colors; existing bilingual text recolors in place without translation requests');
  await options.bringToFront();
  const opacityRange = options.locator('#floatingOpacityRange');
  const opacityNumber = options.locator('#floatingOpacityNumber');
  await opacityRange.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await opacityRange.focus(); await opacityRange.press('Home'); await opacityRange.press('ArrowRight');
  assert.equal(await opacityNumber.inputValue(), '1');
  const sliderBox = await opacityRange.boundingBox();
  await options.mouse.move(sliderBox.x + sliderBox.width - 8, sliderBox.y + sliderBox.height / 2);
  await options.mouse.down();
  await options.mouse.move(sliderBox.x + sliderBox.width * .45, sliderBox.y + sliderBox.height / 2, { steps: 8 });
  await options.mouse.up();
  const draggedValue = Number(await opacityRange.inputValue());
  assert.ok(draggedValue > 20 && draggedValue < 80);
  assert.equal(await opacityNumber.inputValue(), String(draggedValue));
  for (const value of [0, 100, 55]) {
    await opacityNumber.fill(String(value));
    assert.equal(await opacityRange.inputValue(), String(value));
    assert.equal(await options.locator('.appearance-preview-ball').evaluate(el => getComputedStyle(el).opacity), String(value / 100));
  }
  assert.equal(await site.locator('#wupage-floating-ball').evaluate(el => getComputedStyle(el).opacity), '1');
  await options.locator('[data-color-group="floating"]').screenshot({ path: path.join(output, 'floating-opacity.png') });
  await options.locator('#save').click();
  await site.waitForFunction(() => getComputedStyle(document.querySelector('#wupage-floating-ball')).opacity === '0.55');
  await site.bringToFront(); await site.locator('#wupage-floating-ball').hover();
  await site.locator('#wupage-floating-menu').waitFor({ state: 'visible' });
  assert.equal(await site.locator('#wupage-floating-menu').evaluate(el => getComputedStyle(el).opacity), '1');
  await site.keyboard.press('Escape');
  const ballBox = await site.locator('#wupage-floating-ball').boundingBox();
  await site.mouse.move(ballBox.x + ballBox.width / 2, ballBox.y + ballBox.height / 2);
  await site.mouse.down();
  await site.mouse.move(ballBox.x + ballBox.width / 2 - 30, ballBox.y + ballBox.height / 2 - 15, { steps: 6 });
  const draggingOpacity = await site.locator('#wupage-floating-ball').evaluate(el => Number(getComputedStyle(el).opacity));
  assert.ok(Math.abs(draggingOpacity - .55 * .92) < .001);
  await site.mouse.up();
  await site.waitForFunction(() => getComputedStyle(document.querySelector('#wupage-floating-ball')).opacity === '0.55');
  checks.push('opacity slider, numeric entry and live preview; saved opacity updates the ball and dragging while the menu remains opaque');
  // Saving from a popup opened before the appearance edit must retain the newer palette.
  await popup.locator('#sourceLang').selectOption('en');
  await popup.waitForFunction(async () => (await chrome.storage.local.get('wupage.settings'))['wupage.settings'].sourceLang === 'en');
  await options.reload();
  await options.waitForFunction(() => document.querySelector('#appearanceSchemeName').value === '我的午夜');
  assert.equal(await options.locator('[data-color-hex="accent"]').inputValue(), '#ffcc66');
  assert.equal(await options.locator('#floatingOpacityNumber').inputValue(), '55');
  await options.screenshot({ path: path.join(output, 'custom.png'), fullPage: true });
  checks.push('custom colors and opacity persist on reopen and survive saves from an existing popup');

  await options.locator('[name="appearanceMode"][value="system"]').check();
  await options.emulateMedia({ colorScheme: 'light' });
  await options.waitForFunction(() => document.documentElement.dataset.wupageTheme === 'light');
  await options.emulateMedia({ colorScheme: 'dark' });
  await options.waitForFunction(() => document.documentElement.dataset.wupageTheme === 'dark');
  assert.equal(await options.locator('html').evaluate(el => el.style.getPropertyValue('--wp-accent')), '#ffcc66');
  checks.push('system changes select independently configured light and dark schemes');
  for (const width of [960, 720, 390]) {
    await options.setViewportSize({ width, height: 1000 });
    await options.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`);
    await options.screenshot({ path: path.join(output, `width-${width}.png`), fullPage: true });
  }
  checks.push('no document overflow at desktop, tablet and narrow widths');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
