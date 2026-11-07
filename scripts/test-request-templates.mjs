// Exercise saved templates through the real extension and a local HTTP endpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=path.join(root,'.npm-cache/request-templates');
await fs.mkdir(output,{recursive:true});
const moduleName=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(path.isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const requests=[];
const server=http.createServer(async(request,response)=>{
  const chunks=[];
  for await(const chunk of request)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  requests.push({url:request.url,headers:request.headers,body});
  response.writeHead(200,{'Content-Type':'application/json'});
  response.end(JSON.stringify(request.url.endsWith('/messages')
    ?{content:[{type:'text',text:'["你好"]'}]}
    :request.url==='/http'?{translations:['你好']}:{choices:[{message:{content:'["你好"]'}}]}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const endpoint=`http://127.0.0.1:${server.address().port}`;
let context;
try{
  context=await chromium.launchPersistentContext(path.join(output,`profile-${Date.now()}`),{
    ...(process.env.PDF_TEST_BROWSER?{executablePath:process.env.PDF_TEST_BROWSER}:{channel:'chromium'}),
    headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--lang=zh-CN', `--load-extension=${path.join(root,'dist')}`],
    viewport:{width:1100,height:1000}
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const page=await context.newPage();page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#providerSettings`);
  await page.locator('#providerTriggerLabel').waitFor();
  const field=name=>page.locator(`[data-field="${name}"]`);
  async function select(id){
    await page.locator('#providerTrigger').click();
    await page.locator(`[data-action="select"][data-provider-id="${id}"]`).click();
    await page.waitForFunction(id=>document.querySelector('#providerForm').dataset.providerId===id,id);
  }
  async function test(advanced=true){
    const count=requests.length;
    await page.locator(advanced?'[data-action="test-provider"]':'#test').click();
    await page.waitForFunction(()=>document.querySelector('[data-role="provider-test-status"]').textContent==='测试通过：你好');
    assert.equal(requests.length,count+1);
    return requests.at(-1);
  }
  async function save(){
    await page.locator('#save').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent==='已保存。');
  }
  const body='{"enable_thinking":false,"thinking":{"type":"enabled"},"temperature":null,"max_tokens":1234}';
  const providers=['openai-compatible','deepseek','zhipu-glm'];
  for(const id of providers){
    await select(id);await page.locator('#providerGeneralTab').click();
    await field('baseURL').fill(`${endpoint}/v1`);await field('apiKey').fill('local-test-key');
    if(id==='openai-compatible')await field('ollamaCompatibility').selectOption('disabled');
    await page.locator('#providerAdvancedTab').click();
    const defaults=JSON.parse(await field('requestBodyTemplate').inputValue());
    assert.equal(defaults.model,'{{model}}');
    if(id==='deepseek'){
      assert.equal(defaults.thinking.type,'disabled');
      await page.locator('#providerSettings').screenshot({path:path.join(output,'defaults-deepseek.png')});
    }
    await page.locator('[data-action="load-default-request-template"]').click();
    assert.equal(await field('requestTemplateEnabled').isChecked(),true);
    const defaultRequest=await test();
    assert.equal(defaultRequest.body.temperature,0);
    if(id==='deepseek')assert.equal(defaultRequest.body.thinking.type,'disabled');
    await field('requestTemplateEnabled').check();
    await field('requestHeadersTemplate').fill('{"x-opencode-session":"wupage","authorization":"Token {{apiKey}}"}');
    await field('requestBodyTemplate').fill(body);
    const request=await test();
    assert.equal(request.headers['x-opencode-session'],'wupage');
    assert.equal(request.headers.authorization,'Token local-test-key');
    assert.equal(request.body.enable_thinking,false);assert.equal(request.body.thinking.type,'enabled');
    assert.equal(request.body.max_tokens,1234);assert.equal(Object.hasOwn(request.body,'temperature'),false);
    assert.deepEqual(JSON.parse(request.body.messages.at(-1).content).texts,['Hello world']);
  }
  await page.reload();await page.locator('#providerAdvancedTab').click();
  assert.equal(await field('requestBodyTemplate').inputValue(),body);
  await field('requestTemplateEnabled').uncheck();await save();
  await page.locator('#providerGeneralTab').click();
  const disabled=await test(false);
  assert.equal(disabled.headers['x-opencode-session'],undefined);assert.equal(disabled.body.temperature,0);
  await page.locator('#providerAdvancedTab').click();
  assert.equal(await field('requestBodyTemplate').inputValue(),body);
  await field('requestTemplateEnabled').check();
  const count=requests.length;
  await field('requestBodyTemplate').fill('{"stream":true}');
  await page.locator('#providerGeneralTab').click();await page.locator('#save').click();
  await page.locator('[data-role="request-template-status"]').waitFor({state:'visible'});
  assert.match(await page.locator('[data-role="request-template-status"]').textContent(),/非流式/);
  assert.equal(await field('requestBodyTemplate').evaluate(element=>document.activeElement===element),true);
  assert.equal(requests.length,count);
  await field('requestBodyTemplate').fill(body);await save();
  await page.locator('#providerSettings').screenshot({path:path.join(output,'advanced-desktop.png')});
  await page.locator('.request-template-help summary').click();
  for(const width of [390,320]){
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Overflow at ${width}`);
  }
  await page.screenshot({path:path.join(output,'advanced-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1100,height:1000});
  await page.locator('[data-action="reset-request-template"]').click();await save();
  assert.equal(await field('requestTemplateEnabled').isChecked(),false);
  assert.equal(JSON.parse(await field('requestBodyTemplate').inputValue()).model,'{{model}}');

  await page.locator('#addProvider').click();await page.locator('#customProviderName').fill('Local Anthropic');
  await page.locator('#customProviderKind').selectOption('llm');await page.locator('#customLlmFormat').selectOption('anthropic');
  await page.locator('#providerDialogForm button[type="submit"]').click();
  await page.locator('#providerGeneralTab').click();
  await field('baseURL').fill(`${endpoint}/v1`);await field('apiKey').fill('local-test-key');
  await page.locator('#providerAdvancedTab').click();
  assert.equal(JSON.parse(await field('requestBodyTemplate').inputValue()).max_tokens,8192);
  await page.locator('[data-action="load-default-request-template"]').click();
  const defaultAnthropic=await test();
  assert.equal(defaultAnthropic.body.max_tokens,8192);assert.equal(defaultAnthropic.body.messages.length,1);
  assert.ok(defaultAnthropic.body.system);
  await field('requestTemplateEnabled').check();
  await field('requestHeadersTemplate').fill('{"x-opencode-session":"anthropic"}');await field('requestBodyTemplate').fill(body);
  const anthropic=await test();assert.equal(anthropic.url,'/v1/messages');
  assert.equal(anthropic.headers['x-opencode-session'],'anthropic');assert.equal(anthropic.headers['x-api-key'],'local-test-key');
  assert.equal(anthropic.body.max_tokens,1234);

  const disabledId=await page.locator('#providerForm').getAttribute('data-provider-id');
  await page.locator('#providerTrigger').click();
  await page.locator(`[data-action="toggle"][data-provider-id="${disabledId}"]`).click();
  await page.locator('#disabledProviderHint').waitFor({state:'visible'});
  assert.equal(await page.locator('#providerForm').getAttribute('data-provider-id'),disabledId);
  await page.locator('#providerTrigger').click();
  await select('openai-compatible');
  await select(disabledId);
  assert.equal(await page.locator('#disabledProviderHint').isVisible(),true);
  await page.locator('#providerGeneralTab').click();
  await field('apiKey').fill('disabled-test-key');
  await page.locator('#providerAdvancedTab').click();
  const disabledRequest=await test();
  assert.equal(disabledRequest.headers['x-api-key'],'disabled-test-key');
  await save();
  assert.equal(await page.locator('#providerForm').getAttribute('data-provider-id'),disabledId);
  const disabledSettings=await page.evaluate(async()=>{
    const response=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    if(!response.ok)throw new Error(response.error);
    return response.data;
  });
  assert.equal(disabledSettings.activeProviderId,'openai-compatible');
  assert.equal(disabledSettings.providers.find(provider=>provider.id===disabledId).enabled,false);
  await page.locator('#providerSettings').screenshot({path:path.join(output,'disabled-service.png')});
  const popup=await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await popup.locator('#provider option').first().waitFor({state:'attached'});
  assert.equal(await popup.locator(`#provider option[value="${disabledId}"]`).count(),0);
  await popup.close();

  await select('http-template');await page.locator('#providerGeneralTab').click();
  await field('url').fill(`${endpoint}/http`);await page.locator('#providerAdvancedTab').click();
  assert.equal(await field('headers').isVisible(),true);
  await field('headers').fill('{"Content-Type":"application/json","x-session":"legacy"}');
  await test(false);assert.equal(requests.at(-1).headers['x-session'],'legacy');
  assert.deepEqual(requests.at(-1).body.q,['Hello world']);
  assert.deepEqual(errors,[]);
  const report={passed:true,requests:requests.length,providers:4,defaultTemplates:true,legacyHttp:true,persistence:true,disabledServiceEditing:true,disableAndReset:true,validation:true,narrowWidths:[390,320]};
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,output}));
}finally{
  if(context)await context.close();
  await new Promise(resolve=>server.close(resolve));
}
