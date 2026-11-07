// Optional live OCR regression. Downloads the public models into an isolated
// browser profile; translation uses a local stub and no personal credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=path.join(root,'.npm-cache/ocr-flow');
await fs.mkdir(output,{recursive:true});
const moduleName=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(path.isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
let requests=0;
const server=createServer(async(request,response)=>{
  if(request.method==='POST'){
    let body='';for await(const chunk of request)body+=chunk;
    const {texts}=JSON.parse(body);requests++;
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({translations:texts.map(text=>/41|rate/i.test(text)?'命中率 41.7%':'缓存性能')}));
    return;
  }
  response.setHeader('content-type','text/html; charset=utf-8');
  response.end(`<!doctype html><meta charset="utf-8"><title>OCR flow</title><style>body{margin:40px;background:white}img{display:block;width:600px;height:180px}</style><img id="sample"><script>
    const canvas=document.createElement('canvas');canvas.width=600;canvas.height=180;
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,600,180);
    ctx.fillStyle='#172026';ctx.font='28px Arial';ctx.fillText('Cache performance',25,60);ctx.fillText('Hit rate 41.7%',25,120);
    document.querySelector('img').src=canvas.toDataURL();
  </script>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let context;
const errors=[];
try{
  context=await chromium.launchPersistentContext(path.join(output,`profile-${Date.now()}`),{
    ...(process.env.PDF_TEST_BROWSER?{executablePath:process.env.PDF_TEST_BROWSER}:{channel:'chromium'}),
    headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--lang=zh-CN', `--load-extension=${path.join(root,'dist')}`],
    viewport:{width:1200,height:900}
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const base=`chrome-extension://${new URL(worker.url()).host}`;
  const options=await context.newPage();
  options.on('pageerror',error=>errors.push(error.message));
  await options.goto(`${base}/options.html`);
  await options.evaluate(async origin=>{
    const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    Object.assign(settings,{activeProviderId:'http-template',cacheEnabled:true,sourceLang:'en',targetLang:'zh-CN'});
    Object.assign(settings.providers.find(provider=>provider.id==='http-template'),{
      url:`${origin}/translate`,method:'POST',headers:{'Content-Type':'application/json'},
      bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'
    });
    const result=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});
    if(!result.ok)throw new Error(result.error);
  },origin);
  await options.reload();
  await options.locator('#ocrModelAction[data-state="missing"]').waitFor();
  assert.equal(await options.locator('#imageTranslationEnabled').isEnabled(),false);
  await options.locator('#ocrModelAction').click();
  await options.waitForFunction(()=>['installed','error'].includes(document.querySelector('#ocrModelAction').dataset.state),undefined,{timeout:240000});
  const status=await options.evaluate(()=>chrome.runtime.sendMessage({type:'GET_OCR_STATUS'}));
  assert.equal(status.data.state,'installed',JSON.stringify(status));
  console.log('PASS: real OCR model download, checksum and sandbox initialization');
  await options.locator('label:has(#imageTranslationEnabled)').click();
  assert.equal(await options.locator('#imageTranslationEnabled').isChecked(),true);
  await options.locator('#save').click();
  await options.waitForFunction(()=>document.querySelector('#status').textContent.includes('已保存'));
  await options.reload();
  await options.locator('#ocrModelAction[data-state="installed"]').waitFor();
  assert.equal(await options.locator('#imageTranslationEnabled').isChecked(),true);

  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);
  await page.locator('#sample').hover();
  const button=page.locator('#wupage-image-tools button').first();
  await button.waitFor({state:'visible'});
  await button.click();
  await page.waitForFunction(()=>document.querySelector('#wupage-image-tools')?.shadowRoot.querySelector('button')?.textContent==='原',undefined,{timeout:120000});
  const canvas=page.locator('#wupage-image-tools canvas');
  assert.equal(await canvas.isVisible(),true);
  assert.ok(requests>0,'real recognized text reaches the translation provider');
  const firstRequests=requests;
  for(let cycle=0;cycle<3;cycle++){
    await button.click();
    assert.equal(await canvas.isVisible(),false);
    await button.click();
    assert.equal(await canvas.isVisible(),true);
    assert.equal(requests,firstRequests,'image toggles must reuse results');
  }
  await page.screenshot({path:path.join(output,'translated-image.png')});
  await page.reload();
  await page.locator('#sample').hover();
  await button.waitFor({state:'visible'});
  await button.click();
  await page.waitForFunction(()=>document.querySelector('#wupage-image-tools')?.shadowRoot.querySelector('button')?.textContent==='原');
  assert.equal(requests,firstRequests,'reopening the image must reuse persistent results');
  const snapshot=await options.evaluate(()=>chrome.runtime.sendMessage({type:'GET_TRANSLATION_DEBUG'}));
  const texts=snapshot.data.tasks.flatMap(task=>task.sourceTexts||[]);
  assert.ok(texts.some(text=>/Cache/i.test(text)),JSON.stringify(texts));
  assert.ok(texts.some(text=>/41[.,]7/.test(text)),JSON.stringify(texts));

  await options.locator('#ocrModelAction').click();
  await options.locator('#ocrModelAction[data-state="missing"]').waitFor();
  assert.equal(await options.locator('#imageTranslationEnabled').isChecked(),false);
  assert.equal(await options.locator('#imageTranslationEnabled').isEnabled(),false);
  await page.locator('#wupage-image-tools').waitFor({state:'detached'});
  const saved=await options.evaluate(()=>chrome.runtime.sendMessage({type:'GET_SETTINGS'}));
  assert.equal(saved.data.imageTranslationEnabled,false);
  await options.reload();
  await options.locator('#ocrModelAction[data-state="missing"]').waitFor();
  assert.equal(await options.locator('#imageTranslationEnabled').isChecked(),false);
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,downloaded:status.data.downloaded,recognizedTexts:texts,
    requests,viewToggles:3,reopenedFromCache:true,deleted:true,errors},null,2));
  console.log(JSON.stringify({passed:true,requests,viewToggles:3,downloaded:status.data.downloaded,output}));
}finally{
  await context?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
