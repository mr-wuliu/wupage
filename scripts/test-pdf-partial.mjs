// Real interrupted HTTP bodies, isolated browser profiles, no external service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { browserTarget } from './lib/browser-target.mjs';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),target=browserTarget(),output=path.join(root,'.npm-cache/pdf-partial',target.kind);
await fs.mkdir(output,{recursive:true});
const document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.TimesRoman);
for(let number=1;number<=10;number++){
 const page=document.addPage([600,900]);
 for(let index=0;index<(number===1?8:1);index++)page.drawText(`Page ${number} paragraph ${String.fromCharCode(65+index)} contents.`,{x:40,y:820-index*85,size:11,font});
}
const bytes=await document.save(),calls=[],seen=new Set();let phase='partial',aborted=0;
const timers=new Set();
const server=createServer(async(request,response)=>{
 if(request.method==='GET')return response.writeHead(200,{'content-type':'application/pdf'}).end(bytes);
 try{let body='';for await(const chunk of request)body+=chunk;
  const texts=JSON.parse(JSON.parse(body).messages.at(-1).content).texts;calls.push({phase,texts});
  response.on('close',()=>{if(!response.writableFinished)aborted++;});
  const failing=texts.some(text=>/Page 1 paragraph [E-H]/u.test(text));
  if(phase==='jump'&&failing)return;
  const key=JSON.stringify(texts);
  if(failing&&(phase==='partial'||phase==='recover'&&texts.length>1&&!seen.has(key))){
   seen.add(key);response.writeHead(200,{'content-type':'application/json'});response.write('{"choices":[');
   const timer=setTimeout(()=>{timers.delete(timer);response.destroy();},50);timers.add(timer);return;
  }
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({choices:[{message:{content:JSON.stringify(texts.map(text=>'译文：'+text))}}]}));
 }catch(error){response.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;let browser;
async function wait(source,label,timeout=15_000){const end=Date.now()+timeout;while(Date.now()<end){if(await browser.evaluate(source))return;await delay(80);}throw new Error('Timed out: '+label);}
try{
 browser=await openExtensionBrowser(root,output,target.kind==='firefox');
 const base=await browser.api(`const settings=(await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data;
  Object.assign(settings,{activeProviderId:'deepseek',sourceLang:'en',targetLang:'zh-CN',cacheEnabled:false,pdfTranslationPageRadius:0,concurrency:2});
  Object.assign(settings.providers.find(p=>p.id==='deepseek'),{baseURL:input[0]+'/v1',apiKey:'test-only',performanceMode:'custom',concurrency:2,chunkSize:1600});
  await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});return chrome.runtime.getURL('pdf.html');`,[origin]);
 const open=()=>browser.navigate(base+'?url='+encodeURIComponent(origin+'/fixture.pdf')+'&translate=1');
 await open();
 await wait(`return document.querySelectorAll('article[data-page="1"] .translation-block-text').length===4;`,'first group visible');
 await browser.evaluate(`const text=document.querySelector('article[data-page="1"] .translation-block-text');text.focus();text.textContent='手动校对的第一段';text.dispatchEvent(new Event('input',{bubbles:true}));text.dataset.preservedEdit='true';`);
 await wait(`return !document.querySelector('#translateDocument').disabled&&!!document.querySelector('article[data-page="1"] .has-error');`,'bounded retries finish');
 const partial=await browser.evaluate(`const row=document.querySelector('article[data-page="1"]'),text=row.querySelector('.translation-block-text');return{blocks:row.querySelectorAll('.translation-block-text').length,prompt:row.querySelector('.translation-prompt').textContent,edited:text?.dataset.preservedEdit==='true',focused:document.activeElement===text,text:text?.textContent};`);
 assert.equal(partial.blocks,4);assert.ok(partial.prompt.includes('4 / 8'));assert.ok(partial.edited&&partial.focused);assert.equal(partial.text,'手动校对的第一段');
 assert.equal(calls.filter(call=>call.texts.some(text=>/paragraph A/u.test(text))).length,1);
 await browser.capture('partial-failure.png');
 phase='fast';const beforeRetry=calls.length;
 await browser.evaluate(`document.querySelector('article[data-page="1"] .translation-retry').click();`);
 await wait(`return !document.querySelector('#translateDocument').disabled&&!document.querySelector('article[data-page="1"] .has-error');`,'retry only missing');
 assert.ok(calls.slice(beforeRetry).every(call=>call.texts.every(text=>/paragraph [E-H]/u.test(text))));
 assert.equal(await browser.evaluate(`return document.querySelector('article[data-page="1"] .translation-block-text').textContent;`),'手动校对的第一段');
 assert.equal(await browser.evaluate(`return document.querySelectorAll('article[data-page="1"] .translation-block-text').length;`),8);

 phase='recover';seen.clear();await open();
 await wait(`return !document.querySelector('#translateDocument').disabled&&document.querySelector('#statusToast').textContent.includes('翻译完成');`,'automatic recovery');
 assert.equal(await browser.evaluate(`return document.querySelectorAll('article[data-page="1"] .translation-block-text').length;`),8);
 assert.equal(await browser.evaluate('return document.querySelectorAll(".has-error").length;'),0);

 phase='jump';await open();
 await wait(`return document.querySelectorAll('article[data-page="1"] .translation-block-text').length===4;`,'partial before jump');
 const beforeJump=calls.length,abortedBefore=aborted;
 await browser.evaluate(`document.querySelector('article[data-page="10"]').scrollIntoView({block:'start'});`);
 await wait(`return document.querySelectorAll('article[data-page="10"] .translation-block-text').length===1;`,'new reading page preempts old stall');
 assert.ok(calls.slice(beforeJump).some(call=>call.texts.some(text=>text.startsWith('Page 10'))));
 assert.ok(aborted>abortedBefore);
 assert.equal(await browser.evaluate(`return document.querySelectorAll('article[data-page="1"] .translation-block-text').length;`),4);
 phase='fast';const beforeReturn=calls.length;
 await browser.evaluate(`document.querySelector('article[data-page="1"]').scrollIntoView({block:'start'});`);
 await wait(`return document.querySelectorAll('article[data-page="1"] .translation-block-text').length===8;`,'resume old partial page');
 assert.ok(calls.slice(beforeReturn).every(call=>call.texts.every(text=>/paragraph [E-H]/u.test(text))));
 const report={passed:true,browser:target.kind,partial,requests:calls.length,aborted,
  checks:['actual interrupted HTTP bodies','partial page retained','bounded recovery','manual edit and focus retained','missing-only retry','reading preemption','resume after jump']};
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){if(browser){console.error(await browser.evaluate(`return{status:document.querySelector('#statusToast')?.textContent,prompt:document.querySelector('.translation-prompt')?.textContent};`));await browser.capture('failure.png').catch(()=>{});}throw error;}
finally{await browser?.close().catch(()=>{});for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
