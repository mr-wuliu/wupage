// Isolated browser profiles and a local translation service; never attaches to a running browser.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startFirefox } from './lib/firefox.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget(), isFirefox = target.kind === 'firefox';
const output = path.join(root, '.npm-cache/frame-translation', target.kind);
await fs.mkdir(output, { recursive: true });
const calls = [], checks = [], errors = [], pending = [];
let delayed = false;
const inline = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const reporter = name => `<script>const name=${JSON.stringify(name)};let restored=false;const report=()=>{
  const data={name,translations:[...document.querySelectorAll('.wupage-translation')].map(e=>e.textContent),
    restored,floating:document.querySelectorAll('#wupage-floating-ball').length,pending:document.querySelectorAll('.wupage-translation-pending').length};
  if(parent!==window)parent.postMessage({frameTest:data},'*');else window.reports[name]=data;
};window.reports={};window.addEventListener('message',e=>{if(e.data?.frameTestScroll!==undefined)window.scrollTo(0,e.data.frameTestScroll);if(e.data?.frameTest){if(parent!==window)parent.postMessage(e.data,'*');else window.reports[e.data.frameTest.name]=e.data.frameTest;}});
window.addEventListener('pageshow',e=>{restored=e.persisted;report()});new MutationObserver(report).observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true});setInterval(report,300);report();</script>`;
const doc = (name, extra = '') => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${name}</title>
  <style>body{margin:10px;font:16px/1.5 Arial}iframe{width:300px;height:140px;border:1px solid #aaa}</style>
  <body><main><p>${name}: A complete readable paragraph about the hidden kingdom.</p>${extra}</main>${reporter(name)}</body></html>`;
let origin, cross;
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); calls.push(payload);
    if (payload.texts.some(text => text.includes('failed-frame:'))) { response.writeHead(500).end('fixture failure'); return; }
    const finish = () => { if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      translations: payload.texts.map(text => text.includes('⟪WUPAGESEGMENT')
        ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\n)/g, `$1译文(${payload.target}): `) : `译文(${payload.target}): ${text}`)
    })); };
    if (delayed) pending.push(finish); else finish();
    return;
  }
  const url = new URL(request.url, origin);
  let html;
  if (url.pathname === '/fixture') {
    const embedded = doc('srcdoc');
    html = doc('top', `<iframe id="same" src="${origin}/frame?name=same"></iframe>
      <iframe id="cross" src="${cross}/frame?name=cross&nested=1"></iframe>
      <iframe id="srcdoc" srcdoc="${embedded.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>
      <iframe id="sandbox" sandbox="allow-scripts" src="${cross}/frame?name=sandbox"></iframe>
      <iframe id="blank"></iframe><iframe id="blob"></iframe><iframe id="data"></iframe><div id="shadow"></div>
      <iframe id="hidden" style="display:none" src="${cross}/frame?name=hidden"></iframe>
      <iframe id="zero" style="width:0;height:0;border:0" src="${cross}/frame?name=zero"></iframe>
      <iframe id="opacity" style="opacity:0" src="${cross}/frame?name=opacity"></iframe>
      <iframe id="visibility" style="visibility:hidden" src="${cross}/frame?name=visibility"></iframe>
      <p contenteditable="true">Unsent private draft must never leave this page.</p>
      <div style="height:2400px"></div><iframe id="far" src="${cross}/frame?name=far"></iframe>
      <script>const blank=document.querySelector('#blank');blank.contentDocument.open();blank.contentDocument.write(${inline(doc('blank'))});blank.contentDocument.close();
      document.querySelector('#blob').src=URL.createObjectURL(new Blob([${inline(doc('blob'))}],{type:'text/html'}));
      document.querySelector('#data').src='data:text/html;charset=utf-8,'+encodeURIComponent(${inline(doc('data'))});
      const shadow=document.querySelector('#shadow').attachShadow({mode:'closed'});const sf=document.createElement('iframe');sf.src=${JSON.stringify(`${cross}/frame?name=shadow`)};shadow.append(sf);</script>`);
  } else if (url.pathname === '/tall') {
    html = doc('tall-top', `<iframe id="tall" style="height:3200px" src="${cross}/frame?name=tall&tall=1"></iframe>`);
  } else if (url.pathname === '/inner') {
    html = doc('inner-top', `<iframe id="inner" style="height:220px" src="${cross}/frame?name=inner&tall=1"></iframe>`);
  } else if (url.pathname === '/auto' || url.pathname === '/auto-late') {
    html = doc('auto-top', `<iframe src="${cross}/frame?name=${url.pathname === '/auto-late' ? 'auto-late&async=1' : 'auto-foreign'}"></iframe>`)
      .replace('<html lang="en">', '<html lang="zh-CN">')
      .replace('auto-top: A complete readable paragraph about the hidden kingdom.', '这是一个中文网页，主要介绍如何阅读和使用网页中的内容。这里的中文已经是目标语言，但是嵌入的英文文章仍然需要翻译。');
  } else html = doc(url.searchParams.get('name') || 'frame', url.searchParams.has('nested')
    ? `<iframe src="${origin}/frame?name=nested" style="height:90px"></iframe>`
    : url.searchParams.has('tall') ? '<div style="height:2400px"></div><p>tall-bottom: A distant paragraph awaits scrolling.</p>' : '');
  if (url.searchParams.has('async')) html = html.replace(/<p>auto-late:[\s\S]*?<\/p>/, '')
    .replace('</main>', `<script>setTimeout(()=>{const p=document.createElement('p');p.textContent='Delayed English article: A complete readable paragraph about the hidden kingdom and its history.';document.querySelector('main').append(p)},900)</script></main>`);
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise(resolve => server.listen(0, resolve));
origin = `http://127.0.0.1:${server.address().port}`; cross = `http://localhost:${server.address().port}`;

let browser, api, read, evaluatePage, evaluateMod, navigate, capture, close;
const waitFor = async (readValue, predicate, label, timeout = 20000) => {
  const until = Date.now() + timeout; let value;
  do { value = await readValue(); if (predicate(value)) return value; await delay(100); } while (Date.now() < until);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
try {
  if (isFirefox) {
    browser = await startFirefox(output, path.join(root, 'dist-firefox'));
    const result = await browser.command('WebDriver:GetWindowHandle'); const control = result.value ?? result;
    const select = handle => browser.command('WebDriver:SwitchToWindow', { handle });
    await browser.command('WebDriver:Navigate', { url: `${browser.base}options.html` });
    api = async (source, input = []) => {
      await select(control);
      const result = await browser.executeAsync(`const done=arguments[arguments.length-1],input=JSON.parse(arguments[0]),chrome=window.wrappedJSObject.chrome;
        (async()=>{${source}})().then(value=>done(JSON.stringify({value})),error=>done(JSON.stringify({error:String(error)})));`, [JSON.stringify(input)]);
      const parsed = JSON.parse(result); if (parsed.error) throw new Error(parsed.error); return parsed.value;
    };
    const created = await browser.command('WebDriver:NewWindow', { type: 'tab' }); const page = (created.value ?? created).handle;
    evaluatePage = async source => { await select(page); return browser.execute(source); };
    navigate = async url => { await select(page); await browser.command('WebDriver:Navigate', { url }); };
    capture = async name => { await select(page); const value = await browser.command('WebDriver:TakeScreenshot', { id: null, highlights: [], full: false }); await fs.writeFile(path.join(output, name), Buffer.from(value.value, 'base64')); };
    evaluateMod = async source => {
      await select(page); await browser.command('WebDriver:SwitchToFrame', { id: null });
      const iframe = await browser.command('WebDriver:FindElement', { using: 'css selector', value: '#modio_embed' });
      await browser.command('WebDriver:SwitchToFrame', { id: iframe.value });
      try { return await browser.execute(source); }
      finally { await browser.command('WebDriver:SwitchToFrame', { id: null }); }
    };
    close = () => browser.close();
  } else {
    const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
    const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
    browser = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
      ...target.chromiumOptions,
      headless: true, viewport: { width: 1400, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions', '--disable-back-forward-cache'],
      args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
    });
    const session = await browser.browser().newBrowserCDPSession();
    await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    const options = await browser.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    api = (source, input = []) => options.evaluate(`(async()=>{const input=${JSON.stringify(input)};${source}})()`);
    const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
    evaluatePage = source => page.evaluate(`(()=>{${source}})()`);
    navigate = url => page.goto(url);
    capture = name => page.screenshot({ path: path.join(output, name) });
    evaluateMod = source => {
      const frame = page.frames().find(frame => frame.url().includes('embed.modhub.io'));
      return frame ? frame.evaluate(`(()=>{${source}})()`) : Promise.resolve(null);
    };
    close = () => browser.close();
  }
  const identity = verifyBrowserIdentity(target, await evaluatePage('return navigator.userAgent;'));
  const runtime = async request => {
    const response = await api('return chrome.runtime.sendMessage(input[0]);', [request]);
    assert.equal(response?.ok, true, JSON.stringify(response)); return response.data;
  };
  const settings = await runtime({ type: 'GET_SETTINGS' });
  settings.providers.push({ id: 'frame-test', type: 'http-template', label: 'Frame test', method: 'POST', url: `${origin}/translate`,
    headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}},"target":{{json targetLang}}}', responsePath: 'translations' });
  Object.assign(settings, { activeProviderId: 'frame-test', cacheEnabled: true, sourceLang: 'en', targetLang: 'zh-CN', translationDisplayMode: 'bilingual' });
  await runtime({ type: 'SAVE_SETTINGS', settings });
  let currentUrl;
  const open = async pathname => { currentUrl = origin + pathname; await navigate(currentUrl); await waitFor(() => evaluatePage('return !!document.querySelector("#wupage-floating-ball")'), Boolean, 'top runtime'); };
  const send = async (request, detached = false) => {
    const response = await api(`const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);
      const action=chrome.tabs.sendMessage(tab.id,input[1],{frameId:0});
      ${detached ? 'globalThis.frameTestAction=action; return true;' : 'return action;'}`, [currentUrl, request]);
    if (!detached) assert.equal(response?.ok, true, JSON.stringify(response)); return response?.data;
  };
  read = () => evaluatePage('return JSON.parse(JSON.stringify((window.wrappedJSObject || window).reports || {}));');
  await open('/fixture');
  await delay(500);
  assert.equal(calls.length, 0, 'no implicit translation');
  const firstResult = await send({ type: 'TRANSLATE_PAGE' });
  console.log('Initial result:', JSON.stringify(firstResult));
  if (process.argv.includes('--debug')) {
    await send({ type: 'OPEN_TRANSLATION_DEBUG' });
    console.log('Documents:', await evaluatePage('return document.querySelector("#wupage-debug-panel")?.textContent;'));
  }
  const expected = ['same', 'cross', 'srcdoc', 'sandbox', 'blank', 'blob', 'data', 'nested', 'shadow'];
  await waitFor(read, reports => expected.every(name => reports?.[name]?.translations.length), 'all permitted frame types', 30000);
  let reports = await read();
  assert.ok(expected.every(name => reports[name].floating === 0), 'one floating UI');
  assert.equal(reports.hidden?.translations.length ?? 0, 0); assert.equal(reports.far?.translations.length ?? 0, 0);
  assert.equal(reports.zero?.translations.length ?? 0, 0);
  assert.equal(reports.opacity?.translations.length ?? 0, 0); assert.equal(reports.visibility?.translations.length ?? 0, 0);
  assert.ok(!calls.flatMap(call => call.texts).some(text => /Unsent private draft|hidden:|far:|zero:|opacity:|visibility:/.test(text)));
  checks.push('same/cross origin, nested, srcdoc, blank, blob, data, opaque sandbox and closed shadow host; one UI; no hidden/offscreen/draft requests');
  await capture('frames.png');
  const before = calls.length;
  settings.translationDisplayMode = 'replace'; await runtime({ type: 'SAVE_SETTINGS', settings }); await delay(500);
  assert.equal(calls.length, before, 'display mode reuses translations');
  settings.targetLang = 'ja'; await runtime({ type: 'SAVE_SETTINGS', settings });
  await waitFor(read, reports => reports.cross.translations.some(text => text.startsWith('译文(ja)')), 'language sync');
  await evaluatePage('document.querySelector("#hidden").style.display="inline-block"');
  await waitFor(read, reports => reports.hidden?.translations.length > 0, 'revealed iframe');
  await evaluatePage('document.querySelector("#opacity").style.opacity="1";document.querySelector("#visibility").style.visibility="visible";document.querySelector("#opacity").scrollIntoView({block:"center"});');
  await waitFor(read, reports => reports.opacity?.translations.length > 0 && reports.visibility?.translations.length > 0, 'CSS visibility and opacity reveal');
  await evaluatePage('window.scrollTo(0,0);');
  await evaluatePage(`const late=document.createElement('iframe');late.id='late';late.src=${JSON.stringify(`${cross}/frame?name=late`)};document.querySelector('main').prepend(late);`);
  await waitFor(read, reports => reports.late?.translations.length > 0, 'late iframe');
  checks.push('mode reuse, language synchronization, hidden-to-visible and late frame inheritance');
  settings.frameTranslation = { enabled: true, excludeMatches: [`${cross}/*`] };
  await runtime({ type: 'SAVE_SETTINGS', settings });
  await waitFor(read, reports => reports.cross.translations.length === 0 && reports.same.translations.length > 0, 'frame exclusion');
  settings.frameTranslation.excludeMatches = []; await runtime({ type: 'SAVE_SETTINGS', settings });
  await waitFor(read, reports => reports.cross.translations.length > 0, 'frame inclusion');
  await evaluatePage(`delete (window.wrappedJSObject||window).reports.cross;document.querySelector('#cross').src=${JSON.stringify(`${cross}/frame?name=replacement`)};`);
  await waitFor(read, reports => reports.replacement?.translations.length > 0, 'iframe navigation inherits current session');
  await evaluatePage('delete (window.wrappedJSObject||window).reports.cross;delete (window.wrappedJSObject||window).reports.nested;');
  await evaluatePage(`const failed=document.createElement('iframe');failed.src=${JSON.stringify(`${cross}/frame?name=failed-frame`)};document.querySelector('main').prepend(failed);`);
  await waitFor(() => calls.flatMap(call => call.texts), texts => texts.some(text => text.includes('failed-frame:')), 'isolated frame failure');
  assert.ok((await read()).same.translations.length > 0, 'a failed frame must not stop other documents');
  checks.push('iframe navigation inherits session; one document failing does not stop other documents');
  await send({ type: 'CLEAR_TRANSLATION' });
  await waitFor(read, reports => Object.values(reports).every(report => report.translations.length === 0), 'restore all documents');
  delayed = true; settings.cacheEnabled = false; await runtime({ type: 'SAVE_SETTINGS', settings });
  await open('/fixture?cancel=1');
  await send({ type: 'TRANSLATE_PAGE' }, true);
  await waitFor(() => pending.length, count => count > 0, 'requests in flight');
  await send({ type: 'CLEAR_TRANSLATION' }); delayed = false; pending.splice(0).forEach(finish => finish()); await delay(400);
  assert.ok(Object.values(await read()).every(report => report.translations.length === 0), 'late responses stay cancelled');
  checks.push('explicit frame exclusions, unified restoration and cancellation of in-flight requests');
  await open('/tall'); await send({ type: 'TRANSLATE_PAGE' });
  await waitFor(read, reports => reports.tall?.translations.length > 0, 'tall frame top');
  assert.ok(!(await read()).tall.translations.some(text => text.includes('tall-bottom:')), 'distant paragraph must not render before scrolling');
  await evaluatePage('window.scrollTo(0,2300)');
  await waitFor(read, reports => reports.tall.translations.some(text => text.includes('tall-bottom:')), 'outer viewport clipping');
  checks.push('large auto-height iframe respects outer viewport and resumes on outer scrolling');
  await open('/inner'); await send({ type: 'TRANSLATE_PAGE' });
  await waitFor(read, reports => reports.inner?.translations.length > 0, 'inner viewport');
  assert.ok(!(await read()).inner.translations.some(text => text.includes('tall-bottom:')));
  await evaluatePage(`document.querySelector('#inner').contentWindow.postMessage({frameTestScroll:2400},'*');`);
  await waitFor(read, reports => reports.inner.translations.some(text => text.includes('tall-bottom:')), 'independent iframe scrolling');
  checks.push('independent scrolling inside the embedded document');
  await evaluatePage('window.history.back();'); currentUrl = origin + '/tall';
  const historyPage = await waitFor(() => read().catch(() => null), reports => reports?.['tall-top'], 'history restoration');
  if (historyPage['tall-top'].restored) {
    await waitFor(read, reports => reports.tall?.translations.length > 0, 'BFCache restores the active translation session');
    checks.push('BFCache restores the document session and saved translations');
  }
  settings.sourceLang = 'auto'; settings.targetLang = 'zh-CN';
  settings.autoTranslation = { enabled: true, nonTargetLanguage: true, presetSites: [], customSites: [] };
  await runtime({ type: 'SAVE_SETTINGS', settings }); await open('/auto');
  await waitFor(read, reports => reports['auto-foreign']?.translations.length > 0, 'foreign iframe on target-language outer page');
  await send({ type: 'CLEAR_TRANSLATION' });
  await waitFor(read, reports => Object.values(reports).every(report => report.translations.length === 0), 'stop automatic frame translation');
  const stoppedCalls = calls.length; await delay(700); assert.equal(calls.length, stoppedCalls);
  checks.push('automatic language detection includes foreign frame content; restoring remains stopped');
  await open('/auto-late');
  await waitFor(read, reports => reports['auto-late']?.translations.length > 0, 'automatic translation of an initially empty SPA iframe');
  checks.push('automatic translation detects text loaded later inside an initially empty iframe');
  await send({ type: 'CLEAR_TRANSLATION' });
  settings.autoTranslation.enabled = false; await runtime({ type: 'SAVE_SETTINGS', settings });
  if (process.argv.includes('--live')) {
    currentUrl = 'https://baldursgate3.game/mods#/m/queens-garments'; await navigate(currentUrl);
    await waitFor(() => evaluatePage('return !!document.querySelector("#modio_embed")'), Boolean, 'real mod site', 45000);
    await evaluatePage(`const confirm=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Confirm my choices');confirm?.click();`);
    await waitFor(() => evaluateMod('return !!document.querySelector(".mod-content")'), Boolean, 'real mod description loaded', 45000);
    await send({ type: 'TRANSLATE_PAGE' });
    const descriptionTop = await evaluateMod('return document.querySelector(".mod-content").getBoundingClientRect().top;');
    await evaluatePage(`const rect=document.querySelector('#modio_embed').getBoundingClientRect();window.scrollTo({top:window.scrollY+rect.top+${Number(descriptionTop)}-140,behavior:'instant'});`);
    await waitFor(() => evaluateMod('return [...document.querySelectorAll(".mod-content .wupage-translation")].map(e=>e.textContent)'),
      texts => texts?.some(text => text.includes('译文') && text.includes('A collection fit for your queen')), 'real mod translated description rendered', 60000);
    await delay(300);
    await capture('queens-garments.png'); checks.push('real queens-garments embedded mod description translated and rendered');
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, checks, errors }, null, 2));
  console.log(JSON.stringify({ ...identity, checks, errors }, null, 2));
} finally { delayed = false; pending.splice(0).forEach(finish => finish()); await close?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
