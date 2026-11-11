// Real MV3 regression: local video, native captions, cross-origin iframe, mock provider.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = browserTarget();
const output = path.join(root, '.npm-cache/video-subtitles', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const requests = [];
const errors = [];
const checks = [];
let failNext = false;
const translations = new Map([
  ['Hello world.', '你好，世界。'], ['Read the existing subtitles.', '读取视频现有字幕。'],
  ['Seek to another moment.', '跳转到另一个时间。'], ['Imported subtitles.', '导入的字幕。'], ['Retry this subtitle.', '重试这条字幕。'], ['Bonjour tout le monde.', '法语字幕译文。']
]);
const server = createServer(async (request, response) => {
  if (request.url === '/translate' && request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    const data = JSON.parse(body); requests.push(data);
    response.setHeader('Content-Type', 'application/json');
    if (failNext) { failNext = false; response.statusCode = 429; response.end('{"error":"test quota"}'); return; }
    response.end(JSON.stringify({ translations: data.texts.map(text => translations.get(text) || '译：' + text) })); return;
  }
  if (request.url === '/embedded') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><h1>Embedded video</h1><iframe width="850" height="750" src="http://localhost:' + server.address().port + '/"></iframe>'); return;
  }
  const name = request.url === '/video-subtitles.vtt' ? 'video-subtitles.vtt' : 'video-subtitles.html';
  response.setHeader('Content-Type', name.endsWith('.vtt') ? 'text/vtt; charset=utf-8' : 'text/html; charset=utf-8');
  response.end(await fs.readFile(path.join(root, 'tests/fixtures', name)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, 'profile-' + Date.now()), {
    ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : target.chromiumOptions),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging'], viewport: { width: 1240, height: 800 }
  });
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Extensions.loadUnpacked', { path: path.join(root, process.env.VIDEO_TEST_EXTENSION_DIR || 'dist') }); await session.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extension = 'chrome-extension://' + new URL(worker.url()).host;
  const options = await context.newPage(); await options.goto(extension + '/options.html');
  await options.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.activeProviderId = 'http-template'; settings.sourceLang = 'auto'; settings.targetLang = 'zh-CN'; settings.cacheEnabled = false;
    Object.assign(settings.providers.find(provider => provider.id === 'http-template'), {
      enabled: true, url: origin + '/translate', method: 'POST', headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"texts":{{json texts}},"targetLang":{{json targetLang}}}', responsePath: 'translations'
    });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  }, origin);
  await options.evaluate(async () => {
    const { data: previousSettings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    const results = await Promise.all(['a.example', 'b.example'].map(id => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', previousSettings,
      settings: { ...previousSettings, videoTranslation: { enabled: true, showOriginal: true, fontSize: 22,
        background: 'soft', preferredSource: 'auto', enabledSites: [], ...previousSettings.videoTranslation,
        siteLayouts: [{ id, x: 50, bottom: 20, width: 60, fontSize: 24 }] } }
    })));
    if (results.some(result => !result.ok)) throw new Error('Concurrent layout save failed');
    const { data: saved } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (!['a.example', 'b.example'].every(id => saved.videoTranslation.siteLayouts.some(entry => entry.id === id))) throw new Error('Concurrent site layouts were overwritten');
  });
  checks.push('concurrent first layout saves preserve both website records');
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
  const identity = verifyBrowserIdentity(target, await page.evaluate(() => navigator.userAgent));
  await page.goto(origin); await page.waitForFunction(() => window.fixtureReady);
  await page.waitForFunction(() => document.querySelector('video').textTracks[0]?.cues?.length === 3);
  const view = page.locator('[data-wupage-video]').first();
  await view.waitFor(); assert.equal(requests.length, 0, 'discovering video must not translate');
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0], page.url());
  const popup = await context.newPage();
  await popup.addInitScript(tab => { chrome.tabs.query = async () => [tab]; window.close = () => {}; }, tab);
  await popup.goto(extension + '/popup.html'); await popup.locator('#videoTranslation:enabled').waitFor();
  await popup.setViewportSize({ width: 360, height: 700 });
  const videoToggle = popup.locator('#videoTranslation');
  assert.equal(await videoToggle.getAttribute('aria-pressed'), 'true');
  await videoToggle.click(); await view.waitFor({ state: 'detached' });
  await popup.waitForFunction(() => document.querySelector('#videoTranslation').getAttribute('aria-pressed') === 'false');
  await popup.screenshot({ path: path.join(output, 'disabled.png') });
  await videoToggle.click(); await view.waitFor();
  await popup.waitForFunction(() => document.querySelector('#videoTranslation').getAttribute('aria-pressed') === 'true');
  for (const width of [264, 330, 360]) {
    await popup.setViewportSize({ width, height: 760 });
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const layout = await popup.evaluate(() => {
      const video = document.querySelector('#videoTranslation'), features = document.querySelector('.feature-toggles');
      return { grouped: features.contains(video), width: video.getBoundingClientRect().width, groupWidth: features.getBoundingClientRect().width,
        beforeActions: video.getBoundingClientRect().bottom <= document.querySelector('#pageToggle').getBoundingClientRect().top,
        pdfAlone: document.querySelector('#openPdfWorkspace').getBoundingClientRect().width === document.querySelector('#openPdfWorkspace').parentElement.clientWidth };
    });
    assert.ok(layout.grouped && layout.beforeActions && layout.pdfAlone && Math.abs(layout.width - layout.groupWidth) < 1);
    await popup.screenshot({ path: path.join(output, `popup-${width}.png`) });
  }
  await popup.screenshot({ path: path.join(output, 'entry.png') });
  await view.locator('.toggle').evaluate(button => button.click());
  await page.waitForFunction(() => document.querySelector('[data-wupage-video]')?.hasAttribute('data-enabled'));
  await popup.close(); await page.bringToFront();
  const translated = view.locator('.translation span');
  await translated.filter({ hasText: '你好，世界。' }).waitFor();
  assert.equal(await view.locator('.panel').isVisible(), false, 'one click starts without an obstructing panel');
  assert.equal(await page.evaluate(() => document.querySelector('video').textTracks[0].mode), 'hidden');
  assert.deepEqual(requests.flatMap(request => request.texts), [...translations.keys()].slice(0,3));
  checks.push('persistent feature toggle, full-width placement in the feature grid, three popup widths; native WebVTT and compact player controls');
  const caption = await view.locator('.captions').boundingBox(); const video = await page.locator('video').boundingBox();
  assert.ok(Math.abs(caption.width / video.width - .7) < .01, 'default captions occupy 70% of the video width');
  assert.ok(caption.x >= video.x && caption.x + caption.width <= video.x + video.width);
  assert.ok(caption.y >= video.y && caption.y + caption.height <= video.y + video.height);
  await page.screenshot({ path: path.join(output, 'bilingual.png') });
  await view.locator('.settings').evaluate(button => button.click()); await view.locator('.panel').waitFor();
  await page.screenshot({ path: path.join(output, 'settings.png') });
  await view.locator('details').filter({ hasText: '字幕外观' }).evaluate(details => { details.open = true; });
  assert.equal(await view.locator('.display-mode').inputValue(), 'chinese');
  await view.locator('.display-mode').selectOption('western');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.source')).textAlign === 'left');
  assert.equal(await view.locator('.captions .translation').evaluate(element => getComputedStyle(element).textAlign), 'left');
  await page.screenshot({ path: path.join(output, 'alignment-settings.png') });
  await view.locator('details').filter({ hasText: '字幕外观' }).evaluate(details => { details.open = false; });
  checks.push('Chinese and Western layout switch without another translation');
  await view.locator('.original').uncheck();
  await page.waitForFunction(() => document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.source span').textContent === '');
  assert.equal(requests.length, 1, 'changing appearance must reuse text'); await view.locator('.original').check();
  await view.locator('details').filter({ hasText: '更多选项' }).evaluate(details => { details.open = true; });
  const [cancelledImport] = await Promise.all([page.waitForEvent('filechooser'), view.locator('.import').click()]);
  await cancelledImport.setFiles([]);
  await view.locator('details').filter({ hasText: '更多选项' }).evaluate(details => { details.open = false; });
  checks.push('subtitle import button opens its file picker');
  const beforeLayout = await view.locator('.captions').boundingBox();
  const unexpectedPicker = page.waitForEvent('filechooser', { timeout: 500 }).then(async chooser => {
    await chooser.setFiles([]); return true;
  }, error => { if (error.name !== 'TimeoutError') throw error; return false; });
  await view.locator('.layout-open').click();
  assert.equal(await view.locator('.layout-preview .source').evaluate(element => getComputedStyle(element).textAlign), 'left');
  assert.equal(await view.locator('.layout-preview .translation').evaluate(element => getComputedStyle(element).textAlign), 'left');
  assert.equal(await unexpectedPicker, false, 'layout editing must not open a file picker');
  const setLayoutRange = async (selector, value) => view.locator(selector).evaluate((input, value) => {
    input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await setLayoutRange('.layout-width', 60); await setLayoutRange('.layout-font', 28);
  assert.equal(await view.locator('.layout-preview').evaluate(element => getComputedStyle(element).fontSize), '28px');
  await view.locator('.layout-cancel').click();
  assert.deepEqual(await view.locator('.captions').boundingBox(), beforeLayout, 'cancel restores the original caption layout');
  await view.locator('.settings').evaluate(button => button.click()); await view.locator('.layout-open').click();
  await setLayoutRange('.layout-width', 60); await setLayoutRange('.layout-font', 24);
  const preview = view.locator('.layout-preview');
  const start = await preview.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 50, start.y + start.height / 2 - 45, { steps: 8 }); await page.mouse.up();
  const moved = await preview.boundingBox();
  assert.ok(moved.x > start.x + 40 && moved.y < start.y - 35, 'pointer drag moves the subtitle');
  const handle = await view.locator('.layout-right').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 40, handle.y + handle.height / 2, { steps: 8 }); await page.mouse.up();
  assert.ok((await preview.boundingBox()).width < moved.width - 30, 'right handle changes wrapping width');
  await page.screenshot({ path: path.join(output, 'layout-editing.png') });
  await view.locator('.layout-done').click();
  await page.waitForFunction(() => !document.querySelector('[data-wupage-video]').hasAttribute('data-layout-editing'));
  const savedLayout = await options.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).data.videoTranslation.siteLayouts.find(entry => entry.id === '127.0.0.1'));
  assert.equal(savedLayout.fontSize, 24); assert.ok(savedLayout.width < 60); assert.ok(savedLayout.bottom > 10);
  assert.equal(requests.length, 1, 'layout changes reuse translations');
  assert.equal(await view.locator('.captions').evaluate(element => getComputedStyle(element).pointerEvents), 'none');
  const sourceAfterLayout = await view.locator('.captions').boundingBox();
  await view.locator('.settings').evaluate(button => button.click()); await view.locator('.layout-open').click();
  await view.locator('.layout-reset').click();
  assert.equal(await view.locator('.layout-width').inputValue(), '70');
  await view.locator('.layout-font').press('Escape');
  assert.deepEqual(await view.locator('.captions').boundingBox(), sourceAfterLayout, 'reset remains a draft until Done');
  checks.push('layout preview, cancel, real pointer movement and width handles, site persistence, reset draft, Escape, click-through and no retransmission');
  await view.locator('.settings').evaluate(button => button.click());
  await view.locator('.close').click();
  await page.evaluate(() => { document.querySelector('video').currentTime = 2.3; });
  await translated.filter({ hasText: '跳转到另一个时间。' }).waitFor(); assert.equal(requests.length, 1);
  checks.push('settings do not retransmit; seek uses media time and cache');
  await page.evaluate(() => {
    const video=document.querySelector('video');video.textTracks[0].mode='disabled';
    const french=video.addTextTrack('subtitles','French','fr');french.mode='hidden';
    french.addCue(new VTTCue(0,4,'Bonjour tout le monde.'));
  });
  await translated.filter({hasText:'法语字幕译文。'}).waitFor();
  await page.evaluate(() => {
    const tracks=document.querySelector('video').textTracks;tracks[1].mode='disabled';tracks[0].mode='showing';
  });
  await translated.filter({hasText:'跳转到另一个时间。'}).waitFor();
  checks.push('website native subtitle language changes; return to the original selection');
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement?.contains(document.querySelector('[data-wupage-video]')));
  await page.waitForFunction(bottom => {
    const video = document.querySelector('video').getBoundingClientRect();
    const captions = document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.captions').getBoundingClientRect();
    return Math.abs((video.bottom - captions.bottom) / video.height - bottom / 100) < .02;
  }, savedLayout.bottom);
  await translated.filter({ hasText: '跳转到另一个时间。' }).waitFor(); await page.evaluate(() => document.exitFullscreen());
  await page.locator('#nativeFullscreen').click();
  await page.waitForFunction(() => [...document.querySelector('video').textTracks].some(track => track.label === 'WuPage 双语' && track.mode === 'showing' && track.cues?.length));
  const nativeCues = await page.evaluate(() => [...[...document.querySelector('video').textTracks].find(track => track.label === 'WuPage 双语').cues]
    .map(cue => ({ text: cue.text, align: cue.align, line: cue.line, position: cue.position, size: cue.size })));
  assert.deepEqual(nativeCues, [{ text: 'Seek\n跳转到另一个时间。', align: 'left', line: 'auto', position: 15, size: 70 }]);
  await page.screenshot({ path: path.join(output, 'alignment-native-fullscreen.png') });
  await page.evaluate(() => document.exitFullscreen()); checks.push('container and native video fullscreen');
  await page.locator('#pageFullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
  assert.equal(await page.evaluate(() => document.documentElement.getBoundingClientRect().height), 0, 'reproduce fixed-body full-page player layout');
  await translated.filter({ hasText: '跳转到另一个时间。' }).waitFor();
  assert.equal(await view.evaluate(host => host.hidden), false);
  await page.locator('video').hover(); await view.locator('.settings').hover();
  await page.waitForTimeout(2800);
  assert.equal(await view.locator('.toolbar').evaluate(toolbar => getComputedStyle(toolbar).pointerEvents), 'auto');
  await view.locator('.settings').click(); await view.locator('.panel').waitFor();
  await page.screenshot({path:path.join(output,'page-fullscreen.png')});
  await view.locator('.close').click(); await page.evaluate(() => document.exitFullscreen());
  checks.push('whole-page fullscreen with zero-height HTML; hover controls remain clickable');
  await view.locator('.settings').evaluate(button => button.click()); await view.locator('details').filter({ hasText: '更多选项' }).evaluate(details => { details.open = true; });
  await view.locator('input[type=file]').setInputFiles({ name: 'sample.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:00,000 --> 00:00:04,000\n<i>Imported subtitles.</i>') });
  await translated.filter({ hasText: '导入的字幕。' }).waitFor(); checks.push('SRT import starts immediately');
  await view.locator('.settings').evaluate(button => button.click());
  failNext = true;
  await view.locator('input[type=file]').setInputFiles({ name: 'retry.vtt', mimeType: 'text/vtt', buffer: Buffer.from('WEBVTT\n\n00:00.000 --> 00:04.000\nRetry this subtitle.') });
  await page.waitForFunction(() => document.querySelector('[data-wupage-video]').hasAttribute('data-error'));
  const count = requests.length; await page.waitForTimeout(600); assert.equal(requests.length, count);
  if (!await view.locator('.panel').isVisible()) await view.locator('.settings').evaluate(button => button.click());
  await view.locator('.retry').click();
  await translated.filter({ hasText: '重试这条字幕。' }).waitFor(); checks.push('bounded quota failure and manual retry');
  await view.locator('.close').click().catch(() => {});
  await page.setViewportSize({ width: 390, height: 760 }); await view.locator('.settings').evaluate(button => button.click());
  await view.locator('details').filter({ hasText: '字幕外观' }).evaluate(details => { details.open = true; });
  const bounds = await view.locator('.panel').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal(await view.locator('.panel').evaluate(panel => panel.scrollWidth <= panel.clientWidth), true, 'alignment controls fit the mobile panel');
  await page.screenshot({ path: path.join(output, 'mobile.png') }); checks.push('responsive settings');
  await view.locator('.layout-open').click();
  const layoutPanel = await view.locator('.layout-panel').boundingBox();
  assert.ok(layoutPanel.x >= 0 && layoutPanel.x + layoutPanel.width <= 390);
  await view.locator('.layout-done').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'layout-mobile.png') });
  await view.locator('.layout-cancel').click();
  await view.locator('.settings').evaluate(button => button.click());
  await view.locator('.close').click();
  await options.evaluate(async () => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }); settings.targetLang = 'ja';
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  });
  await page.waitForFunction(() => document.querySelector('[data-wupage-video]').shadowRoot.querySelector('.target').value === 'ja');
  await page.waitForTimeout(500); assert.equal(requests.at(-1).targetLang, 'ja');
  await view.locator('.toggle').evaluate(button => button.click());
  assert.equal(await page.evaluate(() => document.querySelector('video').textTracks[0].mode), 'showing');
  assert.equal(await view.locator('.captions').isVisible(), false); checks.push('language changes restart correctly; stop restores native subtitles');
  await page.setViewportSize({ width: 1240, height: 900 });
  await view.locator('.toggle').evaluate(button => button.click());
  const previousPlayer = await view.getAttribute('id');
  await page.evaluate(async () => {
    const old = document.querySelector('video'), parent = old.parentElement, next = old.cloneNode(true);
    old.remove(); await new Promise(resolve => setTimeout(resolve, 140)); parent.prepend(next); next.load();
  });
  await page.waitForFunction(previous => {
    const host=document.querySelector('[data-wupage-video]');
    return host?.id!==previous&&host?.hasAttribute('data-enabled')&&host?.shadowRoot.querySelector('.translation span').textContent==='你好，世界。';
  }, previousPlayer);
  assert.equal(await view.locator('.captions').evaluate(element => getComputedStyle(element).fontSize), '24px', 'replacement player restores the website layout');
  assert.equal(await view.locator('.captions .source').evaluate(element => getComputedStyle(element).textAlign), 'left', 'replacement player restores source alignment');
  await view.locator('.toggle').evaluate(button => button.click());
  const stoppedPlayer = await view.getAttribute('id');
  await page.evaluate(() => { const old=document.querySelector('video');old.replaceWith(old.cloneNode(true)); });
  await page.waitForFunction(previous => { const host=document.querySelector('[data-wupage-video]');return host&&host.id!==previous; }, stoppedPlayer);
  assert.equal(await view.getAttribute('data-enabled'),null);
  checks.push('delayed video replacement preserves manual translation; a manual stop stays stopped');
  const embedded = await context.newPage(); embedded.on('pageerror', error => errors.push(error.message));
  await embedded.goto(origin + '/embedded');
  const frame = embedded.frameLocator('iframe');
  await frame.locator('[data-wupage-video]').waitFor();
  await frame.locator('video').evaluate(async video => { if(video.readyState < 2) await new Promise(resolve => video.addEventListener('loadeddata', resolve, {once:true})); });
  const embeddedTab = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0], embedded.url());
  const result = await options.evaluate(tabId => chrome.runtime.sendMessage({ type: 'OPEN_VIDEO_SUBTITLES', tabId }), embeddedTab.id);
  assert.equal(result.ok,true);
  await frame.locator('[data-wupage-video] .translation span').filter({ hasText: '你好，世界。' }).waitFor();
  checks.push('cross-origin iframe discovery and popup frame routing');
  const beforeDisable = requests.length;
  await options.evaluate(async () => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.videoTranslation = { ...settings.videoTranslation, enabled: false };
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  });
  await page.locator('[data-wupage-video]').waitFor({ state: 'detached' });
  await frame.locator('[data-wupage-video]').waitFor({ state: 'detached' });
  assert.equal(await frame.locator('video').evaluate(video => video.textTracks[0].mode), 'showing');
  await page.waitForTimeout(300); assert.equal(requests.length, beforeDisable);
  await options.evaluate(async () => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.videoTranslation.enabled = true; await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  });
  await page.locator('[data-wupage-video]').waitFor(); await frame.locator('[data-wupage-video]').waitFor();
  assert.equal(await frame.locator('[data-wupage-video]').getAttribute('data-enabled'), null);
  checks.push('disabling removes top/embedded controls and active subtitles and restores the native track; enabling restores idle controls');
  await embedded.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...identity, passed: true, checks, requests: requests.length }));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, passed: true, checks, requests, errors }, null, 2));
} catch (error) {
  const states=[];
  for (const page of context?.pages() ?? []) {
    if (!page.url().startsWith(origin)) continue;
    states.push(await page.evaluate(()=>({url:location.href,time:document.querySelector('video')?.currentTime,views:[...document.querySelectorAll('[data-wupage-video]')].map(el=>({status:el.shadowRoot.querySelector('.status').textContent,source:el.shadowRoot.querySelector('.source').textContent,translation:el.shadowRoot.querySelector('.translation').textContent,hidden:el.hidden,bounds:el.getBoundingClientRect().toJSON()}))})));
    await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, errors, requests, states, failure: String(error) }, null, 2));
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
}
