// Real extension and isolated profiles. All translation requests stay local.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/structured-translation', target.kind);
const reports = [], requests = [];
const paragraph = '先读⟪WUPAGEOPEN1⟫详情⟪WUPAGECLOSE1⟫，再读⟪WUPAGEOPEN0⟫完整指南⟪WUPAGECLOSE0⟫。';
const translate = text => text.replace(/Read ⟪WUPAGEOPEN0⟫the complete guide⟪WUPAGECLOSE0⟫ and ⟪WUPAGEOPEN1⟫the details⟪WUPAGECLOSE1⟫ now\./gu, paragraph)
  .replaceAll('Cancel submission', '取消提交').replaceAll('Review update', '审核更新').replaceAll('Update', '更新')
  .replaceAll('Closed component content.', '封闭组件内容。').replaceAll('Translation structure', '翻译结构验证');
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Translation structure</title>
<style>body{font:16px/1.6 'Segoe UI',sans-serif;margin:24px;color:#161616}main{max-width:900px;margin:auto}section{border:1px solid #ddd;padding:20px;margin:20px 0}
.actions{display:flex;flex-wrap:wrap;gap:12px}custom-action{display:inline-flex}custom-action.primary{color:white}unrecognized-action{display:inline-block;border:1px solid #888;padding:8px 14px}h1{font-size:24px}</style></head>
<body><main><h1>Translation structure</h1><section class="actions"><custom-action class="primary">Update</custom-action>
<custom-action closed>Cancel submission</custom-action><custom-action named><span slot="label">Cancel submission</span><span slot="start" aria-hidden="true">×</span></custom-action>
<unrecognized-action>Update</unrecognized-action></section><section><p id="prose">Read <strong id="bold">the complete guide</strong> and <a id="detail" href="#detail">the details</a> now.</p></section>
<section><closed-card></closed-card></section></main><script>
customElements.define('custom-action',class extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:this.hasAttribute('closed')?'closed':'open'});
root.innerHTML='<style>:host{font:inherit}button{font:inherit;color:inherit;min-height:40px;padding:8px 14px;border:1px solid #888;background:white;border-radius:2px}:host(.primary) button{background:#0078d4;border-color:#0078d4}</style><button type="button"><slot name="start"></slot>'+(this.hasAttribute('named')?'<slot name="label"></slot>':'<slot></slot>')+'</button>';
this.fixtureRoot=root;root.querySelector('button').addEventListener('click',()=>this.dataset.clicks=String(Number(this.dataset.clicks||0)+1));}});
customElements.define('closed-card',class extends HTMLElement{constructor(){super();this.fixtureRoot=this.attachShadow({mode:'closed'});this.fixtureRoot.innerHTML='<p>Closed component content.</p>';}});
const hosts=[...document.querySelectorAll('custom-action,unrecognized-action')],link=document.querySelector('#detail');
window.fixture={hosts,texts:hosts.map(host=>(host.querySelector('[slot="label"]')||host).firstChild),link,bold:document.querySelector('#bold'),closed:document.querySelector('closed-card').fixtureRoot};
link.addEventListener('click',event=>{event.preventDefault();link.dataset.clicks=String(Number(link.dataset.clicks||0)+1);});
</script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixture); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  const { texts } = JSON.parse(body); requests.push(...texts);
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ translations: texts.map(translate) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser, url;
async function until(check, label) {
  for (let i = 0; i < 180; i++) { try { if (await check()) return; } catch {} await delay(80); }
  throw new Error('Timed out: ' + label);
}
async function runtime(request) {
  const response = await browser.api('return chrome.runtime.sendMessage(input[0]);', [request]);
  assert.equal(response.ok, true, JSON.stringify(response)); return response.data;
}
async function send(type) {
  const response = await browser.api(`const tab=(await chrome.tabs.query({})).find(tab=>tab.url===input[0]);return chrome.tabs.sendMessage(tab.id,{type:input[1]},{frameId:0});`, [url, type]);
  assert.equal(response.ok, true, JSON.stringify(response)); return response.data;
}
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const settings = await runtime({ type: 'GET_SETTINGS' });
  Object.assign(settings, { activeProviderId: 'http-template', sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false });
  Object.assign(settings.providers.find(provider => provider.id === 'http-template'), { enabled: true, url: origin + '/translate', method: 'POST',
    headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
  await runtime({ type: 'SAVE_SETTINGS', settings });
  for (const width of [1200, 390]) {
    await browser.resize(width, 1000);
    for (const mode of ['replace', 'bilingual', 'bilingual-accent']) {
      settings.translationDisplayMode = mode; await runtime({ type: 'SAVE_SETTINGS', settings });
      url = origin + '/' + width + '-' + mode; await browser.navigate(url);
      await until(async () => { await send('GET_TRANSLATION_STATE'); return true; }, 'extension ready');
      const original = await browser.evaluate('return document.querySelector("main").innerHTML;');
      await send('TRANSLATE_PAGE');
      const inspect = `const w=window.wrappedJSObject||window,f=w.fixture;return {labels:f.hosts.map(host=>(host.querySelector('.wupage-translation:not(.wupage-translation-pending)')?.textContent)||((host.querySelector('[slot="label"]')||host).textContent)),
        closed:f.closed.querySelector('p').textContent,prose:document.querySelector('#prose').textContent,
        translatedProse:document.querySelector('#prose + .wupage-translation')?.textContent||document.querySelector('#prose .wupage-translation')?.textContent||document.querySelector('#prose').textContent,
        sameNodes:f.hosts.every((host,index)=>(host.querySelector('[slot="label"]')||host).firstChild.isSameNode(f.texts[index])),
        sameLink:document.querySelector('#detail').isSameNode(f.link),sameBold:document.querySelector('#bold').isSameNode(f.bold),
        outside:document.querySelectorAll('.actions>.wupage-translation').length,markers:document.querySelector('main').textContent.includes('WUPAGE'),
        inside:f.hosts.every(host=>{const label=host.querySelector('.wupage-translation');if(!label||!host.fixtureRoot)return true;const a=label.getBoundingClientRect(),b=host.fixtureRoot.querySelector('button').getBoundingClientRect();return a.left>=b.left-1&&a.right<=b.right+1&&a.top>=b.top-1&&a.bottom<=b.bottom+1;})};`;
      await until(async () => { const value = await browser.evaluate(inspect); return value.labels.every(text => /更新|取消提交/u.test(text)) && value.closed.includes('封闭组件内容。') && value.translatedProse.includes('先读详情，再读完整指南。'); }, 'all components translated');
      let value = await browser.evaluate(inspect);
      assert.deepEqual(value.labels, ['更新', '取消提交', '取消提交', '更新']);
      assert.ok(value.sameNodes && value.sameLink && value.sameBold && value.inside && !value.outside && !value.markers, JSON.stringify(value));
      assert.ok(value.translatedProse.includes('先读详情，再读完整指南。'), JSON.stringify(value));
      if (mode === 'replace') assert.equal(value.prose, '先读详情，再读完整指南。');
      await browser.evaluate(`const f=(window.wrappedJSObject||window).fixture;f.link.click();f.hosts.filter(host=>host.fixtureRoot).forEach(host=>host.fixtureRoot.querySelector('button').click());`);
      assert.equal(await browser.evaluate(`const f=(window.wrappedJSObject||window).fixture;return f.link.dataset.clicks==='1'&&f.hosts.filter(host=>host.fixtureRoot).every(host=>host.dataset.clicks==='1');`), true);
      await browser.evaluate(`const f=(window.wrappedJSObject||window).fixture;f.link.removeAttribute('data-clicks');f.hosts.forEach(host=>host.removeAttribute('data-clicks'));`);
      await delay(500); const count = requests.length; await delay(500);
      assert.equal(requests.length, count, 'own structured writes must settle');
      await browser.capture(width + '-' + mode + '.png');
      await send('CLEAR_TRANSLATION');
      assert.equal(await browser.evaluate('return document.querySelector("main").innerHTML;'), original, 'exact source restoration');
      reports.push({ requestedWidth: width, viewportWidth: await browser.evaluate('return innerWidth;'), mode,
        components: 4, closedRoots: true, inlineOrderAndIdentity: true, clickHandlers: true, exactRestoration: true });
    }
  }
  await send('TRANSLATE_PAGE');
  await browser.evaluate(`(window.wrappedJSObject||window).fixture.hosts[3].firstChild.data='Review update';`);
  await until(() => browser.evaluate(`return (window.wrappedJSObject||window).fixture.hosts[3].querySelector('.wupage-translation:not(.wupage-translation-pending)')?.textContent==='审核更新';`), 'real host edit');
  await send('CLEAR_TRANSLATION');
  assert.equal(await browser.evaluate(`return (window.wrappedJSObject||window).fixture.hosts[3].textContent;`), 'Review update');
  const result = { passed: true, ...identity, reports, dynamicEditRestoration: true, requests: requests.length };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
