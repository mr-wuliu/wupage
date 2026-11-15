// Current X photo-menu structure with the built extension and local services.
// No X login, model downloads, or external translation services are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
const output = path.join(root, '.npm-cache/x-image-menu', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const requests = [], errors = [], checks = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body); requests.push({ path: request.url, texts: input.texts });
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/ocr') response.end(JSON.stringify({ schemaVersion: 1, coordinateSpace: 'pixel',
    width: input.image.width, height: input.image.height,
    lines: [{ text: 'Hello photo', poly: [[30, 40], [350, 40], [350, 100], [30, 100]] }] }));
  else response.end(JSON.stringify({ translations: input.texts.map(text => text.replaceAll('Hello photo', '你好，图片')) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X photo menu fixture</title><style>
body{margin:0;background:#fff;color:#0f1419;font:15px/20px system-ui}body.dark{background:#000;color:#e7e9ea}
main{max-width:640px;padding:24px;margin:auto}article{margin:16px 0 24px;padding:16px;border:1px solid #536471;border-radius:16px}
[data-testid=tweetPhoto]{position:relative;width:100%;aspect-ratio:640/180;margin:12px 0;overflow:hidden;border-radius:12px}
[data-testid=tweetPhoto] .pixels,img{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;background-size:100% 100%}
img{opacity:0;pointer-events:none}#layers>[role=group]{position:fixed;inset:0;z-index:2000}
.backdrop{position:fixed;inset:0}[role=menu]{position:absolute;background:#fff;color:#0f1419;border-radius:16px;overflow:hidden;box-shadow:0 0 15px #65778633,0 0 3px #65778626}
.dark [role=menu]{background:#15202b;color:#e7e9ea}[role=menuitem]{display:flex;padding:12px 16px;font-weight:700;cursor:pointer;white-space:nowrap}
[role=menuitem]:hover{background:#65778615}[role=menuitem] [dir]{color:inherit;font:700 15px/20px system-ui}
</style><main><article><strong>Photo menu</strong><p>Right-click a photo.</p><div data-testid="tweetPhoto" id="first"><div class="pixels"></div><img alt="Photo"></div>
<div data-testid="tweetPhoto" id="second"><div class="pixels"></div><img alt="Duplicate photo"></div></article></main><div id="layers"></div>
<script>
window.photoClicks=0;window.copies=0;window.delay=0;
const canvas=document.createElement('canvas');canvas.width=640;canvas.height=180;
const ctx=canvas.getContext('2d');ctx.fillStyle='#e8f5f5';ctx.fillRect(0,0,640,180);ctx.fillStyle='#172033';ctx.font='42px sans-serif';ctx.fillText('Hello photo',30,95);
const source=canvas.toDataURL();
window.closeMenu=()=>document.querySelector('#layers').replaceChildren();
window.mountMenu=(x,y)=>{
 const group=document.createElement('div');group.setAttribute('role','group');group.tabIndex=0;
 group.innerHTML='<div class="backdrop"></div><div role="menu"><div><div data-testid="Dropdown"><div role="menuitem" tabindex="0" data-testid="copyPhotoLinkContextMenuItem"><div dir="ltr">Copy photo link<span class="wupage-translation" aria-hidden="true"> 复制照片链接</span></div></div></div></div></div>';
 const menu=group.querySelector('[role=menu]');menu.style.left=x+'px';menu.style.top=y+'px';
 group.querySelector('.backdrop').onclick=window.closeMenu;
 group.querySelector('[data-testid=copyPhotoLinkContextMenuItem]').onclick=()=>{window.copies++;window.closeMenu()};
 group.addEventListener('keydown',event=>{if(event.key==='Escape')window.closeMenu()});
 document.querySelector('#layers').replaceChildren(group);group.querySelector('[role=menuitem]').focus();
};
for(const photo of document.querySelectorAll('[data-testid=tweetPhoto]')){
 photo.querySelector('img').src=source;photo.querySelector('.pixels').style.backgroundImage='url('+source+')';
 photo.onclick=()=>window.photoClicks++;
 photo.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();window.closeMenu();setTimeout(()=>window.mountMenu(event.clientX,event.clientY),window.delay)});
}
Promise.all([...document.images].map(image=>image.decode())).then(()=>window.fixtureReady=true);
</script></html>`;
let context, page;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1100, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
  });
  context.setDefaultTimeout(10000);
  await context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await context.route('https://example.com/x-menu', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await cdp.detach();
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('#save:enabled').waitFor();
  const identity = verifyBrowserIdentity(target, await options.evaluate(() => navigator.userAgent));
  await options.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    Object.assign(settings, { imageTranslationEnabled: true, imageTranslationContextMenuEnabled: true,
      imageTranslationFloatingEnabled: false, floatingBallEnabled: false, sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false,
      ocr: { mode: 'http', endpoint: `${origin}/ocr`, model: 'photo-fixture', apiKey: '', modelRevision: '1' }, activeProviderId: 'http-template' });
    Object.assign(settings.providers.find(provider => provider.id === 'http-template'), { enabled: true, method: 'POST',
      url: `${origin}/translate`, headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (!response.ok) throw new Error(response.error);
  }, origin);
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://x.com/fixture/status/1'); await page.waitForFunction(() => window.fixtureReady);
  await page.locator('#wupage-image-tools').waitFor({ state: 'attached' });
  const action = page.locator('#wupage-x-image-menu-item');
  const rightClick = async (photo = 'second', position) => {
    await page.locator(`#${photo} .pixels`).click({ button: 'right', ...(position ? { position } : {}) });
    await action.waitFor({ state: 'visible' });
    assert.equal(await action.count(), 1);
  };
  await rightClick();
  assert.equal(await page.locator('[data-testid=copyPhotoLinkContextMenuItem]').count(), 1);
  assert.equal(await page.locator('#wupage-image-tools button').count(), 0);
  assert.equal(requests.length, 0, 'opening the menu never uploads or translates a photo');
  await page.screenshot({ path: path.join(output, 'photo-menu.png') });
  await action.click();
  await page.locator('[role=menu]').waitFor({ state: 'detached' });
  await page.locator('#wupage-image-tools canvas').waitFor({ state: 'visible' });
  const positions = await page.evaluate(() => ({ source: document.querySelector('#second').getBoundingClientRect().top,
    canvas: document.querySelector('#wupage-image-tools').shadowRoot.querySelector('canvas').getBoundingClientRect().top,
    copies: window.copies, photoClicks: window.photoClicks }));
  assert.ok(Math.abs(positions.source - positions.canvas) < 2, 'translate the selected duplicate rather than the first matching URL');
  assert.equal(positions.copies, 0); assert.equal(positions.photoClicks, 0);
  assert.equal(requests.filter(request => request.path === '/ocr').length, 1);
  assert.equal(await page.locator('#wupage-image-tools button:visible').count(), 0);
  await page.screenshot({ path: path.join(output, 'translated-selected-photo.png') });
  checks.push('native right-click opens X menu; injected click translates the selected duplicate with floating controls off');

  await rightClick('first');
  await page.locator('[data-testid=copyPhotoLinkContextMenuItem]').click();
  assert.equal(await page.evaluate(() => window.copies), 1);
  assert.equal(requests.filter(request => request.path === '/ocr').length, 1);
  checks.push('original copy item remains functional and never starts OCR');

  await rightClick('first');
  await page.locator('[data-testid=copyPhotoLinkContextMenuItem]').press('ArrowDown');
  assert.equal(await action.evaluate(element => document.activeElement === element), true);
  await action.press('Escape');
  await page.locator('[role=menu]').waitFor({ state: 'detached' });
  checks.push('arrow keys include the injected row and Escape closes the site menu');

  await page.evaluate(() => { window.delay = 100; document.body.classList.add('dark'); });
  await page.setViewportSize({ width: 390, height: 700 });
  await rightClick('second', { x: 275, y: 60 });
  const menuBox = await page.locator('[role=menu]').boundingBox();
  assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 390);
  assert.ok(menuBox.y >= 0 && menuBox.y + menuBox.height <= 700);
  await page.screenshot({ path: path.join(output, 'photo-menu-mobile-dark.png') });
  await page.evaluate(() => window.mountMenu(340, 660));
  await action.waitFor({ state: 'visible' });
  assert.equal(await action.count(), 1);
  const rebuiltBox = await page.locator('[role=menu]').boundingBox();
  assert.ok(rebuiltBox.x + rebuiltBox.width <= 390 && rebuiltBox.y + rebuiltBox.height <= 700);
  checks.push('delayed and rebuilt menus stay within narrow viewport edges, including dark mode');

  await options.evaluate(async () => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { ...settings, imageTranslationContextMenuEnabled: false } });
  });
  await action.waitFor({ state: 'detached' });
  await page.locator('[role=menuitem]').press('Escape');
  await page.locator('#first .pixels').click({ button: 'right' });
  await page.locator('[data-testid=copyPhotoLinkContextMenuItem]').waitFor();
  assert.equal(await action.count(), 0);
  checks.push('saved context-menu switch removes and disables only the injected action');

  await options.evaluate(async () => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { ...settings, imageTranslationContextMenuEnabled: true } });
  });
  await page.goto('https://example.com/x-menu'); await page.waitForFunction(() => window.fixtureReady);
  await page.locator('#wupage-image-tools').waitFor({ state: 'attached' });
  await page.locator('#first .pixels').click({ button: 'right' });
  await page.locator('[data-testid=copyPhotoLinkContextMenuItem]').waitFor();
  assert.equal(await action.count(), 0);
  checks.push('a different host with the same DOM receives no X-specific injection');
  assert.deepEqual(errors, []);
  const report = { passed: true, ...identity, checks, recognitionRequests: requests.filter(request => request.path === '/ocr').length, errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(JSON.stringify({ requests, errors })); throw error;
} finally {
  await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
