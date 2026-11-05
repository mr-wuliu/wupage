// Synthetic inbox only: never attaches to a signed-in browser or fetches mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget(), baseline = process.argv.includes('--baseline');
const output = path.join(root, '.npm-cache/mail-layout', target.kind);
const calls = [], checks = [], reports = [];
const subject = 'Release workflow failed: publish browser extensions';
const preview = 'The extension build finished. Review the publishing status and retry the failed job.';
const prose = 'This message contains a complete paragraph with important release details for the reader.';
const shortProse = 'Short source.';
const longInlineTranslation = 'A translated sentence that needs to wrap naturally inside a narrow container. '.repeat(6).trim();
const translations = new Map([
  [subject, '发布浏览器扩展的工作流运行失败，请检查发布结果'],
  [preview, '扩展构建已经完成，请查看发布状态、检查错误详情，并重新运行失败的任务。'],
  ['Build service', '构建服务'], ['3:08 AM', '凌晨 3:08'], ['Inbox', '收件箱'],
  [prose, '这封邮件包含完整的发布说明，正文应该保持正常换行，长段落仍能完整阅读。'.repeat(4)],
  [shortProse, longInlineTranslation]
]);
const row = (kind, index) => {
  const tr = kind === 'aria' ? 'div' : 'tr', td = kind === 'aria' ? 'div' : 'td';
  return `<${tr} role="row" data-mail-row data-key="${kind}-${index}">
  <${td} role="gridcell" class="select"><input type="checkbox" style="" aria-label="Select message ${index}"></${td}>
  <${td} role="gridcell" class="sender"><div class="clip">Build <strong>service</strong></div></${td}>
  <${td} role="gridcell" class="message"><div class="slot"><div class="clip line"><div class="text-line"><span class="subject"><span>${subject}</span></span><span class="preview"> - <span>${preview}</span></span></div></div></div></${td}>
  <${td} role="gridcell" class="time"><span>3:08 AM</span></${td}>
  </${tr}>`;
};
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Inbox layout regression</title><style>
  *{box-sizing:border-box}body{margin:24px;font:14px/20px Arial;color:#202124;background:#f7f9fc}
  main{max-width:1200px;margin:auto}h1{font:24px/32px Arial}h2{font:18px/24px Arial}
  table{table-layout:fixed;border-collapse:collapse;width:100%}[role=row]{height:40px;background:#eef3fc;border-bottom:1px solid #d9dfe8}
  [role=gridcell]{padding:0 8px;vertical-align:middle}.select{width:36px}.sender{width:160px}.time{width:88px;text-align:right;white-space:nowrap}
  .clip{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.slot{position:relative;height:20px}.line{position:absolute;inset:0}
  .subject{font-weight:600}.preview{color:#5f6368}.aria [role=row]{display:grid;grid-template-columns:36px 160px minmax(0,1fr) 88px;align-items:center}
  /* Gmail-style flex cells have no fixed-height text wrapper. A wrapping
     preview can stretch the entire row instead of merely being clipped. */
  .flex tbody{display:block}.flex [role=row]{display:flex;height:auto;min-height:40px;align-items:center}
  .flex [role=gridcell]{display:flex;white-space:nowrap}.flex .select,.flex .sender,.flex .time{flex-shrink:0}
  .flex .message{flex:1;min-width:0}.flex .slot{display:flex;height:auto;width:100%;min-width:0}
  .flex .line{position:static;flex:1;min-width:0}.flex .text-line{display:flex;min-width:0;overflow:hidden}
  .flex .subject{display:flex;overflow:hidden;flex:0 1 auto}.flex .subject>span{overflow:hidden;text-overflow:ellipsis}
  .flex .preview{display:block;flex:1 1 0%;overflow:hidden;text-overflow:ellipsis;min-width:0}
  article{max-width:460px;margin-top:32px;background:white;padding:16px}article p{margin:0}
  @media(max-width:800px){.sender{width:100px}.aria [role=row]{grid-template-columns:36px 100px minmax(0,1fr) 88px}}
  </style><body><main role="main"><h1>Inbox</h1><h2>Table inbox</h2><table role="grid"><colgroup><col style="width:36px"><col class="sender"><col><col style="width:88px"></colgroup><tbody>${[1,2].map(i => row('table',i)).join('')}</tbody></table>
  <h2>Grid inbox</h2><div class="aria" role="grid">${[1,2].map(i => row('aria',i)).join('')}</div>
  <h2>Flex inbox</h2><table class="flex" role="grid"><tbody>${[1,2].map(i => row('flex',i)).join('')}</tbody></table>
  <section id="flowing-prose"><div id="nowrap-source" style="width:180px;white-space:nowrap"><span>${shortProse}</span></div></section>
  <article><p>${prose}</p><div style="white-space:nowrap"><p id="nowrap-prose">${prose}</p></div></article>
  <div contenteditable="true" role="textbox" aria-label="Message body">Draft message must remain untouched.</div></main></body></html>`;
const translate = text => {
  for (const [source, result] of translations) text = text.replaceAll(source, result);
  return text;
};
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(fixture); return; }
  let body = ''; for await (const part of request) body += part;
  const payload = JSON.parse(body); calls.push(...payload.texts);
  await delay(600);
  response.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({translations:payload.texts.map(translate)}));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/fixture`;
const waitFor = async (read, test, label) => {
  const until = Date.now()+30000; let value;
  do { value=await read(); if(test(value)) return value; await delay(100); } while(Date.now()<until);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
let browser;
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const runtime = async request => {
    const result = await browser.api('return chrome.runtime.sendMessage(input[0]);',[request]);
    assert.equal(result?.ok,true,JSON.stringify(result)); return result.data;
  };
  const settings = await runtime({type:'GET_SETTINGS'});
  settings.providers.push({id:'mail-test',type:'http-template',label:'Mail layout test',method:'POST',url:url+'/translate',
    headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
  Object.assign(settings,{activeProviderId:'mail-test',sourceLang:'en',targetLang:'zh-CN',translationDisplayMode:'replace',cacheEnabled:false});
  await runtime({type:'SAVE_SETTINGS',settings});
  await browser.navigate(url);
  await waitFor(()=>browser.evaluate('return !!document.querySelector("#wupage-floating-ball")'),Boolean,'content runtime');
  const send = async type => {
    const result = await browser.api('const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);return chrome.tabs.sendMessage(tab.id,{type:input[1]},{frameId:0});',[url,type]);
    assert.equal(result?.ok,true,JSON.stringify(result)); return result.data;
  };
  const inspect = () => browser.evaluate(`const box=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};
    return {rows:[...document.querySelectorAll('[data-mail-row]')].map(row=>({key:row.dataset.key,box:box(row),
      cells:[...row.children].map(cell=>({cls:cell.className,box:box(cell)})),
      outside:row.querySelectorAll('.message > .wupage-translation,.slot > .wupage-translation,[role=row] > .wupage-translation').length,
      subject:row.querySelector('.subject').textContent,preview:row.querySelector('.preview').textContent,
      translations:[...row.querySelectorAll('.wupage-translation')].map(e=>({text:e.textContent,parent:e.parentElement.className,box:box(e),whiteSpace:getComputedStyle(e).whiteSpace}))})),
      proseHeight:document.querySelector('article p').getBoundingClientRect().height,
      inheritedNowrapProseHeight:document.querySelector('#nowrap-prose').getBoundingClientRect().height,
      flowingInlineProse:(()=>{const source=document.querySelector('#nowrap-source'),result=source.querySelector('.wupage-translation');
        return {height:source.getBoundingClientRect().height,width:source.clientWidth,scrollWidth:source.scrollWidth,
          mode:result?.dataset.wupageMode,whiteSpace:result?getComputedStyle(result).whiteSpace:null};})(),
      draft:document.querySelector('[contenteditable]').innerHTML,
      invalid:document.querySelectorAll('tr > .wupage-translation,tbody > .wupage-translation,table > .wupage-translation').length};`);
  const assertLayout = (before, after, label) => {
    assert.equal(after.invalid,0,'table structure preserved');
    assert.equal(after.draft,before.draft,'draft is never translated');
    for(const b of before.rows) {
      const a=after.rows.find(row=>row.key===b.key);
      assert.ok(a,`${label}: ${b.key} remains present`);
      assert.ok(Math.abs(a.box.height-b.box.height)<1,`${label}: ${a.key} row height ${b.box.height} -> ${a.box.height}`);
      assert.equal(a.outside,0,`${label}: translation remains inside original text line`);
      assert.deepEqual(a.cells.map(c=>({cls:c.cls,width:Math.round(c.box.width),x:Math.round(c.box.x)})),b.cells.map(c=>({cls:c.cls,width:Math.round(c.box.width),x:Math.round(c.box.x)})),`${label}: columns unchanged`);
      for(const t of a.translations) assert.equal(t.whiteSpace,'nowrap',`${label}: ${t.parent} remains on one line`);
    }
  };
  for(const width of [1400,760]) {
    await send('CLEAR_TRANSLATION'); await browser.resize(width,1000); await delay(200);
    await browser.evaluate(`const w=window.wrappedJSObject||window;w.mailOriginal=[...document.querySelectorAll('[data-mail-row],article,#flowing-prose,[contenteditable]')].map(e=>({e,html:e.innerHTML,nodes:[...e.querySelectorAll('*')]}));`);
    const before=await inspect(); assert.equal(before.rows.length,6,'all inbox fixtures are present');
    await browser.capture(`${width}-before.png`);
    // Dispatch without holding the control tab while the request completes.
    await browser.api('const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);void chrome.tabs.sendMessage(tab.id,{type:"TRANSLATE_PAGE"},{frameId:0});return true;',[url]);
    if(!baseline && width===1400) {
      await waitFor(()=>browser.evaluate('return !!document.querySelector("[data-mail-row] .wupage-translation-pending")'),Boolean,'pending translations');
      assertLayout(before,await inspect(),`${width}/pending`);
    }
    // Rich replacement can write into the bound original spans without adding
    // a translation element. Wait for the visible result rather than its DOM shape.
    await waitFor(()=>browser.evaluate(`return {
      untranslatedSubjects:[...document.querySelectorAll('.subject')].filter(e=>!e.textContent.includes(${JSON.stringify(translations.get(subject))})).length,
      untranslatedPreviews:[...document.querySelectorAll('.preview')].filter(e=>!e.textContent.includes(${JSON.stringify(translations.get(preview))})).length,
      flowingProse:document.querySelector('#nowrap-source').textContent.includes(${JSON.stringify(longInlineTranslation)})};`),
      state=>state.untranslatedSubjects===0&&state.untranslatedPreviews===0&&state.flowingProse,'mail and flowing prose translations');
    await delay(300);
    const callCount=calls.length;
    for(const mode of ['replace','bilingual','bilingual-accent']) {
      settings.translationDisplayMode=mode; await runtime({type:'SAVE_SETTINGS',settings});
      await waitFor(()=>browser.evaluate(`return [...document.querySelectorAll('.wupage-translation')].every(e=>e.dataset.wupageDisplayMode===${JSON.stringify(mode)})`),Boolean,mode);
      const after=await inspect(); await browser.capture(`${baseline?'baseline-':''}${width}-${mode}.png`);
      reports.push({width,mode,before,after});
      if(!baseline) {
        assertLayout(before,after,`${width}/${mode}`);
        assert.ok(after.proseHeight>20,'email body continues wrapping');
        assert.ok(after.inheritedNowrapProseHeight>20,'full email paragraph can relax inherited nowrap');
        assert.equal(after.flowingInlineProse.mode,'inline','short prose retains inline placement');
        assert.equal(after.flowingInlineProse.whiteSpace,'normal','flowing prose can wrap independently of placement');
        assert.ok(after.flowingInlineProse.height>40,'long translation of a short source actually wraps');
        assert.ok(after.flowingInlineProse.scrollWidth<=after.flowingInlineProse.width+1,'long inline prose does not overflow');
        for(const row of after.rows) {
          assert.ok(row.subject.includes(translations.get(subject)),'subject translated inside its original span');
          assert.ok(row.preview.includes(translations.get(preview)),'preview translated inside its original span');
        }
        assert.equal(calls.length,callCount,'display modes reuse translations');
      }
      if(!baseline) checks.push(`${width}px/${mode}: six compact table/grid/flex rows, stable columns, independent subject/preview, wrapping block and inline prose`);
    }
    if(!baseline) {
      await browser.evaluate(`for(const [kind,selector] of [['table','table:not(.flex) tbody'],['flex','.flex tbody']]){
        const holder=document.createElement('tbody');holder.innerHTML=kind==='flex'?${JSON.stringify(row('flex',3))}:${JSON.stringify(row('table',3))};
        const row=holder.firstElementChild;row.dataset.dynamic='true';document.querySelector(selector).append(row);}`);
      await waitFor(()=>browser.evaluate(`return [...document.querySelectorAll('[data-dynamic] .subject')].every(e=>e.textContent.includes(${JSON.stringify(translations.get(subject))}))
        && [...document.querySelectorAll('[data-dynamic] .preview')].every(e=>e.textContent.includes(${JSON.stringify(translations.get(preview))}));`),Boolean,'new inbox rows translated');
      assertLayout(before,await inspect(),`${width}/dynamic`);
      const dynamic=(await inspect()).rows.find(row=>row.key==='table-3');
      assert.ok(Math.abs(dynamic.box.height-before.rows[0].box.height)<1,'dynamically inserted inbox row keeps height');
      assert.equal(dynamic.outside,0,'dynamic result stays in clipped text line');
      assert.ok(dynamic.preview.includes(translations.get(preview)),'new row preview translated independently');
      const flexDynamic=(await inspect()).rows.find(row=>row.key==='flex-3');
      assert.ok(Math.abs(flexDynamic.box.height-before.rows.find(row=>row.key==='flex-1').box.height)<1,'dynamically inserted flex row keeps height');
      assert.equal(flexDynamic.outside,0,'dynamic flex result stays in clipped text line');
      assert.ok(flexDynamic.preview.includes(translations.get(preview)),'new flex row preview translated independently');
      await browser.evaluate('document.querySelectorAll("[data-dynamic]").forEach(row=>row.remove());');
      // Existing checkbox behavior and identity survive text replacement.
      assert.equal(await browser.evaluate('const e=document.querySelector("[data-mail-row] input");e.click();return e.checked;'),true);
      await browser.evaluate('document.querySelector("[data-mail-row] input").click();');
      checks.push(`${width}px: dynamic row translation and checkbox behavior${width===1400?', pending layout':''}`);
    }
    await send('CLEAR_TRANSLATION');
    const restoration=await browser.evaluate(`const w=window.wrappedJSObject||window;return w.mailOriginal.filter(({e,html,nodes})=>e.innerHTML!==html||!nodes.every(n=>n.isConnected)).map(({e,html})=>({before:html,after:e.innerHTML}));`);
    if(!baseline) assert.deepEqual(restoration,[],'original DOM and node identities restored');
    reports.push({width,restoration});
    settings.translationDisplayMode='replace'; await runtime({type:'SAVE_SETTINGS',settings});
  }
  await fs.writeFile(path.join(output,baseline?'baseline.json':'report.json'),JSON.stringify({...identity,checks,reports,calls},null,2));
  console.log(JSON.stringify({...identity,baseline,checks,output},null,2));
} catch(error) {
  await Promise.allSettled([
    browser?.capture('failure.png'),
    fs.writeFile(path.join(output,'failure.txt'),String(error.stack || error))
  ]);
  throw error;
} finally { if(browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
