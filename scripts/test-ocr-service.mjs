// Isolated browser + local OCR/translation fixtures. No models or real services.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, '.npm-cache/ocr-service');
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const requests = [], translations = [], errors = [];
let invalid = false;
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/ocr') {
      requests.push({ input, headers: request.headers });
      const { width, height } = input.image;
      response.end(JSON.stringify({ schemaVersion: 1, coordinateSpace: 'pixel', width, height,
        lines: [{ text: 'Hello OCR 123', poly: [[32, 50], [360, 50], [360, 100], [32, 100]], ...(invalid ? { score: 100 } : {}) }] }));
    } else {
      translations.push(input);
      response.end(JSON.stringify({ translations: input.texts.map(text => text.replaceAll('Hello OCR', '你好，文字识别')) }));
    }
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><meta charset="utf-8"><title>OCR sample</title>
    <style>body{margin:40px;background:white}img{width:640px;height:160px;display:block}</style><img id="sample"><script>
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=160;
    const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,640,160);c.font='48px sans-serif';c.fillStyle='#111';c.fillText('Hello OCR 123',32,100);
    document.querySelector('img').src=canvas.toDataURL();</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...browserTarget().chromiumOptions, headless: true, viewport: { width: 1200, height: 1100 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
  });
  const session = await context.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const options = await context.newPage(); options.on('pageerror', error => errors.push(error.message));
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('#providerForm[data-provider-id]').waitFor({ state: 'attached' });
  await options.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings.activeProviderId = 'http-template'; settings.sourceLang = 'en';
    Object.assign(settings.providers.find(p => p.id === 'http-template'), { enabled: true, method: 'POST', url: `${origin}/translate`,
      headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    const result = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (!result.ok) throw new Error(result.error);
  }, origin);
  await options.reload();
  await options.locator('#providerForm[data-provider-id="http-template"]').waitFor({ state: 'attached' });
  await options.locator('.settings-nav a[aria-controls="providerSettings"]').click();
  assert.deepEqual(await options.locator('#providerSettings > .service-settings-card h2').allTextContents(), ['文本翻译服务', 'OCR 翻译服务']);
  assert.equal(await options.locator('#generalSettings #ocrBackend').count(), 0);
  await options.locator('#ocrBackend').selectOption('http');
  await options.locator('#ocrServiceEndpoint').fill(`${origin}/ocr`);
  await options.locator('#ocrServiceModel').fill('my-ocr');
  await options.locator('#ocrServiceKey').fill('fixture-ocr-key');
  await options.locator('#testOcrService').click();
  await options.waitForFunction(() => !document.querySelector('#testOcrService').disabled && document.querySelector('#ocrServiceTestStatus').textContent);
  assert.match(await options.locator('#ocrServiceTestStatus').innerText(), /识别完成/u);
  assert.equal(await options.locator('#ocrServiceTestText').innerText(), 'Hello OCR 123');
  assert.equal(translations.length, 0, 'test recognition must not translate');
  assert.equal((await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }))).data.ocr, undefined, 'tests must not save drafts');
  await options.screenshot({ path: path.join(output, 'settings-desktop.png'), fullPage: true });
  await options.setViewportSize({ width: 360, height: 900 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no narrow-screen horizontal overflow');
  await options.screenshot({ path: path.join(output, 'settings-mobile.png'), fullPage: true });
  await options.setViewportSize({ width: 1200, height: 1100 });
  await options.locator('.settings-nav a[aria-controls="generalSettings"]').click();
  await options.locator('#imageTranslationEnabled').check({ force: true });
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  await options.reload();
  await options.waitForFunction(() => document.querySelector('#imageTranslationEnabled').checked);
  assert.equal(await options.locator('#ocrServiceModel').inputValue(), 'my-ocr');
  assert.equal((await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_OCR_STATUS' }))).data.backend, 'http');
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('#sample').hover();
  const button = page.locator('#wupage-image-tools button').first();
  await button.waitFor({ state: 'visible' }); await button.click();
  await page.waitForFunction(() => document.querySelector('#wupage-image-tools')?.shadowRoot.querySelector('canvas'));
  assert.equal(await page.locator('#wupage-image-tools canvas').isVisible(), true);
  assert.equal(translations.length, 1);
  assert.equal(translations[0].texts.length, 1);
  assert.match(translations[0].texts[0], /Hello OCR/u);
  assert.ok(!JSON.stringify(translations).includes('base64'));
  await page.screenshot({ path: path.join(output, 'translated-image.png') });
  const beforeCache = requests.length;
  await page.reload(); await page.locator('#sample').hover(); await button.waitFor({ state: 'visible' }); await button.click();
  await page.waitForFunction(() => document.querySelector('#wupage-image-tools')?.shadowRoot.querySelector('canvas'));
  assert.equal(requests.length, beforeCache, 'reopening must reuse the matching OCR cache');
  await options.locator('.settings-nav a[aria-controls="providerSettings"]').click();
  await options.locator('#ocrServiceRevision').fill('2'); await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
  await page.waitForFunction(() => !document.querySelector('#wupage-image-tools')?.shadowRoot.querySelector('canvas'));
  await page.locator('#sample').hover(); await button.waitFor({ state: 'visible' }); await button.click();
  await page.waitForFunction(() => document.querySelector('#wupage-image-tools')?.shadowRoot.querySelector('canvas'));
  assert.equal(requests.length, beforeCache + 1, 'a changed model cache version must recognize again');
  invalid = true; await options.locator('#testOcrService').click();
  await options.waitForFunction(() => document.querySelector('#ocrServiceTestStatus').textContent.includes('协议'));
  for (const { input, headers } of requests) {
    assert.deepEqual(Object.keys(input).sort(), ['image', 'model', 'schemaVersion']);
    assert.equal(input.model, 'my-ocr'); assert.equal(headers.authorization, 'Bearer fixture-ocr-key');
    assert.equal(headers.cookie, undefined); assert.equal(headers.referer, undefined);
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, recognitionRequests: requests.length,
    translationRequests: translations.length, cacheReused: true, cacheVersionInvalidated: true, malformedResponseRejected: true,
    mobileOverflow: false, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, recognitionRequests: requests.length, translationRequests: translations.length, output }));
} catch (error) {
  const page = context?.pages().find(page => page.url() === `${origin}/`);
  const imageStatus = await page?.evaluate(() => document.querySelector('#wupage-image-tools')?.shadowRoot?.textContent).catch(() => 'unavailable');
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(JSON.stringify({ recognitionRequests: requests.length, translations, imageStatus, errors }));
  throw error;
} finally {
  await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
