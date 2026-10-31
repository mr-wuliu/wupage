// MV3 integration on mobile YouTube fixtures with real touch input. This runs
// desktop Chromium/Edge in mobile emulation; Android device testing is separate.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = browserTarget();
const output = path.join(root, '.npm-cache/video-mobile', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const calls = [], checks = [], errors = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const data = JSON.parse(body); calls.push(data);
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ translations: data.texts.map(text => '译：' + text) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const base = await fs.readFile(path.join(root, 'tests/fixtures/video-subtitles.html'), 'utf8');
const modes = ['initial', 'api', 'observed', 'rendered'];
let mode, context, identity;
function fixture() {
  return base.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
    .replace('<div class="player">', '<div class="player" id="player-container-id">')
    .replace('<video ', '<div style="position:relative"><video ')
    .replace(/<track[^>]*>/u, '')
    .replace('</video></div>', '</video></div><div class="ytp-caption-window-container"><span class="caption-visual-line"></span></div></div>')
    .replace('<script>', `<script>
      const mode=${JSON.stringify(mode)};
      const metadata={videoDetails:{videoId:'mobile'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[
        {baseUrl:'/api/timedtext?v=mobile&lang=en&kind=asr',languageCode:'en',vssId:'a.en',kind:'asr',name:{simpleText:'English'}}
      ]}}};
      if(mode==='initial')window.ytInitialPlayerResponse=metadata;
      if(mode==='api')document.querySelector('#player-container-id').getPlayerResponse=()=>metadata;
      if(mode!=='rendered')fetch('/api/timedtext?v=mobile&lang=en&kind=asr&c=MWEB&signature=mobile-signature&fmt=json3');
      setInterval(()=>{
        const video=document.querySelector('video');
        document.querySelector('.caption-visual-line').textContent=new URL(location.href).searchParams.get('v')==='next'
          ? 'Next mobile video.' : video.currentTime<2 ? 'Mobile caption.' : 'Seek caption.';
      },60);
    </script><script>`);
}
try {
  context = await chromium.launchPersistentContext(path.join(output, 'profile-' + Date.now()), {
    ...target.chromiumOptions, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2'],
    viewport: { width: 390, height: 844 },
    hasTouch: true, isMobile: true, deviceScaleFactor: 1
  });
  await context.route('https://m.youtube.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/timedtext') {
      assert.equal(url.searchParams.get('signature'), 'mobile-signature', 'keep the complete authorized mobile request');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [
        { tStartMs: 0, dDurationMs: 1900, segs: [{ utf8: 'Mobile caption.' }] },
        { tStartMs: 2000, dDurationMs: 1900, segs: [{ utf8: 'Seek caption.' }] }
      ] }) });
    }
    return route.fulfill({ contentType: 'text/html', body: fixture() });
  });
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Extensions.loadUnpacked', { path: path.join(root, process.env.VIDEO_TEST_EXTENSION_DIR || 'dist') });
  await session.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const options = await context.newPage();
  await options.goto('chrome-extension://' + new URL(worker.url()).host + '/options.html');
  // Edge uses a compatibility UA on YouTube; identify the browser on its own page.
  identity = verifyBrowserIdentity(target, await options.evaluate(() => navigator.userAgent));
  await options.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.activeProviderId = 'http-template'; settings.sourceLang = 'en'; settings.targetLang = 'zh-CN'; settings.cacheEnabled = false;
    Object.assign(settings.providers.find(provider => provider.id === 'http-template'), {
      enabled: true, url: origin, method: 'POST', headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations'
    });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  }, origin);
  for (mode of modes) {
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(mode + ': ' + error.message));
    await page.goto('https://m.youtube.com/watch?v=mobile');
    await page.waitForFunction(() => window.fixtureReady);
    const view = page.locator('[data-wupage-video]').first(); await view.waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-wupage-video]').hasAttribute('data-controls'));
    await page.locator('video').tap({ position: { x: 100, y: 40 } });
    assert.equal(await view.getAttribute('data-controls'), '');
    const touchTarget = await view.locator('.toggle').evaluate(button => ({ height: button.getBoundingClientRect().height,
      coarse: matchMedia('(pointer: coarse)').matches, touch: navigator.maxTouchPoints, minimum: getComputedStyle(button).minHeight }));
    assert.ok(touchTarget.height >= 44, JSON.stringify(touchTarget));
    await view.locator('.toggle').tap();
    await view.locator('.translation span').filter({ hasText: '译：Mobile caption.' }).waitFor();
    await page.waitForFunction(expected => document.querySelector('[data-wupage-video]').dataset.subtitleSource === expected,
      mode === 'rendered' ? 'live' : 'timeline');
    await page.evaluate(() => { document.querySelector('video').pause(); document.querySelector('video').currentTime = 2.3; });
    await view.locator('.translation span').filter({ hasText: '译：Seek caption.' }).waitFor();
    await page.screenshot({ path: path.join(output, mode + '.png') });
    await page.locator('#nativeFullscreen').tap();
    await page.waitForFunction(() => document.fullscreenElement === document.querySelector('video') &&
      [...document.querySelector('video').textTracks].some(track => track.label === 'WuPage 双语' && track.mode === 'showing' &&
        [...(track.cues || [])].some(cue => cue.text.includes('译：Seek caption.'))));
    await page.evaluate(() => document.exitFullscreen());
    await page.evaluate(() => { history.pushState({}, '', '/watch?v=next'); document.dispatchEvent(new Event('yt-navigate-finish')); });
    await view.locator('.translation span').filter({ hasText: '译：Next mobile video.' }).waitFor();
    assert.equal(await view.getAttribute('data-subtitle-source'), 'live', 'ignore metadata and signed URLs from the previous video');
    await page.locator('video').tap({ position: { x: 100, y: 40 } });
    await view.locator('.toggle').tap();
    assert.equal(await view.getAttribute('data-enabled'), null);
    assert.equal(await page.locator('[data-wupage-video-native]').count(), 0);
    checks.push(mode + ': touch, translation, seek, native fullscreen, stale metadata after navigation, stop');
    await page.close();
  }
  assert.deepEqual(errors, []);
  const report = { passed: true, environment: 'desktop browser with mobile viewport and touch emulation', identity, checks, requests: calls.length, errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, identity, checks, errors, failure: String(error) }, null, 2));
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
}
