// Exercise the built MV3 background with fresh profiles and fixed sample text.
// --live sends only these samples to Google; the default mode stays offline.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = browserTarget(), live = process.argv.includes('--live');
if (target.kind === 'firefox') throw new Error('This worker-level regression runs on Chrome or Edge.');
const output = path.join(root, '.npm-cache/google-web', `${target.kind}-${live ? 'live' : 'offline'}`);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const browser = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
  ...target.chromiumOptions, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
});
try {
  const cdp = await browser.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await cdp.detach();
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const control = await browser.newPage();
  await control.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const identity = verifyBrowserIdentity(target, await control.evaluate(() => navigator.userAgent));
  await worker.evaluate(live => {
    const originalFetch = globalThis.fetch;
    globalThis.googleRequests = [];
    globalThis.googleMode = 'normal';
    globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(url);
      if (!['translate.googleapis.com', 'translate-pa.googleapis.com', 'clients5.google.com'].includes(parsed.hostname)) return originalFetch(url, init);
      const headers = new Headers(init.headers);
      if ([...headers.values()].some(value => value.includes('fixture-saved-cloud-key'))) throw new Error('Saved Cloud credential leaked');
      let response;
      if (globalThis.googleMode !== 'normal' && parsed.hostname === 'translate-pa.googleapis.com'
        || globalThis.googleMode === 'both-limited' && parsed.hostname === 'clients5.google.com') {
        response = new Response('Rate limited', { status: 429, headers: { 'Retry-After': '120' } });
      } else if (live) response = await originalFetch(url, init);
      else if (parsed.pathname.includes('/translate_a/element.js')) response = new Response("_loadJs('https://translate.googleapis.com/_/translate_http/_/js/k=fixture/m=el_main')");
      else if (parsed.hostname === 'translate.googleapis.com') response = new Response(`({'x-goog-api-key':'${'A'.repeat(39)}'})`);
      else {
        const translate = text => text.replaceAll('Hello world', '你好世界').replaceAll('The cat is sleeping.', '猫正在睡觉。')
          .replaceAll('Please open the window.', '请打开窗户。').replaceAll('Read', '阅读');
        const payload = parsed.hostname === 'translate-pa.googleapis.com'
          ? [JSON.parse(init.body)[0][0].map(translate)]
          : parsed.searchParams.getAll('q').map(text => parsed.searchParams.get('sl') === 'auto' ? [translate(text), 'en'] : translate(text));
        response = new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
      }
      // Never record headers, keys, full query strings, or arbitrary user text.
      globalThis.googleRequests.push({ host: parsed.hostname, path: parsed.pathname, status: response.status });
      return response;
    };
  }, live);
  const send = request => control.evaluate(request => chrome.runtime.sendMessage(request), request);
  const saved = await send({ type: 'GET_SETTINGS' }); assert.equal(saved.ok, true);
  const settings = saved.data, provider = settings.providers.find(provider => provider.type === 'google-web-translate');
  settings.activeProviderId = provider.id; settings.cacheEnabled = false; settings.targetLang = 'zh-CN';
  provider.serviceMode = 'free'; provider.api = { apiKey: 'fixture-saved-cloud-key' };
  assert.equal((await send({ type: 'SAVE_SETTINGS', settings })).ok, true);
  const tested = await send({ type: 'TEST_PROVIDER', providerId: provider.id }); assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.match(tested.data.translation, /\p{Script=Han}/u);
  const batch = { type: 'TRANSLATE_BATCH', providerId: provider.id,
    texts: ['The cat is sleeping.', 'Please open the window.'], context: 'Page title: Everyday English', sourceLang: 'en', targetLang: 'zh-CN' };
  const contextual = await send(batch); assert.equal(contextual.ok, true, JSON.stringify(contextual));
  assert.equal(contextual.data.translations.length, 2);
  assert.ok(contextual.data.translations.every(text => /\p{Script=Han}/u.test(text) && !text.includes('Page title:') && !/<\/?(?:pre|a)\b/.test(text)));
  const primaryRequests = await worker.evaluate(() => globalThis.googleRequests);
  assert.equal(primaryRequests.filter(request => request.host === 'translate-pa.googleapis.com' && request.status === 200).length, 2);
  assert.equal(primaryRequests.some(request => request.host === 'clients5.google.com'), false, 'Primary samples unexpectedly used fallback');

  await worker.evaluate(() => { globalThis.googleMode = 'primary-limited'; });
  const fallback = await send({ ...batch, sourceLang: 'auto' }); assert.equal(fallback.ok, true, JSON.stringify(fallback));
  assert.equal(fallback.data.translations.length, 2);
  assert.ok(fallback.data.translations.every(text => /\p{Script=Han}/u.test(text)));
  const again = await send({ type: 'TEST_PROVIDER', providerId: provider.id }); assert.equal(again.ok, true, JSON.stringify(again));
  let requests = await worker.evaluate(() => globalThis.googleRequests);
  assert.equal(requests.filter(request => request.host === 'translate-pa.googleapis.com' && request.status === 429).length, 1, 'Primary cooldown was ignored');
  assert.equal(requests.filter(request => request.host === 'clients5.google.com' && request.status === 200).length, 2);
  if (!live) {
    const literals = await send({ ...batch, context: undefined, texts: ['Read <div> &lt; literally.\n\nHello world'] });
    assert.equal(literals.ok, true, JSON.stringify(literals));
    assert.deepEqual(literals.data.translations, ['阅读 <div> &lt; literally.\n\n你好世界']);
  }
  await worker.evaluate(() => { globalThis.googleMode = 'both-limited'; });
  const limited = await send({ type: 'TEST_PROVIDER', providerId: provider.id });
  assert.equal(limited.ok, false); assert.equal(limited.errorCode, 'rate-limited'); assert.equal(limited.retryAfterMs, 120_000);
  requests = await worker.evaluate(() => globalThis.googleRequests);
  assert.ok(requests.every(request => !request.path.includes('/translate_a/single')));
  const report = { ...identity, live, passed: true, checks: ['primary preference', 'context paragraph alignment', '429 fallback', 'fallback cooldown',
    'rate-limit propagation', 'saved Cloud key isolation', ...(!live ? ['literal entities and line breaks'] : [])],
    samples: { primary: tested.data.translation, contextual: contextual.data.translations, fallback: fallback.data.translations }, requests };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }, null, 2));
} finally { await browser.close(); }
