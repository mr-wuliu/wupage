import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),target=browserTarget();
const output=path.join(root,'.npm-cache/local-shortcuts',target.kind),calls=[],checks=[];
await fs.mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
  if(req.url==='/translate'&&req.method==='POST'){
    let raw='';for await(const part of req)raw+=part;const data=JSON.parse(raw);calls.push(data);
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({translations:data.texts.map(text=>text.includes('⟪WUPAGESEGMENT')
      ?text.replace(/(⟪WUPAGESEGMENT\d+⟫\n)/gu,'$1译文：'):'译文：'+text)}));return;
  }
  res.writeHead(200,{'content-type':'text/html;charset=utf-8'});
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:36px;font:18px/1.7 Arial}iframe{display:block;width:650px;height:170px}p{max-width:720px}</style><body>
    <p id="paragraph">A complete paragraph for a reader to translate.</p><p id="select">Select this sentence to open the translation card.</p><textarea aria-label="Page draft">Private draft</textarea>
    ${req.url==='/frame'?'':'<iframe src="/frame"></iframe>'}</body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const waitFor=async(read,test,label)=>{let value;const end=Date.now()+30000;do{value=await read();if(test(value))return value;await delay(100);}while(Date.now()<end);throw Error(label+': '+JSON.stringify(value));};
