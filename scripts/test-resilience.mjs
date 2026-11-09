// Real extension, isolated profiles, local fixtures; no external translation calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
const output = path.join(root, '.npm-cache/resilience', target.kind);
const calls = [], checks = [];
let behavior = 'normal', bodyCancelled = false;
let slowResponse = Promise.resolve(), releaseSlow = () => {};
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Resilience regression</title>
  <style>body{font:16px/1.5 sans-serif;margin:20px}main{max-width:680px}button{min-height:32px}pre{white-space:pre-wrap}</style>
  </head><body><main><p id="prose">Install <span translate="no">PrivateProduct</span> before continuing.</p>
  <p id="formula">Use <math><mi>alpha</mi><mo>+</mo><mi>beta</mi></math> to continue.</p>
  <p id="code">Read <code>oldName()</code> carefully.</p>
  <p class="notranslate">Private opted-out paragraph.</p><svg width="180" height="30"><text y="20">Diagram label</text></svg>
  <div contenteditable="plaintext-only"><pre><code>// Unsent private draft</code></pre></div>
  <input translate="no" placeholder="Private placeholder"><button id="action">Continue reading</button></main>
  <script nonce="resilience-fixture">document.querySelector('#action').addEventListener('click',()=>{document.documentElement.dataset.clicks=String(Number(document.documentElement.dataset.clicks||0)+1)})</script>
  </body></html>`;
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST') {
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      if (request.url === '/trusted-types') headers['Content-Security-Policy'] = "script-src 'nonce-resilience-fixture'; require-trusted-types-for 'script'; trusted-types 'none'";
      if (request.url === '/rejected-input') {
        response.writeHead(200, headers).end('<!doctype html><main><p>Only this fixture paragraph is rejected by the service.</p></main>');
        return;
      }
      if (request.url === '/automatic-component') {
        response.writeHead(200, headers).end(`<!doctype html><main><div id="component"></div></main>
          <script>document.querySelector('#component').attachShadow({mode:'open'});</script>`);
        return;
      }
      if (request.url === '/visible-layouts') {
        response.writeHead(200, headers).end(`<!doctype html><main>
          <div id="boxless" style="display:contents">Visible prose without an element box.</div>
          <section style="visibility:hidden"><p id="override" style="visibility:visible">Visible prose with a visibility override.</p></section>
          <div id="bare"></div>
          <iframe title="Embedded prose" srcdoc='<div style="display:contents">Visible boxless prose inside a frame.</div>'></iframe>
          </main><div style="position:fixed;inset:0;z-index:100;background:transparent"></div>
          <script>window.fixtureText=document.createTextNode('Visible prose directly inside a shadow root.');
          document.querySelector('#bare').attachShadow({mode:'open'}).append(window.fixtureText);</script>`);
        return;
      }
      if (request.url === '/selectable-translation') {
        response.writeHead(200, headers).end(`<!doctype html><meta charset="utf-8">
          <style>body{font:20px/1.6 sans-serif;margin:24px}main{max-width:680px}
          #restricted{-webkit-user-select:none;user-select:none}</style>
          <main><p id="plain">These selectable words are in a complete sentence.</p>
          <p id="restricted">Read the selectable words in this paragraph too.</p>
          <p id="rich">Keep <strong>selectable formatting</strong> around the <a href="#destination">original link</a> in a longer sentence.</p>
          <button id="native">Continue reading</button></main>
          <script>const button=document.querySelector('#native');button.addEventListener('click',event=>{
          if(event.target===button)button.dataset.clicked='true';});</script>`);
        return;
      }
      response.writeHead(200, headers).end(fixture); return;
    }
    let body = ''; for await (const part of request) body += part;
    const data = JSON.parse(JSON.parse(body).messages.at(-1).content);
    calls.push(data);
    if (behavior === 'limited') { response.writeHead(429, { 'Retry-After': '3600' }).end('Local test rate limit'); return; }
    if (data.texts.some(text => text.includes('Only this fixture paragraph is rejected'))) {
      response.writeHead(413).end('Rejected fixture input'); return;
    }
    if (behavior === 'slow') await slowResponse;
    response.writeHead(200, { 'content-type': 'application/json' });
    if (behavior === 'stalled') {
      response.flushHeaders(); response.write('{"choices":[');
      response.on('close', () => { bodyCancelled = true; }); return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data.texts.map(text => `译文：${text}`)) } }] }));
  } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const waitFor = async (read, test, label) => {
  const until = Date.now() + 15000; let value;
  do { value = await read(); if (test(value)) return value; await delay(80); } while (Date.now() < until);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
let browser, currentUrl;
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const runtime = async request => {
    const response = await browser.api('return chrome.runtime.sendMessage(input[0]);', [request]);
    assert.equal(response?.ok, true, JSON.stringify(response)); return response.data;
  };
  const send = async (request, url = currentUrl) => {
    const response = await browser.api('const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);return chrome.tabs.sendMessage(tab.id,input[1],{frameId:0});', [url, request]);
    assert.equal(response?.ok, true, JSON.stringify(response)); return response.data;
  };
  const settings = await runtime({ type: 'GET_SETTINGS' });
  settings.providers.push({ id: 'resilience-test', type: 'deepseek', label: 'Local resilience test',
    baseURL: `${origin}/v1`, apiKey: 'test-only', model: 'test', systemPrompt: 'Translate.' });
  Object.assign(settings, { activeProviderId: 'resilience-test', sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false });
  await runtime({ type: 'SAVE_SETTINGS', settings });
  const open = async suffix => {
    currentUrl = `${origin}/${suffix}`; await browser.navigate(currentUrl);
    await waitFor(() => browser.evaluate('return !!document.querySelector("#wupage-floating-ball");'), Boolean, 'content initialization');
  };
  const inspect = () => browser.evaluate(`return {translations:document.querySelectorAll('.wupage-translation:not(.wupage-translation-pending)').length
      + ((document.querySelector('#action')?.textContent||'').startsWith('译文：')&&!document.querySelector('#action .wupage-translation')?1:0),
    math:document.querySelectorAll('.wupage-translation math').length,
    hidden:document.querySelectorAll('.wupage-replaced-source').length,
    text:document.querySelector('main')?.textContent,bodyWidth:document.documentElement.scrollWidth,viewport:innerWidth};`);
  for (const width of [1200, 390]) {
    await browser.resize(width, 900);
    for (const mode of ['bilingual', 'bilingual-accent', 'replace']) {
      settings.translationDisplayMode = mode; await runtime({ type: 'SAVE_SETTINGS', settings });
      await open(`${width}-${mode}`);
      // Screenshot engines temporarily set caret styles on editors/inputs and
      // may leave an empty style attribute. Establish that baseline first.
      await browser.capture(`${width}-${mode}-original.png`);
      const original = await browser.evaluate('return document.querySelector("main").innerHTML;');
      const start = calls.length;
      await send({ type: 'TRANSLATE_PAGE' });
      const state = await waitFor(inspect, value => value.translations >= 4, 'translated fixture');
      assert.equal(state.math, 1, 'MathML retained');
      assert.ok(state.bodyWidth <= state.viewport + 1, 'no horizontal page overflow');
      const sent = JSON.stringify(calls.slice(start));
      for (const excluded of ['PrivateProduct', 'Private opted-out', 'Unsent private draft', 'Diagram label', 'Private placeholder']) {
        assert.ok(!sent.includes(excluded), `excluded source/context: ${excluded}`);
      }
      await browser.evaluate('document.querySelector("#action").click();');
      assert.equal(await browser.evaluate('return document.documentElement.dataset.clicks;'), '1', 'original control still works');
      await browser.capture(`${width}-${mode}.png`);
      await send({ type: 'CLEAR_TRANSLATION' });
      assert.equal(await browser.evaluate('return document.querySelector("main").innerHTML;'), original, 'exact source restoration');
      checks.push(`${width}px ${mode}: protected text/math, draft exclusion, controls, width, restoration`);
    }
  }

  await open('trusted-types'); await send({ type: 'TRANSLATE_PAGE' });
  await waitFor(inspect, value => value.translations >= 4, 'CSP/Trusted Types translation');
  await send({ type: 'CLEAR_TRANSLATION' });
  assert.equal((await inspect()).hidden, 0);
  checks.push('strict script CSP and Trusted Types policy');

  for (const mode of ['bilingual', 'bilingual-accent', 'replace']) {
    settings.translationDisplayMode = mode; await runtime({ type: 'SAVE_SETTINGS', settings });
    await open(`components-${mode}`);
    const componentOriginal = await browser.evaluate(`document.querySelector('main').innerHTML='<article-card></article-card>';
      const root=document.querySelector('article-card').attachShadow({mode:'open'});
      root.innerHTML='<style>:host{display:block}article{max-width:320px}span{position:relative}</style><article><p>Component paragraph with <code>guide()</code>.</p><nested-card></nested-card><input placeholder="Search components"><button>Keep original control</button></article>';
      root.querySelector('button').addEventListener('click',()=>document.documentElement.dataset.componentClicks='1');
      const nested=root.querySelector('nested-card').attachShadow({mode:'open'});
      nested.innerHTML='<p>Nested component paragraph.</p><div contenteditable="plaintext-only"><p>Private nested draft.</p></div>';
      return [root.querySelector('article').innerHTML,nested.innerHTML];`);
    const first = calls.length;
    await send({ type: 'TRANSLATE_PAGE' });
    await waitFor(() => browser.evaluate(`const r=document.querySelector('article-card').shadowRoot;return {
      text:r.querySelector('.wupage-translation')?.textContent,nested:r.querySelector('nested-card').shadowRoot.querySelector('.wupage-translation')?.textContent,
      width:document.documentElement.scrollWidth,viewport:innerWidth};`), value => value.nested?.startsWith('译文：'), 'nested component translation');
    assert.ok(!JSON.stringify(calls.slice(first)).includes('Private nested draft'), 'component editor excluded');
    await browser.evaluate(`const root=document.querySelector('article-card').shadowRoot;root.querySelector('button').click();root.querySelector('#wupage-translation-style').remove();document.querySelector('#wupage-translation-style').textContent='';`);
    await waitFor(() => browser.evaluate(`return !!document.querySelector('article-card').shadowRoot.querySelector('#wupage-translation-style') && document.querySelector('#wupage-translation-style').textContent.length>100;`), Boolean, 'styles repaired in document and component');
    assert.equal(await browser.evaluate('return document.documentElement.dataset.componentClicks;'), '1');
    assert.equal(await browser.evaluate('return document.documentElement.scrollWidth<=innerWidth+1;'), true, 'component width stable');
    await send({ type: 'CLEAR_TRANSLATION' });
    assert.deepEqual(await browser.evaluate(`const r=document.querySelector('article-card').shadowRoot;const n=r.querySelector('nested-card').shadowRoot;
      return [r.querySelector('article').innerHTML, [...n.children].filter(e=>e.id!=='wupage-translation-style').map(e=>e.outerHTML).join('')];`), componentOriginal);
    checks.push(`open nested components ${mode}: styles, width, privacy, controls and exact restoration`);
  }

  await open('hidden-output');
  await browser.evaluate(`document.querySelector('main').innerHTML='<p>Keep source visible under hostile CSS.</p>';const s=document.createElement('style');s.textContent='.wupage-translation{display:none!important}';document.head.append(s);`);
  await send({ type: 'TRANSLATE_PAGE' });
  assert.equal(await browser.evaluate('return document.querySelector("main").textContent;'), 'Keep source visible under hostile CSS.');
  await send({ type: 'CLEAR_TRANSLATION' });
  checks.push('site CSS hiding replacement falls back to original');

  await open('dynamic'); await send({ type: 'TRANSLATE_PAGE' });
  await browser.evaluate('document.querySelector("#code > code").textContent="newName()";');
  await waitFor(() => browser.evaluate('return document.querySelector(".wupage-translation code")?.textContent;'), value => value === 'newName()', 'updated protected code');
  await browser.evaluate('document.body.innerHTML="<main><p>Replacement body paragraph.</p></main>";');
  await waitFor(inspect, value => value.text?.includes('译文：Replacement body paragraph.'), 'replacement body translation');
  await send({ type: 'CLEAR_TRANSLATION' });
  assert.equal((await inspect()).text, 'Replacement body paragraph.');
  checks.push('protected source mutations and entire body replacement');

  await open('virtualized-restore');
  const rowOriginal = await browser.evaluate(`document.querySelector('main').innerHTML='<section><p>Virtual row with <code>token()</code>.</p><input placeholder="Search rows"></section>';return document.querySelector('main').innerHTML;`);
  await send({ type: 'TRANSLATE_PAGE' });
  await browser.evaluate(`const parked=document.createElement('template');parked.id='parked-row';document.body.append(parked);parked.content.append(document.querySelector('main'));`);
  await send({ type: 'CLEAR_TRANSLATION' });
  assert.equal(await browser.evaluate(`const parked=document.querySelector('#parked-row');document.body.append(parked.content.firstChild);parked.remove();return document.querySelector('main').innerHTML;`), rowOriginal);
  checks.push('detached virtual rows retain original text after stopping and reinsertion');

  behavior = 'limited'; await open('rate-limited');
  await send({ type: 'TRANSLATE_PAGE' });
  const count = calls.length;
  await browser.evaluate('document.body.insertAdjacentHTML("beforeend","<p>New paragraph during cooldown.</p>");window.dispatchEvent(new Event("scroll"));');
  await delay(700); assert.equal(calls.length, count, 'paused provider receives no new calls');
  await send({ type: 'CLEAR_TRANSLATION' });
  assert.equal((await inspect()).hidden, 0, 'failure leaves originals available');
  behavior = 'normal'; await send({ type: 'TRANSLATE_PAGE' });
  await waitFor(inspect, value => value.translations >= 4, 'explicit retry');
  await send({ type: 'CLEAR_TRANSLATION' });
  checks.push('rate-limit pause, original restoration and explicit recovery');

  behavior = 'stalled'; bodyCancelled = false; await open('stalled-body');
  const before = calls.length;
  await browser.api('const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);void chrome.tabs.sendMessage(tab.id,{type:"TRANSLATE_PAGE"},{frameId:0}).catch(()=>{});return true;', [currentUrl]);
  await waitFor(async () => calls.length, value => value > before, 'stalled request');
  await delay(100); await send({ type: 'CLEAR_TRANSLATION' });
  await waitFor(async () => bodyCancelled, Boolean, 'network body cancellation');
  assert.equal((await inspect()).hidden, 0);
  behavior = 'normal'; await send({ type: 'TRANSLATE_PAGE' });
  await waitFor(inspect, value => value.translations >= 4, 'queue usable after body cancellation');
  checks.push('stalled response body cancelled; translation queue recovers');

  settings.translationDisplayMode = 'bilingual';
  await runtime({ type: 'SAVE_SETTINGS', settings });
  await open('visible-layouts');
  await send({ type: 'TRANSLATE_PAGE' });
  await waitFor(() => browser.evaluate(`return {
    boxless:document.querySelector('#boxless')?.textContent.includes('译文：'),
    override:document.querySelector('#override')?.textContent.includes('译文：'),
    shadow:(window.wrappedJSObject||window).fixtureText.nextSibling?.textContent.includes('译文：'),
    frame:document.querySelector('iframe')?.contentDocument?.body?.textContent.includes('译文：')
  };`), value => Object.values(value).every(Boolean), 'translation of visible layouts in the document, component and frame');
  await send({ type: 'CLEAR_TRANSLATION' });
  assert.equal(await browser.evaluate(`const source=(window.wrappedJSObject||window).fixtureText;
    return source.getRootNode()===source.ownerDocument.querySelector('#bare').shadowRoot
      && source.data==='Visible prose directly inside a shadow root.';`), true);
  checks.push('transparent pointer layer, visibility override, boxless text including a frame, and bare shadow text');

  await open('opaque-occlusion');
  await browser.evaluate(`document.querySelector('main').innerHTML='<p>Only revealed after the dialog closes.</p>';
    const holder=document.createElement('div'); holder.id='dialog-holder';
    holder.innerHTML='<div style="position:fixed;inset:0;z-index:100;background:white"></div>';document.body.append(holder);`);
  const beforeOverlay = calls.length;
  await send({ type: 'TRANSLATE_PAGE' });
  assert.equal(calls.length, beforeOverlay, 'opaque dialog still prevents covered text from being sent');
  await browser.evaluate('document.querySelector("#dialog-holder").replaceChildren();');
  await waitFor(inspect, value => value.text?.includes('译文：Only revealed'), 'revealed text translated without scrolling or resizing');
  checks.push('removal of an opaque overlay wakes covered text in another subtree');

  await open('healthy-tab');
  await send({ type: 'TRANSLATE_PAGE' });
  await waitFor(inspect, value => value.translations >= 4, 'healthy tab translating');
  const rejectedUrl = origin + '/rejected-input';
  const rejectedId = await browser.api('return (await chrome.tabs.create({url:input[0],active:false})).id;', [rejectedUrl]);
  await waitFor(() => send({ type: 'GET_TRANSLATION_STATE' }, rejectedUrl).catch(() => null), Boolean, 'second tab ready');
  const rejected = await send({ type: 'TRANSLATE_PAGE' }, rejectedUrl);
  assert.equal(rejected.errorCode, 'input-too-long');
  await browser.evaluate('document.querySelector("main").insertAdjacentHTML("beforeend","<p>New valid text in the healthy tab.</p>");');
  await waitFor(inspect, value => value.text?.includes('译文：New valid text'), 'healthy tab continues after the other input fails');
  await browser.api('await chrome.tabs.remove(input[0]);', [rejectedId]);
  checks.push('request rejection stays local to the affected batch');

  behavior = 'slow'; slowResponse = new Promise(resolve => { releaseSlow = resolve; });
  await open('slow-response');
  const progress = await send({ type: 'TRANSLATE_PAGE' });
  assert.ok(progress.pending > 0 && !progress.error, JSON.stringify(progress));
  assert.equal(await browser.evaluate('return getComputedStyle(document.querySelector(".wupage-translation-pending")).pointerEvents;'), 'none');
  releaseSlow(); behavior = 'normal';
  await waitFor(() => send({ type: 'GET_TRANSLATION_STATE', includeProgress: true }),
    result => result.progress?.translated > 0 && !result.progress.pending && !result.progress.error, 'completed slow request');
  checks.push('slow translation returns progress and later reports completion');

  async function selectText(selector, phrase) {
    const bounds = await browser.evaluate(`const element=document.querySelector(${JSON.stringify(selector)});
      const phrase=${JSON.stringify(phrase)};
      window.getSelection().removeAllRanges();
      const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
      let node;while(walker.nextNode())if(walker.currentNode.data.includes(phrase)){node=walker.currentNode;break;}
      const start=node.data.indexOf(phrase),range=document.createRange();
      const edge=(offset,fraction)=>{range.setStart(node,offset);range.setEnd(node,offset+1);
        const rect=range.getBoundingClientRect();return {x:rect.left+rect.width*fraction,y:rect.top+rect.height/2};};
      return [edge(start,0.15),edge(start+phrase.length-1,0.85)];`);
    await browser.pointer([{ type: 'move', ...bounds[0] }, { type: 'down' }, { type: 'move', ...bounds[1] }, { type: 'up' }]);
    assert.deepEqual(await browser.evaluate(`const element=document.querySelector(${JSON.stringify(selector)}),selection=window.getSelection();
      return {text:selection.toString(),inside:element.contains(selection.anchorNode)&&element.contains(selection.focusNode)};`),
      { text: phrase, inside: true }, selector);
  }
  for (const mode of ['replace', 'bilingual', 'bilingual-accent']) {
    settings.translationDisplayMode = mode; await runtime({ type: 'SAVE_SETTINGS', settings });
    await open('selectable-translation');
    const original = await browser.evaluate('return document.querySelector("main").innerHTML;');
    await send({ type: 'TRANSLATE_PAGE' });
    const plain = '#plain .wupage-translation:not(.wupage-translation-pending)';
    await waitFor(() => browser.evaluate(`return Boolean(document.querySelector(${JSON.stringify(plain)}));`), Boolean, 'plain translation');
    assert.equal(await browser.evaluate(`return getComputedStyle(document.querySelector(${JSON.stringify(plain)})).pointerEvents;`), 'auto');
    await selectText(plain, 'selectable words');
    await selectText('#restricted .wupage-translation:not(.wupage-translation-pending)', 'selectable words');
    await selectText(mode === 'replace' ? '#rich strong' : '#rich + .wupage-translation strong', 'selectable formatting');
    if (mode !== 'replace') {
      await selectText('#rich + .wupage-translation a', 'original link');
      const click = async selector => {
        const point = await browser.evaluate(`const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};`);
        await browser.pointer([{ type: 'move', ...point }, { type: 'down' }, { type: 'up' }]);
      };
      await click('#native .wupage-translation');
      assert.equal(await browser.evaluate('return document.querySelector("#native").dataset.clicked;'), 'true');
      await click('#rich + .wupage-translation a');
      assert.equal(await browser.evaluate('return location.hash;'), '', 'the presentation copy must not navigate');
      await browser.evaluate('delete document.querySelector("#native").dataset.clicked;');
    }
    await send({ type: 'CLEAR_TRANSLATION' });
    assert.equal(await browser.evaluate('return document.querySelector("main").innerHTML;'), original);
    checks.push(`${mode}: native drag selects prose and formatted text while preserving controls and original markup`);
  }

  settings.autoTranslation = { enabled: true, nonTargetLanguage: false, presetSites: [],
    customSites: [{ id: 'component', pattern: origin + '/automatic-component', enabled: true }] };
  await runtime({ type: 'SAVE_SETTINGS', settings });
  await open('automatic-component'); await delay(550);
  await browser.evaluate('document.querySelector("#component").shadowRoot.append(document.createTextNode("Foreign prose loaded inside a component."));');
  await waitFor(() => browser.evaluate('return document.querySelector("#component").shadowRoot.querySelector(".wupage-translation:not(.wupage-translation-pending)")?.textContent;'),
    value => value?.includes('译文：Foreign prose'), 'automatic translation samples newly populated shadow content');
  checks.push('automatic translation discovers content loaded inside a shadow tree');

  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, checks, requests: calls.length }, null, 2));
  console.log(JSON.stringify({ ...identity, checks, output }, null, 2));
} finally {
  releaseSlow(); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
