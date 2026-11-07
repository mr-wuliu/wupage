// Real keyboard events, saved in-page configuration, isolated profiles and a local service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const isEdge = /msedge/i.test(process.env.CHROME_TEST_BROWSER || process.env.PDF_TEST_BROWSER || '');
const output = path.join(root, '.npm-cache/shortcuts', isEdge ? 'edge' : '');
await fs.mkdir(output, { recursive: true });
const calls = [], errors = [], checks = [];
const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/translate') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const data = JSON.parse(raw); calls.push(data);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translations: data.texts.map(text =>
      `译文：${text.replace(/(⟪WUPAGESEGMENT\d+⟫\n)/gu, '$1译文：')}`) }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shortcut reading test</title><style>body{margin:60px;font:20px/1.8 system-ui;color:#243a35}main{max-width:800px}textarea{display:block}</style></head><body><main><h1>A quiet place to read</h1><p id="selection">A selected sentence for translation.</p><p id="paragraph">Another paragraph to read and translate.</p><textarea aria-label="Private draft">Private draft</textarea></main></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  const chromeBrowser = process.env.CHROME_TEST_BROWSER;
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...(chromeBrowser || process.env.PDF_TEST_BROWSER ? { executablePath: chromeBrowser || process.env.PDF_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: chromeBrowser ? ['--lang=zh-CN', '--enable-unsafe-extension-debugging'] : ['--lang=zh-CN', `--load-extension=${path.join(root, 'dist')}`],
    viewport: { width: 1200, height: 1000 }
  });
  if (chromeBrowser) {
    const session = await context.browser().newBrowserCDPSession();
    await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  }
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  options.on('pageerror', error => errors.push(error.message));
  const optionsURL = `chrome-extension://${extensionId}/options.html#shortcutSettings`;
  await options.goto(optionsURL);
  await options.locator('#shortcut-toggle-page-translation:enabled').waitFor();
  await options.evaluate(async baseURL => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.providers.push({ type: 'http-template', id: 'shortcut-test', label: 'Shortcut test', method: 'POST',
      url: `${baseURL}/translate`, headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    settings.activeProviderId = 'shortcut-test'; settings.floatingBallEnabled = false;
    settings.cacheEnabled = false; settings.selectionTranslation.enabled = true;
    settings.translationDisplayMode = 'bilingual'; settings.sourceLang = 'en'; settings.targetLang = 'zh-CN';
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  }, origin);
  await options.reload();
  const field = options.locator('#shortcut-toggle-page-translation');
  await options.locator('#shortcut-toggle-page-translation:enabled').waitFor();
  assert.equal(await options.locator('#shortcutBindings input').count(), 4);
  assert.equal(await options.getByRole('switch').count(), 8);
  assert.equal(await options.locator('#manageShortcuts').count(), 0);
  const record = async combination => { await field.focus(); await field.press(combination); };
  const save = async (binding, enabled = Boolean(binding)) => {
    await options.locator('#save').click();
    await options.waitForFunction(async expected => {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      return response.data.shortcuts['toggle-page-translation'] === expected.binding
        && response.data.shortcutEnabled['toggle-page-translation'] === expected.enabled;
    }, { binding, enabled });
  };
  await record('Alt+Shift+J');
  assert.equal(await field.inputValue(), 'Alt＋Shift＋J');
  await record('Alt+Shift+Q');
  assert.match(await options.locator('#shortcut-error-toggle-page-translation').textContent(), /已用于/);
  await field.press('Escape');
  assert.equal(await field.inputValue(), 'Alt＋Shift＋J');
  await save('Alt+Shift+J');
  await options.reload(); await options.locator('#shortcut-toggle-page-translation:enabled').waitFor();
  assert.equal(await field.inputValue(), 'Alt＋Shift＋J');
  checks.push('in-page recording, conflict, cancellation, persistence and no navigation');
  assert.ok((await options.locator('#shortcutSettings').boundingBox()).height < 800, 'compact desktop shortcut panel');
  await options.screenshot({ path: path.join(output, 'settings-desktop.png'), fullPage: true });
  await options.setViewportSize({ width: 390, height: 844 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await options.screenshot({ path: path.join(output, 'settings-mobile.png'), fullPage: true });
  checks.push('responsive recorder and save controls');
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/article`);
  await page.waitForSelector('#wupage-selection-tools', { state: 'attached' });
  const press = async combination => { await page.bringToFront(); await page.keyboard.press(combination); };
  const translationCount = () => page.locator('.wupage-translation').count();
  await press('Alt+Shift+Y'); await page.waitForTimeout(150); assert.equal(await translationCount(), 0);
  await press('Alt+Shift+J'); await page.locator('.wupage-translation').filter({ hasText: '译文：' }).first().waitFor();
  const translated = calls.length;
  await press('Alt+Shift+M');
  await page.waitForFunction(() => document.querySelector('.wupage-translation')?.getAttribute('data-wupage-display-mode') === 'bilingual-accent');
  assert.equal(calls.length, translated);
  await press('Alt+Shift+J'); await page.waitForFunction(() => document.querySelectorAll('.wupage-translation').length === 0);
  checks.push('actual custom keystroke, old key disabled, page toggle and display reuse');
  await options.bringToFront();
  const pageSwitch = options.locator('[data-shortcut-toggle="toggle-page-translation"]');
  await pageSwitch.click(); await save('Alt+Shift+J', false);
  assert.equal(await field.inputValue(), 'Alt＋Shift＋J');
  await options.reload(); await options.locator('#shortcut-toggle-page-translation:enabled').waitFor();
  assert.equal(await pageSwitch.getAttribute('aria-checked'), 'false');
  assert.equal(await field.inputValue(), 'Alt＋Shift＋J');
  await press('Alt+Shift+J'); await page.waitForTimeout(150); assert.equal(await translationCount(), 0);
  await press('Alt+Shift+L'); await page.waitForFunction(() => document.documentElement.classList.contains('wupage-paragraph-mode'));
  await press('Alt+Shift+L'); await page.waitForFunction(() => !document.documentElement.classList.contains('wupage-paragraph-mode'));
  await options.bringToFront(); await pageSwitch.click(); await save('Alt+Shift+J', true);
  await press('Alt+Shift+J'); await page.locator('.wupage-translation').first().waitFor();
  await press('Alt+Shift+J'); await page.waitForFunction(() => document.querySelectorAll('.wupage-translation').length === 0);
  checks.push('independent on/off switch retains the key across reloads and does not disable other actions');
  await options.bringToFront(); await record('Alt+Shift+K'); await save('Alt+Shift+K');
  await press('Alt+Shift+J'); await page.waitForTimeout(150); assert.equal(await translationCount(), 0);
  await press('Alt+Shift+K'); await page.locator('.wupage-translation').first().waitFor();
  await press('Alt+Shift+K'); await page.waitForFunction(() => document.querySelectorAll('.wupage-translation').length === 0);
  await options.bringToFront();
  await record('Delete');
  assert.equal(await pageSwitch.isDisabled(), true);
  assert.equal(await pageSwitch.getAttribute('aria-checked'), 'false');
  assert.equal(await field.inputValue(), '');
  await save('');
  await options.reload(); await options.locator('#shortcut-toggle-page-translation:enabled').waitFor();
  assert.equal(await pageSwitch.isDisabled(), true);
  assert.equal(await field.inputValue(), '');
  await press('Alt+Shift+K'); await page.waitForTimeout(150); assert.equal(await translationCount(), 0);
  await options.bringToFront(); await options.locator('#restorePageDefaults').click(); await save('Alt+Shift+Y');
  await press('Alt+Shift+Y'); await page.locator('.wupage-translation').first().waitFor();
  await press('Alt+Shift+Y'); await page.waitForFunction(() => document.querySelectorAll('.wupage-translation').length === 0);
  checks.push('live rebinding, empty bindings stay disabled across reloads, explicit default restoration without reloading the reading page');
  await press('Alt+Shift+L'); await page.waitForFunction(() => document.documentElement.classList.contains('wupage-paragraph-mode'));
  await press('Alt+Shift+L'); await page.waitForFunction(() => !document.documentElement.classList.contains('wupage-paragraph-mode'));
  await page.locator('#selection').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await press('Alt+Shift+Q'); await page.locator('.wupage-translation').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.wupage-translation')?.textContent.includes('译文'));
  assert.match(await page.locator('.wupage-translation').first().textContent(), /译文/);
  assert.equal(await page.locator('.wupage-translation').first().getAttribute('data-wupage-translation-target'), await page.locator('#selection').getAttribute('data-wupage-target-id'));
  assert.equal(await page.locator('#paragraph').getAttribute('data-wupage-target-id'), null);
  assert.equal(await page.locator('#wupage-selection-tools .card').isVisible(), false);
  const paragraphRequests = calls.length;
  await press('Alt+Shift+Q'); await page.waitForFunction(() => !document.querySelector('.wupage-translation'));
  assert.equal(calls.length, paragraphRequests);
  await page.locator('#selection').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
  });
  await page.locator('#wupage-selection-tools .trigger-dot, #wupage-selection-tools .trigger-line').first().click();
  await page.locator('#wupage-selection-tools .selection-translation').waitFor();
  const selectionRequests = calls.length;
  await press('Alt+Shift+Q'); assert.equal(calls.length, selectionRequests);
  await page.keyboard.press('Escape'); await page.locator('#wupage-selection-tools .card').waitFor({ state: 'hidden' });
  checks.push('keyboard paragraph mode, inline paragraph translation and restoration, selection card Escape');
  await page.getByRole('textbox', { name: 'Private draft', exact: true }).focus();
  await page.keyboard.press('Alt+Shift+Y'); await page.keyboard.press('Alt+Shift+Q');
  await page.waitForTimeout(150); assert.equal(await translationCount(), 0); assert.equal(calls.length, selectionRequests);
  await page.evaluate(() => { document.activeElement.blur(); window.getSelection().removeAllRanges(); });
  await page.mouse.move(0, 0);
  await press('Alt+Shift+Q'); await page.locator('#wupage-shortcut-notice p').filter({ hasText: '正文段落' }).waitFor();
  assert.equal(calls.length, selectionRequests);
  checks.push('typing protection and visible selection guidance');
  await page.screenshot({ path: path.join(output, 'page-feedback.png'), fullPage: true });
  await options.bringToFront(); await record('Control+c');
  assert.equal(await field.inputValue(), 'Ctrl＋C');
  assert.equal(await field.getAttribute('aria-invalid'), null);
  const warning = options.locator('#shortcut-error-toggle-page-translation');
  assert.match(await warning.textContent(), /可能与浏览器或编辑快捷键冲突/);
  await save('Ctrl+C'); await options.reload();
  await options.locator('#shortcut-toggle-page-translation:enabled').waitFor();
  assert.equal(await field.inputValue(), 'Ctrl＋C');
  assert.match(await warning.textContent(), /可能与浏览器或编辑快捷键冲突/);
  await options.setViewportSize({ width: 1200, height: 1000 });
  await options.screenshot({ path: path.join(output, 'settings-warning.png'), fullPage: true });
  await press('Control+c'); await page.locator('.wupage-translation').filter({ hasText: '译文：' }).first().waitFor();
  await press('Control+c'); await page.waitForFunction(() => document.querySelectorAll('.wupage-translation').length === 0);
  checks.push('advisory warning does not block recording, saving, reloading or actual shortcut execution');
  const popup = await context.newPage(); popup.on('pageerror', error => errors.push(error.message));
  const readingTab = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0], page.url());
  await popup.addInitScript(tab => { chrome.tabs.query = async () => [tab]; }, readingTab);
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#translationDisplayMode:enabled').waitFor();
  await popup.locator('#sourceLang').selectOption('auto');
  await popup.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).data.sourceLang === 'auto');
  for (const width of [264, 320]) {
    await popup.setViewportSize({ width, height: 700 });
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const row = await popup.evaluate(() => {
      const target = document.querySelector('#targetLang').getBoundingClientRect();
      const auto = document.querySelector('#autoTranslation').getBoundingClientRect();
      return { targetRight: target.right, autoLeft: auto.left, centerDifference: Math.abs(target.y + target.height / 2 - auto.y - auto.height / 2) };
    });
    assert.ok(row.autoLeft > row.targetRight && row.centerDifference < 1);
    await popup.screenshot({ path: path.join(output, `popup-${width}.png`), fullPage: true });
  }
  await popup.screenshot({ path: path.join(output, 'popup-entry.png'), fullPage: true });
  assert.equal(await popup.locator('header button').count(), 1);
  assert.equal(await popup.getByRole('button', { name: '打开设置', exact: true }).isVisible(), true);
  assert.equal(await popup.locator('#openOptions svg').count(), 1);
  assert.equal(await popup.locator('#openOptions').textContent().then(text => text.trim()), '');
  assert.equal(await popup.locator('#autoTranslation').textContent(), '自动');
  const selectionToggle = popup.getByRole('button', { name: '划词翻译', exact: true });
  await selectionToggle.click();
  await popup.waitForFunction(() => document.querySelector('#selectionTranslation').getAttribute('aria-pressed') === 'false');
  await popup.reload(); await popup.locator('#selectionTranslation:enabled').waitFor();
  assert.equal(await selectionToggle.getAttribute('aria-pressed'), 'false');
  await page.bringToFront();
  await page.locator('#selection').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await press('Alt+Shift+Q');
  await page.locator('.wupage-translation').first().waitFor();
  await press('Alt+Shift+Q'); await page.waitForFunction(() => !document.querySelector('.wupage-translation'));
  await popup.bringToFront(); await selectionToggle.click();
  await popup.waitForFunction(() => document.querySelector('#selectionTranslation').getAttribute('aria-pressed') === 'true');
  await page.bringToFront();
  await page.locator('#selection').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
  });
  await page.locator('#wupage-selection-tools .trigger-dot, #wupage-selection-tools .trigger-line').first().click();
  await page.locator('#wupage-selection-tools .selection-translation').waitFor();
  checks.push('compact settings icon, automatic switch beside target language, independent selection toggle and paragraph shortcut');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, output }));
} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) {
    console.error(JSON.stringify({ url: page.url(), errors, calls, state: await page.locator('body').innerText().catch(() => 'unavailable') }));
    await page.screenshot({ path: path.join(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
}
