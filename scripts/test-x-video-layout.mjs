// X-shaped portrait players with the real extension and a local mock service.
// This verifies layout and fullscreen behavior, not the current production X DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = browserTarget();
const output = path.join(root, '.npm-cache/x-video-layout', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const requests = [], checks = [], errors = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const { texts } = JSON.parse(body); requests.push(...texts);
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ translations: texts.map(text => {
    const markers = [...text.matchAll(/⟪WUPAGESEGMENT\d+⟫/gu)];
    const translated = '这是一段用于检查竖屏视频布局的中文译文。';
    return markers.length ? markers.map(marker => marker[0] + '\n' + translated).join('\n') : translated;
  }) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>Portrait video</title>
  <style>
    body{margin:16px;background:#101418;color:white;font:15px/1.5 system-ui}
    main{max-width:600px;margin:auto}p{margin:0 0 12px}
    .player{position:relative;width:var(--player-width);max-width:100%;margin:auto;background:#173b3c}
    video{display:block;width:100%;aspect-ratio:9/16;object-fit:contain}
    .controls{position:absolute;bottom:8px;left:8px;right:8px;display:flex;justify-content:space-between;gap:2px;align-items:center}
    .controls button{flex:0 0 40px;min-height:32px;padding:4px 0;border:0;border-radius:4px;background:#243138;color:white;font:10px/1.2 system-ui}
    .player:fullscreen,:fullscreen .player{position:fixed;inset:0;width:100vw;height:100vh;max-width:none}
    .player:fullscreen video,:fullscreen .player video{height:100%;aspect-ratio:auto}
  </style><main><article><p data-testid="tweetText">Watch this portrait video.</p>
    <div data-testid="videoComponent"><div data-testid="videoPlayer" class="player">
      <video autoplay muted playsinline></video><div class="controls">
        <button data-control="play"><span>Play</span></button><button data-control="mute"><span>Mute</span></button>
        <button data-control="speed"><span>Speed</span></button><button data-control="quality"><span>Quality</span></button>
        <button data-control="fullscreen"><span>Expand</span></button>
      </div>
    </div></div>
  </article></main><script>
    document.querySelector('.player').style.setProperty('--player-width',new URL(location.href).searchParams.get('width')+'px');
    window.clicked=[];document.querySelectorAll('[data-control]').forEach(button=>button.onclick=()=>window.clicked.push(button.dataset.control));
    const canvas=document.createElement('canvas');canvas.width=180;canvas.height=320;
    const context=canvas.getContext('2d');context.fillStyle='#173b3c';context.fillRect(0,0,180,320);
    context.fillStyle='#a9ead3';context.font='16px system-ui';context.fillText('Portrait video',30,130);
    const video=document.querySelector('video');video.srcObject=canvas.captureStream(1);
    video.play().then(()=>window.fixtureReady=true);
  </script></html>`;
let context, page, identity;
try {
  context = await chromium.launchPersistentContext(path.join(output, 'profile-' + Date.now()), {
    ...target.chromiumOptions, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'], viewport: { width: 1240, height: 900 }
  });
  await context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  const session = await context.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const options = await context.newPage(); await options.goto('chrome-extension://' + id + '/options.html');
  identity = verifyBrowserIdentity(target, await options.evaluate(() => navigator.userAgent));
  const configure = mode => options.evaluate(async ({ origin, mode }) => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.activeProviderId = 'http-template'; settings.sourceLang = 'en'; settings.targetLang = 'zh-CN';
    settings.translationDisplayMode = mode; settings.cacheEnabled = false;
    Object.assign(settings.providers.find(provider => provider.id === 'http-template'), {
      enabled: true, url: origin, method: 'POST', headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations'
    });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  }, { origin, mode });
  for (const [width, viewport] of [[240, 280], [320, 390], [390, 1240]]) {
    for (const mode of ['bilingual', 'bilingual-accent', 'replace']) {
      await configure(mode);
      page = await context.newPage(); await page.setViewportSize({ width: viewport, height: 900 });
      page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
      await page.goto('https://x.com/fixture/status/1?width=' + width); await page.waitForFunction(() => window.fixtureReady);
      const ball = page.locator('#wupage-floating-ball'); await ball.waitFor();
      const controls = page.locator('.controls');
      const baseline = await controls.evaluate(element => ({ html: element.innerHTML, width: element.clientWidth, height: element.clientHeight }));
      const tabId = await options.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, page.url());
      const result = await options.evaluate(({ tabId }) => chrome.tabs.sendMessage(tabId, { type: 'TRANSLATE_PAGE' }), { tabId });
      assert.equal(result.ok, true, JSON.stringify(result));
      await page.locator('[data-testid="tweetText"] + .wupage-translation, [data-testid="tweetText"] .wupage-translation').waitFor();
      assert.deepEqual(await controls.evaluate(element => ({ html: element.innerHTML, width: element.clientWidth, height: element.clientHeight })), baseline);
      assert.equal(await page.locator('[data-testid="videoComponent"] .wupage-translation').count(), 0);
      const boxes = await controls.locator('button').evaluateAll(buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }));
      for (let index = 1; index < boxes.length; index++) assert.ok(boxes[index].left >= boxes[index - 1].right);
      for (const control of ['play', 'mute', 'speed', 'quality', 'fullscreen']) await page.locator('[data-control="' + control + '"]').click();
      assert.deepEqual(await page.evaluate(() => window.clicked), ['play', 'mute', 'speed', 'quality', 'fullscreen']);
      await page.screenshot({ path: path.join(output, width + '-' + mode + '.png') });
      checks.push(width + 'px / ' + mode + ': controls unchanged, separated and clickable');
      if (width === 390 && mode === 'replace') {
        for (const selector of ['.player', 'html', 'body', 'video']) {
          await ball.hover(); await page.locator('#wupage-floating-menu').waitFor();
          await page.evaluate(selector => document.querySelector(selector).requestFullscreen(), selector);
          await page.waitForFunction(() => !!document.fullscreenElement && document.querySelector('#wupage-floating-hitbox').hidden);
          assert.equal(await page.locator('#wupage-floating-menu').isVisible(), false);
          if (selector !== 'video') await page.locator('[data-control="speed"]').click();
          await page.screenshot({ path: path.join(output, 'fullscreen-' + selector.replace('.', '') + '.png') });
          await page.evaluate(() => document.exitFullscreen());
          await ball.waitFor({ state: 'visible' });
          assert.equal(await page.locator('#wupage-floating-menu').isVisible(), false);
          checks.push(selector + ' fullscreen: floating ball/menu hidden, restored on exit');
        }
      }
      await page.close(); page = undefined;
    }
  }
  assert.ok(requests.length > 0);
  assert.ok(requests.every(text => text.includes('Watch this portrait video.') && !/\b(?:Play|Mute|Speed|Quality|Expand)\b/u.test(text)), JSON.stringify(requests));
  assert.deepEqual(errors, []);
  const report = { passed: true, environment: 'local X-shaped portrait fixture; no production X page', identity, checks, requests, errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, identity, checks, requests, errors, failure: String(error) }, null, 2)); throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
}
