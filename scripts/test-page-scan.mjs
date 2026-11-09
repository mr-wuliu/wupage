// Real extension regression for scan scheduling; all translation stays on localhost.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openExtensionBrowser } from './lib/extension-browser.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const firefox = process.argv.includes('--firefox');
const target = firefox ? 'firefox' : process.argv.includes('--edge') ? 'edge' : 'chrome';
const output = path.join(root, '.npm-cache', `page-scan-${target}`);
const contentSha256 = createHash('sha256').update(await fs.readFile(path.join(root, firefox ? 'dist-firefox' : 'dist', 'content.js'))).digest('hex');
const requests = [];
const rawRequests = [];
function segmentSources(text) {
  const parts = text.split(/⟪WUPAGESEGMENT\d+⟫\s*\n/);
  return parts.length > 1 ? parts.slice(1).map(part => part.trim()) : [text];
}
const server = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const { texts } = JSON.parse(body); rawRequests.push(...texts); requests.push(...texts.flatMap(segmentSources));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ translations: texts.map(text => text.includes("WUPAGESEGMENT") ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\s*\n)/g, "$1译文：") : `译文：${text}`) }));
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const overflow = url.pathname === '/overflow';
  const sections = Number(url.searchParams.get('sections') || 400);
  const content = overflow
    ? Array.from({ length: 4096 }, (_, index) => `<p class="hidden">Hidden source ${index}.</p>`).join('')
      + '<p id="tail-one">Visible overflow paragraph one.</p><p id="tail-two">Visible overflow paragraph two.</p>'
    : Array.from({ length: sections }, (_, index) => `<section><h2>Section ${index}</h2><p>Read the <em>complete article</em> for section ${index} before deciding what to do next.</p><p>Additional readable content for section ${index}.</p><ul><li>First item ${index}.</li><li>Second item ${index}.</li></ul></section>`).join('');
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Scan regression</title><style id="fixture-style">body{margin:24px;font:16px/1.5 Arial}main{max-width:800px}section{margin-bottom:24px}.hidden{display:none}#overlay{position:fixed;inset:0;background:white;z-index:999999}</style></head><body><main>${content}</main>${overflow ? '<div id="overlay"></div>' : ''}<script>
    document.documentElement.dataset.scanTasks='[]';document.documentElement.dataset.scanStart='0';
    if(PerformanceObserver.supportedEntryTypes?.includes('longtask'))new PerformanceObserver(list=>{const root=document.documentElement;const tasks=JSON.parse(root.dataset.scanTasks||'[]');tasks.push(...list.getEntries().map(entry=>({start:entry.startTime,duration:entry.duration})));root.dataset.scanTasks=JSON.stringify(tasks)}).observe({type:'longtask'});
  </script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const reports = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function action(type, includeProgress = false) {
  return browser.api(`const tab=(await chrome.tabs.query({})).find(tab=>tab.url?.startsWith(input[0]+'/'));return chrome.tabs.sendMessage(tab.id,input[1]);`,
    [origin, { type, ...(includeProgress ? { includeProgress: true } : {}) }]);
}
async function waitFor(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(60); }
  throw new Error(`Timed out: ${description}`);
}
async function open(url) {
  await browser.navigate(origin + url);
  await waitFor(async () => { try { return (await action('GET_TRANSLATION_STATE')).ok; } catch { return false; } }, 'extension ready');
  await pause(150);
}
async function waitForInitialTranslation(minimumTranslated) {
  // A large initial scan may acknowledge the action while it is still working.
  await waitFor(async () => {
    const response = await action('GET_TRANSLATION_STATE', true);
    assert.ok(response.ok, JSON.stringify(response));
    const state = response.data.progress;
    assert.ok(!state.error && !state.failed, JSON.stringify(state));
    return state.active && !state.pending && state.translated >= minimumTranslated;
  }, 'initial translation settled');
}
async function mark() { await browser.evaluate('document.documentElement.dataset.scanStart=String(performance.now());document.documentElement.dataset.scanTasks="[]";'); }
async function metrics() {
  await pause(80);
  return browser.evaluate(`const root=document.documentElement;const tasks=JSON.parse(root.dataset.scanTasks||'[]').filter(task=>task.start>=Number(root.dataset.scanStart||0));return {supported:PerformanceObserver.supportedEntryTypes?.includes('longtask')||false,longest:Math.max(0,...tasks.map(task=>task.duration)),longTasks:tasks.length};`);
}
try {
  browser = await openExtensionBrowser(root, output, firefox);
  await browser.api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    settings.activeProviderId='http-template';settings.cacheEnabled=false;settings.floatingBallEnabled=false;settings.autoTranslation.enabled=false;settings.translationDisplayMode='bilingual';
    Object.assign(settings.providers.find(provider=>provider.id==='http-template'),{url:input[0]+'/translate',method:'POST',headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
    const saved=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});if(!saved.ok)throw new Error(saved.error);`, [origin]);
  let calibrated = false;
  for (const sections of [400, 800]) {
    await open('/long?sections=' + sections);
    if (!calibrated && await browser.evaluate("return PerformanceObserver.supportedEntryTypes?.includes('longtask') || false;")) {
      await mark();
      await browser.evaluate('setTimeout(()=>{const until=performance.now()+80;while(performance.now()<until){}document.documentElement.dataset.calibrated="yes"},0);');
      await waitFor(() => browser.evaluate('return document.documentElement.dataset.calibrated === "yes";'), 'long-task calibration');
      const calibration = await metrics();
      assert.ok(calibration.longest >= 50, 'long-task observation must detect the calibration task');
      reports.push({ scenario: 'long-task observation calibration', metrics: calibration });
      calibrated = true;
    }
    await mark();
    const result = await action('TRANSLATE_PAGE'); assert.equal(result.ok, true, JSON.stringify(result));
    await waitForInitialTranslation(1);
    const initial = await metrics();
    // A hard ceiling catches a return to multi-second synchronous scans. These
    // measurements include layout and translation rendering, not just scanning.
    assert.ok(initial.longest < 500, `Long document task exceeded 500 ms: ${JSON.stringify(initial)}`);
    await mark();
    const before = await browser.evaluate('return document.querySelectorAll(".wupage-translation").length;');
    for (let step = 0; step < 8; step++) {
      await browser.evaluate('window.scrollBy(0,450);'); await pause(140);
    }
    await waitFor(async () => await browser.evaluate('return document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)").length;') > before, 'translations after scrolling');
    reports.push({ scenario: 'long document', sections, initial, afterScroll: await metrics() });
  }
  await open('/overflow'); const before = requests.length;
  const result = await action('TRANSLATE_PAGE'); assert.equal(result.ok, true);
  await waitForInitialTranslation(0);
  assert.equal(requests.length, before, 'hidden source must never reach the provider');
  await mark();
  await browser.evaluate(`document.querySelector('#fixture-style').sheet.insertRule('#overlay{display:none}',1);window.dispatchEvent(new Event('scroll'));`);
  await waitFor(async () => await browser.evaluate('return document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)").length;') === 2, 'overflow after one scroll');
  assert.deepEqual(requests.slice(before).sort(), ['Visible overflow paragraph one.', 'Visible overflow paragraph two.']);
  assert.equal(rawRequests.some(text => text.includes('Hidden source ')), false, 'hidden content must stay out of context and source');
  const overflow = await metrics(); assert.ok(overflow.longest < 500, JSON.stringify(overflow));
  reports.push({ scenario: '4096 hidden roots and a collapsed overflow root', metrics: overflow });
  await open('/long?sections=800');
  await browser.api(`const tab=(await chrome.tabs.query({})).find(tab=>tab.url?.startsWith(input[0]+'/'));
    const started=chrome.tabs.sendMessage(tab.id,{type:'TRANSLATE_PAGE'});
    await new Promise(resolve=>setTimeout(resolve,5));await chrome.tabs.sendMessage(tab.id,{type:'CLEAR_TRANSLATION'});await started;`, [origin]);
  await pause(300);
  const stopped = await action('GET_TRANSLATION_STATE'); assert.equal(stopped.data.translated, false, JSON.stringify(stopped));
  assert.equal(await browser.evaluate('return document.querySelectorAll(".wupage-translation").length;'), 0);
  reports.push({ scenario: 'stop during initial scan', active: false });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ target, contentSha256, reports }, null, 2));
  process.stdout.write(JSON.stringify({ target, contentSha256, reports }) + '\n');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
