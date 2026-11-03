// Isolated extension profiles and a local service that stalls selected pages.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { browserTarget } from './lib/browser-target.mjs';
import { openExtensionBrowser } from './lib/extension-browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/pdf-lifetime', target.kind);
await fs.mkdir(output, { recursive: true });
const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.TimesRoman);
for (let page = 1; page <= 3; page++) {
  document.addPage([600, 800]).drawText(`Lifetime page ${page}. A paragraph to translate.`, { x: 40, y: 700, size: 12, font });
}
const bytes = await document.save();
let mode = 'stall', closed = 0, calls = 0;
const timers = new Set();
const server = createServer(async (request, response) => {
  if (request.method === 'GET') return response.writeHead(200, { 'content-type': 'application/pdf' }).end(bytes);
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const { texts } = JSON.parse(JSON.parse(body).messages.at(-1).content);
    calls++;
    let timer;
    response.on('close', () => { if (!response.writableFinished) closed++; clearTimeout(timer); timers.delete(timer); });
    const reply = () => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify(texts.map(text => `译文：${text}`))
    } }] }));
    if (mode === 'stall') return;
    if (mode === 'slow' && texts.some(text => text.includes('Lifetime page 1.'))) { timer = setTimeout(reply, 35_000); timers.add(timer); return; }
    reply();
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
async function wait(source, label, limit = 15_000) {
  const until = Date.now() + limit;
  while (Date.now() < until) { if (await browser.evaluate(source)) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function eventually(condition, label) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) { if (condition()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const base = await browser.api(`const settings=(await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data;
    Object.assign(settings,{activeProviderId:'deepseek',sourceLang:'en',targetLang:'zh-CN',cacheEnabled:false,pdfTranslationPageRadius:null,concurrency:2});
    Object.assign(settings.providers.find(p=>p.id==='deepseek'),{baseURL:input[0]+'/v1',apiKey:'test-only',performanceMode:'custom',concurrency:2,chunkSize:3200});
    await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});return chrome.runtime.getURL('pdf.html');`, [origin]);
  await browser.navigate(base + '?url=' + encodeURIComponent(origin + '/fixture.pdf') + '&translate=0');
  await wait('return document.querySelectorAll(".page-row").length===3&&!document.querySelector("#translateDocument").disabled;', 'PDF ready');
  // Accelerate only the reader's existing two-minute deadline. The backend's
  // independent deadline and recovery cancellation are covered by unit tests.
  await browser.evaluate(`const content=window.wrappedJSObject||window;content.pdfTestSetTimeout=content.setTimeout;
    const accelerated=function(fn,ms,...args){return content.pdfTestSetTimeout(fn,ms===120000?1500:ms,...args);};
    content.setTimeout=typeof exportFunction==='function'?exportFunction(accelerated,content):accelerated;
    document.querySelector('#translateDocument').click();`);
  await wait('return !document.querySelector("#translateDocument").disabled&&document.querySelector("#statusToast").textContent.includes("失败");', 'stalled pages stop');
  await eventually(() => closed >= 3, 'stalled network requests aborted');
  const timedOut = await browser.evaluate('return [...document.querySelectorAll(".translation-prompt")].map(e=>e.textContent);');
  assert.ok(timedOut.every(text => text.includes('120 秒')));
  mode = 'fast';
  await browser.evaluate('const content=window.wrappedJSObject||window;content.setTimeout=content.pdfTestSetTimeout;document.querySelector("#translateDocument").click();');
  await wait('return !document.querySelector("#translateDocument").disabled&&document.querySelector("#statusToast").textContent.includes("翻译完成");', 'retry succeeds');
  assert.equal(await browser.evaluate('return document.querySelectorAll(".has-error,.translation-canvas-shell.is-loading").length;'), 0);

  // No polling of the worker during this wait: heartbeat messages must keep
  // the active translation alive through Chromium's 30-second idle interval.
  mode = 'slow';
  await browser.evaluate('const target=document.querySelector("#targetLang");target.value="de";target.dispatchEvent(new Event("change"));document.querySelector("#translateDocument").click();');
  await wait('return !document.querySelector("#translateDocument").disabled&&document.querySelector("#statusToast").textContent.includes("翻译完成");', 'slow response survives worker idle interval', 90_000);
  assert.equal(await browser.evaluate('return document.querySelectorAll(".has-error,.translation-canvas-shell.is-loading").length;'), 0);

  mode = 'stall'; const before = calls, closedBefore = closed;
  await browser.evaluate('const target=document.querySelector("#targetLang");target.value="fr";target.dispatchEvent(new Event("change"));document.querySelector("#translateDocument").click();');
  await eventually(() => calls >= before + 2, 'requests running before settings change');
  await browser.evaluate('const target=document.querySelector("#targetLang");target.value="ja";target.dispatchEvent(new Event("change"));');
  await eventually(() => closed >= closedBefore + 2, 'settings change cancels running pages');
  await wait('return !document.querySelector("#translateDocument").disabled&&!document.querySelector(".translation-canvas-shell.is-loading");', 'settings change unlocks retry');
  mode = 'fast';
  await browser.evaluate('document.querySelector("#translateDocument").click();');
  await wait('return !document.querySelector("#translateDocument").disabled&&document.querySelector("#statusToast").textContent.includes("翻译完成");', 'new settings translate successfully');

  mode = 'stall'; const closingCalls = calls, closingClosed = closed;
  await browser.evaluate('const target=document.querySelector("#targetLang");target.value="ko";target.dispatchEvent(new Event("change"));document.querySelector("#translateDocument").click();');
  await eventually(() => calls >= closingCalls + 2, 'requests running before navigation');
  await browser.navigate('about:blank');
  await eventually(() => closed >= closingClosed + 2, 'leaving PDF cancels running pages');
  const debug = await browser.api('return (await chrome.runtime.sendMessage({type:"GET_TRANSLATION_DEBUG"})).data;');
  assert.equal(debug.activeCount, 0); assert.equal(debug.queuedCount, 0);
  const report = { browser: target.kind, calls, abortedRequests: closed, timedOut,
    checks: ['page deadline', 'network abort', 'retry', '35-second response', 'settings change', 'reader navigation', 'empty queue'] };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (browser) {
    console.error(JSON.stringify(await browser.evaluate('return {status:document.querySelector("#statusToast")?.textContent,prompts:[...document.querySelectorAll(".translation-prompt")].map(e=>e.textContent)};')));
    await browser.capture('failure.png').catch(() => {});
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
