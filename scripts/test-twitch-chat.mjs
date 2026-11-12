// Offline Twitch DOM regression with the built extension and a local translation service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
if (target.kind === 'firefox') throw new Error('This routed fixture supports Chromium and Edge.');
const output = path.join(root, '.npm-cache/twitch-chat', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const requests = [], errors = [], reports = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const { texts } = JSON.parse(body); requests.push(...texts);
  await new Promise(resolve => setTimeout(resolve, 100));
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ translations: texts.map(text => text
    .split(/(⟪WUPAGE(?:OPEN|CLOSE|BREAK|SEGMENT)\d+⟫)/gu)
    .map(part => /^⟪WUPAGE/u.test(part) || !/\p{L}/u.test(part) ? part : `聊天译文：${part}`).join('')) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const url = 'https://www.twitch.tv/__wupage_chat_test__';
const message = (id, text) => `<div class="chat-line__message" data-a-target="chat-line-message" role="group" tabindex="0">
  <div class="chat-line__message-container"><div class="chat-line__no-background">
    <div class="chat-line__username-container"><span role="button" tabindex="0"><span data-a-target="chat-message-username">Viewer${id}</span></span></div><span aria-hidden="true">: </span><span id="message-${id}" data-a-target="chat-line-message-body" dir="auto">${text}</span>
    <button class="reply">Reply</button>
  </div></div></div>`;
const fragment = text => `<span class="text-fragment" data-a-target="chat-message-text">${text}</span>`;
const fixture = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Twitch chat regression</title>
  <style>*{box-sizing:border-box}body{margin:0;font:14px/1.5 Arial;color:#18181b}main{padding:24px}
  aside{position:fixed;right:0;top:0;width:312px;height:100vh;border-left:1px solid #ddd;background:white;overflow:auto;padding:12px}
  .chat-line__message{padding:8px 0;overflow-wrap:anywhere}.chat-line__username-container{display:inline;color:#9147ff;font-weight:bold}
  [data-a-target=chat-message-username]{cursor:pointer}.reply{font-size:12px;margin-left:6px}
  [contenteditable]{border:1px solid #aaa;padding:8px;margin-top:16px}img{vertical-align:middle}</style>
  <main></main><aside><h4>直播聊天</h4><section data-a-target="chat-room-component-layout"><div role="log">
  ${message(1, fragment('自分の感想やめて'))}
  ${message(2, fragment('見方から話しかけてたよ'))}
  ${message(3, `${fragment('Please read ')}<a id="guide" href="https://example.com/guide">this guide</a>${fragment(' before playing.')}<button data-a-target="emote-button"><img alt="Kappa" width="24" height="24" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></button>`)}
  </div><div contenteditable="true" role="textbox">Unsent private chat draft.</div></section>
  <span id="unrelated">Unrelated sidebar text.</span></aside>
  <script>window.replyClicks=0;window.authorClicks=0;for(const button of document.querySelectorAll('.reply'))button.onclick=()=>replyClicks++;
  for(const author of document.querySelectorAll('[data-a-target=chat-message-username]'))author.onclick=()=>authorClicks++;
  window.originalNodes=[...document.querySelectorAll('[data-a-target=chat-message-username],#guide,img,.reply')];</script></html>`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1400, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  // Only synthetic HTML is served at this origin; no Twitch requests leave the browser.
  await context.route('https://www.twitch.tv/**', route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }) : route.abort());
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const control = await context.newPage();
  await control.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  const settings = await control.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.providers.push({ id: 'twitch-test', type: 'http-template', label: 'Twitch local test', method: 'POST',
      url: `${origin}/translate`, headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    Object.assign(settings, { activeProviderId: 'twitch-test', sourceLang: 'auto', targetLang: 'zh-CN', cacheEnabled: false,
      floatingBallEnabled: false, translationDisplayMode: 'bilingual', imageTranslationEnabled: false });
    settings.autoTranslation = { ...settings.autoTranslation, enabled: false };
    settings.selectionTranslation = { ...settings.selectionTranslation, enabled: false };
    settings.videoTranslation = { ...settings.videoTranslation, enabled: false };
    const saved = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (!saved.ok) throw new Error(saved.error); return settings;
  }, origin);
  const send = request => control.evaluate(async ({ url, request }) => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    return chrome.tabs.sendMessage(tab.id, request, { frameId: 0 });
  }, { url, request });
  const identity = verifyBrowserIdentity(target, await page.evaluate('navigator.userAgent'));
  for (const width of [1400, 390, 312]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('.chat-line__message'));
    // Wait for the extension content script, independently of the page's own readiness.
    await assert.doesNotReject(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { if ((await send({ type: 'GET_TRANSLATION_STATE' }))?.ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Twitch content script did not initialize');
    });
    const original = await page.locator('[role="log"]').innerHTML();
    assert.equal((await send({ type: 'TRANSLATE_PAGE' })).ok, true);
    await page.waitForFunction(() => [1, 2, 3].every(id => document.getElementById(`message-${id}`).textContent.includes('聊天译文：')));
    for (const mode of ['bilingual-accent', 'replace', 'bilingual']) {
      settings.translationDisplayMode = mode;
      assert.equal((await control.evaluate(settings => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }), settings)).ok, true);
      await page.waitForFunction(mode => document.querySelector(`[data-wupage-display-mode="${mode}"]`), mode);
      assert.ok(await page.evaluate(() => window.originalNodes.every(node => node.isConnected)));
      assert.deepEqual(await page.locator('[data-a-target="chat-message-username"]').allTextContents(), ['Viewer1', 'Viewer2', 'Viewer3']);
    }
    await page.evaluate(html => document.querySelector('[role="log"]').insertAdjacentHTML('beforeend', html),
      message(4, fragment('もっとゆっくり話してください')));
    await page.waitForFunction(() => document.getElementById('message-4').textContent.includes('聊天译文：'));
    await page.locator('#message-4').evaluate(element => element.firstElementChild.firstChild.data = 'New message in a reused chat row.');
    await page.waitForFunction(() => document.getElementById('message-4').textContent.includes('聊天译文：New message in a reused chat row.'));
    const layout = await page.evaluate(() => {
      const chat = document.querySelector('aside').getBoundingClientRect();
      return [...document.querySelectorAll('[data-a-target="chat-line-message-body"] .wupage-translation')].every(element => {
        const box = element.getBoundingClientRect(); return box.left >= chat.left - 1 && box.right <= chat.right + 1;
      });
    });
    assert.ok(layout, `${width}px: translation overflowed the chat sidebar`);
    await page.locator('[data-a-target="chat-message-username"]').first().click();
    await page.locator('.reply').first().click();
    assert.deepEqual(await page.evaluate(() => [window.authorClicks, window.replyClicks]), [1, 1]);
    await page.screenshot({ path: path.join(output, `translated-${width}.png`) });
    await send({ type: 'CLEAR_TRANSLATION' });
    await page.waitForFunction(() => !document.querySelector('.wupage-translation'));
    await page.locator('[data-a-target="chat-line-message"]').last().evaluate(element => element.remove());
    assert.equal(await page.locator('[role="log"]').innerHTML(), original, 'restoration changed the original chat DOM');
    assert.equal(await page.locator('[role="textbox"]').textContent(), 'Unsent private chat draft.');
    reports.push({ width, initialMessages: 3, appendedMessages: 1, reusedRow: true, modes: 3, restored: true, layout });
  }
  assert.ok(requests.some(text => text.includes('自分の感想やめて')));
  assert.ok(requests.some(text => text.includes('Please read') && text.includes('this guide') && text.includes('before playing.')));
  assert.ok(!requests.some(text => /Viewer\d|Unsent private|Unrelated sidebar/u.test(text)), 'identity, draft or unrelated sidebar text reached the translation service');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, simulatedTranslation: true, requests: requests.length, reports }, null, 2));
  console.log(JSON.stringify({ ...identity, requests: requests.length, reports, output }));
} finally {
  await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
