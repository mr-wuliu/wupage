// Nested comment components with the built extension and a localhost translator.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
const output = path.join(root, '.npm-cache/selection-components', target.kind);
await fs.mkdir(output, { recursive: true });
const calls = [], errors = [], checks = [];
const fixture = `<!doctype html><meta charset="utf-8"><title>Comment component selection</title>
<style>body{margin:40px;font:18px/2 Arial}bili-comments{display:block;margin-top:30px}</style>
<p id="ordinary">Ordinary selected phrase</p><div id="commentapp"><bili-comments></bili-comments></div>
<script>
window.parts=[];const mode=new URL(location.href).searchParams.get('mode')||'open';
let current=document.querySelector('bili-comments');
for(const tag of ['bili-comment-thread-renderer','bili-comment-renderer','bili-rich-text']){
 const root=current.attachShadow({mode:mode==='closed'?'closed':'open'});window.parts.push(root);
 root.innerHTML='<style>:host{display:block}#content{font:18px/2 Arial}</style><'+tag+'></'+tag+'>';
 current=root.querySelector(tag);
}
const root=current.attachShadow({mode:mode==='closed'?'closed':'open'});window.parts.push(root);
const content='<div id="content" style="font:18px/2 Arial">Unselected introduction. <span id="selected" style="white-space:nowrap">Selected comment text</span> Unselected ending.</div><button>Reply</button>';
root.innerHTML='<style>:host{display:block}</style>'+(mode==='slot'?'<slot></slot>':content);
if(mode==='slot')current.innerHTML=content;
window.selectedNode=mode==='ordinary'?document.querySelector('#ordinary'):(mode==='slot'?current:root).querySelector('#selected');window.fixtureReady=true;
</script>`;
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const part of request) body += part;
    const input = JSON.parse(body); calls.push(input);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ translations: input.texts.map(text => `译文：${text}`) }));
  } else { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(fixture); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context, page;
try {
  const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1200, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await cdp.detach();
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html#selectionTranslationSettings`);
  await options.locator('#save:enabled').waitFor();
  await options.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    Object.assign(settings, { activeProviderId: 'http-template', cacheEnabled: false, floatingBallEnabled: false,
      imageTranslationEnabled: false, sourceLang: 'en', targetLang: 'zh-CN',
      selectionTranslation: { enabled: true, provider: 'youdao', style: 'dot' } });
    Object.assign(settings.providers.find(provider => provider.id === 'http-template'), { enabled: true, method: 'POST',
      url: origin + '/translate', headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (!response.ok) throw new Error(response.error);
  }, origin);
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.waitForFunction(() => window.fixtureReady && document.getElementById('wupage-selection-tools'));
  const identity = verifyBrowserIdentity(target, await page.evaluate(() => navigator.userAgent));
  const trigger = page.locator('#wupage-selection-tools .trigger-dot,#wupage-selection-tools .trigger-line').first();
  const select = async (reverse = false) => {
    const bounds = await page.evaluate(() => { const r=window.selectedNode.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; });
    const left=bounds.x+1, right=bounds.x+bounds.width-1, y=bounds.y+bounds.height/2;
    await page.mouse.move(reverse?right:left,y); await page.mouse.down();
    await page.mouse.move(reverse?left:right,y,{steps:12}); await page.mouse.up();
  };
  const selections = [];
  for (const [mode, style, reverse] of [['open','dot',false], ['closed','dot',false], ['slot','underline',false], ['open','underline',true], ['ordinary','underline',false]]) {
    await options.evaluate(async style => {
      const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      settings.selectionTranslation.style=style;
      const response=await chrome.runtime.sendMessage({ type:'SAVE_SETTINGS',settings });
      if(!response.ok)throw new Error(response.error);
    }, style);
    await page.goto(`${origin}/?mode=${mode}`);
    await page.waitForFunction(() => window.fixtureReady && document.getElementById('wupage-selection-tools'));
    const before=calls.length;
    await select(reverse);
    const selection = await page.evaluate(() => {
      const s=window.getSelection(), range=s.rangeCount?s.getRangeAt(0):null;
      return { text:s.toString(), collapsed:s.isCollapsed, rangeText:range?.toString(), rangeCollapsed:range?.collapsed };
    });
    selections.push({mode,style,reverse,...selection});
    await trigger.waitFor({ timeout: 5000 });
    assert.equal(calls.length,before,'selecting text alone must not contact the translator');
    await trigger.click();
    await page.locator('#wupage-selection-tools .selection-translation').waitFor();
    const expected=mode==='ordinary'?'Ordinary selected phrase':'Selected comment text';
    assert.deepEqual(calls.at(-1).texts,[expected]);
    assert.equal(await page.locator('#wupage-selection-tools .word').inputValue(), expected);
    assert.equal(await page.evaluate(() => window.selectedNode.textContent),expected);
    checks.push(`${mode}/${style}/${reverse?'backward':'forward'}: native selection, click-only translation and exact source retained`);
    await page.screenshot({ path:path.join(output,`${mode}-${style}-${reverse?'backward':'forward'}.png`) });
  }
  const setEnabled = async enabled => options.evaluate(async enabled => {
    const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    settings.selectionTranslation.enabled=enabled;
    const response=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});if(!response.ok)throw new Error(response.error);
  },enabled);
  await setEnabled(false); await page.locator('#wupage-selection-tools .card').waitFor({state:'hidden'});
  await select(); await page.waitForTimeout(100); assert.equal(await trigger.count(),0);
  await setEnabled(true); await select(); await trigger.waitFor();
  checks.push('saved disablement and re-enablement take effect on the existing page');
  const report={passed:true,...identity,checks,selections,requests:calls.length,errors};
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally { await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
