// Reproduce a popup opened on a tab that predates extension loading, then
// verify a retry after refreshing the page. Profiles and service are isolated.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
if (target.kind === 'firefox') throw new Error('This popup regression uses Chromium automation.');
const output = path.join(root, '.npm-cache/paragraph-mode', target.kind);
await fs.mkdir(output, { recursive: true });
const calls = [], checks = [];
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const part of request) body += part;
    const payload = JSON.parse(body); calls.push(...payload.texts);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translations: payload.texts.map(text =>
      text.includes('⟪WUPAGESEGMENT') ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\n)/g, '$1译文：') : `译文：${text}`) }));
  } else response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><meta charset="utf-8">
    <title>Paragraph mode recovery</title><style>body{font:18px/1.6 Arial;padding:24px}iframe{width:600px;height:220px}</style><body><main>
    <p id="paragraph">${request.url === '/child' ? 'Embedded' : 'Main'} paragraph: A useful translation tool should preserve the original text and let readers choose each paragraph.</p>
    <p id="rich">This paragraph keeps <strong>original inline formatting</strong> and renders its translation separately.</p>
    ${request.url === '/child' ? '' : '<iframe src="/child"></iframe>'}</main></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
  browser = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1400, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
  });
  const page = await browser.newPage(); await page.goto(origin);
  const identity = verifyBrowserIdentity(target, await page.evaluate(() => navigator.userAgent));
  const session = await browser.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const control = await browser.newPage(); await control.goto(`chrome-extension://${id}/options.html`);
  await control.evaluate(async origin => {
    const loaded = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }); const settings = loaded.data;
    settings.providers.push({ id: 'paragraph-test', type: 'http-template', label: 'Paragraph test', method: 'POST', url: `${origin}/translate`,
      headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    Object.assign(settings, { activeProviderId: 'paragraph-test', sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false, translationDisplayMode: 'bilingual' });
    const saved = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }); if (!saved.ok) throw new Error(saved.error);
  }, origin);
  const sourceTab = await control.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url === origin + '/'), origin);
  assert.ok(sourceTab?.id);
  assert.equal(await page.locator('#wupage-floating-ball').count(), 0, 'the pre-existing tab has no content script');
  const popup = await browser.newPage(); await popup.setViewportSize({ width: 330, height: 1050 });
  // A toolbar popup does not replace the web tab as the active tab. A test tab
  // does, so preserve the real source-tab metadata for active-tab queries only.
  await popup.addInitScript(sourceTab => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = info => info.active ? Promise.resolve([sourceTab]) : query(info);
  }, sourceTab);
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const mode = popup.locator('#translationDisplayMode'), toggle = popup.locator('#paragraphMode');
  await toggle.waitFor({ state: 'visible' });
  await popup.locator('#paragraphMode:not(:disabled)').waitFor();
  await popup.screenshot({ path: path.join(output, 'disconnected.png') });
  {
    assert.equal(await toggle.isEnabled(), true, 'connection failure does not disable the button');
    assert.equal(await mode.locator('option').count(), 3);
    assert.ok((await popup.locator('#status').textContent()).includes('刷新网页后重试'));
    await toggle.click();
    await popup.waitForFunction(() => !document.querySelector('#paragraphMode').disabled && document.querySelector('#paragraphMode').getAttribute('aria-pressed') === 'false');
    assert.ok((await popup.locator('#status').textContent()).includes('刷新网页后重试'));
    assert.equal(await toggle.isEnabled(), true);
    checks.push('missing content script gives an actionable refresh hint and keeps retry enabled');
    await page.reload(); await page.locator('#wupage-floating-ball').waitFor({ state: 'visible' });
    await toggle.click();
    await page.waitForFunction(() => document.documentElement.classList.contains('wupage-paragraph-mode'));
    await popup.waitForFunction(() => !document.querySelector('#paragraphMode').disabled && document.querySelector('#paragraphMode').getAttribute('aria-pressed') === 'true');
    assert.equal(await popup.locator('#status').textContent(), '');
    assert.equal(await toggle.getAttribute('title'), null);
    await mode.selectOption('bilingual-accent');
    await control.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).data.translationDisplayMode === 'bilingual-accent');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    for (const width of [264, 330]) {
      await popup.setViewportSize({ width, height: 1000 });
      assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const full = await popup.locator('#pageToggle').boundingBox(), paragraph = await toggle.boundingBox();
      assert.ok(Math.abs(full.y - paragraph.y) < 1 && Math.abs(full.height - paragraph.height) < 1);
      await popup.screenshot({ path: path.join(output, `buttons-${width}.png`) });
    }
    await popup.screenshot({ path: path.join(output, 'enabled.png') });
    checks.push('the same popup successfully retries after page refresh and clears the stale warning');
    const child = page.frames().find(frame => frame.url() === origin + '/child'); assert.ok(child);
    await child.waitForFunction(() => document.documentElement.classList.contains('wupage-paragraph-mode'));
    for (const frame of [page, child]) {
      for (const [source, output] of [['#paragraph', '#paragraph .wupage-translation'], ['#rich', '#rich + .wupage-translation']]) {
        await frame.locator(source).click({ modifiers: ['Control'] });
        const translation = frame.locator(`${output}:not(.wupage-translation-pending)`);
        await translation.waitFor();
        await translation.scrollIntoViewIfNeeded();
        assert.ok((await translation.textContent()).includes('译文'));
        const fragment = await translation.evaluate(element => {
          const box = element.getBoundingClientRect();
          const rect = [...element.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          return { x: x - box.left, y: y - box.top, hitsTranslation: element.contains(document.elementFromPoint(x, y)) };
        });
        assert.ok(fragment.hitsTranslation, 'the pointer targets the visible translation');
        const box = await translation.boundingBox(); assert.ok(box);
        await page.keyboard.down('Control');
        try { await page.mouse.click(box.x + fragment.x, box.y + fragment.y); } finally { await page.keyboard.up('Control'); }
        await frame.locator(output).waitFor({ state: 'detached', timeout: 5000 });
      }
    }
    assert.equal(calls.length, 4, 'only the clicked paragraphs are sent');
    await toggle.click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('wupage-paragraph-mode'));
    await child.waitForFunction(() => !document.documentElement.classList.contains('wupage-paragraph-mode'));
    assert.equal(await mode.inputValue(), 'bilingual-accent');
    checks.push('Ctrl-clicking inline and sibling translations restores the correct paragraph in top and embedded documents');
    const ball = page.locator('#wupage-floating-ball');
    await ball.hover();
    const menu = page.locator('#wupage-floating-menu'); await menu.waitFor({ state: 'visible' });
    const menuToggle = menu.locator('[data-action="paragraph-mode"]');
    await menuToggle.click();
    await page.waitForFunction(() => document.documentElement.classList.contains('wupage-paragraph-mode'));
    await menu.locator('[data-role="display-mode"]').selectOption('replace');
    await page.waitForFunction(() => document.querySelector('[data-role="display-mode"]').disabled === false);
    assert.equal(await menuToggle.getAttribute('aria-pressed'), 'true');
    await menuToggle.click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('wupage-paragraph-mode'));
    checks.push('popup and floating menu expose independent paragraph buttons and preserve mode when changing display style');
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, checks, calls }, null, 2));
  console.log(JSON.stringify({ ...identity, checks, output }, null, 2));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
