// Exercise real extension settings/runtime messages with simulated API responses.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=path.join(root,'.npm-cache/service-modes');
await fs.mkdir(output,{recursive:true});
const moduleName=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(path.isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const context=await chromium.launchPersistentContext(path.join(output,`profile-${Date.now()}`),{
  ...(process.env.PDF_TEST_BROWSER?{executablePath:process.env.PDF_TEST_BROWSER}:{channel:'chromium'}),
  headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--lang=zh-CN', ...(process.env.PDF_TEST_BROWSER
    ?['--enable-unsafe-extension-debugging']:[`--load-extension=${path.join(root,'dist')}`])],viewport:{width:1100,height:1000}
});
try{
  if(process.env.PDF_TEST_BROWSER){
    const session=await context.browser().newBrowserCDPSession();
    await session.send('Extensions.loadUnpacked',{path:path.join(root,'dist')});await session.detach();
  }
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const extension=`chrome-extension://${new URL(worker.url()).host}`;
  await worker.evaluate(()=>{
    globalThis.serviceModeRequests=[];
    globalThis.fetch=async(url,init={})=>{
      const parsed=new URL(url),headers=new Headers(init.headers),host=parsed.hostname;
      if(host==='translate.googleapis.com')return new Response(parsed.pathname.includes('/translate_a/element.js')
        ?"_loadJs('https://translate.googleapis.com/_/translate_http/_/js/k=fixture/m=el_main')"
        :`({'x-goog-api-key':'${'A'.repeat(39)}'})`);
      globalThis.serviceModeRequests.push({host,key:headers.get('Authorization')||headers.get('Ocp-Apim-Subscription-Key')||headers.get('X-RapidAPI-Key')||parsed.searchParams.get('key')});
      const payload=host==='edge.microsoft.com'||host==='api.cognitive.microsofttranslator.com'?[{translations:[{text:'你好'}]}]
        :host==='translate-pa.googleapis.com'?[["<pre>你好</pre>"]]
          :host==='translation.googleapis.com'?{data:{translations:[{translatedText:'你好'}]}}
            :host==='transmart.qq.com'?{header:{ret_code:'succ'},auto_translation:['你好']}
              :host==='tokenhub.tencentmaas.com'?{choices:[{message:{content:'你好'}}]}
                :host==='translate.yandex.net'?{code:200,text:['你好']}
                  :host==='translate.api.cloud.yandex.net'?{translations:[{text:'你好'}]}
                    :host==='translate.volcengine.com'?{base_resp:{status_code:0},translation:'你好'}
                      :host==='translate.volcengineapi.com'?{TranslationList:[{Translation:'你好'}]}
                        :host==='api.mymemory.translated.net'||host==='translated-mymemory---translation-memory.p.rapidapi.com'?{responseStatus:200,responseData:{translatedText:'你好'}}:null;
      if(!payload)throw new Error('Unexpected test request');
      return new Response(JSON.stringify(payload),{headers:{'Content-Type':'application/json'}});
    };
  });
  const options=await context.newPage();options.setDefaultTimeout(8000);
  const errors=[];options.on('pageerror',error=>errors.push(String(error)));
  await options.goto(`${extension}/options.html#providerSettings`);await options.locator('#providerTriggerLabel').waitFor();
  const ids=['microsoft-web-translate','google-web-translate','tencent-transmart','yandex-web-translate','volcengine-web-translate','mymemory'];
  async function save(){
    await options.locator('#save').click();
    await options.waitForFunction(()=>document.querySelector('#status').textContent==='已保存。');
  }
  async function test(){
    await options.locator('#test').click();
    await options.waitForFunction(()=>document.querySelector('[data-role="provider-test-status"]').textContent==='测试通过：你好');
  }
  for(const id of ids){
    await options.locator('#providerTrigger').click();
    await options.locator(`[data-action="select"][data-provider-id="${id}"]`).click();
    const mode=options.locator('[data-field="serviceMode"]');
    assert.equal(await mode.inputValue(),'free');
    assert.equal(await options.locator('#translationApiFields').isVisible(),false);
    assert.match(await options.locator('#providerUsage h3').textContent(),/匿名/);
    assert.ok(await options.locator('#providerUsage a').count());
    await test();await mode.selectOption('api');
    assert.equal(await options.locator('#translationApiFields').isVisible(),true);
    assert.doesNotMatch(await options.locator('#providerUsage h3').textContent(),/匿名/);
    const sources=await options.locator('#providerUsage a').evaluateAll(links=>links.map(link=>({url:link.href,target:link.target,rel:link.rel})));
    assert.ok(sources.every(source=>source.url.startsWith('https://')&&source.target==='_blank'&&source.rel==='noopener noreferrer'));
    const key=options.locator(id==='volcengine-web-translate'?'[data-api-field="secretAccessKey"]':'[data-api-field="apiKey"]');
    await key.fill('example-user-key');
    if(id==='volcengine-web-translate')await options.locator('[data-api-field="accessKeyId"]').fill('example-user-id');
    await test();await save();
    await options.reload();await options.locator('[data-field="serviceMode"]').waitFor();
    assert.equal(await options.locator('[data-field="serviceMode"]').inputValue(),'api');
    assert.equal(await key.inputValue(),'example-user-key');
    if(id==='microsoft-web-translate'){
      await options.locator('#providerForm').screenshot({path:path.join(output,'api-settings.png')});
      for(const width of [390,320]){
        await options.setViewportSize({width,height:1000});
        assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`API settings overflow at ${width}`);
      }
      await options.setViewportSize({width:1100,height:1000});
      await options.locator('.settings-nav a[href="#performanceSettings"]').click();
      await options.locator('#concurrency').fill('2');
      assert.match(await options.locator('[data-role="provider-scheduling"]').textContent(),/调度并发 2/);
      await options.locator('#concurrency').fill('3');
      await options.locator('.settings-nav a[href="#providerSettings"]').click();
    }
    await options.locator('[data-field="serviceMode"]').selectOption('free');
    assert.equal(await options.locator('#translationApiFields').isVisible(),false);
    await save();await test();
    assert.equal(await key.inputValue(),'example-user-key');
    if(id==='tencent-transmart')await options.locator('#providerForm').screenshot({path:path.join(output,'free-settings.png')});
  }
  await options.locator('#providerTrigger').click();
  await options.locator('[data-action="select"][data-provider-id="tencent-transmart"]').click();
  await options.locator('[data-field="serviceMode"]').selectOption('api');
  await options.locator('[data-api-field="model"]').fill('custom-model-'.repeat(50));
  await options.setViewportSize({width:320,height:1000});
  assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'long model name overflowed the usage card');
  const requests=await worker.evaluate(()=>globalThis.serviceModeRequests);
  assert.equal(requests.length,18);
  for(let index=0;index<requests.length;index+=3){
    assert.equal(requests[index].key,null,'default free mode disclosed a key');
    assert.ok(requests[index+1].key,'API mode missed credentials');
    assert.equal(requests[index+2].key,null,'switching back to free disclosed a saved key');
    assert.notEqual(requests[index].host,requests[index+1].host);
  }
  assert.deepEqual(errors,[]);
  const report={passed:true,providers:ids.length,requests:requests.length,defaultFree:true,apiRoundTrip:true,credentialsPreserved:true,noCredentialsInFreeMode:true,usageByMode:true,officialSources:true,schedulingUpdated:true,longModelLayout:true,narrowWidths:[390,320]};
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,output}));
}finally{await context.close();}
