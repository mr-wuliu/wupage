// Isolated real-browser regression for settings category geometry and scrolling.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),target=browserTarget(),record=process.argv.includes('--record');
const output=path.join(root,'.npm-cache/settings-layout',target.kind,record?'before':'after');
await fs.mkdir(output,{recursive:true});
let browser;
const checks=[],reports=[];
try{
  browser=await openExtensionBrowser(root,output,target.kind==='firefox');
  const identity=verifyBrowserIdentity(target,await browser.evaluate('return navigator.userAgent;'));
  const options=await browser.api('return chrome.runtime.getURL("options.html#generalSettings");');
  await browser.navigate(options);
  for(let i=0;i<100;i++){if(await browser.evaluate('return !!document.querySelector("#appearanceScheme option");'))break;await delay(50);}
  const geometry=()=>browser.evaluate(`const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,bottom:r.bottom};},panel=document.querySelector('.settings-panel:not([hidden])'),actions=document.querySelector('.settings-actions');return {panel:rect(panel),actions:rect(actions),gap:actions.getBoundingClientRect().top-panel.getBoundingClientRect().bottom,position:getComputedStyle(actions).position,viewport:innerWidth,client:document.documentElement.clientWidth,scrollY,overflow:document.documentElement.scrollWidth>innerWidth};`);
  for(const width of [1400,900,720,390]){
    await browser.resize(width,900);
    const categories=[];
    for(const name of ['general','selectionTranslation','autoTranslation','shortcut','appearance','provider','performance','statistics','appearance']){
      await browser.evaluate(`document.querySelector('.settings-nav a[aria-controls="${name}Settings"]').click();`);await delay(50);
      const value=await geometry();categories.push({name,...value});
      if(!record){
        assert.equal(value.overflow,false,`${width}: ${name} horizontal overflow`);
        assert.ok(Math.abs(value.panel.x-categories[0].panel.x)<.75,`${width}: switching to ${name} moves the settings panel horizontally`);
        assert.ok(Math.abs(value.panel.width-categories[0].panel.width)<.75,`${width}: switching to ${name} changes the settings panel width`);
        assert.ok(Math.abs(value.actions.x-value.panel.x)<.75&&Math.abs(value.actions.width-value.panel.width)<.75,'settings and save cards share their edges');
        assert.ok(value.gap>=15&&value.gap<=17,'save bar follows the settings card without covering it');
      }
    }
    await browser.evaluate(`for(const e of document.querySelectorAll('#appearanceSettings details'))e.open=true;`);
    const scrolling=[];
    for(const fraction of [0,.25,.5,.75,1]){
      await browser.evaluate(`window.scrollTo(0,(document.documentElement.scrollHeight-innerHeight)*${fraction});`);await delay(40);
      const value=await geometry();scrolling.push({fraction,...value});
      if(!record){assert.ok(value.gap>=15&&value.gap<=17,`${width}: cards overlap while scrolling`);assert.ok(Math.abs(value.actions.x-value.panel.x)<.75,'scrolling retains horizontal alignment');}
      if(fraction===.5||fraction===1)await browser.capture(`appearance-${width}-${fraction===1?'bottom':'middle'}.png`);
    }
    if(!record){
      const save=await browser.evaluate(`const b=document.querySelector('#save'),r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,visible:r.top>=0&&r.bottom<=innerHeight,clickable:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===b};`);
      assert.equal(save.visible,true);assert.equal(save.clickable,true,'last setting and save button remain accessible');
    }
    reports.push({width,categories,scrolling});
  }
  // Both appearance subpanels participate in the same flow; tab switching cannot move the shell.
  await browser.resize(1400,900);await browser.evaluate(`window.scrollTo(0,0);document.querySelector('#appearanceMenuTab').click();`);await delay(50);
  const menu=await geometry();
  await browser.evaluate(`document.querySelector('#appearanceColorsTab').click();`);await delay(50);const colors=await geometry();
  if(!record){assert.ok(Math.abs(menu.panel.x-colors.panel.x)<.75);assert.ok(menu.gap>=15&&menu.gap<=17);}
  checks.push('all settings categories keep identical horizontal geometry across long and short panels');
  checks.push('settings and save cards remain aligned with a constant gap at every scroll position');
  checks.push('appearance colors and menu tabs, expanded groups, narrow windows and save-button hit testing');
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({...identity,checks,reports},null,2));
  console.log(JSON.stringify({...identity,record,checks,changes:reports.map(r=>({width:r.width,horizontalDelta:Math.max(...r.categories.map(c=>c.panel.x))-Math.min(...r.categories.map(c=>c.panel.x)),minimumGap:Math.min(...r.scrolling.map(s=>s.gap))})),output},null,2));
}finally{await browser?.close();}
