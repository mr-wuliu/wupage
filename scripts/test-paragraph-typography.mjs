// Compare source and translated typography through the paragraph keyboard shortcut.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const baseline = process.argv.includes('--baseline');
const output = path.join(root, '.npm-cache/paragraph-typography', target.kind);
await fs.mkdir(output, { recursive: true });
const calls = [], reports = [], checks = [];
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Paragraph typography</title><style>
body{margin:32px;font:16px/1.5 Arial;color:#183d36}main{max-width:1080px;margin:auto}
h2{font:700 42px/1.25 Georgia}#hero{font-weight:400}#rich{font:italic 500 28px/1.4 Georgia;letter-spacing:.4px}
#lines{font:600 24px/1.5 Georgia}#lines span{display:inline-block}#single{font-size:26px}#literal{white-space:pre-line}
@media(max-width:750px){h2{font-size:30px}#rich{font-size:22px}#lines{font-size:20px}#single{font-size:19px}}
</style><body><main><h2 id="hero" data-typography>A language empowering everyone<br>to build reliable and efficient software.</h2>
<h2 id="simple" data-typography>Why choose this language?</h2>
<p id="rich" data-typography>A complete <em>paragraph with emphasis</em> should keep its own typography.</p>
<div><span id="lines" data-typography>First authored sentence with enough text.<br>Second authored sentence on its own line.<br></span></div>
<div id="literal" data-typography>First authored line.\n\nSecond authored line after a blank line.</div>
<p id="single" data-typography>A plain paragraph should have the same font size as its translation.</p>
<h2 id="anchor" data-typography>Review <em>this heading</em><a class="anchor" href="#anchor">§</a></h2></main></body></html>`;
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixture); return; }
  let raw = ''; for await (const part of request) raw += part;
  const { texts } = JSON.parse(raw); calls.push(...texts);
  const translate = text => {
    const hero = /^(?:[\s\S]*(⟪WUPAGESEGMENT\d+⟫\n))?A language empowering/u.exec(text);
    if (hero) return (hero[1] ?? '') + (text.includes('⟪WUPAGEBREAK0⟫')
      ? '一门赋能所有人的语言，⟪WUPAGEBREAK0⟫用来构建可靠而高效的软件。' : '一门赋能所有人构建可靠且高效软件的语言。');
    return text.replace(/(⟪WUPAGESEGMENT\d+⟫\n)/gu, '$1译文：').replace(/^([^⟪])/u, '译文：$1');
  };
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translations: texts.map(translate) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const waitFor = async (read, test, label) => {
  const until = Date.now() + 30000; let result;
  do { result = await read(); if (test(result)) return result; await delay(100); } while (Date.now() < until);
  throw new Error(`${label}: ${JSON.stringify(result)}`);
};
let browser;
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const runtime = async request => {
    const result = await browser.api('return chrome.runtime.sendMessage(input[0]);', [request]);
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  const settings = await runtime({ type: 'GET_SETTINGS' });
  settings.providers.push({ id: 'typography-test', type: 'http-template', label: 'Typography test', method: 'POST', url: `${origin}/translate`,
    headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
  Object.assign(settings, { activeProviderId: 'typography-test', sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false,
    floatingBallEnabled: false, translationDisplayMode: 'bilingual' });
  settings.selectionTranslation.enabled = false;
  await runtime({ type: 'SAVE_SETTINGS', settings });
  const inspect = () => browser.evaluate(`const props=['fontSize','fontFamily','fontWeight','fontStyle','lineHeight','letterSpacing','wordSpacing','textTransform'];
    return [...document.querySelectorAll('[data-typography]')].map(source=>{
      const id=source.getAttribute('data-wupage-target-id');
      const original=(window.wrappedJSObject||window).typographyOriginal?.find(entry=>entry.e===source);
      const inline=${JSON.stringify(settings.translationDisplayMode)}==='replace'&&original&&original.nodes.length>0
        &&source.innerHTML!==original.html&&original.nodes.every(node=>node.isConnected);
      const output=source.querySelector('.wupage-translation')||[...document.querySelectorAll('.wupage-translation')].find(e=>id&&e.getAttribute('data-wupage-translation-target')===id)||(inline?source:null);
      const read=e=>Object.fromEntries(props.map(p=>[p,getComputedStyle(e)[p]]));
      const anchor=source.querySelector('a.anchor');
      return {id:source.id,source:read(source),output:output&&read(output),text:output?.textContent,lineBreaks:output?.querySelectorAll('br').length,
        contained:output&&source.contains(output),mode:output===source?'replace':output?.dataset.wupageDisplayMode,
        anchorBeforeResult:!anchor||!output||output===source||output.dataset.wupageDisplayMode==='replace'||anchor.getBoundingClientRect().bottom<=output.getBoundingClientRect().top+1};});`);
  for (const live of process.argv.includes('--live') ? [false, true] : [false]) {
    for (const mode of baseline ? ['bilingual'] : ['bilingual', 'bilingual-accent', 'replace']) {
      settings.translationDisplayMode = mode; await runtime({ type: 'SAVE_SETTINGS', settings });
      const label = live ? 'rust' : 'fixture';
      await browser.resize(1400, 1200);
      await browser.navigate(live ? 'https://rust-lang.org/' : `${origin}/fixture`);
      await waitFor(() => browser.evaluate('return !!document.querySelector("#wupage-translation-style");'), Boolean, 'content runtime');
      if (live) await browser.evaluate(`const hero=[...document.querySelectorAll('h2')].find(e=>e.textContent.includes('A language empowering'));
        if(!hero)throw new Error('Rust hero missing');hero.id='rust-hero';hero.setAttribute('data-typography','');
        document.querySelectorAll('h2,h3,p').forEach(e=>{if(e.closest('main'))e.setAttribute('data-typography','');});`);
      await browser.evaluate(`const w=window.wrappedJSObject||window;w.typographyOriginal=[...document.querySelectorAll('[data-typography]')].map(e=>({e,html:e.innerHTML,nodes:[...e.querySelectorAll('*')]}));
        const range=document.createRange();const first=document.querySelector('[data-typography]'),last=[...document.querySelectorAll('[data-typography]')].at(-1);
        range.setStart(first,0);range.setEnd(last,last.childNodes.length);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);`);
      await browser.press('Alt+Shift+Q');
      await waitFor(inspect, rows => rows.length > 0 && rows.every(row => row.output), 'paragraph translations');
      await waitFor(() => browser.evaluate('return document.querySelectorAll(".wupage-translation-pending").length;'), n => n === 0, 'all selected translations finish');
      await browser.evaluate('getSelection().removeAllRanges();');
      await browser.capture(`${baseline ? 'baseline-' : ''}${label}-1400-${mode}.png`);
      let measured = await inspect(); reports.push({ label, width: 1400, mode, rows: measured });
      if (baseline) continue;
      if (!live) {
        assert.deepEqual(['hero', 'lines', 'literal'].map(id => measured.find(row => row.id === id)?.lineBreaks), [1, 2, 2]);
      }
      await delay(250);
      const count = calls.length;
      for (const width of [1400, 680]) {
        await browser.resize(width, 1200);
        measured = await waitFor(inspect, rows => rows.every(row => row.mode === mode && row.anchorBeforeResult
          && JSON.stringify(row.source) === JSON.stringify(row.output)), `${label}/${width}/${mode}: typography matches source`);
        assert.equal(calls.length, count, 'resizing reuses translations');
        reports.push({ label, width, mode, rows: measured });
        await browser.capture(`${label}-${width}-${mode}.png`);
      }
      if (!live && mode !== 'replace') {
        await browser.evaluate(`document.querySelector('#rich').style.fontSize='31px';document.querySelector('#rich').style.fontWeight='700';
          document.querySelector('#lines').style.fontSize='25px';document.querySelector('#lines').style.lineHeight='1.8';`);
        measured = await waitFor(inspect, rows => rows.every(row => JSON.stringify(row.source) === JSON.stringify(row.output)), 'host style changes');
        reports.push({ label, hostStyleChange: true, rows: measured });
        assert.equal(calls.length, count);
      }
      await browser.evaluate(`const range=document.createRange();const first=document.querySelector('[data-typography]'),last=[...document.querySelectorAll('[data-typography]')].at(-1);
        range.setStart(first,0);range.setEnd(last,last.childNodes.length);getSelection().removeAllRanges();getSelection().addRange(range);`);
      await browser.press('Alt+Shift+Q');
      await waitFor(() => browser.evaluate('return document.querySelectorAll(".wupage-translation").length;'), n => n === 0, 'shortcut restores originals');
      assert.equal(await browser.evaluate(`const w=window.wrappedJSObject||window;return w.typographyOriginal.every(({e,html,nodes})=>e.innerHTML===html&&nodes.every(n=>n.isConnected));`), true);
      checks.push(`${label}/${mode}: keyboard translation, source typography, responsive widths, reuse and restoration`);
    }
  }
  await fs.writeFile(path.join(output, baseline ? 'baseline.json' : 'report.json'), JSON.stringify({ ...identity, checks, reports }, null, 2));
  console.log(JSON.stringify({ ...identity, baseline, checks, output }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), reports, calls }, null, 2));
  await browser?.capture('failure.png').catch(() => {}); throw error;
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