let browser;
try{
  browser=await openExtensionBrowser(root,output,target.kind==='firefox');
  const identity=verifyBrowserIdentity(target,await browser.evaluate('return navigator.userAgent;'));
  const runtime=async request=>{const result=await browser.api('return chrome.runtime.sendMessage(input[0]);',[request]);assert.equal(result?.ok,true,JSON.stringify(result));return result.data;};
  const initial=await runtime({type:'GET_SETTINGS'});
  initial.providers.push({type:'http-template',id:'local-key-test',label:'Local shortcut test',method:'POST',url:origin+'/translate',headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
  Object.assign(initial,{activeProviderId:'local-key-test',floatingBallEnabled:true,cacheEnabled:false,sourceLang:'en',targetLang:'zh-CN',translationDisplayMode:'bilingual'});
  initial.selectionTranslation.enabled=true;
  await runtime({type:'SAVE_SETTINGS',settings:initial});
  const options=await browser.api('return chrome.runtime.getURL("options.html#shortcutSettings");');
  await browser.navigate(options);await browser.resize(1400,1100);
  await waitFor(()=>browser.evaluate('return !!document.querySelector("#shortcut-local-selection-submit:not(:disabled)");'),Boolean,'local editor');
  const record=async(name,keys)=>{await browser.evaluate(`document.querySelector('[data-local-command="${name}"]').focus();`);await browser.press(keys);};
  await browser.evaluate(`const e=document.querySelector('[data-local-command="paragraph-click"]');e.value='Alt+Shift';e.dispatchEvent(new Event('change',{bubbles:true}));`);
  await record('selection-submit','Alt+Enter');
  await record('dismiss-overlays','Alt+Escape');
  await record('floating-activate','Alt+Shift+J');
  await record('floating-menu','Alt+Shift+K');
  await record('selection-submit','Alt+Shift+Y');
  assert.match(await browser.evaluate('return document.querySelector("#shortcut-error-selection-submit").textContent;'),/已用于/);
  await browser.press('Escape');
  await browser.evaluate('document.querySelector("#save").click();');
  const saved=await waitFor(()=>runtime({type:'GET_SETTINGS'}),value=>value.localShortcuts['selection-submit']==='Alt+Enter','saved local bindings');
  assert.equal(saved.localShortcuts['paragraph-click'],'Alt+Shift');assert.equal(saved.localShortcuts['dismiss-overlays'],'Alt+Escape');
  await browser.navigate(options);await waitFor(()=>browser.evaluate('return document.querySelector("[data-local-command=selection-submit]")?.value;'),value=>value==='Alt＋Enter','persisted recorder');
  await browser.capture('settings-desktop.png');
  await browser.resize(390,1100);
  assert.equal(await browser.evaluate('return document.documentElement.scrollWidth<=innerWidth;'),true,'narrow editor does not overflow');
  await browser.capture('settings-narrow.png');
  checks.push('local recorder, modifier selector, global conflict validation, cancellation, saving, reopening and responsive settings');
  await browser.resize(1400,1100);await browser.navigate(origin+'/article');
  await waitFor(()=>browser.evaluate('return document.querySelector("#wupage-floating-hitbox")?.dataset.positionReady==="true"&&!!document.querySelector("#wupage-selection-tools");'),Boolean,'page tools');
  await runtime({type:'SET_PARAGRAPH_MODE',enabled:true});
  await waitFor(()=>browser.evaluate('return document.documentElement.classList.contains("wupage-paragraph-mode")&&document.querySelector("iframe").contentDocument.documentElement.classList.contains("wupage-paragraph-mode");'),Boolean,'paragraph mode in top and embedded documents');
  await browser.evaluate(`const w=window.wrappedJSObject||window;w.localClickEvents=[];
    for(const d of [document,document.querySelector('iframe').contentDocument])d.addEventListener('click',event=>w.localClickEvents.push({frame:d!==document,
      target:event.target.id,alt:event.altKey,shift:event.shiftKey,ctrl:event.ctrlKey,prevented:event.defaultPrevented,x:event.clientX,y:event.clientY}),true);`);
  const clickParagraph=async(frame,custom)=>{
    const point=await browser.evaluate(`const f=document.querySelector('iframe'),d=${frame?'f.contentDocument':'document'},r=d.querySelector('#paragraph').getBoundingClientRect(),outer=${frame?'f.getBoundingClientRect()':'{left:0,top:0}'};return {x:outer.left+r.left+r.width/2+${frame?'f.clientLeft':'0'},y:outer.top+r.top+r.height/2+${frame?'f.clientTop':'0'}};`);
    await browser.pointer([{type:'move',...point},{type:'down'},{type:'up'}],custom?['Alt','Shift']:['Control']);
  };
  await clickParagraph(false,false);await delay(160);assert.equal(calls.length,0,'old Ctrl click is disabled');
  await clickParagraph(false,true);
  await waitFor(()=>browser.evaluate('return document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)").length;'),value=>value===1,'custom top paragraph click');
  await clickParagraph(true,false);await delay(160);
  assert.equal(await browser.evaluate('return document.querySelector("iframe").contentDocument.querySelectorAll(".wupage-translation").length;'),0);
  await clickParagraph(true,true);
  await waitFor(()=>browser.evaluate('return document.querySelector("iframe").contentDocument.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)").length;'),value=>value===1,'custom iframe paragraph click');
  assert.match(await browser.evaluate('return document.querySelector("#wupage-paragraph-mode-hint").textContent;'),/Alt.*Shift/);
  checks.push('custom modifier click works immediately in top and embedded documents; old Ctrl click does not translate; hints follow the configuration');
  await runtime({type:'SET_PARAGRAPH_MODE',enabled:false});
  await browser.evaluate(`const e=document.querySelector('#select'),r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new MouseEvent('pointerup',{bubbles:true}));`);
  await waitFor(()=>browser.evaluate('return !!document.querySelector("#wupage-selection-tools").shadowRoot.querySelector(".trigger-dot,.trigger-line");'),Boolean,'selection trigger');
  await browser.evaluate('document.querySelector("#wupage-selection-tools").shadowRoot.querySelector(".trigger-dot,.trigger-line").click();');
  await waitFor(()=>browser.evaluate('return !document.querySelector("#wupage-selection-tools").shadowRoot.querySelector(".card").hidden;'),Boolean,'selection card');
  await browser.evaluate(`const e=document.querySelector('#wupage-selection-tools').shadowRoot.querySelector('.word');e.value='A newly edited sentence to translate.';e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();`);
  const before=calls.length;
  await browser.press('Control+Enter');await delay(160);assert.equal(calls.length,before,'old submission does not request');
  await browser.press('Alt+Enter');await waitFor(()=>calls.length,value=>value>before,'new submission shortcut');
  await browser.press('Escape');assert.equal(await browser.evaluate('return document.querySelector("#wupage-selection-tools").shadowRoot.querySelector(".card").hidden;'),false);
  await browser.press('Alt+Escape');assert.equal(await browser.evaluate('return document.querySelector("#wupage-selection-tools").shadowRoot.querySelector(".card").hidden;'),true);
  checks.push('actual custom card submission and dismissal work, old shortcuts stop working, and ordinary text editing stays local');
  // Paragraph-click checks leave actual translations visible. Restore them
  // before testing a fresh page start through the floating control.
  await browser.api(`const tab=(await chrome.tabs.query({})).find(tab=>tab.url===input[0]);
    const result=await chrome.tabs.sendMessage(tab.id,{type:'CLEAR_TRANSLATION'});if(!result.ok)throw new Error(result.error);`,[origin+'/article']);
  await waitFor(()=>browser.evaluate('return document.querySelectorAll(".wupage-translation").length;'),value=>value===0,'paragraph results restored before floating scenario');
  await browser.evaluate('getSelection()?.removeAllRanges();document.querySelector("#wupage-floating-ball").focus();');
  const beforeBall=calls.length;await browser.press('Enter');await delay(160);assert.equal(calls.length,beforeBall,'unbound native Enter cannot activate the floating button');
  await browser.press('Alt+Shift+K');
  await waitFor(()=>browser.evaluate('return document.activeElement?.tagName;'),value=>value==='SELECT','custom enter menu shortcut');
  await browser.press('Escape');assert.equal(await browser.evaluate('return document.querySelector("#wupage-floating-menu").hidden;'),false);
  await browser.press('Alt+Escape');assert.equal(await browser.evaluate('return document.querySelector("#wupage-floating-menu").hidden;'),true);
  await browser.evaluate('document.querySelector("#wupage-floating-ball").focus();');await browser.press('Alt+Shift+J');
  await waitFor(()=>calls.length,value=>value>beforeBall,'custom floating translation');
  await browser.press('Alt+Shift+J');
  await waitFor(()=>browser.evaluate('return document.querySelectorAll(".wupage-translation").length;'),value=>value===0,'stop floating translation');
  checks.push('floating translation and menu use separate custom keys; native Enter is suppressed after rebinding; menu dismissal follows the configured key');
  const off=await runtime({type:'GET_SETTINGS'});off.shortcutEnabled['paragraph-click']=false;
  off.localShortcuts['dismiss-overlays']='Control+Shift+Space'.replace('Control','Ctrl');
  await runtime({type:'SAVE_SETTINGS',settings:off});
  await runtime({type:'SET_PARAGRAPH_MODE',enabled:true});
  const beforeOff=calls.length;await clickParagraph(false,true);await clickParagraph(true,true);await delay(180);assert.equal(calls.length,beforeOff);
  await browser.evaluate('document.querySelector("#wupage-floating-ball").focus();');await browser.press('Alt+Shift+K');
  await browser.press('Alt+Escape');assert.equal(await browser.evaluate('return document.querySelector("#wupage-floating-menu").hidden;'),false);
  await browser.press('Control+Shift+Space');assert.equal(await browser.evaluate('return document.querySelector("#wupage-floating-menu").hidden;'),true);
  checks.push('live settings updates replace dismissal keys and disable paragraph clicks in top and embedded content without reloading');
  console.log(JSON.stringify({...identity,checks,calls:calls.length,output},null,2));
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({...identity,checks},null,2));
}catch(error){
 const events=await browser?.evaluate('return (window.wrappedJSObject||window).localClickEvents;').catch(()=>undefined);
 await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),events,calls},null,2));
 await browser?.capture('failure.png').catch(()=>{});throw error;
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
