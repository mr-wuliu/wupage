// Real MV3 regression: leave a translating video and a dormant iframe open during reload.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = browserTarget();
const output = path.join(root, '.npm-cache/extension-reload', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const errors = [];
const server = createServer(async (request, response) => {
  if (request.url === '/translate') {
    let body = ''; for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ translations: JSON.parse(body).texts.map(text => '译：' + text) })); return;
  }
  if (request.url === '/empty-frame') {
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><p>Waiting for video</p>'); return;
  }
  const name = request.url === '/video-subtitles.vtt' ? 'video-subtitles.vtt' : 'video-subtitles.html';
  response.setHeader('Content-Type', name.endsWith('.vtt') ? 'text/vtt' : 'text/html; charset=utf-8');
  response.end(await fs.readFile(path.join(root, 'tests/fixtures', name)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, 'profile-' + Date.now()), {
    ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : target.chromiumOptions),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'], viewport: { width: 1240, height: 800 }
  });
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const options = await context.newPage(); await options.goto('chrome-extension://' + new URL(worker.url()).host + '/options.html');
  await options.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.activeProviderId = 'http-template'; settings.cacheEnabled = false;
    Object.assign(settings.providers.find(provider => provider.id === 'http-template'), {
      enabled: true, url: origin + '/translate', method: 'POST', headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations'
    });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  }, origin);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
  const identity = verifyBrowserIdentity(target, await page.evaluate(() => navigator.userAgent));
  await page.goto(origin); await page.waitForFunction(() => window.fixtureReady);
  const view = page.locator('[data-wupage-video]').first(); await view.waitFor();
  await view.locator('.toggle').evaluate(button => button.click());
  await view.locator('.translation span').filter({ hasText: '译：Hello world.' }).waitFor();
  assert.equal(await page.locator('video').evaluate(video => video.textTracks[0].mode), 'hidden');
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.src = '/empty-frame'; document.body.append(frame);
  });
  const frame = page.frameLocator('iframe'); await frame.locator('p').waitFor();
  // Ensure the frame bootstrap has started its discovery heartbeat.
  await page.waitForTimeout(600);
  const reloaded = context.waitForEvent('serviceworker', { predicate: next => next !== worker });
  await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); }); await reloaded;
  await frame.locator('body').evaluate(body => {
    const video = document.createElement('video'); video.width = 640; video.height = 360; body.append(video);
    video.dispatchEvent(new Event('playing', { bubbles: true }));
  });
  await view.waitFor({ state: 'detached' });
  assert.equal(await page.locator('video').evaluate(video => video.textTracks[0].mode), 'showing');
  // Old observers must not recreate controls when YouTube replaces its player.
  await page.locator('.player').evaluate(player => { player.append(player.querySelector('video').cloneNode(true)); });
  await page.waitForTimeout(6500);
  assert.equal(await page.locator('[data-wupage-video]').count(), 0);
  assert.equal(await frame.locator('[data-wupage-video]').count(), 0);
  assert.deepEqual(errors, []);
  await page.reload(); await page.waitForFunction(() => window.fixtureReady);
  await view.waitFor();
  if (!await view.getAttribute('data-enabled')) await view.locator('.toggle').evaluate(button => button.click());
  await view.locator('.translation span').filter({ hasText: '译：Hello world.' }).waitFor();
  assert.deepEqual(errors, []);
  const report = { ...identity, passed: true, checks: ['reload stops old subtitle timers and observers', 'native captions restored', 'dormant iframe discovery stops without errors', 'page refresh restores translation'], errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, failure: String(error), errors }, null, 2));
  console.error(JSON.stringify({ count: errors.length, firstErrors: errors.slice(0, 4) }));
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
}
