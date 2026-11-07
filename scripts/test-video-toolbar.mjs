// Real extension, site-shaped native control rows and a local mock service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
const output = path.join(root, '.npm-cache/video-toolbar', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const errors = [], checks = [], alignment = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const part of request) body += part;
  const { texts } = JSON.parse(body);
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ translations: texts.map(() => '这是一条测试字幕。') }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sites = [
  { id: 'youtube', url: 'https://www.youtube.com/watch?v=toolbar-preview', player: 'html5-video-player', controls: 'ytp-right-controls', anchor: 'ytp-subtitles-button' },
  { id: 'bilibili', url: 'https://www.bilibili.com/video/BVtoolbar/', player: 'bpx-player-container', controls: 'bpx-player-control-bottom-right', anchor: 'bpx-player-ctrl-subtitle', controlHeight: 22, align: 'normal' },
  { id: 'bilibili-legacy', url: 'https://player.bilibili.com/player.html?bvid=BVtoolbar', player: 'bilibili-player-video-wrap', controls: 'bilibili-player-video-control-bottom-right', anchor: 'bilibili-player-video-btn-subtitle', controlHeight: 24, align: 'flex-end', controlMargin: 4 },
  { id: 'vimeo', url: 'https://player.vimeo.com/video/12345', player: 'player', controls: 'ControlBarButtonsAndMenus_module_collapsibleContent__fixture', anchor: 'cc', height: 40, controlHeight: 32, wrap: true },
  { id: 'udemy', url: 'https://www.udemy.com/course/toolbar/', player: 'player', controls: '_control-bar_fixture_28', anchor: '_control-captions_fixture_125', extra: 'data-purpose="media-player-container"', height: 48, controlHeight: 36, controlMargin: 3, wrap: true },
  { id: 'videojs', url: 'https://www.coursera.org/learn/toolbar', player: 'video-js', controls: 'vjs-control-bar', anchor: 'vjs-subs-caps-button', height: 30 },
  { id: 'plyr', url: 'https://video.example.test/toolbar', player: 'plyr', controls: 'plyr__controls', anchor: '', caption: 'data-plyr="captions"' },
  { id: 'jwplayer', url: 'https://jwplayer.example.test/toolbar', player: 'jwplayer', wrapper: 'jw-controlbar', controls: 'jw-button-container', anchor: 'jw-icon-cc', height: 44, controlHeight: 40 },
  { id: 'dplayer', url: 'https://dplayer.example.test/toolbar', player: 'dplayer', controls: 'dplayer-icons-right', anchor: 'dplayer-subtitle-btn', height: 41, controlHeight: 32 },
  { id: 'artplayer', url: 'https://artplayer.example.test/toolbar', player: 'art-video-player', controls: 'art-controls-right', anchor: 'art-control-subtitle', height: 40, controlHeight: 24, align: 'flex-end' },
  { id: 'xgplayer', url: 'https://xgplayer.example.test/toolbar', player: 'xgplayer', wrapper: 'xgplayer-controls', controls: 'xg-right-grid', anchor: 'xgplayer-subtitle', anchorTag: 'xg-icon', height: 48, controlHeight: 32, controlMargin: 6 },
  { id: 'shaka', url: 'https://shaka.example.test/toolbar', player: 'shaka-video-container', controls: 'shaka-controls-button-panel', anchor: 'shaka-caption-button', height: 48, controlHeight: 32, controlMargin: 4 },
  { id: 'media-chrome', url: 'https://media-chrome.example.test/toolbar', player: 'media-controller', controls: '', controlsTag: 'media-control-bar', anchor: '', anchorTag: 'media-captions-button', height: 40, controlHeight: 32 }
];
const fixture = site => `<!doctype html><html><meta charset="utf-8"><title>Video toolbar</title>
  <style>body{margin:16px;background:#15191c;color:white;font:16px system-ui}
  #movie_player{position:relative;width:min(1000px,100%);margin:20px auto}
  video{display:block;width:100%;aspect-ratio:16/9;background:#245252}
  .native-bar{position:absolute;bottom:0;left:0;right:0;height:${site.height || 35}px;background:#12181cdd;display:flex;justify-content:space-between}
  .native-controls,.native-left{height:100%;display:flex;align-items:${site.align || 'center'}}
  .native-bar button,.native-bar .native{display:inline-flex;align-items:center;justify-content:center;width:40px;height:${site.controlHeight ? `${site.controlHeight}px` : '100%'};margin-top:${site.controlMargin || 0}px;border:0;background:transparent;color:white}
  .native-control-wrapper{height:100%;display:flex;align-items:flex-start}
  .native-hidden .native-bar{opacity:0}
  #movie_player:fullscreen{width:100%;height:100%;margin:0;display:grid;align-content:center}
  #movie_player:fullscreen video{max-height:100vh}
  </style><div id="movie_player" class="${site.player}" ${site.extra || ''}><video muted playsinline></video>
  <div class="native-bar ${site.wrapper || ''}"><div class="native-left"><button>Play</button><button>Mute</button></div>
  <${site.controlsTag || 'div'} class="native-controls ${site.controls}">${site.wrap ? '<div class="native-control-wrapper">' : ''}<${site.anchorTag || 'button'} class="native ${site.anchor}" ${site.caption || ''}>CC</${site.anchorTag || 'button'}>${site.wrap ? '</div>' : ''}<button>HD</button><button class="expand">Full</button></${site.controlsTag || 'div'}></div></div>
  <script>window.nativeClicks=0;document.querySelector('.native').onclick=()=>window.nativeClicks++;
  document.querySelector('.expand').onclick=()=>document.querySelector('#movie_player').requestFullscreen();
  const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#245252';ctx.fillRect(0,0,960,540);
  ctx.fillStyle='white';ctx.font='32px sans-serif';ctx.fillText('Video toolbar preview',48,96);
  const video=document.querySelector('video');video.srcObject=canvas.captureStream(1);
  const track=video.addTextTrack('subtitles','English','en');track.mode='showing';track.addCue(new VTTCue(0,1000,'A sample subtitle.'));
  video.play().then(()=>window.fixtureReady=true);</script></html>`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
  });
  await context.route('https://**/*', route => {
    const site = sites.find(site => new URL(site.url).hostname === new URL(route.request().url()).hostname);
    return site ? route.fulfill({ contentType: 'text/html', body: fixture(site) }) : route.abort();
  });
  const session = await context.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`);
  const identity = verifyBrowserIdentity(target, await options.evaluate(() => navigator.userAgent));
  await options.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.activeProviderId = 'http-template'; settings.sourceLang = 'en'; settings.targetLang = 'zh-CN'; settings.cacheEnabled = false;
    Object.assign(settings.providers.find(p => p.id === 'http-template'), { enabled: true, url: origin, method: 'POST',
      headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  }, origin);
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  for (const site of sites) {
  await page.goto(site.url); await page.waitForFunction(() => window.fixtureReady);
  const dock = page.locator('[data-wupage-video-toolbar]'); const view = page.locator('[data-wupage-video]');
  const checkAlignment = async label => {
    const native = await page.locator('.native').boundingBox();
    const center = native.y + native.height / 2;
    for (const selector of ['.mark', '.settings svg']) {
      const icon = await dock.locator(selector).boundingBox();
      const error = Math.abs(icon.y + icon.height / 2 - center);
      alignment.push({ site: site.id, label, selector, error });
      assert.ok(error <= 1, `${site.id} ${label}: ${selector} centered on native control, error=${error}`);
    }
  };
  await dock.waitFor();
  assert.equal(await dock.locator('.toggle').textContent(), '译');
  assert.equal(await page.locator('.native-controls > [data-wupage-video-toolbar]').count(), 1);
  assert.equal(await dock.evaluate(element => !!element.nextElementSibling?.matches('.native,.native-control-wrapper')), true, 'next to native caption controls');
  await dock.locator('.toggle').click(); await view.locator('.translation span').filter({ hasText: '这是一条测试字幕。' }).waitFor();
  assert.equal(await dock.locator('.toggle').textContent(), '双');
  assert.equal(await view.locator('.toolbar').count(), 0, 'caption layer has no floating toolbar');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const bar = await page.locator('.native-bar').boundingBox(); const button = await dock.boundingBox();
    assert.ok(button.x >= bar.x && button.x + button.width <= bar.x + bar.width + 1);
    assert.ok(button.y >= bar.y && button.y + button.height <= bar.y + bar.height + 1);
    await checkAlignment(`${width}px`);
    await dock.locator('.settings').click(); await view.locator('.panel').waitFor();
    await view.locator('.original').uncheck();
    await page.waitForFunction(() => document.querySelector('[data-wupage-video-toolbar]').shadowRoot.querySelector('.mark').textContent === '单');
    assert.equal(await dock.locator('.toggle').getAttribute('aria-label'), '仅译文已开启，点击停止字幕翻译');
    await view.locator('.original').check();
    await page.waitForFunction(() => document.querySelector('[data-wupage-video-toolbar]').shadowRoot.querySelector('.mark').textContent === '双');
    const panel = await view.locator('.panel').boundingBox(); assert.ok(panel.x >= 0 && panel.x + panel.width <= width);
    await page.screenshot({ path: path.join(output, `${site.id}-settings-${width}.png`) });
    await view.locator('.close').click();
    await page.locator('.native').click();
    await page.evaluate(() => document.querySelector('#movie_player').classList.add('native-hidden'));
    await page.waitForFunction(() => document.querySelector('[data-wupage-video-toolbar]').inert);
    assert.equal(await dock.evaluate(host => {
      const r = host.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === host;
    }), false, 'hidden native controls cannot intercept clicks');
    assert.equal(await view.locator('.translation span').isVisible(), true, 'captions stay visible while controls hide');
    await page.screenshot({ path: path.join(output, `${site.id}-hidden-${width}.png`) });
    await page.evaluate(() => document.querySelector('#movie_player').classList.remove('native-hidden'));
    await page.waitForFunction(() => !document.querySelector('[data-wupage-video-toolbar]').inert);
    await page.screenshot({ path: path.join(output, `${site.id}-toolbar-${width}.png`) });
    await page.locator('#movie_player').evaluate(element => { element.style.transform='scale(.85)';element.style.transformOrigin='top left'; });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(160); await checkAlignment(`${width}px scaled`);
    await page.locator('#movie_player').evaluate(element => element.style.removeProperty('transform'));
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    checks.push(`${site.id} ${width}px: compact native bar, modes, settings, native buttons, opacity-only hide and independent captions`);
  }
  assert.equal(await page.evaluate(() => window.nativeClicks), 2);
  await page.evaluate(() => {
    const old=document.querySelector('.native-controls');
    window.nativeControlMarkup=[...old.children].filter(element=>!element.hasAttribute('data-wupage-video-toolbar')).map(element=>element.outerHTML).join('');
    const rebuilt=old.cloneNode(false);rebuilt.innerHTML=window.nativeControlMarkup;old.replaceWith(rebuilt);
  });
  await dock.waitFor(); assert.equal(await dock.locator('.toggle').getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => { const row=document.querySelector('.native-controls');window.nativeControlClass=row.className;window.nativeControlTag=row.localName;row.remove(); });
  await view.locator('.toggle').waitFor();
  await page.evaluate(() => { const bar=document.createElement(window.nativeControlTag);bar.className=window.nativeControlClass;bar.innerHTML=window.nativeControlMarkup;document.querySelector('.native-bar').append(bar); });
  await dock.waitFor();
  await page.locator('#movie_player').evaluate(element => element.requestFullscreen());
  await checkAlignment('fullscreen');
  await dock.locator('.settings').click(); await view.locator('.panel').waitFor();
  await page.screenshot({ path: path.join(output, `${site.id}-fullscreen.png`) });
  await view.locator('.close').click(); await page.evaluate(() => document.exitFullscreen());
  await dock.locator('.toggle').click();
  assert.equal(await dock.locator('.toggle').textContent(), '译');
  assert.equal(await page.evaluate(() => document.querySelector('video').textTracks[0].mode), 'showing');
  checks.push(`${site.id}: bar replacement, missing-bar fallback, fullscreen, settings and native caption restoration`);
  }
  assert.deepEqual(errors, []);
  const report = { passed: true, ...identity, checks, alignment, errors, output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await context?.close(); await new Promise(resolve => server.close(resolve)); }
