// Optional integration check using real Mozilla models. LOCAL_MODEL_FIXTURE_DIR
// supplies previously downloaded files so the check can also run offline.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, '.npm-cache/local-translation');
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const catalog = JSON.parse(await fs.readFile(path.join(root, 'src/local/catalog.json'), 'utf8'));
const model = catalog.find(entry => entry.id === 'en-zh-Hans');
let fixtureServer;
let fixtureRequests = 0;
let resumed = false;
let fixtureOrigin;
let extension = path.join(root, 'dist');
if (process.env.LOCAL_MODEL_FIXTURE_DIR) {
  fixtureServer = createServer(async (request, response) => {
    const file = model.files.find(entry => `/${entry.name}` === request.url);
    if (!file) { response.writeHead(404); response.end(); return; }
    fixtureRequests++;
    const data = await fs.readFile(path.join(process.env.LOCAL_MODEL_FIXTURE_DIR, file.name));
    const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0);
    if (offset) resumed = true;
    response.writeHead(offset ? 206 : 200, { 'content-type': 'application/octet-stream',
      'content-length': String(data.length - offset),
      ...(offset ? { 'content-range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {}) });
    if (fixtureRequests === 1) {
      // Force an actual broken HTTP stream after persisted checkpoints.
      response.write(data.subarray(0, 2 * 1024 * 1024));
      setTimeout(() => response.destroy(), 250);
    } else response.end(data.subarray(offset));
  });
  await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
  fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  extension = path.join(output, `extension-${Date.now()}`);
  await fs.cp(path.join(root, 'dist'), extension, { recursive: true });
  // Redirect model data only in the disposable test build. Production sources,
  // model bytes, hashes, the downloader and the upstream engine stay unchanged.
  for (const name of await fs.readdir(path.join(extension, 'assets'))) {
    if (!name.endsWith('.js')) continue;
    const location = path.join(extension, 'assets', name);
    const source = await fs.readFile(location, 'utf8');
    let rewritten = source;
    for (const file of model.files) rewritten = rewritten.replaceAll(file.url, `${fixtureOrigin}/${file.name}`);
    if (source !== rewritten) await fs.writeFile(location, rewritten);
  }
}
const context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
  ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : { channel: 'chromium' }),
  headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--lang=zh-CN', `--load-extension=${extension}`], viewport: { width: 900, height: 1000 }
});
const errors = [];
const requests = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  let options = await context.newPage();
  await options.goto(`${base}/options.html#providerSettings`);
  await options.locator('#providerTrigger').click();
  await options.locator('[data-action="select"][data-provider-id="firefox-local"]').click();
  await options.locator('[data-local="download"]:enabled').waitFor();
  assert.match(await options.locator('.local-resource-notice').textContent(), /CPU/);
  assert.match(await options.locator('.local-resource-notice').textContent(), /额外下载/);
  assert.equal(requests.length, 0, 'Selecting local translation must not start a download');
  const missing = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH',
    texts: ['Hello world'], sourceLang: 'en', targetLang: 'zh-CN' }));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /下载或导入/);
  assert.equal(requests.length, 0, 'Missing models must not trigger a download');
  assert.equal(fixtureRequests, 0);
  await options.locator('[data-local="download"]').click();
  await options.waitForFunction(() => {
    const option = document.querySelector('[data-local="model"]')?.selectedOptions[0];
    return option?.textContent.includes('已就绪');
  }, undefined, { timeout: 300000 });
  if (fixtureServer) assert.equal(resumed, true, 'An interrupted real download must resume with Range');
  await options.close();
  await context.setOffline(true);
  options = await context.newPage();
  await options.goto(`${base}/options.html#providerSettings`);
  await options.locator('[data-local="status"]').filter({ hasText: '模型已就绪' }).waitFor();
  const before = requests.length;
  const fixtureBefore = fixtureRequests;
  const result = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH',
    texts: ['Hello world.', 'This is a local translation test.'], sourceLang: 'en', targetLang: 'zh-CN' }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.translations.length, 2);
  assert.ok(result.data.translations.every(text => /\p{Script=Han}/u.test(text)), JSON.stringify(result));
  const automatic = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH',
    texts: ['The browser translates this sentence using a local model without an internet connection.'], sourceLang: 'auto', targetLang: 'zh-CN' }));
  assert.equal(automatic.ok, true, JSON.stringify(automatic));
  assert.match(automatic.data.translations[0], /\p{Script=Han}/u);
  assert.equal(requests.length, before, 'Translation and source detection must stay offline');
  assert.equal(fixtureRequests, fixtureBefore, 'Inference must not request model files again');
  const unsupported = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH',
    texts: ['Hello'], sourceLang: 'en', targetLang: 'ko' }));
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /更换语言/);
  await options.screenshot({ path: path.join(output, 'options.png'), fullPage: true });
  await options.locator('[data-local="remove"]').click();
  await options.waitForFunction(() => !document.querySelector('[data-local="model"]')?.selectedOptions[0]?.textContent.includes('已就绪'));
  if (process.env.LOCAL_MODEL_FIXTURE_DIR) {
    await options.locator('[data-local="files"]').setInputFiles(model.files.map(file => path.join(process.env.LOCAL_MODEL_FIXTURE_DIR, file.name)));
    await options.waitForFunction(() => document.querySelector('[data-local="model"]')?.selectedOptions[0]?.textContent.includes('已就绪'));
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }));
    const imported = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH',
      texts: ['Thank you for using offline translation.'], sourceLang: 'en', targetLang: 'zh-CN' }));
    assert.equal(imported.ok, true, JSON.stringify(imported));
    assert.match(imported.data.translations[0], /\p{Script=Han}/u);
  }
  assert.deepEqual(errors, []);
  const report = { translations: result.data.translations, automatic: automatic.data.translations,
    modelVersion: model.version, downloadRequests: fixtureServer ? fixtureRequests : requests.length, resumed, errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const page of context.pages()) {
    if (new URL(page.url()).pathname !== '/options.html') continue;
    console.log('Options diagnostics:', await page.locator('body').innerText());
    console.log('Model diagnostics:', await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_LOCAL_MODEL_STATUS' })));
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  }
  console.log('Page errors:', errors);
  throw error;
} finally {
  await context.close();
  if (fixtureServer) await new Promise(resolve => fixtureServer.close(resolve));
}
