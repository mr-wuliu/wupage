import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget(), firefox = target.kind === 'firefox', baseline = process.argv.includes('--baseline');
const output = path.join(root, '.npm-cache/profile-layout', target.kind);
const calls = [], checks = [];
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Profile layout regression</title><style>
  body{margin:24px;font:16px/1.5 Arial;color:#222}main{max-width:1000px;margin:auto}
  ol{padding:0;margin:0;list-style:none}.list{display:flex;flex-wrap:wrap;gap:16px}.list>li{display:flex;width:calc(50% - 8px)}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.grid>li{display:grid}
  .card{box-sizing:border-box;display:flex;width:100%;border:1px solid #aaa;border-radius:6px;padding:16px}
  .content{display:flex;flex-direction:column;min-width:0;width:100%}.heading{display:flex;justify-content:space-between;gap:12px}
  .heading a{font-weight:600;color:#06c}.badge{border:1px solid #bbb;border-radius:12px;padding:0 6px;font-size:12px}
  .description{font-size:14px;margin:8px 0 16px}.metadata{margin-top:auto;font-size:12px}.metadata a{margin-left:12px}
  .counter{display:inline-block}
  @media(max-width:700px){.list>li{width:100%}.grid{grid-template-columns:1fr}}
  </style><body><main><h1>Project collections</h1>${['list','grid'].map(layout => `<ol class="${layout}">${[1,2].map(i => `
  <li data-layout-slot><div class="card" data-layout-card><div class="content"><div class="heading">
    <span><a href="/project/${layout}-${i}">Project <em>${layout} ${i}</em></a></span><span class="badge">Public</span></div>
    <p class="description" data-description>A complete <strong>${layout} project ${i} description</strong> with useful details for readers.</p>
    <p class="metadata">Community project <a href="/stats/${layout}-${i}"><svg width="16" height="16"></svg><span>View statistics</span></a>
      <a class="counter" href="/count/${layout}-${i}"><svg width="16" height="16"></svg>160</a></p>
  </div></div></li>`).join('')}</ol>`).join('<h2>More projects</h2>')}</main></body></html>`;
const segments = () => calls.flatMap(text => text.includes('⟪WUPAGESEGMENT')
  ? text.split(/⟪WUPAGESEGMENT\d+⟫\n/).slice(1).map(text => text.trim()) : [text]);
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixture); return; }
  let body = ''; for await (const part of request) body += part;
  const payload = JSON.parse(body); calls.push(...payload.texts);
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translations: payload.texts.map(text =>
    text.includes('⟪WUPAGESEGMENT') ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\n)/g, '$1译文：') : `译文：${text}`) }));
});
await new Promise(resolve => server.listen(0, resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const waitFor = async (read, test, label) => {
  const until = Date.now() + 30000; let value;
  do { value = await read(); if (test(value)) return value; await delay(100); } while (Date.now() < until);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
let browser;
try {
  browser = await openExtensionBrowser(root, output, firefox);
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const runtime = async request => {
    const response = await browser.api('return chrome.runtime.sendMessage(input[0]);', [request]);
    assert.equal(response?.ok, true, JSON.stringify(response)); return response.data;
  };
  const settings = await runtime({ type: 'GET_SETTINGS' });
  settings.providers.push({ id: 'layout-test', type: 'http-template', label: 'Layout test', method: 'POST', url: `http://127.0.0.1:${server.address().port}/translate`,
    headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
  Object.assign(settings, { activeProviderId: 'layout-test', sourceLang: 'en', targetLang: 'zh-CN', translationDisplayMode: 'bilingual', cacheEnabled: false });
  await runtime({ type: 'SAVE_SETTINGS', settings });
  let url;
  const inspect = () => browser.evaluate(`return [...document.querySelectorAll('[data-layout-card],.pinned-item-list-item')].map(card=>{
    const box=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};
    const description=card.querySelector('[data-description],.pinned-item-desc');
    return {html:card.outerHTML,box:box(card),description:description?.textContent,
      descriptionTargets:description?[description,...description.querySelectorAll('[data-wupage-translated]')].filter(e=>e.getAttribute('data-wupage-translated')==='true').length:0,
      numbers:[...card.querySelectorAll('.counter,.pinned-item-meta')].map(e=>e.textContent.trim()),
      outside:card.parentElement.querySelectorAll(':scope > .wupage-translation').length,
      children:[...card.children].map(e=>({tag:e.tagName,cls:e.className,box:box(e),text:e.textContent})),
      translations:[...card.querySelectorAll('.wupage-translation')].map(e=>({text:e.textContent,parent:e.parentElement.className,box:box(e)}))};});`);
  const send = async type => {
    const result = await browser.api(`const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);return chrome.tabs.sendMessage(tab.id,{type:input[1]},{frameId:0});`, [url, type]);
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  const reports = [];
  for (const live of process.argv.includes('--live') ? [false, true] : [false]) {
    url = live ? 'https://github.com/termdock' : origin + '/fixture';
    await browser.navigate(url);
    await waitFor(() => browser.evaluate('return !!document.querySelector("#wupage-floating-ball")'), Boolean, 'content runtime');
    await waitFor(inspect, cards => cards.length >= (live ? 3 : 4), 'profile cards');
    const label = live ? 'github' : 'fixture';
    await browser.evaluate(`const w=window.wrappedJSObject||window;w.profileOriginal=[...document.querySelectorAll('[data-layout-slot],.pinned-item-list-item')].map(e=>({e,html:e.innerHTML,nodes:[...e.querySelectorAll('*')]}));`);
    for (const width of baseline ? [1400] : [1400, 680]) {
      await send('CLEAR_TRANSLATION'); await browser.resize(width, 1100); await delay(300);
      const before = await inspect(); await browser.capture(`${label}-${width}-before.png`);
      const start = calls.length;
      await send('TRANSLATE_PAGE'); await delay(1000);
      let after = await inspect();
      await browser.capture(`${baseline ? 'baseline-' : ''}${label}-${width}-bilingual.png`);
      if (!baseline) {
        const callCount = calls.length;
        for (const mode of ['bilingual','bilingual-accent','replace']) {
          settings.translationDisplayMode = mode; await runtime({ type: 'SAVE_SETTINGS', settings });
          await waitFor(() => browser.evaluate(`return [...document.querySelectorAll('.wupage-translation')].every(e=>e.dataset.wupageDisplayMode===${JSON.stringify(mode)})`), Boolean, mode);
          after = await inspect();
          assert.equal(after.length, before.length);
          for (let i = 0; i < after.length; i++) {
            const original = before[i], card = after[i];
            assert.ok(Math.abs(card.box.width - original.box.width) < 1, `${label}/${width}/${mode}: card ${i} keeps width`);
            assert.equal(card.outside, 0, 'no extra translation cell next to card');
            assert.deepEqual(card.numbers, original.numbers, 'numeric statistics remain beside their own icons');
            for (const text of card.translations) {
              assert.ok(text.box.x >= card.box.x - 1 && text.box.x + text.box.width <= card.box.x + card.box.width + 1, 'translation stays inside card');
            }
            const description = original.description.trim();
            if (description) assert.equal(card.descriptionTargets, 1, 'description translated exactly once inside card');
          }
          await browser.capture(`${label}-${width}-${mode}.png`);
        }
        if (!live) assert.equal(calls.length, callCount, 'modes reuse results');
        const requested = segments();
        for (const card of before) {
          const description = card.description.trim().replace(/\s+/g,' ');
          if (description) assert.ok(!requested.some(text => text.includes(description) && text.includes('Public')), 'no aggregate card request');
        }
        await send('CLEAR_TRANSLATION');
        const restored = await browser.evaluate(`const w=window.wrappedJSObject||window;return w.profileOriginal.every(({e,html,nodes})=>{
          const source=e.cloneNode(true);source.querySelectorAll('[data-wupage-prose-source]').forEach(boundary=>boundary.replaceWith(...boundary.childNodes));
          return source.innerHTML===html&&nodes.every(n=>n.isConnected);});`);
        assert.equal(restored,true,'original card content, attributes and nodes retained after hiding cached translations');
        settings.translationDisplayMode = 'bilingual'; await runtime({ type: 'SAVE_SETTINGS', settings });
        checks.push(`${label}, ${width}px: card widths, text containment, one description, three modes, original DOM restoration`);
      }
      reports.push({ label, width, before, after, calls: calls.slice(start) });
    }
  }
  await fs.writeFile(path.join(output, baseline ? 'baseline.json' : 'report.json'), JSON.stringify({ ...identity, checks, reports }, null, 2));
  console.log(JSON.stringify({ ...identity, baseline, checks, output }, null, 2));
} finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
