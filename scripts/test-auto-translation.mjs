// Real MV3 regression using local pages and a local translation service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=path.join(root,'.npm-cache/auto-translation');
await fs.mkdir(output,{recursive:true});
const moduleName=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(path.isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const english='A quiet afternoon is a good time to read. Automatic translation helps readers explore articles in other languages while keeping the original text available for comparison.';
const chinese='这是一个中文页面，内容已经使用读者所选择的目标语言，不应再次发起自动翻译。浏览器应根据实际正文识别语言，而不是只相信网页可能填写错误的语言标签。';
const requests=[];
const translation='.wupage-translation:not(.wupage-translation-pending)';
const server=createServer(async(req,res)=>{
  if(req.method==='POST'){
    let body='';for await(const chunk of req)body+=chunk;
    const payload=JSON.parse(body);requests.push(payload.texts);
    const translated='自动翻译让阅读不同语言的文章更加方便，原文会保留以便随时对照。';
    res.setHeader('content-type','application/json');res.end(JSON.stringify({translations:payload.texts.map(text=>
      (text.match(/⟪WUPAGESEGMENT\d+⟫/g)||['']).map(marker=>marker+'\n'+translated).join('\n'))}));return;
  }
  res.setHeader('content-type','text/html;charset=utf-8');
  const body=req.url==='/zh'?chinese:req.url==='/unknown'?'1234567890 '.repeat(20):english;
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Automatic translation</title></head><body><main>${req.url==='/dynamic'?'':`<p>${body}</p>`}</main>${req.url==='/dynamic'?`<script>setTimeout(()=>{document.querySelector('main').innerHTML='<p>${english}</p>';},800)</script>`:''}</body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const context=await chromium.launchPersistentContext(path.join(output,`profile-${Date.now()}`),{
  ...(process.env.PDF_TEST_BROWSER?{executablePath:process.env.PDF_TEST_BROWSER}:{channel:'chromium'}),
  headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--lang=zh-CN', '--enable-unsafe-extension-debugging'],viewport:{width:1100,height:1000}
});
const errors=[];
try{
  const session=await context.browser().newBrowserCDPSession();
  await session.send('Extensions.loadUnpacked',{path:path.join(root,'dist')});await session.detach();
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const extension=`chrome-extension://${new URL(worker.url()).host}`;
  const options=await context.newPage();options.setDefaultTimeout(8000);await options.goto(`${extension}/options.html#providerSettings`);
  await options.locator('#providerTriggerLabel').waitFor();
  await options.evaluate(async origin=>{
    const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    settings.activeProviderId='http-template';settings.cacheEnabled=false;
    Object.assign(settings.providers.find(provider=>provider.id==='http-template'),{
      url:origin+'/translate',method:'POST',headers:{'Content-Type':'application/json'},
      bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'
    });
    await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});
  },origin);
  await options.reload();await options.locator('#providerForm [data-field="url"]').waitFor();
  await options.locator('.settings-nav a[href="#autoTranslationSettings"]').click();
  assert.equal(await options.locator('#autoTranslateEnabled').isChecked(),false);
  assert.equal(await options.locator('#autoTranslateNonTargetOption').isVisible(),false);
  await options.locator('#autoTranslateEnabled').locator('..').click();
  assert.equal(await options.locator('#autoTranslateNonTargetOption').isVisible(),true);
  assert.equal(await options.locator('#autoTranslateNonTarget').isChecked(),true,'language matching should be selected on first enable');
  const controls=await options.locator('.auto-translation-controls').evaluate(row=>{
    const master=row.querySelector('.auto-translation-master').getBoundingClientRect();
    const option=row.querySelector('.auto-language-option').getBoundingClientRect();
    return {masterCenter:master.y+master.height/2,optionCenter:option.y+option.height/2,masterRight:master.right,optionLeft:option.x};
  });
  assert.ok(Math.abs(controls.masterCenter-controls.optionCenter)<1&&controls.optionLeft>controls.masterRight,'automatic controls must share a row');
  await options.locator('#autoTranslateNonTarget').uncheck();
  await options.locator('#autoTranslateEnabled').locator('..').click();
  assert.equal(await options.locator('#autoTranslateNonTargetOption').isVisible(),false);
  await options.locator('#autoTranslateEnabled').locator('..').click();
  assert.equal(await options.locator('#autoTranslateNonTarget').isChecked(),false,'turning the master off and on must retain the checkbox choice');
  await options.locator('#autoTranslateSites input[data-preset="github.com"]').check();
  await options.locator('#addAutoTranslateSite').click();
  await options.locator('.auto-site-row:nth-last-child(2) .auto-site-pattern').fill(origin+'/allow/*');
  await options.locator('#save').click();
  await options.waitForFunction(()=>document.querySelector('#status').textContent==='已保存。');
  await options.reload();await options.locator('.auto-site-row').first().waitFor();
  assert.equal(await options.locator('#autoTranslateEnabled').isChecked(),true);
  assert.equal(await options.locator('#autoTranslateNonTargetOption').isVisible(),true);
  assert.equal(await options.locator('#autoTranslateNonTarget').isChecked(),false);
  assert.equal(await options.locator('#autoTranslateSites input[data-preset="github.com"]').isChecked(),true);
  const presetRows=await options.locator('#autoTranslateSites > .auto-site-row').evaluateAll(rows=>rows.map(row=>{
    const {x,y,width,bottom}=row.getBoundingClientRect();return {x,y,width,bottom};
  }));
  assert.equal(presetRows.length,7);
  for(let i=1;i<presetRows.length;i++){
    assert.equal(presetRows[i].x,presetRows[0].x);
    assert.equal(presetRows[i].width,presetRows[0].width);
    assert.ok(presetRows[i].y>=presetRows[i-1].bottom,'preset sites must form a vertical list');
  }
  await options.waitForTimeout(180);
  await options.locator('#autoTranslationSettings').screenshot({path:path.join(output,'settings.png')});
  for(const width of [390,320]){
    await options.setViewportSize({width,height:1000});
    assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`settings overflow at ${width}`);
    await options.locator('#autoTranslationSettings').screenshot({path:path.join(output,`settings-${width}.png`)});
  }
  await options.setViewportSize({width:1100,height:1000});
  await options.locator('.auto-site-row[data-site-id="preset-reddit.com"] button').click();
  await options.locator('#save').click();
  await options.waitForFunction(()=>document.querySelector('#status').textContent==='已保存。');
  await options.reload();await options.locator('#addAutoTranslateSite').waitFor();
  assert.equal(await options.locator('.auto-site-row[data-site-id="preset-reddit.com"]').count(),0,'deleted presets must not return');
  assert.equal(await options.locator('#autoTranslateSites input[data-preset="github.com"]').isChecked(),true);
  async function openPage(route){
    const page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(origin+route);await page.bringToFront();return page;
  }
  const allowed=await openPage('/allow/article');
  await allowed.locator(translation).first().waitFor({timeout:12000});
  let baseline=requests.length;
  const tab=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0],origin+'/allow/article');
  await worker.evaluate(async id=>chrome.tabs.sendMessage(id,{type:'CLEAR_TRANSLATION'}),tab.id);
  await allowed.evaluate(()=>{document.querySelector('main').insertAdjacentHTML('beforeend','<p>A later update after manually restoring the original text.</p>');});
  await allowed.waitForTimeout(800);
  assert.equal(await allowed.locator('.wupage-translation').count(),0);
  assert.equal(requests.length,baseline,'manual restoration was overridden');await allowed.close();

  const spa=await openPage('/allow/spa');
  await spa.locator(translation).first().waitFor({timeout:12000});baseline=requests.length;
  await spa.evaluate(()=>{history.pushState({},'','/deny');document.querySelector('main').innerHTML='<p>A new page outside the selected path must stay in its original language.</p>';});
  await spa.waitForTimeout(900);
  assert.equal(await spa.locator('.wupage-translation').count(),0);
  assert.equal(requests.length,baseline,'translated outside the selected path');
  await spa.evaluate(()=>{history.pushState({},'','/allow/next');document.querySelector('main').innerHTML='<p>A new article inside the selected path should be translated automatically.</p>';});
  await spa.locator(translation).first().waitFor({timeout:12000});assert.ok(requests.length>baseline);await spa.close();

  await options.bringToFront();await options.locator('#autoTranslateNonTarget').locator('..').click();await options.locator('#save').click();
  await options.waitForFunction(()=>document.querySelector('#status').textContent==='已保存。');
  for(const route of ['/zh','/unknown']){
    const page=await openPage(route);baseline=requests.length;await page.waitForTimeout(1000);
    assert.equal(requests.length,baseline,`unexpected automatic request on ${route}`);await page.close();
  }
  const foreign=await openPage('/foreign');await foreign.locator(translation).first().waitFor({timeout:12000});await foreign.close();
  const dynamic=await openPage('/dynamic');await dynamic.locator(translation).first().waitFor({timeout:12000});await dynamic.close();
  await options.evaluate(async()=>{
    const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    settings.autoTranslation={enabled:false,nonTargetLanguage:false,presetSites:[],customSites:[]};
    await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});
  });
  const quick=await openPage('/quick');
  const quickTab=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0],origin+'/quick');
  const popup=await context.newPage();await popup.setViewportSize({width:332,height:760});
  await popup.addInitScript(tab=>{chrome.tabs.query=async()=>[tab];},quickTab);
  await popup.goto(`${extension}/popup.html`);
  await popup.waitForFunction(()=>!document.querySelector('#autoTranslation').disabled);
  assert.equal(await popup.locator('#autoTranslation').getAttribute('aria-pressed'),'false');
  assert.equal(await popup.locator('#addAutoTranslationSite').isVisible(),false);
  await popup.locator('#autoTranslation').click();
  await popup.waitForFunction(()=>document.querySelector('#autoTranslation').getAttribute('aria-pressed')==='true');
  const firstUse=await popup.evaluate(async()=>(await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data.autoTranslation);
  assert.deepEqual(firstUse,{enabled:true,nonTargetLanguage:true,presetSites:[],customSites:[]});
  await quick.bringToFront();await quick.locator(translation).first().waitFor({timeout:12000});
  await popup.bringToFront();
  await popup.waitForFunction(()=>document.querySelector('#pageToggle').textContent==='显示全文');
  await popup.waitForTimeout(180);
  await popup.locator('.popup').screenshot({path:path.join(output,'popup-switch.png')});
  const addSite=popup.locator('#addAutoTranslationSite');
  await addSite.waitFor({state:'visible'});
  for(const width of [264,320]){
    await popup.setViewportSize({width,height:760});
    const layout=await popup.evaluate(()=>{
      const automatic=document.querySelector('#autoTranslation').getBoundingClientRect();
      const add=document.querySelector('#addAutoTranslationSite').getBoundingClientRect();
      return {overflow:document.documentElement.scrollWidth>innerWidth,beside:add.left>=automatic.right,
        centered:Math.abs(add.y+add.height/2-automatic.y-automatic.height/2)<1};
    });
    assert.equal(layout.overflow,false);assert.equal(layout.beside,true);assert.equal(layout.centered,true);
    await popup.locator('.popup').screenshot({path:path.join(output,`popup-add-site-${width}.png`)});
  }
  await addSite.click();
  await popup.waitForFunction(()=>document.querySelector('#addAutoTranslationSite').querySelector('svg')?.dataset.icon==='tick');
  assert.equal(await addSite.isDisabled(),false);
  const addedRules=await popup.evaluate(async()=>(await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data.autoTranslation);
  assert.equal(addedRules.customSites.length,1);assert.equal(addedRules.customSites[0].pattern,new URL(origin).host);
  assert.equal(addedRules.customSites[0].enabled,true);assert.equal(addedRules.nonTargetLanguage,true);
  await popup.reload();await popup.locator('#translationDisplayMode:enabled').waitFor();
  assert.equal(await addSite.locator('svg').getAttribute('data-icon'),'tick');assert.equal(await addSite.isDisabled(),false);
  await addSite.click();await popup.waitForFunction(()=>document.querySelector('#addAutoTranslationSite').querySelector('svg')?.dataset.icon==='plus');
  const excludedRules=await popup.evaluate(async()=>(await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data.autoTranslation);
  assert.equal(excludedRules.enabled,true);assert.equal(excludedRules.nonTargetLanguage,true);
  assert.deepEqual(excludedRules.excludedSites,[new URL(origin).host]);
  await quick.bringToFront();await quick.waitForFunction(()=>!document.querySelector('.wupage-translation'));
  await quick.reload();await quick.locator('#wupage-floating-ball').waitFor({state:'visible'});
  await quick.waitForTimeout(750);assert.equal(await quick.locator(translation).count(),0,'exclusion must survive reload and override the language rule');
  await options.reload();
  await options.getByRole('button',{name:`取消排除 ${new URL(origin).host}`,exact:true}).waitFor({state:'visible'});
  await options.locator('#autoTranslationSettings').screenshot({path:path.join(output,'settings-excluded-site.png')});
  await options.locator('#save').click();await options.waitForFunction(()=>document.querySelector('#status').textContent.includes('保存'));
  const savedExclusion=await options.evaluate(async()=>(await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data.autoTranslation);
  assert.deepEqual(savedExclusion.excludedSites,[new URL(origin).host]);
  await popup.reload();await popup.locator('#translationDisplayMode:enabled').waitFor();
  assert.equal(await addSite.locator('svg').getAttribute('data-icon'),'plus');
  await addSite.click();await popup.waitForFunction(()=>document.querySelector('#addAutoTranslationSite').querySelector('svg')?.dataset.icon==='tick');
  await quick.bringToFront();await quick.locator(translation).first().waitFor({timeout:12000});
  await options.reload();await options.waitForFunction(host=>[...document.querySelectorAll('#autoTranslateSites .auto-site-pattern')].some(input=>input.value===host),new URL(origin).host);
  const savedRow=options.locator('.auto-site-row').filter({has:options.locator('.auto-site-pattern')});
  assert.equal(await savedRow.locator('.auto-site-pattern').evaluateAll((inputs,host)=>inputs.filter(input=>input.value===host).length,new URL(origin).host),1);
  await popup.locator('#autoTranslation').click();
  await quick.waitForFunction(()=>!document.querySelector('.wupage-translation'));
  assert.equal(await addSite.isVisible(),false);
  await popup.close();await quick.bringToFront();
  await options.evaluate(async()=>{
    const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    settings.autoTranslation={enabled:false,nonTargetLanguage:false,presetSites:['github.com'],customSites:[]};
    await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});
  });
  await quick.locator('#wupage-floating-ball').hover();
  const floatingAuto=quick.locator('#wupage-floating-menu [data-action="auto-translation"]');
  await floatingAuto.waitFor({state:'visible'});
  assert.equal(await floatingAuto.getAttribute('aria-pressed'),'false');
  await floatingAuto.click();
  await quick.waitForFunction(()=>document.querySelector('[data-action="auto-translation"]').getAttribute('aria-pressed')==='true');
  assert.equal(await floatingAuto.getAttribute('aria-pressed'),'true');
  const floatingAdd=quick.locator('#wupage-floating-menu [data-action="add-auto-site"]');
  await floatingAdd.waitFor({state:'visible'});await quick.waitForFunction(()=>!document.querySelector('[data-action="add-auto-site"]').disabled);
  assert.equal(await quick.locator(translation).count(),0,'a site-only configuration must wait until the current site is added');
  await floatingAdd.click();await quick.locator(translation).first().waitFor({timeout:12000});
  await quick.waitForFunction(()=>document.querySelector('[data-action="add-auto-site"]').querySelector('svg')?.dataset.icon==='tick');
  const floatingRules=await options.evaluate(async()=>(await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data.autoTranslation);
  assert.equal(floatingRules.nonTargetLanguage,false);assert.deepEqual(floatingRules.presetSites,['github.com']);
  assert.equal(floatingRules.customSites.length,1);assert.equal(floatingRules.customSites[0].pattern,new URL(origin).host);
  await quick.locator('#wupage-floating-menu').screenshot({path:path.join(output,'floating-add-site.png')});
  await floatingAdd.click();await quick.waitForFunction(()=>document.querySelector('[data-action="add-auto-site"]').querySelector('svg')?.dataset.icon==='plus');
  await quick.waitForFunction(()=>!document.querySelector('.wupage-translation'));
  assert.equal(await floatingAuto.getAttribute('aria-pressed'),'true');
  await floatingAdd.click();await quick.locator(translation).first().waitFor({timeout:12000});
  await quick.waitForFunction(()=>document.querySelector('[data-action="add-auto-site"]').querySelector('svg')?.dataset.icon==='tick');
  await floatingAuto.click();await quick.waitForFunction(()=>!document.querySelector('.wupage-translation'));
  await quick.close();
  assert.deepEqual(errors,[]);
  const report={passed:true,persistedRules:true,inlineSiteEditing:true,deletedPresetPreserved:true,conditionalLanguageCheckbox:true,defaultLanguageSelection:true,narrowWidths:[390,320],siteMatch:true,manualStopRespected:true,
    spaPathBoundaries:true,targetLanguageSkipped:true,unknownLanguageSkipped:true,foreignLanguage:true,dynamicContent:true,
    popupSwitch:true,floatingSwitch:true,firstUseLanguageRule:true,pageActionSynchronized:true,addCurrentSite:true,duplicateSitePrevented:true,addedRuleInSettings:true,siteAdditionStartsTranslation:true,siteToggleExclusion:true,exclusionOverridesLanguage:true,exclusionPersists:true,requests:requests.length};
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,output}));
}catch(error){
  const pages=await Promise.all(context.pages().map(async page=>({url:page.url(),state:await page.evaluate(()=>({
    visible:document.visibilityState,text:document.querySelector('main')?.textContent?.slice(0,220),
    floating:!!document.querySelector('#wupage-floating-ball')
  })).catch(()=>null)})));
  await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({pages,requests,errors},null,2));
  console.error(JSON.stringify({pages,requestCount:requests.length,errors}));throw error;
}finally{await context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
