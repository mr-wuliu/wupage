// Local fixtures and disposable extension builds only. The test hook removes
// message listeners to reproduce a real browser "Receiving end does not exist".
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
const output = path.join(root, '.npm-cache/frame-connection', target.kind);
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(output, 'build-'));
const directory = target.kind === 'firefox' ? 'dist-firefox' : 'dist';
await fs.cp(path.join(root, directory), path.join(temporary, directory), { recursive: true });
const bootstrap = path.join(temporary, directory, 'frame-bootstrap.js');
const hook = `(()=>{
  const event=chrome.runtime.onMessage,add=event.addListener.bind(event),listeners=[];
  event.addListener=listener=>{listeners.push(listener);add(listener)};
  event.addListener((request,sender,respond)=>{
    if(request.type==='FRAME_TEST_SNAPSHOT'){
      chrome.runtime.sendMessage({type:'FRAME_SESSION_GET'}).then(respond);return true;
    }
    if(request.type==='FRAME_TEST_DISCONNECT'){
      respond({ok:true});for(const listener of listeners)event.removeListener(listener);
    }
  });
})();`;
await fs.writeFile(bootstrap, hook + await fs.readFile(bootstrap, 'utf8'));
const checks = [], reports = [], calls = [];
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'text/html;charset=utf-8');
  if (request.method === 'POST') {
    let body = ''; for await (const part of request) body += part;
    const { texts } = JSON.parse(body);
    calls.push(texts);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ translations: texts.map(text => text.includes('WUPAGESEGMENT')
      ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\s*\n)/g, '$1译文：') : `译文：${text}`) })); return;
  }
  response.end(request.url.startsWith('/child')
    ? '<!doctype html><html lang="en"><p>Visible embedded article must be translated.</p></html>'
    : '<!doctype html><html lang="en"><style>body{font:16px/24px Arial;margin:24px}iframe{width:600px;height:160px}</style>'
      + '<main><p>Main article must keep translating when a helper disconnects.</p>'
      + '<iframe id="article" src="/child"></iframe><iframe id="helper" style="display:none"></iframe></main></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const url = `${origin}/fixture`;
let browser;
const waitFor = async (read, check, label) => {
  const deadline = Date.now() + 20000; let value;
  do { value = await read(); if (check(value)) return value; await delay(80); } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
try {
  browser = await openExtensionBrowser(temporary, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const runtime = async request => {
    const value = await browser.api('return chrome.runtime.sendMessage(input[0]);', [request]);
    assert.equal(value?.ok, true, JSON.stringify(value)); return value.data;
  };
  const settings = await runtime({ type: 'GET_SETTINGS' });
  settings.providers.push({ id: 'connection-test', label: 'Connection test', type: 'http-template',
    url: `${origin}/translate`, method: 'POST', headers: { 'Content-Type': 'application/json' },
    bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
  Object.assign(settings, { activeProviderId: 'connection-test', sourceLang: 'en', targetLang: 'zh-CN',
    translationDisplayMode: 'bilingual', cacheEnabled: false });
  settings.autoTranslation.enabled = false;
  await runtime({ type: 'SAVE_SETTINGS', settings });
  const send = (type, frameId = 0) => browser.api(`const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);
    return chrome.tabs.sendMessage(tab.id,{type:input[1]},{frameId:input[2]});`, [url, type, frameId]);
  const snapshot = async () => {
    const value = await send('FRAME_TEST_SNAPSHOT'); assert.equal(value?.ok, true, JSON.stringify(value)); return value.data;
  };
  const record = async (scenario, value) => {
    reports.push({ scenario, value });
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, checks, reports }, null, 2));
  };
  const translatePage = async (expectedDocuments = 2) => {
    // Firefox's control tab hides the fixture. Dispatch first, then select the
    // content tab while viewport-aware translation runs; collect the reply later.
    await browser.api(`const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);
      const w=window.wrappedJSObject||window;w.frameTestReply='';
      void chrome.tabs.sendMessage(tab.id,{type:'TRANSLATE_PAGE'},{frameId:0})
        .then(value=>{w.frameTestReply=JSON.stringify(value)},error=>{w.frameTestReply=JSON.stringify({ok:false,error:String(error)})});
      return true;`, [url]);
    await waitFor(() => browser.evaluate(`return [document.querySelector('main > p'),document.querySelector('#article')?.contentDocument?.querySelector('p')]
      .filter(node=>node?.textContent.includes('译文：')).length;`), value => value >= expectedDocuments, 'visible document translations');
    const reply = await waitFor(() => browser.api("return (window.wrappedJSObject||window).frameTestReply;"), Boolean, 'translation reply');
    return JSON.parse(reply);
  };
  await browser.navigate(url);
  await waitFor(() => snapshot().catch(() => undefined), value => value?.frames.length === 3
    && value.frames.every(frame => frame.status !== 'unavailable'), 'registered documents');
  const initial = await snapshot();
  const helper = initial.frames.find(frame => frame.url === 'about:blank');
  const article = initial.frames.find(frame => frame.url.startsWith(`${origin}/child`));
  assert.ok(helper && article, 'both local embedded documents are registered');
  await send('FRAME_TEST_DISCONNECT', helper.frameId);
  // Verify that this is a browser delivery rejection, not a translated error string.
  const delivery = await send('FRAME_IDENTIFY', helper.frameId).then(() => '', error => String(error));
  assert.match(delivery, /receiving end does not exist|could not establish connection/iu);
  for (let cycle = 0; cycle < 2; cycle++) {
    const result = await translatePage(); await record(`hidden helper disconnected, cycle ${cycle + 1}`, result);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.data.translated >= 2, 'main and visible embedded article both translate');
    assert.equal(result.data.error, undefined, 'hidden helper is not a whole-page translation failure');
    const state = await snapshot();
    assert.equal(state.frames.find(frame => frame.frameId === helper.frameId)?.status, 'unavailable');
    assert.match(state.frames.find(frame => frame.frameId === helper.frameId)?.reason ?? '', /receiving end does not exist/iu);
    await send('CLEAR_TRANSLATION');
  }
  checks.push('actual browser receiver loss in a hidden helper; two start/stop cycles preserve healthy translation and diagnostics');
  // document.open clears the pagehide listener, reproducing an embedded document
  // disappearing without its optional FRAME_LEAVE message reaching the registry.
  await browser.evaluate(`const frame=document.querySelector('#helper'),doc=frame.contentDocument;
    doc.open();doc.write('<!doctype html><html></html>');doc.close();frame.remove();`);
  const removed = await translatePage(); await record('helper removed without leave notification', removed);
  assert.equal(removed.data.error, undefined, JSON.stringify(removed));
  assert.equal((await snapshot()).frames.some(frame => frame.frameId === helper.frameId), false, 'removed helper is pruned');
  checks.push('removed helper is pruned from the registry after failed delivery');
  await send('CLEAR_TRANSLATION');
  await send('FRAME_TEST_DISCONNECT', article.frameId);
  const visible = await translatePage(1); await record('visible embedded article disconnected', visible);
  assert.ok(visible.data.translated >= 1, 'main article still translates');
  assert.equal(visible.data.errorCode, 'frame-connection-lost', 'visible content loss remains an explicit failure');
  checks.push('visible embedded content failures remain actionable while the main article translates');
  await browser.evaluate(`document.querySelector('#article').src='/child?reconnected';`);
  await waitFor(() => browser.evaluate(`return document.querySelector('#article')?.contentDocument?.querySelector('p')?.textContent.includes('译文：');`),
    Boolean, 'replacement embedded document translates');
  await waitFor(snapshot, value => !value.state.error && value.frames.some(frame =>
    frame.url.endsWith('/child?reconnected') && (frame.state?.translated ?? 0) > 0), 'replacement embedded document reconnects');
  checks.push('replacement document registers and translates, clearing the obsolete connection failure');
  await record('reconnected', await snapshot());
  await browser.capture('result.png');
  console.log(JSON.stringify({ ...identity, checks, output }, null, 2));
} catch (error) {
  if (browser) {
    const diagnostic = await browser.api(`const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);
      const reply=(window.wrappedJSObject||window).frameTestReply;
      const value=await chrome.tabs.sendMessage(tab.id,{type:'FRAME_TEST_SNAPSHOT'},{frameId:0}).catch(error=>({error:String(error)}));
      return {reply,state:value?.data?.state,frames:value?.data?.frames,error:value?.error};`, [url]).catch(error => ({ error: String(error) }));
    await fs.writeFile(path.join(output, 'failure-state.json'), JSON.stringify(diagnostic, null, 2));
    const dom = await browser.evaluate(`return {main:document.querySelector('main')?.innerHTML,
      child:document.querySelector('#article')?.contentDocument?.body?.innerHTML};`).catch(error => ({ error: String(error) }));
    await fs.writeFile(path.join(output, 'failure-dom.json'), JSON.stringify({ calls, dom }, null, 2));
  }
  await Promise.allSettled([browser?.capture('failure.png'), fs.writeFile(path.join(output, 'failure.txt'), String(error.stack || error))]);
  throw error;
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
