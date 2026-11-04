// Restart the real MV3 worker while static pages remain open. Local service only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
assert.notEqual(target.kind, 'firefox', 'This regression exercises Chromium service worker termination.');
const output = path.join(root, '.npm-cache/background-resume', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const requests = [], checks = [];
let origin;
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const part of request) body += part;
    const { texts } = JSON.parse(body); requests.push(...texts);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      translations: texts.map(text => text.includes('WUPAGESEGMENT')
        ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\s*\n)/g, '$1译文：') : `译文：${text}`)
    }));
    return;
  }
  const child = request.url.startsWith('/child');
  const source = child ? 'Embedded article remains readable after background sleep.' : 'Static article remains readable after background sleep.';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><meta charset="utf-8">
    <style>body{font:16px/1.5 sans-serif;margin:24px}iframe{width:700px;height:180px}</style>
    <body><main><p>${source}</p>${child ? '' : `<iframe src="${origin.replace('127.0.0.1', 'localhost')}/child"></iframe>`}</main></body></html>`);
});
await new Promise(resolve => server.listen(0, resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const waitFor = async (read, check, label) => {
  const until = Date.now() + 15000; let value;
  do { value = await read(); if (check(value)) return value; await delay(80); } while (Date.now() < until);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
let browser;
try {
  browser = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1200, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  const loader = await browser.browser().newBrowserCDPSession();
  await loader.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await loader.detach();
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const extensionUrl = worker.url().replace(/background\.js$/, '');
  const control = await browser.newPage(); await control.goto(`${extensionUrl}options.html`);
  const api = (source, input = []) => control.evaluate(`(async()=>{const input=${JSON.stringify(input)};${source}})()`);
  const settings = await api("return (await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data;");
  Object.assign(settings, { activeProviderId: 'http-template', cacheEnabled: false, floatingBallEnabled: false,
    sourceLang: 'en', targetLang: 'zh-CN', translationDisplayMode: 'bilingual' });
  settings.autoTranslation.enabled = false;
  Object.assign(settings.providers.find(provider => provider.id === 'http-template'), {
    url: `${origin}/translate`, method: 'POST', headers: { 'Content-Type': 'application/json' },
    bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations'
  });
  const saved = await api("return chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings:input[0]});", [settings]);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const page = await browser.newPage();
  const identity = verifyBrowserIdentity(target, await page.evaluate('navigator.userAgent'));
  const send = request => api(`const tab=(await chrome.tabs.query({})).find(tab=>tab.url===input[0]);
    return chrome.tabs.sendMessage(tab.id,input[1],{frameId:0});`, [`${origin}/article`, request]);
  await page.goto(`${origin}/article`);
  await waitFor(() => send({ type: 'GET_TRANSLATION_STATE' }).catch(() => null), value => value?.ok, 'page ready');
  await delay(600);
  const inspect = () => Promise.all(page.frames().map(frame => frame.evaluate(() => ({
    url: location.href, source: document.querySelector('p')?.firstChild?.textContent,
    translations: [...document.querySelectorAll('.wupage-translation:not(.wupage-translation-pending)')].map(node => node.textContent)
  }))));
  const original = await inspect();
  assert.equal(requests.length, 0, 'a static page must not translate before user action');
  const cdp = await browser.newCDPSession(control);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const version of updates) versions.set(version.versionId, version);
  });
  await cdp.send('ServiceWorker.enable');
  const suspend = async () => {
    await delay(200); // Drain document state reports before stopping the worker.
    const version = await waitFor(() => [...versions.values()].find(value => value.scriptURL === worker.url()
      && value.runningStatus === 'running'), Boolean, 'running extension worker');
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await waitFor(() => versions.get(version.versionId)?.runningStatus, value => value === 'stopped', 'worker stopped');
  };
  const record = async (scenario, result) => {
    const frames = await inspect(); checks.push({ scenario, result, frames });
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ identity, checks,
      contentSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'dist/content.js'))).digest('hex') }, null, 2));
    return frames;
  };
  await suspend();
  assert.deepEqual(await inspect(), original, 'worker termination must not change the static page');
  const first = await send({ type: 'TRANSLATE_PAGE' });
  const firstFrames = await record('first click after worker termination', first);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.data.translated >= 2, JSON.stringify(first));
  assert.ok(firstFrames.every(frame => frame.translations.length > 0), JSON.stringify(firstFrames));

  await suspend();
  await send({ type: 'CLEAR_TRANSLATION' });
  await waitFor(inspect, frames => frames.every(frame => !frame.translations.length), 'stop restores every document after worker restart');
  await record('stop after worker termination', await inspect());
  await suspend();
  const count = requests.length;
  const restored = await send({ type: 'TRANSLATE_PAGE' });
  const restoredFrames = await record('resume saved results after another worker termination', restored);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.ok(restoredFrames.every(frame => frame.translations.length > 0));
  assert.equal(requests.length, count, 'resume reuses saved translations with the provider cache disabled');
  console.log(JSON.stringify({ identity, checks: checks.map(check => check.scenario) }));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
