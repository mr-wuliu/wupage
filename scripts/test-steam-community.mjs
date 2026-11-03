// Public Steam pages in an isolated browser; translation requests stay on localhost.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
const output = path.join(root, '.npm-cache/steam-community', target.kind);
await fs.mkdir(output, { recursive: true });
const requests = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const { texts } = JSON.parse(body); requests.push(...texts);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ translations: texts.map(text => text.includes('⟪WUPAGESEGMENT')
    ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\s*\n)/gu, '$1验证译文：') : `验证译文：${text}`) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const reports = [];
let browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  do { last = await read(); if (last === true) return; await pause(100); } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  await browser.resize(1491, 1242);
  await browser.api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    settings.providers.push({id:'steam-test',type:'http-template',label:'Steam local test',method:'POST',url:input[0]+'/translate',
      headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
    Object.assign(settings,{activeProviderId:'steam-test',sourceLang:'en',targetLang:'zh-CN',cacheEnabled:false,
      translationDisplayMode:'replace',floatingBallEnabled:false});settings.autoTranslation={...settings.autoTranslation,enabled:false};
    settings.selectionTranslation={...settings.selectionTranslation,enabled:false};settings.videoTranslation={...settings.videoTranslation,enabled:false};settings.imageTranslationEnabled=false;
    const saved=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});if(!saved.ok)throw new Error(saved.error);`, [origin]);

  const pages = [
    ['community', 'https://steamcommunity.com/app/1281930/?l=english'],
    ['workshop', 'https://steamcommunity.com/app/1281930/workshop/?l=english']
  ];
  for (const [name, url] of pages) {
    await browser.navigate(url);
    await waitFor(() => browser.evaluate(`return document.readyState==='complete' && ${name === 'community'
      ? "!!document.querySelector('.apphub_CardContentNewsTitle') && getComputedStyle(document.querySelector('.apphub_Card')).display!=='none'"
      : name === 'workshop' ? "[...document.querySelectorAll('a[href*=\"filedetails\"]')].filter(e=>e.textContent.trim()).length>3"
      : "!!document.querySelector('.workshopItemTitle') && !!document.querySelector('.workshopItemDescription')"};`), `${name} content ready`);
    const tab = await browser.api('return (await chrome.tabs.query({})).find(tab=>tab.url===input[0]);', [url]);
    assert.ok(tab?.id);
    const action = async type => {
      const result = await browser.api('return chrome.tabs.sendMessage(input[0],{type:input[1]},{frameId:0});', [tab.id, type]);
      assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
    };
    await waitFor(async () => { try { await action('GET_TRANSLATION_STATE'); return true; } catch { return false; } }, 'extension ready');
    const samples = await browser.evaluate(`const normal=text=>text.replace(/\\s+/g,' ').trim();
      window.steamTestTargets=[];
      const add=(element,source=element?.textContent)=>{if(element&&normal(source||''))window.steamTestTargets.push({element,source:normal(source)});};
      if(${JSON.stringify(name)}==='community'){
        add(document.querySelector('.apphub_StoreAppText'));add(document.querySelector('.apphub_CardContentNewsTitle'));
        const body=document.querySelector('.Announcement_Card .apphub_CardTextContent');
        for(const node of [...(body?.childNodes||[])].filter(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim()).slice(0,2))add(body,node.textContent);
      }else if(${JSON.stringify(name)}==='workshop'){
        const titles=[...document.querySelectorAll('a[href*="filedetails"]')].filter(e=>{
          const box=e.getBoundingClientRect();return e.textContent.trim()&&box.width>0&&box.height>0&&box.left>=0&&box.right<=innerWidth;
        });
        const seen=new Set();for(const element of titles){const text=normal(element.textContent);if(!seen.has(text)){add(element);seen.add(text);}if(window.steamTestTargets.length>=8)break;}
        for(const label of ['Store Page','All','Mods','Mod Features','Learn More']){
          const element=[...document.querySelectorAll('a,div,span')].find(element=>normal(element.textContent).toLowerCase()===label.toLowerCase()
            && ![...element.children].some(child=>normal(child.textContent).toLowerCase()===label.toLowerCase())
            && element.getBoundingClientRect().width>0 && element.getBoundingClientRect().height>0);
          if(element)add(element);
        }
      }else{
        add(document.querySelector('.workshopItemTitle'));
        const description=document.querySelector('.workshopItemDescription');
        const walker=document.createTreeWalker(description,NodeFilter.SHOW_TEXT);
        while(walker.nextNode()&&window.steamTestTargets.length<3){const node=walker.currentNode;
          if(normal(node.textContent).length>25)add(node.parentElement,node.textContent);}
      }
      return window.steamTestTargets.map(({source,element})=>({source,tag:element.tagName,class:element.className}));`);
    assert.ok(samples.length >= (name === 'community' ? 4 : 3), JSON.stringify(samples));
    if (name === 'workshop') pages.push(['item', await browser.evaluate('return window.steamTestTargets[0].element.href;')]);
    await browser.capture(`${name}-before.png`);
    const result = await action('TRANSLATE_PAGE');
    assert.equal(result.failed, 0, JSON.stringify(result));
    for (let index = 0; index < samples.length; index++) {
      if (name !== 'community') await browser.evaluate(`window.steamTestTargets[${index}].element.scrollIntoView({block:'center'});`);
      await waitFor(() => browser.evaluate(`const {source}=window.steamTestTargets[${index}];
        const normal=text=>text.replace(/\\s+/g,' ').trim();
        return [...document.querySelectorAll('.wupage-translation:not(.wupage-translation-pending)')]
          .some(element=>normal(element.textContent).includes('验证译文：'+source));`), `${name} translates ${samples[index].source}`);
    }
    await browser.evaluate('window.scrollTo(0,0);'); await pause(250);
    await browser.capture(`${name}-after.png`);
    const translated = await browser.evaluate('return document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)").length;');
    await action('CLEAR_TRANSLATION');
    const restored = await browser.evaluate(`const normal=text=>text.replace(/\\s+/g,' ').trim();
      return window.steamTestTargets.every(({source,element})=>normal(element.textContent).includes(source))
        &&!document.querySelector('.wupage-translation');`);
    assert.equal(restored, true, `${name} restores original content`);
    reports.push({ name, url, samples, translated, restored });
    console.log(JSON.stringify({ name, checked: samples.length, translated, restored }));
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, simulatedTranslation: true, requests: requests.length, reports }, null, 2));
  console.log(JSON.stringify({ ...identity, requests: requests.length, output }));
} catch (error) {
  await browser?.capture('failure.png').catch(() => {}); throw error;
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
