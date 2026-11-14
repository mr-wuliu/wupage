// Offline native-layout and extension regression; no online translator or site.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';
import { visibilityCases, visibilityFixture } from './fixtures/content-visibility.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/content-visibility', target.kind), requests = [], reports = [];
await fs.mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `import {createRenderVisibilitySnapshot} from './src/content/visibility';window.visibilityProbe=createRenderVisibilitySnapshot;`, resolveDir: root }, bundle: true, format: 'iife', write: false });
const translate = text => text.split(/(⟪WUPAGE(?:OPEN|CLOSE|BREAK|SEGMENT)?\d+⟫)/gu)
  .map(part => /^⟪WUPAGE/u.test(part) || !/\p{L}/u.test(part) ? part : `验证译文：${part}`).join('');
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const part of request) body += part;
    const { texts } = JSON.parse(body); requests.push(...texts);
    response.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({translations:texts.map(translate)})); return;
  }
  if (request.url==='/embedded') {
    response.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><html lang="en"><body><p id="embedded">Embedded reader prose for translation.</p></body></html>');return;
  }
  const name = new URL(request.url, 'http://localhost').searchParams.get('case');
  const test = visibilityCases.find(test => test.name === name) ?? visibilityCases[0];
  response.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(visibilityFixture(test, bundle.outputFiles[0].text));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, url;
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const runtime = async request => {
    const response = await browser.api('return chrome.runtime.sendMessage(input[0]);',[request]);
    assert.equal(response.ok,true,JSON.stringify(response)); return response.data;
  };
  const send = async type => {
    const response = await browser.api(`const tab=(await chrome.tabs.query({})).find(tab=>tab.url===input[0]);return chrome.tabs.sendMessage(tab.id,{type:input[1],includeProgress:true},{frameId:0});`,[url,type]);
    assert.equal(response.ok,true,JSON.stringify(response)); return response.data;
  };
  const until = async (source, label) => {
    const deadline = Date.now()+15000;
    while(Date.now()<deadline) { if(await browser.evaluate(source))return; await new Promise(resolve=>setTimeout(resolve,60)); }
    throw new Error('Timed out: '+label);
  };
  const settings = await runtime({type:'GET_SETTINGS'});
  settings.providers.push({id:'visibility-test',type:'http-template',label:'Visibility regression',method:'POST',url:origin+'/translate',headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
  Object.assign(settings,{activeProviderId:'visibility-test',sourceLang:'en',targetLang:'zh-CN',cacheEnabled:false,imageTranslationEnabled:false});
  settings.autoTranslation.enabled=false;settings.selectionTranslation.enabled=false;
  await runtime({type:'SAVE_SETTINGS',settings});
  for(const width of [1400,390]) {
    await browser.resize(width,1000);
    for(const test of visibilityCases) {
      url=origin+'/?case='+test.name+'&width='+width;await browser.navigate(url);
      await until('return !!(window.wrappedJSObject||window).visibilityProbe;',test.name+' fixture');
      const native=await browser.evaluate(`return new Promise(resolve=>{const observer=new IntersectionObserver(([entry])=>{observer.disconnect();resolve(entry.intersectionRect.width>1&&entry.intersectionRect.height>1);});observer.observe(document.querySelector('#source'));});`);
      // Firefox's intersection rectangles do not consistently include clip-path.
      // The actual request and restoration checks still apply to every case.
      if (!(target.kind==='firefox' && (test.css.includes('clip-path') || test.html.includes('clip-path')))) {
        assert.equal(native,test.name.endsWith('opacity')?true:test.visible,test.name+' native intersection');
      }
      // The page probe cannot use extension-only APIs for closed shadow roots;
      // those cases are checked by the extension's real request path below.
      if(test.probe) assert.equal(await browser.evaluate(`const w=window.wrappedJSObject||window;return w.visibilityProbe().isTextNodeVisuallyRendered(document.querySelector('#source').firstChild);`),test.visible,test.name+' native layout');
      const start=requests.length;
      for(const mode of test.visible?['bilingual','bilingual-accent','replace']:['replace']) {
        settings.translationDisplayMode=mode;await runtime({type:'SAVE_SETTINGS',settings});
        await send('TRANSLATE_PAGE');
        if(test.visible) {
          await until(`return document.querySelector('#source').hasAttribute('data-wupage-translated')&&!document.querySelector('.wupage-translation-pending');`,test.name+' '+mode);
          assert.ok(requests.slice(start).some(text=>text.includes('peripheral configuration')),test.name+' request');
          assert.equal(await browser.evaluate(`const w=window.wrappedJSObject||window,f=w.visibilityFixture;f.link.click();return f.link.isConnected&&f.link.isSameNode(document.querySelector('#link'))&&f.link.getAttribute('href')==='#reference';`),true,test.name+' link');
        } else assert.ok(!requests.slice(start).some(text=>text.includes('peripheral configuration')),test.name+' hidden request');
        await send('CLEAR_TRANSLATION');
        assert.equal(await browser.evaluate(`const w=window.wrappedJSObject||window;return document.querySelector('#source').innerHTML===w.visibilityFixture.html;`),true,test.name+' restoration');
      }
      reports.push({case:test.name,width,visible:test.visible,nativeIntersection:native,restored:true});
    }
  }
  // Opening a popover changes a pseudo-class without changing its attributes.
  url=origin+'/?case=closed-popover&dynamic=1';await browser.navigate(url);await send('TRANSLATE_PAGE');
  await browser.evaluate(`document.querySelector('#panel').showPopover();`);
  await until(`return document.querySelector('#source').hasAttribute('data-wupage-translated');`,'popover opened after translation');
  await send('CLEAR_TRANSLATION');
  reports.push({case:'dynamic-popover',restored:true});
  for(const closed of [false,true]) {
    url=origin+'/?case='+(closed?'closed-slot-overflow':'slot-opacity')+'&dynamic=1';await browser.navigate(url);
    await browser.evaluate(`const w=window.wrappedJSObject||window;w.fixtureRoot.firstElementChild.style.cssText='opacity:0';`);
    await send('TRANSLATE_PAGE');
    await browser.evaluate(`const w=window.wrappedJSObject||window;w.fixtureRoot.firstElementChild.style.cssText='';`);
    await until(`return document.querySelector('#source').hasAttribute('data-wupage-translated');`,'slot ancestor revealed');
    await send('CLEAR_TRANSLATION');
    assert.equal(await browser.evaluate(`const w=window.wrappedJSObject||window;return document.querySelector('#source').innerHTML===w.visibilityFixture.html;`),true);
    reports.push({case:closed?'dynamic-closed-slot':'dynamic-open-slot',restored:true});
  }
  url=origin+'/?case=modal-opacity&embedded=1';await browser.navigate(url);
  await browser.evaluate(`const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin+'/embedded')};document.querySelector('#panel').append(frame);`);
  await until(`return !!document.querySelector('iframe')?.contentDocument?.querySelector('#embedded');`,'modal iframe loaded');
  await send('TRANSLATE_PAGE');
  await until(`return !!document.querySelector('iframe').contentDocument.querySelector('#embedded[data-wupage-translated]');`,'modal iframe translated');
  assert.ok(requests.some(text=>text.includes('Embedded reader prose')));
  await send('CLEAR_TRANSLATION');
  await until(`return !document.querySelector('iframe').contentDocument.querySelector('.wupage-translation');`,'modal iframe restored');
  reports.push({case:'top-layer-iframe',restored:true});
  const result={passed:true,...identity,reports,requests:requests.length};
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:true,browser:target.kind,cases:reports.length,requests:requests.length,output}));
} catch(error) {
  await browser?.capture('failure.png').catch(()=>{});
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:false,error:String(error),reports,requests},null,2));
  throw error;
} finally { await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
