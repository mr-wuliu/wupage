// Resource smoke test. Page heap and renderer task time are not total browser memory/CPU.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, '.npm-cache/video-performance');
await fs.mkdir(output, { recursive: true });
const seconds = Number(process.env.VIDEO_SOAK_SECONDS || 120);
assert.ok(Number.isFinite(seconds) && seconds >= 10 && seconds <= 3600);
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
let requestCount = 0;
const fixture = (await fs.readFile(path.join(root, 'tests/fixtures/video-subtitles.html'), 'utf8'))
  .replace(/<track[^>]*>/, '')
  .replace('</video></div>', '</video><div class="vjs-text-track-display" style="position:absolute;bottom:20px">Existing caption</div></div>');
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const data = JSON.parse(raw); requestCount++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ translations: data.texts.map(text => '译：' + text) }));
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixture);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let context;
const errors = [];
const samples = [];
try {
  context = await chromium.launchPersistentContext(path.join(output, 'profile-' + Date.now()), {
    ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging'],
    viewport: { width: 1240, height: 850 }
  });
  const browserSession = await context.browser().newBrowserCDPSession();
  await browserSession.send('Extensions.loadUnpacked', { path: path.join(root, process.env.VIDEO_TEST_EXTENSION_DIR || 'dist') }); await browserSession.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const settingsPage = await context.newPage();
  await settingsPage.goto('chrome-extension://' + new URL(worker.url()).host + '/options.html');
  await settingsPage.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.activeProviderId = 'http-template'; settings.sourceLang = 'en'; settings.targetLang = 'zh-CN';
    Object.assign(settings.providers.find(provider => provider.id === 'http-template'), {
      enabled: true, url: origin, method: 'POST', headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations'
    });
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  }, origin);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.waitForFunction(() => window.fixtureReady);
  const view = page.locator('[data-wupage-video]').first(); await view.waitFor();
  await page.evaluate(async () => {
    const video = document.querySelector('video'); video.loop = true; await video.play();
    let index = 0;
    window.captionTimer = setInterval(() => { document.querySelector('.vjs-text-track-display').textContent = 'Sentence ' + (++index); }, 450);
  });
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const sample = async label => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const values = Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
    samples.push({ label, at: Date.now(), requests: requestCount, ...Object.fromEntries(
      ['TaskDuration', 'ScriptDuration', 'JSHeapUsedSize', 'Nodes', 'Documents', 'JSEventListeners'].map(key => [key, values[key]])
    ), quality: await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) return null;
      const quality = video.getVideoPlaybackQuality();
      return { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames };
    }) });
    await fs.writeFile(path.join(output, 'samples.json'), JSON.stringify(samples, null, 2));
  };
  await sample('inactive-start'); await page.waitForTimeout(10000); await sample('inactive-end');
  assert.equal(requestCount, 0, 'inactive feature must not submit subtitles');
  await view.locator('.toggle').evaluate(button => button.click());
  await view.locator('.translation span').filter({ hasText: '译：Sentence' }).waitFor();
  await page.waitForTimeout(3000); await sample('active-start');
  let remaining = seconds;
  while (remaining > 0) {
    const interval = Math.min(30, remaining); await page.waitForTimeout(interval * 1000); remaining -= interval;
    await sample('active-' + (seconds - remaining));
  }
  await view.locator('.toggle').evaluate(button => button.click());
  await page.waitForTimeout(1000); const stoppedRequests = requestCount;
  await page.waitForTimeout(3000); assert.equal(requestCount, stoppedRequests, 'stop must stop new submissions');
  await sample('stopped');
  await page.evaluate(() => { document.querySelector('.player').remove(); clearInterval(window.captionTimer); });
  await page.waitForTimeout(6500); await sample('removed');
  assert.equal(await page.locator('[data-wupage-video]').count(), 0);
  assert.deepEqual(errors, []);
  const rate = (a, b, key) => (b[key] - a[key]) / ((b.at - a.at) / 1000);
  const first = samples.find(sample => sample.label === 'active-start');
  const last = samples.filter(sample => sample.label.startsWith('active-')).at(-1);
  const report = {
    passed: true, browser: context.browser().version(), platform: os.platform(), logicalCores: os.cpus().length,
    seconds, requests: requestCount, samples, errors,
    rendererTaskSecondsPerSecond: { inactive: rate(samples[0], samples[1], 'TaskDuration'), active: rate(first, last, 'TaskDuration') },
    rendererScriptSecondsPerSecond: { inactive: rate(samples[0], samples[1], 'ScriptDuration'), active: rate(first, last, 'ScriptDuration') },
    activeHeapGrowthBytes: last.JSHeapUsedSize - first.JSHeapUsedSize,
    limitations: 'Local rolling-caption fixture, mock text service, headless renderer metrics. Excludes whole-browser processes, GPU memory and real-site authorization.'
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, seconds, requests: requestCount, activeHeapGrowthBytes: report.activeHeapGrowthBytes, rendererTaskSecondsPerSecond: report.rendererTaskSecondsPerSecond }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
}
