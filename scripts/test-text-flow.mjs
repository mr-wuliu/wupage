// Exercise native text hit testing and the extension's real paragraph/page paths.
// Isolated profiles, a local page and a deterministic translation endpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/text-flow', target.kind), calls = [], checks = [];
const expected = 'Read from a sketchboard and keep its links.';
const plain = text => text.replace(/⟪WUPAGEBREAK\d+⟫/gu, ' ').replace(/⟪WUPAGE(?:OPEN|CLOSE|SEGMENT)?\d+⟫/gu, '').replace(/\s+/gu, ' ').trim();
const translate = text => text.split(/(⟪WUPAGE(?:OPEN|CLOSE|BREAK|SEGMENT)?\d+⟫)/gu)
  .map(part => /^⟪WUPAGE/u.test(part) || !/\p{L}/u.test(part) ? part : '这一部分的译文。').join('');
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const part of request) body += part;
    const payload = JSON.parse(body);
    calls.push(...payload.texts.flatMap(text => text.includes('⟪WUPAGESEGMENT')
      ? text.split(/⟪WUPAGESEGMENT\d+⟫\n/gu).slice(1).filter(value => value.trim()) : [text]));
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translations: payload.texts.map(translate) }));
    return;
  }
  const variant = Number(new URL(request.url, 'http://localhost').searchParams.get('variant') || 0);
  const tag = ['div', 'span', 'section'][variant % 3], format = variant === 2 ? 'div' : 'span';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><meta charset="utf-8">
    <title>Text flow regression</title><style>body{font:18px/1.6 Arial;margin:32px}.format{display:inline}#body{display:block}td{padding:10px}</style>
    <body><table><tr><td><div id="author">Example author and metadata</div><${tag} id="body">Read from a<br><${format} class="format"><a id="reference" href="#reference">sketchboard</a></${format}> and <em>keep its links</em>.<p id="second">An independent paragraph inside the same comment.</p>A final paragraph without a wrapping tag.</${tag}><button id="reply">Reply to this comment</button></td></tr></table>
    <script>window.replyClicks=0;document.getElementById('reply').addEventListener('click',()=>window.replyClicks++);</script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, url;
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const send = request => browser.api(`const tab=(await chrome.tabs.query({})).find(tab=>tab.url===input[0]);
    return chrome.tabs.sendMessage(tab.id,input[1],{frameId:0});`, [url, request]);
  const wait = async (source, label) => {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      if (await browser.evaluate(source)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await browser.capture('timeout.png'); throw new Error(`Timed out: ${label}`);
  };
  await browser.api(`const loaded=await chrome.runtime.sendMessage({type:'GET_SETTINGS'}),settings=loaded.data;
    settings.providers.push({id:'flow-test',type:'http-template',label:'Flow test',method:'POST',url:input[0]+'/translate',
      headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
    Object.assign(settings,{activeProviderId:'flow-test',sourceLang:'en',targetLang:'zh-CN',cacheEnabled:false,translationDisplayMode:'bilingual'});
    settings.selectionTranslation.enabled=false;
    const saved=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});if(!saved.ok)throw new Error(saved.error);`, [origin]);
  const point = async part => browser.evaluate(`const body=document.getElementById('body');
    const node=${part === 'first' ? "body.querySelector('[data-wupage-prose-source]')?.firstChild||body.firstChild" : part === 'second' ? "document.getElementById('second').firstChild" : "body.lastChild"};
    const range=document.createRange();range.selectNodeContents(node);const rect=range.getClientRects()[0];
    return {x:rect.left+Math.min(30,rect.width/2),y:rect.top+rect.height/2};`);
  const clickParagraph = async part => {
    const position = await point(part); await browser.pointer([{type:'move',...position},{type:'down'},{type:'up'}], ['Control']);
  };
  for (let variant = 0; variant < 3; variant++) {
    url = `${origin}/?variant=${variant}`; await browser.navigate(url);
    await wait('return !!document.getElementById("wupage-floating-ball");', 'content initialization');
    await browser.evaluate(`const body=document.getElementById('body');(window.wrappedJSObject||window).flowOriginal={text:body.textContent,nodes:[...body.childNodes],link:document.getElementById('reference')};`);
    await send({type:'SET_PARAGRAPH_MODE',enabled:true});
    const start = calls.length; await clickParagraph('first');
    await wait(`return document.getElementById('body').textContent.includes('这一部分的译文。')&&!document.querySelector('.wupage-translation-pending');`, 'opening paragraph translation');
    assert.equal(calls.length, start + 1, JSON.stringify(calls.slice(start))); assert.equal(plain(calls[start]), expected);
    assert.match(calls[start], /⟪WUPAGEBREAK\d+⟫/u);
    assert.ok(await browser.evaluate(`return !document.querySelector('#author .wupage-translation,#reply .wupage-translation')
      && document.getElementById('second').textContent==='An independent paragraph inside the same comment.';`));
    const ball = await browser.evaluate(`const r=document.getElementById('wupage-floating-ball').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};`);
    await browser.pointer([{type:'move',...ball}]);
    await wait(`return !!document.querySelector('#wupage-floating-menu [data-role="display-mode"]');`, 'display control');
    for (const mode of ['bilingual-accent', 'replace', 'bilingual']) {
      await browser.evaluate(`const select=document.querySelector('#wupage-floating-menu [data-role="display-mode"]');select.value='${mode}';select.dispatchEvent(new Event('change',{bubbles:true}));`);
      await wait(`return !document.querySelector('#wupage-floating-menu [data-role="display-mode"]').disabled
        && document.getElementById('body').textContent.includes('这一部分的译文。');`, mode);
      const link = await browser.evaluate(`const original=(window.wrappedJSObject||window).flowOriginal,current=document.getElementById('reference');
        return {same:current.isSameNode(original.link),text:current.textContent,connected:original.link.isConnected};`);
      assert.ok(link.same && link.text.trim().length>0 && link.connected, JSON.stringify({variant,mode,link}));
    }
    await browser.press('Escape'); await clickParagraph('first');
    await wait(`return !document.querySelector('.wupage-translation');`, 'opening restoration');
    for (const part of ['second', 'last']) {
      await clickParagraph(part);
      await wait(`return !!document.querySelector('.wupage-translation:not(.wupage-translation-pending)')&&!document.querySelector('.wupage-translation-pending');`, `${part} translation`);
      await clickParagraph(part); await wait(`return !document.querySelector('.wupage-translation');`, `${part} restoration`);
    }
    assert.ok(await browser.evaluate(`const body=document.getElementById('body'),original=(window.wrappedJSObject||window).flowOriginal;return body.textContent===original.text
      && original.nodes.every(node=>node.isConnected&&body.contains(node));`));
    await browser.evaluate(`document.getElementById('reply').click();`);
    assert.equal(await browser.evaluate('return (window.wrappedJSObject||window).replyClicks;'), 1);
    await browser.capture(`variant-${variant}.png`);
    checks.push(`variant ${variant}: native paragraph targeting, hard break, three display modes, original links/nodes and reply handler`);
  }
  url = `${origin}/?variant=2`; await browser.navigate(url);
  await wait('return !!document.getElementById("wupage-floating-ball");', 'page initialization');
  const start = calls.length; await send({type:'TRANSLATE_PAGE'});
  await wait(`return document.querySelectorAll('.wupage-translation:not(.wupage-translation-pending)').length>=4&&!document.querySelector('.wupage-translation-pending');`, 'whole page translation');
  assert.equal(calls.slice(start).map(plain).filter(text => text===expected).length, 1);
  await browser.evaluate(`const p=document.createElement('p');p.textContent='An additional paragraph loaded after translation.';document.getElementById('body').append(p);`);
  await wait(`return document.getElementById('body').lastElementChild?.textContent.includes('这一部分的译文。');`, 'incremental paragraph translation');
  assert.equal(calls.slice(start).map(plain).filter(text => text===expected).length, 1);
  await send({type:'CLEAR_TRANSLATION'});
  await wait(`return !document.querySelector('.wupage-translation');`, 'whole page restoration');
  checks.push('whole-page/incremental translation share the same ranges without repeating the opening paragraph');
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({browser:target.kind,checks,calls},null,2));
  console.log(JSON.stringify({browser:target.kind,checks,output},null,2));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
