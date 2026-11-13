// Synthetic Outlook HTML only; no account, mailbox or live translation service is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
if (target.kind === 'firefox') throw new Error('This routed fixture supports Chromium and Edge.');
const output = path.join(root, '.npm-cache/outlook-content', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const requests = [], errors = [], reports = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const { texts } = JSON.parse(body); requests.push(...texts);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ translations: texts.map(text => text
    .split(/(⟪WUPAGE(?:OPEN|CLOSE|BREAK|SEGMENT)?\d+⟫)/gu)
    .map(part => /^⟪WUPAGE/u.test(part) || !/\p{L}/u.test(part) ? part : `邮件译文：${part}`).join('')) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const url = 'https://partner.outlook.cn/mail/__wupage_outlook_test__';
const fixture = `<!doctype html><html translate="no" lang="en"><meta charset="utf-8"><title>Outlook mail regression</title>
  <style>*{box-sizing:border-box}body{margin:24px;font:16px/1.5 Arial;color:#202124;background:white}
  main{max-width:700px;margin:auto;overflow-wrap:anywhere}[contenteditable]{border:1px solid #aaa;padding:12px}</style>
  <main role="main"><section role="document" tabindex="0" aria-label="Message body">
    <p id="message">Please review the <strong>attached report</strong> before our next meeting.</p>
    <p id="protected" translate="no">Locally excluded paragraph.</p><p class="notranslate">Protected paragraph.</p>
    <p hidden>Hidden message.</p>
    <div contenteditable="true" role="textbox" style="">Unsent reply draft.</div>
  </section></main></html>`;
let context, page;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1400, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.route('https://partner.outlook.cn/**', route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }) : route.abort());
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const control = await context.newPage();
  await control.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const settings = await control.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.providers.push({ id: 'outlook-test', type: 'http-template', label: 'Outlook local test', method: 'POST',
      url: `${origin}/translate`, headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    Object.assign(settings, { activeProviderId: 'outlook-test', sourceLang: 'auto', targetLang: 'zh-CN', cacheEnabled: false,
      floatingBallEnabled: false, translationDisplayMode: 'bilingual', imageTranslationEnabled: false });
    settings.autoTranslation = { ...settings.autoTranslation, enabled: false };
    settings.selectionTranslation = { ...settings.selectionTranslation, enabled: false };
    settings.videoTranslation = { ...settings.videoTranslation, enabled: false };
    const result = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (!result.ok) throw new Error(result.error); return settings;
  }, origin);
  const send = async request => {
    const result = await control.evaluate(async ({ url, request }) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      return chrome.tabs.sendMessage(tab.id, request, { frameId: 0 });
    }, { url, request });
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const waitTranslation = (id, text, mode) => page.waitForFunction(({ id, text, mode }) => {
    const source = document.getElementById(id);
    const target = source?.getAttribute('data-wupage-target-id');
    const translated = source?.querySelector('.wupage-translation')
      || (target && document.querySelector(`[data-wupage-translation-target="${target}"]`));
    if (mode === 'replace') return source?.hasAttribute('data-wupage-translated') && source.textContent.includes(text) && !translated;
    return translated?.textContent.includes(text) && (!mode || translated.getAttribute('data-wupage-display-mode') === mode);
  }, { id, text, mode });
  const identity = verifyBrowserIdentity(target, await page.evaluate('navigator.userAgent'));
  for (const width of [1400, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url);
    await assert.doesNotReject(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await send({ type: 'GET_TRANSLATION_STATE' }); return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Outlook content script did not initialize');
    });
    const original = await page.locator('main').innerHTML();
    await send({ type: 'TRANSLATE_PAGE' });
    await waitTranslation('message', '邮件译文：');
    for (const mode of ['replace', 'bilingual-accent', 'bilingual']) {
      settings.translationDisplayMode = mode;
      assert.equal((await control.evaluate(settings => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }), settings)).ok, true);
      await waitTranslation('message', '邮件译文：', mode);
      assert.equal(await page.locator('html').getAttribute('translate'), 'no');
      assert.equal(await page.locator('#protected').textContent(), 'Locally excluded paragraph.');
      assert.equal(await page.locator('[contenteditable]').textContent(), 'Unsent reply draft.');
    }
    await page.locator('[role="document"]').evaluate(element => element.insertAdjacentHTML('beforeend', '<p id="next-message">A newly opened message.</p>'));
    await waitTranslation('next-message', '邮件译文：');
    await page.locator('#message').evaluate(element => { element.textContent = 'Updated email body.'; });
    await waitTranslation('message', 'Updated email body.');
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.wupage-translation')].every(element => {
      const box = element.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1;
    })), `${width}px: translation overflowed the mail pane`);
    await page.screenshot({ path: path.join(output, `translated-${width}.png`) });
    await send({ type: 'CLEAR_TRANSLATION' });
    await page.waitForFunction(() => !document.querySelector('.wupage-translation'));
    assert.equal(await page.locator('#message').textContent(), 'Updated email body.');
    await page.locator('#message').evaluate(element => { element.innerHTML = 'Please review the <strong>attached report</strong> before our next meeting.'; });
    await page.locator('#next-message').evaluate(element => element.remove());
    assert.equal(await page.locator('main').innerHTML(), original);
    reports.push({ width, modes: 3, dynamicMessage: true, reusedBody: true, restored: true });
  }
  assert.ok(requests.some(text => text.includes('attached report')));
  assert.ok(!requests.some(text => /Locally excluded|Protected paragraph|Unsent reply|Hidden message/u.test(text)));
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, simulatedTranslation: true, requests: requests.length, reports }, null, 2));
  console.log(JSON.stringify({ ...identity, requests: requests.length, reports, output }));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') });
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, requests, errors,
    body: await page?.locator('main').innerHTML() }, null, 2));
  throw error;
} finally {
  await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
