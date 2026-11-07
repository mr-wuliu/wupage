// Uses separate browser profiles and a local mock; never contacts a translation provider.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startFirefox } from './lib/firefox.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget(), firefox = target.kind === 'firefox';
const baseline = process.argv.includes('--baseline');
const output = path.join(root, '.npm-cache/scientific-page', target.kind);
await fs.mkdir(output, { recursive: true });
const calls = [], checks = [];
const requestedSegments = () => calls.flatMap(text => text.includes('⟪WUPAGESEGMENT')
  ? text.split(/⟪WUPAGESEGMENT\d+⟫\n/).slice(1).map(text => text.trim()) : [text]);
const fixture = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN"><html><head>
  <meta name="Generator" content="LaTeX2HTML v2002-2-1"><title>Scientific document regression</title></head><body>
  <div align="center"><big class="XLARGE">A scientific article with inline equations</big></div><p>
  <div align="center"><big>Abstract</big></div><div class="ABSTRACT">Our model preserves the
  <span class="MATH"><img src="/formula.svg" alt="$ -1/r$" width="40" height="31"></span> tail and improves numerical precision.</div><p>
  <h1><a name="intro">Introduction</a></h1>
  Bare introduction with a <a href="#ref">reference</a> and <i>emphasized words</i> remains one complete paragraph.
  <p>A paragraph containing <span class="MATH"><img src="/formula.svg" alt="$ x_i$" width="40" height="31"></span> and
  <span class="MATH"><img src="/formula.svg" alt="$ y_i$" width="40" height="31"></span> retains both formulas.</p>
  <div class="mathdisplay"><a name="equation"></a><table class="equation"><tr><td><span class="MATH"><img src="/formula.svg"
  alt="$\\displaystyle E = x + y$" width="140" height="31"></span></td><td class="eqno">(1)</td></tr></table></div><br clear="all"><p></p>
  where <span class="MATH"><img src="/formula.svg" alt="$ x$" width="40" height="31"></span> denotes an input quantity and
  <a href="#ref">another reference</a> remains clickable.<p>
  <p><span class="MATH"><img src="/formula.svg" alt="$\\displaystyle very_long_latex_expression_that_is_not_prose_and_must_never_be_sent_to_a_translation_provider$" width="40" height="31"></span></p>
  <div style="height:2800px"></div>
  <h2>Later section</h2>Bare distant paragraph must wait until the reader scrolls to this section.<p>
  <ol><li><a name="ref">An example reference with <b>rich text</b> and a citation.</a></li></ol>
  </body></html>`;
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const part of request) body += part;
    const data = JSON.parse(body); calls.push(...data.texts);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translations: data.texts.map(text =>
      text.includes('⟪WUPAGESEGMENT') ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\n)/g, '$1译文: ') : `译文: ${text}`) }));
  } else if (request.url === '/formula.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="31"><text x="0" y="22">x+y</text></svg>');
  } else response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixture);
});
await new Promise(resolve => server.listen(0, resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const waitFor = async (read, test, label) => {
  const until = Date.now() + 30000; let value;
  do { value = await read(); if (test(value)) return value; await delay(150); } while (Date.now() < until);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
let browser, api, evaluate, navigate, capture, close;
try {
  if (firefox) {
    browser = await startFirefox(output, path.join(root, 'dist-firefox'));
    const handle = await browser.command('WebDriver:GetWindowHandle'); const control = handle.value ?? handle;
    const select = handle => browser.command('WebDriver:SwitchToWindow', { handle });
    await browser.command('WebDriver:Navigate', { url: `${browser.base}options.html` });
    api = async (source, input = []) => {
      await select(control);
      const result = await browser.executeAsync(`const done=arguments[arguments.length-1],input=JSON.parse(arguments[0]),chrome=window.wrappedJSObject.chrome;
        (async()=>{${source}})().then(value=>done(JSON.stringify({value})),error=>done(JSON.stringify({error:String(error)})));`, [JSON.stringify(input)]);
      const parsed = JSON.parse(result); if (parsed.error) throw new Error(parsed.error); return parsed.value;
    };
    const created = await browser.command('WebDriver:NewWindow', { type: 'tab' }); const page = (created.value ?? created).handle;
    evaluate = async source => { await select(page); return browser.execute(source); };
    navigate = async url => { await select(page); await browser.command('WebDriver:Navigate', { url }); };
    capture = async name => { await select(page); const value = await browser.command('WebDriver:TakeScreenshot', { id: null, highlights: [], full: false }); await fs.writeFile(path.join(output, name), Buffer.from(value.value, 'base64')); };
    close = () => browser.close();
  } else {
    const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
    const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
    browser = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
      ...target.chromiumOptions,
      headless: true, viewport: { width: 1400, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
    });
    const session = await browser.browser().newBrowserCDPSession();
    await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    const options = await browser.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    api = (source, input = []) => options.evaluate(`(async()=>{const input=${JSON.stringify(input)};${source}})()`);
    const page = await browser.newPage(); evaluate = source => page.evaluate(`(()=>{${source}})()`);
    navigate = url => page.goto(url); capture = name => page.screenshot({ path: path.join(output, name) }); close = () => browser.close();
  }
  const identity = verifyBrowserIdentity(target, await evaluate('return navigator.userAgent;'));
  const runtime = async request => { const result = await api('return chrome.runtime.sendMessage(input[0]);', [request]); assert.equal(result?.ok, true, JSON.stringify(result)); return result.data; };
  const settings = await runtime({ type: 'GET_SETTINGS' });
  settings.providers.push({ id: 'scientific-test', type: 'http-template', label: 'Scientific test', method: 'POST', url: `${origin}/translate`,
    headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
  Object.assign(settings, { activeProviderId: 'scientific-test', sourceLang: 'en', targetLang: 'zh-CN', translationDisplayMode: 'bilingual', cacheEnabled: false });
  await runtime({ type: 'SAVE_SETTINGS', settings });
  let currentUrl;
  const send = async request => {
    const result = await api(`const tab=(await chrome.tabs.query({})).find(t=>t.url===input[0]);return chrome.tabs.sendMessage(tab.id,input[1],{frameId:0});`, [currentUrl, request]);
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  const open = async url => { currentUrl = url; await navigate(url); await waitFor(() => evaluate('return !!document.querySelector("#wupage-floating-ball")'), Boolean, 'content runtime'); };
  const inspect = () => evaluate(`return {translations:[...document.querySelectorAll('.wupage-translation')].map(e=>({text:e.textContent,formulas:e.querySelectorAll('.MATH img').length,mode:e.dataset.wupageDisplayMode})),
    formulaTranslations:document.querySelectorAll('.mathdisplay .wupage-translation,.MATH .wupage-translation').length};`);
  const remember = () => evaluate(`const w=window.wrappedJSObject||window;w.scientificOriginal={images:[...document.querySelectorAll('.MATH img')],links:[...document.querySelectorAll('a')],
    values:[...document.querySelectorAll('.MATH img')].map(e=>e.outerHTML),texts:[...document.body.childNodes].filter(n=>n.nodeType===3).map(n=>n.data),
    equations:[...document.querySelectorAll('.mathdisplay')].map(e=>e.outerHTML)};return true;`);
  const originalState = () => evaluate(`const w=window.wrappedJSObject||window,o=w.scientificOriginal;return {
    translations:document.querySelectorAll('.wupage-translation').length,images:o.images.every((e,i)=>e.isConnected&&e.outerHTML===o.values[i]),links:o.links.every(e=>e.isConnected),
    text:o.texts.every(text=>document.body.textContent.includes(text)),hidden:document.querySelectorAll('.wupage-replaced-source').length,
    equations:[...document.querySelectorAll('.mathdisplay')].every((e,i)=>e.outerHTML===o.equations[i])};`);
  await open(origin + '/fixture'); await remember(); await send({ type: 'TRANSLATE_PAGE' });
  await waitFor(inspect, value => value.translations.length > 3, 'fixture translations'); await delay(1000);
  const first = await inspect(); await capture(baseline ? 'baseline-fixture.png' : 'fixture.png');
  if (!baseline) {
    assert.ok(requestedSegments().some(text => /^Bare introduction with a reference and emphasized words remains one complete paragraph\.$/.test(text)), 'one bare paragraph');
    assert.ok(first.translations.some(t => t.text.includes('tail and improves') && t.formulas === 1), 'abstract formula');
    assert.ok(first.translations.some(t => t.text.includes('retains both formulas') && t.formulas === 2), 'inline math');
    assert.ok(first.translations.some(t => t.text.includes('denotes an input') && t.formulas === 1), 'prose after equation');
    assert.equal(first.formulaTranslations, 0, 'no translated equations');
    assert.ok(!calls.some(text => /very_long_latex|Bare distant paragraph/.test(text)), 'no math alt or distant prose requests');
    checks.push('complete legacy prose runs; inline formulas preserved; display equations and math alt excluded; viewport scheduling');
    const callCount = calls.length;
    for (const mode of ['replace', 'bilingual-accent', 'bilingual']) {
      settings.translationDisplayMode = mode; await runtime({ type: 'SAVE_SETTINGS', settings });
      await waitFor(inspect, value => value.translations.every(t => t.mode === mode), mode);
      const state = await inspect(); assert.ok(state.translations.some(t => t.formulas === 2)); assert.equal(state.formulaTranslations, 0);
    }
    assert.equal(calls.length, callCount, 'mode switch without new calls');
    await send({ type: 'CLEAR_TRANSLATION' });
    assert.deepEqual(await originalState(), { translations: 0, images: true, links: true, text: true, hidden: 0, equations: true });
    await send({ type: 'TRANSLATE_PAGE' }); await delay(500);
    assert.equal(calls.length, callCount, 'resume reuses results');
    await evaluate('window.scrollTo(0,document.body.scrollHeight)');
    await waitFor(inspect, value => value.translations.some(t => t.text.includes('Bare distant paragraph')), 'distant paragraph after scrolling');
    checks.push('three display modes reuse results; original formula and citation nodes restored');
    checks.push('hidden and resumed translation reuses results; distant bare prose translated after scrolling');
  }
  if (process.argv.includes('--live')) {
    calls.length = 0; await open('https://openmx-square.org/exx/PRA2011/index.html'); await remember(); await send({ type: 'TRANSLATE_PAGE' });
    await waitFor(inspect, value => value.translations.length > 3, 'OpenMX translations'); await delay(1500);
    const live = await inspect(); await capture(baseline ? 'baseline-openmx.png' : 'openmx.png');
    await fs.writeFile(path.join(output, baseline ? 'baseline-live.json' : 'live.json'), JSON.stringify({ calls, ...live }, null, 2));
    if (!baseline) {
      assert.ok(live.translations.some(t => t.formulas > 0 && t.text.includes('asymptotic')), 'real abstract retains formula');
      assert.ok(requestedSegments().some(text => text.startsWith('The density-functional theory') && text.includes('formulation by') && text.endsWith('biophysics.')), 'real introduction paragraph grouped');
      assert.equal(live.formulaTranslations, 0);
      settings.translationDisplayMode = 'replace'; await runtime({ type: 'SAVE_SETTINGS', settings });
      await waitFor(inspect, value => value.translations.every(t => t.mode === 'replace'), 'real page replacement mode');
      await capture('openmx-replace.png');
      await evaluate(`document.querySelector('h2').scrollIntoView()`);
      await waitFor(inspect, value => value.translations.some(t => t.text.includes('atomic units') && t.formulas > 0), 'real formulation after scrolling');
      assert.equal((await originalState()).equations, true, 'real display equations unchanged');
      await capture('openmx-equations.png');
      await send({ type: 'CLEAR_TRANSLATION' });
      assert.deepEqual(await originalState(), { translations: 0, images: true, links: true, text: true, hidden: 0, equations: true });
      checks.push('live OpenMX article: complete abstract and introduction with original inline formula images');
      checks.push('live OpenMX article: replacement mode, scrolling to formulation, unchanged display equations, original image and link node restoration');
    }
  }
  await fs.writeFile(path.join(output, baseline ? 'baseline-report.json' : 'report.json'), JSON.stringify({ ...identity, checks, calls, first }, null, 2));
  console.log(JSON.stringify({ ...identity, baseline, checks, segments: first.translations.length, output }, null, 2));
} finally { if (close) await close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
