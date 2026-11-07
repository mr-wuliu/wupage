// Optional frame-by-frame check of saved feature states in the built extension.
// Only settings and OCR status responses are delayed or stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const moduleName=process.env.PLAYWRIGHT_MODULE || 'playwright';
const {chromium}=await import(path.isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const output = path.join(root,'.npm-cache/settings-initialization');
await fs.mkdir(output, {recursive:true});
const context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
  ...(process.env.PDF_TEST_BROWSER?{executablePath:process.env.PDF_TEST_BROWSER}:{channel:'chromium'}),
  headless:true, ignoreDefaultArgs:['--disable-extensions'], args:['--lang=zh-CN', '--enable-unsafe-extension-debugging'],
  viewport:{width:800,height:900}
});
const reports=[];
try {
  const browserSession=await context.browser().newBrowserCDPSession();
  const {id:extensionId}=await browserSession.send('Extensions.loadUnpacked',{path:path.join(root,'dist')});
  await browserSession.detach();
  for (const pageName of ['popup','options']) {
    for (const enabled of [true,false]) {
      for (let opening=0; opening<2; opening++) {
        const page=await context.newPage();
        const errors=[];
        page.on('pageerror',error=>errors.push(String(error)));
        await page.addInitScript(({pageName,enabled})=>{
          const settings={targetLang:'zh-CN',sourceLang:'auto',activeProviderId:'google-web-translate',chunkSize:1200,concurrency:3,
            pdfTranslationPageRadius:5,cacheEnabled:true,floatingBallEnabled:true,imageTranslationEnabled:enabled,translateCodeComments:true,
            translationDisplayMode:'bilingual',providers:[{type:'google-web-translate',id:'google-web-translate',label:'Google Web Translate',enabled:true}]};
          let release;
          const ready=new Promise(resolve=>{release=resolve;});
          window.releaseSettings=release;
          window.toggleFrames=[];
          chrome.runtime.sendMessage=async request=>{
            if(request.type==='GET_SETTINGS'){await ready;return {ok:true,data:settings};}
            if(request.type==='GET_OCR_STATUS')return {ok:true,data:{state:'installed',total:100,downloaded:100}};
            return {ok:true};
          };
          chrome.tabs.query=async()=>[{id:42,url:'https://example.com/article'}];
          chrome.tabs.sendMessage=async()=>({ok:true,data:{enabled:false,translated:false}});
          const record=()=>{
            const toggle=document.querySelector(pageName==='popup'?'#imageTranslation':'#imageTranslationEnabled');
            const control=document.querySelector(pageName==='popup'?'#imageTranslation':'.image-feature .setting-toggle-control');
            if(toggle&&control){
              const knob=control;
              const pseudo=pageName==='popup'?null:'::after';
              const surface=pageName==='popup'?control.closest('.image-feature-row'):control;
              window.toggleFrames.push({visible:getComputedStyle(control).visibility==='visible'&&control.getBoundingClientRect().height>0,
                enabled:toggle instanceof HTMLInputElement?toggle.checked:toggle.getAttribute('aria-pressed')==='true',
                transform:getComputedStyle(knob,pseudo).transform,background:getComputedStyle(surface).backgroundColor,
                loading:toggle.closest('.image-feature').hasAttribute('data-loading')});
            }
            requestAnimationFrame(record);
          };
          requestAnimationFrame(record);
        },{pageName,enabled});
        await page.goto(`chrome-extension://${extensionId}/${pageName}.html`);
        await page.waitForTimeout(160);
        assert.equal(await page.locator('.image-feature').getAttribute('aria-busy'),'true');
        assert.equal(await page.locator('.image-feature').evaluate(el=>getComputedStyle(el.querySelector('#imageTranslation,.setting-toggle-control')).visibility),'hidden');
        await page.evaluate(()=>window.releaseSettings());
        await page.waitForFunction(()=>!document.querySelector('.image-feature').hasAttribute('data-loading'));
        await page.waitForTimeout(220);
        const frames=await page.evaluate(()=>window.toggleFrames);
        const visible=frames.filter(frame=>frame.visible);
        assert.ok(visible.length>0);
        assert.ok(visible.every(frame=>frame.enabled===enabled && !frame.loading),`${pageName}: stale feature state was painted`);
        if(pageName==='popup') {
          const background=await page.locator('.image-feature-row').evaluate(el=>getComputedStyle(el).backgroundColor);
          assert.ok(visible.every(frame=>frame.background===background),`${pageName}: startup color transition was painted`);
          assert.ok(visible.every(frame=>frame.transform==='none'));
        } else {
          assert.ok(visible.every(frame=>frame.background===(enabled?'rgb(17, 100, 102)':'rgb(215, 222, 219)')),`${pageName}: startup color transition was painted`);
          assert.ok(visible.every(frame=>enabled?frame.transform==='matrix(1, 0, 0, 1, 8, 0)':frame.transform==='none'),`${pageName}: startup knob transition was painted`);
        }
        assert.deepEqual(errors,[]);
        if(enabled&&opening===1) {
          if(pageName==='options') {
            for(const width of [1440,1200,800,375]) {
              await page.setViewportSize({width,height:900});
              const layout=await page.evaluate(()=>{
                const rects=Array.from(document.querySelector('.general-toggles').children,el=>el.getBoundingClientRect());
                const card=document.querySelector('.image-feature-row').getBoundingClientRect();
                const components=['.image-feature-label','.ocr-help-trigger','.ocr-model-action','.image-feature .setting-toggle-control']
                  .map(selector=>document.querySelector(selector).getBoundingClientRect());
                return {overflow:document.documentElement.scrollWidth>innerWidth,tops:rects.map(rect=>rect.top),
                  componentsInside:components.every(rect=>rect.left>=card.left&&rect.right<=card.right&&rect.top>=card.top&&rect.bottom<=card.bottom),
                  ordered:components.every((rect,index)=>index===0||rect.left>=components[index-1].right)};
              });
              assert.equal(layout.overflow,false);
              assert.equal(layout.componentsInside,true);
              assert.equal(layout.ordered,true);
              if(width>=1200)assert.ok(layout.tops.every(top=>Math.abs(top-layout.tops[0])<1),'all four general controls must share a row');
              await page.locator('#generalSettings').screenshot({path:path.join(output,`general-${width}.png`)});
            }
            await page.locator('.ocr-help-trigger').click();
            assert.equal(await page.locator('#ocrHelpPanel').isVisible(),true);
            assert.equal(await page.locator('#imageTranslationEnabled').isChecked(),true,'help must not toggle image translation');
            await page.keyboard.press('Escape');
            await page.locator('#imageTranslationLabel').click();
            assert.equal(await page.locator('#imageTranslationEnabled').isChecked(),false);
            await page.locator('#imageTranslationLabel').click();
            assert.equal(await page.locator('#imageTranslationEnabled').isChecked(),true);
            await page.setViewportSize({width:1440,height:900});
          }
          await page.locator('.image-feature-row').screenshot({path:path.join(output,`${pageName}-enabled.png`)});
        }
        reports.push({page:pageName,enabled,opening,frames:frames.length,visibleFrames:visible.length,passed:true});
        await page.close();
      }
    }
  }
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(reports,null,2));
  console.log(JSON.stringify({passed:true,checks:reports.length,output}));
} finally {
  await context.close();
}
