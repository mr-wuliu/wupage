// Optional real MV3 regression with local pages, a local translation stub and
// an isolated browser profile. Build dist/ first; see docs/development.md.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const output = path.join(root, '.npm-cache/floating-interactions');
await fs.mkdir(output, { recursive: true });
let calls = 0;
const requests=[];
let fail = false;
let hold = false;
let unchanged = false;
let heldStarted;
const heldResponses = [];
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    calls++;
    if (hold) {
      const released = new Promise(resolve => heldResponses.push(resolve));
      heldStarted?.();
      await released;
    }
    if (fail) { response.writeHead(400).end('Translation service unavailable'); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ translations: payload.texts.map(text => unchanged ? text : `${payload.targetLang === 'ja' ? 'ja: ' : ''}好的翻译让我们读懂更广阔的世界，也让阅读自然地融入日常生活。`) }));
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>A quiet place to read</title><style>
    body{margin:0;background:#f7f6f2;color:#263d38;font:17px/1.9 Georgia,serif}header{padding:28px 6vw;border-bottom:1px solid #dedfd8;font:600 13px system-ui;letter-spacing:2px}main{max-width:760px;margin:76px auto;padding:0 32px}small{color:#7a8c80;font:12px system-ui;letter-spacing:2px}h1{font-size:52px;line-height:1.15;font-weight:400;margin:24px 0}p{max-width:640px}aside{margin:40px 0;padding:24px;border-left:3px solid #aec0aa;background:#eff0e9} @media(max-width:600px){main{margin-top:35px}h1{font-size:36px}}
    /* Host loading styles, as used by Stack Overflow, must not decorate the floating ball. */
    .is-loading::before,.is-loading::after{content:"";position:absolute;width:1.23em;height:1.23em;left:.6em;top:calc(50% - .6em);border:2px solid currentColor}
    .is-loading::before{opacity:.3}.is-loading::after{border-color:transparent;border-left-color:currentColor}
  </style></head><body><header>FIELD NOTES</header><main><small>READING & IDEAS · OCTOBER 2026</small><h1>A quiet place to read</h1><p>Good translation opens a wider world. It allows us to follow ideas across languages while keeping our attention on the page.</p><p>The most useful tools become a natural part of reading. They stay nearby when we need them and give the page room to breathe.</p><aside>Simple interactions make more space for the things that matter.</aside></main></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging'],
    viewport: { width: 1200, height: 850 }
  });
  const browserSession = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await browserSession.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
  await browserSession.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/options.html`);
  await control.evaluate(async (origin) => {
    const loaded = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    const settings = loaded.data;
    settings.activeProviderId = 'http-template';
    settings.cacheEnabled = false;
    settings.providers.find(p => p.id === 'http-template').label = '本地测试服务';
    Object.assign(settings.providers.find(p => p.id === 'http-template'), {
      url: `${origin}/translate`, method: 'POST', headers: {'Content-Type':'application/json'},
      bodyTemplate: '{"texts":{{json texts}},"targetLang":{{json targetLang}}}', responsePath: 'translations'
    });
    assertSave(await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }));
    function assertSave(result) { if (!result.ok) throw new Error(result.error); }
  }, origin);
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(origin);
  const originalArticle = await page.locator('main').innerHTML();
  const ball = page.locator('#wupage-floating-ball');
  const menu = page.locator('#wupage-floating-menu');
  const hitbox = page.locator('#wupage-floating-hitbox');
  await ball.waitFor({state:'visible'});
  const message = request => worker.evaluate(async ({origin,request}) => {
    const [tab] = await chrome.tabs.query({url:`${origin}/*`});
    return chrome.tabs.sendMessage(tab.id,request);
  },{origin,request});
  const openPopup = async () => {
    const sourceTab=await worker.evaluate(async origin=>(await chrome.tabs.query({url:`${origin}/*` }))[0],origin);
    const popup=await context.newPage();
    popup.on('pageerror',error=>errors.push(String(error)));
    // A toolbar popup keeps the web tab active. Opening popup.html in a test
    // tab needs this narrow query override; all messages still use real APIs.
    await popup.addInitScript(sourceTab=>{
      const query=chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query=info=>info.active?Promise.resolve([sourceTab]):query(info);
    },sourceTab);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator('#pageToggle:not(:disabled)').waitFor();
    return popup;
  };
  // Observe real pointer timing, independently of the fake-timer unit tests.
  await page.mouse.move(5,5);
  await page.evaluate(()=>{
    const hitbox=document.querySelector('#wupage-floating-hitbox');
    const menu=document.querySelector('#wupage-floating-menu');
    hitbox.addEventListener('pointerenter',()=>{window.hoverStarted=performance.now();});
    new MutationObserver(()=>{
      if(!menu.hidden)window.hoverElapsed=performance.now()-window.hoverStarted;
    }).observe(menu,{attributes:true,attributeFilter:['hidden']});
  });
  await ball.hover();
  await page.waitForTimeout(200);
  assert.equal(await menu.isVisible(),false,'brief hover must not open the menu');
  await page.mouse.move(5,5);
  await page.waitForTimeout(400);
  assert.equal(await menu.isVisible(),false,'leaving must cancel pending opening');
  await ball.hover();
  await menu.waitFor({state:'visible'});
  const hoverElapsed=await page.evaluate(()=>window.hoverElapsed);
  assert.ok(hoverElapsed>=490,`menu opened too early: ${hoverElapsed} ms`);
  await page.mouse.move(5,5);
  await menu.waitFor({state:'hidden'});
  hold = true;
  const slowRequest = new Promise(resolve => { heldStarted = resolve; });
  await ball.click();
  assert.equal(await ball.textContent(), '原', 'label changes immediately');
  await withTimeout(slowRequest,'the floating ball translation did not reach the local provider');
  assert.deepEqual(await ball.evaluate(el => ['::before','::after'].map(pseudo => getComputedStyle(el,pseudo).content)),
    ['none','none'], 'host loading styles must not add icons over the floating label');
  assert.equal(await ball.getAttribute('aria-disabled'), 'false');
  assert.equal(await ball.evaluate(el => getComputedStyle(el).cursor), 'pointer');
  assert.equal(await ball.evaluate(el => getComputedStyle(el).opacity), '1');
  assert.equal(await page.locator('[data-action="page-toggle"]').isEnabled(), true);
  await ball.click();
  assert.equal(await ball.textContent(), '译');
  assert.equal(await page.locator('.wupage-translation').count(), 0);
  hold = false;
  heldResponses.splice(0).forEach(resolve => resolve());
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.wupage-translation').count(), 0, 'late response stays cancelled');
  await ball.click();
  await page.waitForFunction(() => document.querySelector('#wupage-floating-ball').getAttribute('aria-busy') === 'false' && document.querySelector('.wupage-translation:not(.wupage-translation-pending)'));
  assert.equal(await ball.textContent(), '原');
  const cachedPageCalls = calls;
  for (let cycle = 0; cycle < 3; cycle++) {
    await ball.click();
    assert.equal(await ball.textContent(), '译');
    assert.equal(await page.locator('.wupage-translation').count(), 0);
    await ball.click();
    await page.waitForFunction(() => document.querySelector('#wupage-floating-ball').getAttribute('aria-busy') === 'false');
    assert.equal(await ball.textContent(), '原');
    assert.equal(calls, cachedPageCalls, 'view toggles must not call the translation provider');
    assert.match(await page.locator('[data-role="translation-status"]').textContent(), /缓存命中/);
  }
  await ball.click();
  assert.equal(await ball.textContent(), '译');
  unchanged = true;
  await page.reload();
  await ball.waitFor({state:'visible'});
  await ball.click();
  await page.waitForFunction(() => document.querySelector('#wupage-floating-ball').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('.wupage-translation').count(), 0);
  assert.equal(await ball.textContent(), '原', 'unchanged translation keeps translation mode enabled');
  assert.equal((await message({type:'GET_TRANSLATION_STATE'})).data.translated,true,
    'popup state must agree with the ball even when the provider returns unchanged text');
  const unchangedPopup=await openPopup();
  assert.equal(await unchangedPopup.locator('#pageToggle').textContent(),'显示全文');
  await unchangedPopup.close();
  await ball.click();
  assert.equal(await ball.textContent(), '译');
  unchanged = false;
  await page.reload();
  await ball.waitFor({state:'visible'});
  await page.mouse.move(20, 20);
  await ball.hover();
  await menu.waitFor({state:'visible'});
  await page.locator('.wupage-provider-trigger').click();
  await page.locator('.wupage-provider-choice[data-value="http-template"]').click();
  assert.equal(await menu.locator('[data-role="provider-value"]').count(), 0, 'legacy provider text must not overlap the icon picker');
  const providerIconBox = await menu.locator('.wupage-provider-trigger .wupage-provider-icon').boundingBox();
  const providerNameBox = await menu.locator('.wupage-provider-trigger .wupage-provider-name').boundingBox();
  assert.ok(providerIconBox?.width > 0 && providerNameBox?.x >= providerIconBox.x + providerIconBox.width,
    'the provider icon must be visible to the left of its name');
  await page.mouse.move(20, 20);
  await menu.waitFor({state:'hidden', timeout:2000});
  await ball.hover();
  await page.locator('[data-role="display-mode"]').hover();
  assert.equal(await menu.isVisible(), true, 'menu remains open across hover gap');
  await page.screenshot({path:path.join(output, 'desktop-menu.png')});
  await menu.screenshot({path:path.join(output, 'menu-preview.png')});
  const compact = await menu.evaluate(element => {
    const header = element.querySelector('.wupage-menu-header').getBoundingClientRect();
    const languages = element.querySelector('.wupage-language-pair').getBoundingClientRect();
    const provider = element.querySelector('[data-role="provider"]').closest('label').getBoundingClientRect();
    const target = element.querySelector('[data-role="target-lang"]').getBoundingClientRect();
    const auto = element.querySelector('[data-action="auto-translation"]').getBoundingClientRect();
    return { headerGap: languages.top - header.bottom, languageGap: provider.top - languages.bottom,
      automaticBesideTarget: auto.left > target.right && Math.abs(auto.y + auto.height / 2 - target.y - target.height / 2) < 1,
      fontSize: getComputedStyle(element.querySelector('strong')).fontSize };
  });
  assert.equal(compact.headerGap,6);assert.equal(compact.languageGap,6);assert.equal(compact.fontSize,'15px');
  assert.equal(compact.automaticBesideTarget,true);
  assert.equal(await menu.getByRole('button',{name:'打开设置',exact:true}).locator('svg').count(),1);
  const selectionToggle = menu.locator('[data-action="selection-translation"]');
  await selectionToggle.click();
  await page.waitForFunction(()=>document.querySelector('[data-action="selection-translation"]').getAttribute('aria-pressed')==='false');
  const syncedPopup = await openPopup();
  assert.equal(await syncedPopup.locator('#selectionTranslation').getAttribute('aria-pressed'),'false');
  await syncedPopup.locator('#selectionTranslation').click();
  await page.waitForFunction(()=>document.querySelector('[data-action="selection-translation"]').getAttribute('aria-pressed')==='true');
  await syncedPopup.close();await page.bringToFront();await ball.hover();await menu.waitFor({state:'visible'});
  await menu.locator('[data-role="ocr-action"][data-state="missing"]').waitFor();
  assert.equal(await menu.locator('[data-action="image-translation"]').isDisabled(),true);
  await menu.locator('.ocr-help-trigger').click();
  await menu.locator('#wupage-ocr-help').waitFor({state:'visible'});
  const helpBox=await menu.locator('#wupage-ocr-help').boundingBox();
  assert.ok(helpBox.x>=0&&helpBox.y>=0&&helpBox.x+helpBox.width<=page.viewportSize().width&&helpBox.y+helpBox.height<=page.viewportSize().height);
  await page.keyboard.press('Escape');
  await menu.locator('#wupage-ocr-help').waitFor({state:'hidden'});
  await ball.click();
  await page.waitForFunction(() => document.querySelector('#wupage-floating-ball').getAttribute('aria-busy') === 'false' && document.querySelector('.wupage-translation:not(.wupage-translation-pending)'));
  assert.ok(calls > 0);
  const afterTranslation = calls;
  await page.mouse.move(20, 20);
  await ball.hover();
  await page.locator('[data-role="display-mode"]').selectOption('replace');
  await page.waitForFunction(() => document.querySelector('.wupage-translation')?.dataset.wupageDisplayMode === 'replace');
  assert.equal(calls, afterTranslation);
  await page.screenshot({path:path.join(output, 'translated-menu.png')});
  await page.locator('main').evaluate(el => el.replaceChildren());
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.wupage-translation').count(), 0);
  assert.equal(await ball.textContent(), '原', 'virtualized feed keeps translation mode enabled');
  assert.equal((await message({type:'GET_TRANSLATION_STATE'})).data.translated,true,
    'popup state must stay active when a virtualized feed temporarily has no rendered translations');
  await ball.click();
  await page.waitForFunction(() => !document.querySelector('.wupage-translation'));
  assert.equal(await ball.textContent(), '译');
  await page.locator('main').evaluate((el, html) => { el.innerHTML = html; }, originalArticle);
  await page.mouse.move(20,20);
  await ball.hover();
  const rect = await ball.boundingBox();
  await page.mouse.move(rect.x+20, rect.y+20);
  await page.mouse.down();
  assert.equal(await menu.isVisible(), false, 'menu closes on drag');
  await page.mouse.move(500, 300, {steps:12});
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.equal(calls, afterTranslation, 'drag does not translate');
  assert.equal(await menu.isVisible(), false, 'menu stays closed after drag');
  const position=await worker.evaluate(async()=>{
    return (await chrome.storage.local.get('wupage.floating.position'))['wupage.floating.position'];
  });
  assert.equal(position.edge,null);
  await page.mouse.move(5,5);
  await page.reload();
  await ball.waitFor({state:'visible'});
  const restoredPosition=await ball.boundingBox();
  assert.ok(Math.abs(restoredPosition.x-position.left)<1,'drag position survives reload');
  assert.ok(Math.abs(restoredPosition.y-position.top)<1,'drag height survives reload');
  await page.mouse.move(20,20);
  await ball.hover();
  await menu.waitFor({state:'visible'});
  assert.equal(await menu.isVisible(), true);
  await page.mouse.move(20,20);
  await menu.waitFor({state:'hidden'});
  await ball.focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('[data-role="source-lang"]').evaluate(el=>el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await menu.isVisible(), false);
  fail = true;
  await ball.click();
  await page.waitForFunction(() => document.querySelector('[data-role="translation-status"]')?.dataset.tone === 'error');
  await menu.waitFor({state:'visible'});
  assert.equal(await page.locator('[data-action="retranslate"]').isVisible(), true);
  await page.screenshot({path:path.join(output, 'failed-menu.png')});
  fail = false;
  await page.locator('[data-action="retranslate"]').click();
  await page.waitForFunction(() => document.querySelector('[data-role="translation-status"]')?.dataset.tone === 'normal' && document.querySelector('.wupage-translation:not(.wupage-translation-pending)'));
  const reusedRequests=calls;
  await ball.focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  assert.equal(await ball.textContent(),'译');
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#wupage-floating-ball').getAttribute('aria-busy')==='false');
  assert.equal(await ball.textContent(),'原');
  assert.equal(calls,reusedRequests,'keyboard toggles reuse the page results');

  const popup=await openPopup();
  assert.equal(await popup.locator('#pageToggle').textContent(),'显示全文');
  await popup.locator('#pageToggle').click();
  await popup.waitForFunction(()=>document.querySelector('#status').textContent==='已显示原文。');
  assert.equal(await ball.textContent(),'译');
  assert.equal(await page.locator('.wupage-translation').count(),0);
  await popup.locator('#pageToggle').click();
  await popup.waitForFunction(()=>document.querySelector('#pageToggle').textContent==='显示全文'&&!document.querySelector('#pageToggle').classList.contains('is-loading'));
  assert.equal(await ball.textContent(),'原');
  assert.equal(calls,reusedRequests,'popup toggles share the floating ball page cache');
  await popup.locator('#floatingBall').click();
  await hitbox.waitFor({state:'hidden'});
  await popup.locator('#floatingBall:not(:disabled)').click();
  await hitbox.waitFor({state:'visible'});
  await popup.locator('#paragraphMode').click();
  await page.waitForFunction(()=>document.documentElement.classList.contains('wupage-paragraph-mode'));
  await popup.locator('#paragraphMode:not(:disabled)').click();
  await page.waitForFunction(()=>!document.documentElement.classList.contains('wupage-paragraph-mode'));

  await control.evaluate(async()=>{
    const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    const result=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings:{...settings,cacheEnabled:true}});
    if(!result.ok)throw new Error(result.error);
  });
  const cachedRequest={type:'TRANSLATE_BATCH',texts:['A unique persistent cache regression sentence.'],sourceLang:'en',targetLang:'zh-CN',context:'Cache regression'};
  const translateCached=()=>control.evaluate(request=>chrome.runtime.sendMessage(request),cachedRequest);
  const cacheRequests=()=>requests.filter(request=>request.texts.includes(cachedRequest.texts[0])).length;
  assert.equal((await translateCached()).data.cached,0);
  const persistentRequests=cacheRequests();
  assert.equal((await translateCached()).data.cached,1);
  assert.equal(cacheRequests(),persistentRequests);
  await popup.locator('#clearCache').click();
  await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('已清除'));
  assert.equal((await translateCached()).data.cached,0);
  assert.equal(cacheRequests(),persistentRequests+1,'clearing cache must invalidate persistent entries');
  await popup.locator('#debug').click();
  await page.locator('#wupage-debug-panel').waitFor({state:'visible'});
  await page.locator('#wupage-debug-panel .wupage-debug-task').first().waitFor();
  await page.locator('[data-action="close-debug"]').click();
  await page.locator('#wupage-debug-panel').waitFor({state:'hidden'});
  if(!popup.isClosed())await popup.close();

  await ball.click();
  await page.locator('main p').first().evaluate(node=>{node.textContent='A new paragraph for a slow popup translation.';});
  hold=true;
  const popupStarted=new Promise(resolve=>{heldStarted=resolve;});
  const slowPopup=await openPopup();
  await slowPopup.locator('#pageToggle').click();
  await withTimeout(popupStarted,'the popup translation did not reach the local provider');
  assert.equal(await slowPopup.locator('#pageToggle').isEnabled(),true,'popup must permit stopping its own pending request');
  assert.equal(await slowPopup.locator('#pageToggle').textContent(),'显示全文');
  await slowPopup.locator('#pageToggle').click();
  await slowPopup.waitForFunction(()=>document.querySelector('#status').textContent==='已显示原文。');
  assert.equal(await ball.textContent(),'译');
  hold=false;
  heldResponses.splice(0).forEach(resolve=>resolve());
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.wupage-translation').count(),0,'late popup response must stay cancelled');
  assert.equal(await slowPopup.locator('#pageToggle').textContent(),'翻译全文');
  await slowPopup.close();
  await ball.click();
  await page.waitForFunction(()=>document.querySelector('#wupage-floating-ball').getAttribute('aria-busy')==='false');

  await page.mouse.move(5,5);
  await ball.hover();
  await menu.waitFor({state:'visible'});
  await page.locator('[data-role="source-lang"]').selectOption('en');
  await page.locator('[data-role="target-lang"]').selectOption('ja');
  await page.waitForFunction(()=>document.querySelector('[data-role="target-lang-value"]').textContent==='日本語');
  await assertEventually(async()=>{
    const settings=await control.evaluate(async()=>(await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data);
    assert.equal(settings.sourceLang,'en');
    assert.equal(settings.targetLang,'ja');
  });
  // Saving the language does not mean its translation has finished.
  await page.waitForFunction(()=>{
    const translations=[...document.querySelectorAll('.wupage-translation')];
    return document.querySelector('#wupage-floating-ball').getAttribute('aria-busy')==='false'
      && translations.length>0 && translations.every(node=>node.textContent.startsWith('ja: '));
  });
  for(const mode of ['bilingual','bilingual-accent','replace']){
    const before=calls;
    await page.locator('[data-role="display-mode"]').selectOption(mode);
    await page.waitForFunction(mode=>[...document.querySelectorAll('.wupage-translation')].every(node=>node.dataset.wupageDisplayMode===mode),mode);
    assert.equal(calls,before,'display choices reuse current translations');
  }
  await control.close();
  await page.locator('[data-action="settings"]').click();
  await assertEventually(async()=>{
    // Chromium may embed options in chrome://extensions. Inspect the rendered
    // options frame; the extension intentionally has no permission to read
    // internal browser tab URLs through chrome.tabs.query().
    const frames=context.pages().flatMap(tab=>tab.frames());
    const optionsFrame=frames.find(frame=>frame.url()===`chrome-extension://${extensionId}/options.html`);
    assert.ok(optionsFrame,'the settings page must open again after its old tab closes');
    assert.equal(await optionsFrame.locator('#save').isVisible(),true);
  });
  await page.bringToFront();
  await page.setViewportSize({width:390,height:600});
  await page.mouse.move(5,5);
  await ball.hover();
  await menu.waitFor({state:'visible'});
  const narrowMenu = await menu.boundingBox();
  assert.ok(narrowMenu.x >= 8 && narrowMenu.x+narrowMenu.width<=382);
  assert.ok(narrowMenu.y >= 8 && narrowMenu.y+narrowMenu.height<=592);
  await page.screenshot({path:path.join(output,'narrow-menu.png')});
  await page.setViewportSize({width:320,height:320});
  await page.mouse.move(5,5);
  await ball.hover();
  await menu.waitFor({state:'visible'});
  assert.ok(await menu.evaluate(el => el.scrollHeight > el.clientHeight));
  await page.locator('[data-action="close"]').click();
  assert.equal(await hitbox.isVisible(), false);
  assert.equal(await menu.isVisible(), false);
  await page.reload();
  await page.waitForSelector('#wupage-floating-hitbox',{state:'attached'});
  assert.equal(await hitbox.isVisible(),false,'hidden preference survives reload');
  assert.deepEqual(errors, []);
  const checks=['500ms real hover delay','cancel brief hover','immediate original label','enabled while translating',
    'host loading styles do not decorate the floating ball',
    'stop while translating','discard late response','restart after stopping','hover gap','pointer leave','direct click',
    'display modes','restore original','drag suppression','drag position persistence','keyboard','failure and retry',
    'popup state synchronization','popup translation toggle','popup floating visibility','popup paragraph mode',
    'popup stop while translating','popup late response suppressed','persistent cache and clear','debug panel',
    'language persistence','open settings','390px viewport','320px short viewport','hide preference persistence'];
  await fs.writeFile(path.join(output,'report.json'), JSON.stringify({passed:true,calls,hoverElapsed,errors,checks},null,2));
  console.log(JSON.stringify({passed:true,calls,output}));
} catch(error) {
  console.error(error);
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}

async function assertEventually(check){
  for(let attempt=0;;attempt++){
    try{await check();return;}catch(error){
      if(attempt>=100)throw error;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
}

async function withTimeout(promise,message){
  let timer;
  try{
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(message)),10000);
    })]);
  }finally{clearTimeout(timer);}
}
