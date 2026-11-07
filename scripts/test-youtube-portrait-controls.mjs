// Shorts-shaped sibling overlays, actual extension controls and local media.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/youtube-portrait', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const checks = [], errors = [];
const fixture = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Portrait player controls</title><style>
body{margin:0;background:#f4f6f5;font:16px system-ui}header{height:50px;background:white}
ytd-reel-video-renderer{display:block;position:relative;margin:20px auto;width:min(610px,calc(100vw - 32px));height:900px;border-radius:18px;overflow:hidden;background:#245252}
#player-container-id{position:absolute;inset:0;z-index:1}.html5-video-player,video{width:100%;height:100%}video{display:block;object-fit:cover}
.native-top{position:absolute;z-index:2;top:16px;left:16px;right:16px;display:flex;justify-content:space-between;pointer-events:none}
.native-group{display:flex;gap:8px}.native-top button{pointer-events:auto;width:48px;height:48px;border:0;border-radius:50%;color:white;background:#17202488;font:15px system-ui}
.native-hidden .native-top{opacity:0}.landscape{height:340px}.native-bottom{position:absolute;bottom:0;left:0;right:0;height:44px;background:#172024cc;display:flex;justify-content:flex-end}
.ytp-right-controls{height:44px;display:flex}.ytp-right-controls button{width:44px;height:44px;background:transparent;border:0;color:white}
ytd-reel-video-renderer:fullscreen{width:100vw;height:100vh;margin:0;border-radius:0}
</style><header></header><ytd-reel-video-renderer is-active>
<div id="player-container-id"><div id="shorts-player" class="html5-video-player"><video muted playsinline></video></div></div>
<div class="native-top"><div class="native-group"><button data-native="pause">Pause</button><button data-native="mute">Mute</button></div><div class="native-group"><button data-native="menu">Menu</button><button data-native="fullscreen">Full</button></div></div>
</ytd-reel-video-renderer><script>
window.clicked=[];document.querySelectorAll('[data-native]').forEach(button=>button.onclick=()=>window.clicked.push(button.dataset.native));
const canvas=document.createElement('canvas');canvas.width=360;canvas.height=640;const ctx=canvas.getContext('2d');ctx.fillStyle='#245252';ctx.fillRect(0,0,360,640);ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText('Portrait video',30,220);
const video=document.querySelector('video');video.srcObject=canvas.captureStream(1);video.play().then(()=>window.fixtureReady=true);
</script>`;
const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
let context, page;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1000, height: 1100 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  const identity = verifyBrowserIdentity(target, await page.evaluate(() => navigator.userAgent));
  await page.goto('https://www.youtube.com/shorts/portrait-fixture');
  await page.waitForFunction(() => window.fixtureReady);
  const player = page.locator('ytd-reel-video-renderer'), view = page.locator('[data-wupage-video]');
  await view.waitFor();
  const check = async label => {
    await page.locator('video').hover({ position: { x: 80, y: 160 } });
    await page.waitForTimeout(200);
    const toolbar = await view.locator('.toolbar').boundingBox();
    const native = await page.locator('[data-native]').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
    assert.ok(native.every(button => !overlap(toolbar, button)), `${label}: toolbar overlaps native controls: ${JSON.stringify({toolbar,native})}`);
    const video = await page.locator('video').boundingBox();
    assert.ok(toolbar.x >= video.x && toolbar.x + toolbar.width <= video.x + video.width + 1);
    assert.ok(toolbar.y >= video.y && toolbar.y + toolbar.height <= video.y + video.height + 1);
    await view.locator('.settings').click(); await view.locator('.panel').waitFor();
    await view.locator('.close').click();
    for (const name of ['menu', 'fullscreen']) await page.locator(`[data-native="${name}"]`).click();
    const before = await page.evaluate(() => window.clicked.length);
    await page.locator('video').hover({ position: { x: 80, y: 160 } });
    await page.waitForTimeout(200);
    await view.locator('.toggle').click();
    assert.equal(await view.locator('.toggle').getAttribute('aria-pressed'), 'true');
    await view.locator('.toggle').click();
    assert.equal(await view.locator('.toggle').getAttribute('aria-pressed'), 'false');
    await view.locator('.frame').click();
    assert.equal(await page.evaluate(() => window.clicked.length), before, 'extension click never reaches native menu/fullscreen');
    await page.screenshot({ path: path.join(output, `${label}.png`) });
    checks.push(`${label}: toolbar separated, settings and frame buttons clickable, native menu/fullscreen still clickable`);
  };
  for (const width of [1000, 640, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await check(`portrait-${width}`);
  }
  await page.evaluate(() => document.querySelectorAll('[data-native]').forEach(button => { button.style.height='80px'; }));
  await page.waitForFunction(() => {
    const toolbar=document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.toolbar').getBoundingClientRect();
    return toolbar.top >= Math.max(...[...document.querySelectorAll('[data-native]')].map(button=>button.getBoundingClientRect().bottom)) + 7;
  });
  await check('native-controls-resized');
  const visibleTop = (await view.locator('.toolbar').boundingBox()).y;
  await player.evaluate(element => element.classList.add('native-hidden'));
  await page.waitForTimeout(200);
  assert.equal((await view.locator('.toolbar').boundingBox()).y, visibleTop);
  await player.evaluate(element => element.classList.remove('native-hidden'));
  checks.push('native fade-out retains toolbar position without a hover jump');
  await player.evaluate(element => { element.style.transform='scale(.8)';element.style.transformOrigin='top center'; });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await check('scaled-player');
  await player.evaluate(element => element.style.removeProperty('transform'));
  await page.setViewportSize({ width: 1000, height: 900 });
  await player.evaluate(element => element.requestFullscreen());
  await check('fullscreen');
  await page.evaluate(() => document.exitFullscreen());
  await page.evaluate(() => {
    const player=document.querySelector('ytd-reel-video-renderer');player.classList.add('landscape');
    player.querySelector('.native-top').remove();
    document.querySelector('#shorts-player').insertAdjacentHTML('beforeend','<div class="native-bottom"><div class="ytp-right-controls"><button class="ytp-subtitles-button">CC</button><button>Full</button></div></div>');
  });
  const dock = page.locator('[data-wupage-video-toolbar]'); await dock.waitFor();
  assert.equal(await view.locator('.toolbar').count(), 0);
  await dock.locator('.settings').click(); await view.locator('.panel').waitFor(); await view.locator('.close').click();
  await page.evaluate(() => document.querySelector('.native-bottom').remove());
  await view.locator('.toolbar').waitFor();
  checks.push('landscape: native bottom row docking and fallback restoration');
  assert.deepEqual(errors, []);
  const report={passed:true,...identity,checks,errors};
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error) {
  await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:false,checks,errors,error:String(error)},null,2));throw error;
} finally { await context?.close(); }
