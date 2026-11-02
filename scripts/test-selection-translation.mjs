// Real MV3 regression: local page, synthetic dictionaries and audio, isolated browser profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const output = path.join(root, '.npm-cache/selection-translation');
await fs.mkdir(output, { recursive: true });
const checks = [];
const errors = [];
const translationCalls = [];
// A short real PCM wave validates decoding/playback without calling a voice service.
const audio = Buffer.alloc(44 + 3200);
audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
audio.write('data', 36); audio.writeUInt32LE(3200, 40);
for (let i = 0; i < 1600; i++) audio.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 8000) * 500), 44 + i * 2);

const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/translate') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    let input;
    try { input = JSON.parse(raw); } catch { response.writeHead(400).end('Invalid test request JSON'); return; }
    translationCalls.push(input);
    if (input.texts.includes('slow translation')) await new Promise(resolve => setTimeout(resolve, 500));
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translations: input.texts.map(text => `译文：${text}`) }));
    return;
  }
  if (request.url === '/page.css') {
    response.writeHead(200, { 'content-type': 'text/css' }).end('body{font:20px/1.8 system-ui;margin:70px;color:#243a35}p{margin:30px 0}#multiline{width:180px}textarea{display:block}');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'none'" });
  response.end('<!doctype html><html><head><meta charset="utf-8"><title>Dictionary reading test</title><link rel="stylesheet" href="/page.css"></head><body><h1>A quiet place to read</h1><p id="first">example</p><p id="second">running</p><p id="slow">slow</p><p id="missing">missing</p><p id="failure">failure</p><p id="title">feat: add selection translation with dictionaries</p><p id="slowTranslation">slow translation</p><p id="multiline">take off and explore a wider world</p><p id="chinese">齉</p><p id="polyphonic">重</p><p id="chinesePinyin">你好</p><p id="chineseMissing">龘</p><p id="chineseSentence">这是一句需要直接翻译的中文。</p><textarea aria-label="Draft">private draft</textarea><div id="editable" contenteditable="true">private note</div></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--load-extension=${path.join(root, 'dist')}`, '--mute-audio'], viewport: { width: 1100, height: 800 }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(({ wav }) => {
    const original = globalThis.fetch.bind(globalThis);
    globalThis.dictionaryCalls = [];
    globalThis.dictionaryBadAudio = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url || String(input));
      const isYoudao = url.hostname === 'dict.youdao.com';
      const isBing = url.hostname === 'cn.bing.com';
      if (!isYoudao && !isBing) return original(input, init);
      const voice = url.pathname === '/dictvoice' || url.pathname === '/dict/mediamp3';
      const q = url.searchParams.get('q');
      globalThis.dictionaryCalls.push({ provider: isYoudao ? 'youdao' : 'bing', voice, q, credentials: init?.credentials,
        dictionaries: url.searchParams.get('dicts'), language: url.searchParams.get('le') });
      if (voice) return globalThis.dictionaryBadAudio ? new Response('<html>unavailable</html>', { headers: { 'content-type': 'text/html' } })
        : new Response(Uint8Array.from(atob(wav), c => c.charCodeAt(0)), { headers: { 'content-type': 'audio/wav' } });
      if (q === 'slow') await new Promise(resolve => setTimeout(resolve, 500));
      if (q === 'failure') return new Response('limited', { status: 429 });
      if (isYoudao && q === '齉') return Response.json({ input: q, newhh: { word: q, dataList: [
        { pinyin: 'nàng', cat: '形容词', sense: [{ def: ['鼻子不通气；也指因鼻子不通气而发音不清'] }] }
      ] } });
      if (isYoudao && q === '重') return Response.json({ input: q, newhh: { word: q, dataList: [
        { pinyin: 'chóng', sense: [{ cat: '动词', def: ['重叠；重复'] }] },
        { pinyin: 'zhòng', sense: [{ cat: '形容词', def: ['重量大（跟“轻”相对）'] }] }
      ] } });
      if (isYoudao && q === '你好') return Response.json({ input: q, simple: { word: [{ phone: 'nǐ hǎo' }] } });
      if (isYoudao && q === '龘') return Response.json({ input: q });
      if (isYoudao) return Response.json(q === 'missing' ? { input: q } : { input: q, ec: { word: [{ 'return-phrase': { l: { i: q } },
        ukphone: 'ɪɡˈzɑːmpəl', usphone: 'ɪɡˈzæmpəl', ukspeech: q + '&type=1', usspeech: q + '&type=2',
        trs: [{ tr: [{ l: { i: ['n. 例子；范例'] } }] }] }] } });
      return new Response(`<html><head><title>${q} - 搜索 词典</title></head><body>${q === 'missing' ? '' : `<div class="qdef"><h1>${q}</h1><div class="hd_prUS">美 [ɪɡˈzæmpəl]</div><div class="hd_pr">英 [ɪɡˈzɑːmpəl]</div><a id="bigaud_uk" data-mp3link="/dict/mediamp3?blob=audio%2Fuk.mp3"></a><a id="bigaud_us" data-mp3link="/dict/mediamp3?blob=audio%2Fus.mp3"></a><ul><li><span class="pos">n.</span><span class="def">例子；示例</span></li></ul></div>`}</body></html>`, { headers: { 'content-type': 'text/html' } });
    };
  }, { wav: audio.toString('base64') });
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html#selectionTranslationSettings`);
  await settings.locator('#selectionTranslationEnabled').waitFor();
  await settings.waitForFunction(() => document.querySelector('#selectionTranslationEnabled').checked);
  assert.equal(await settings.locator('#selectionDictionary').inputValue(), 'youdao');
  assert.equal(await settings.locator('#selectionTriggerStyle').inputValue(), 'dot');
  await settings.evaluate(async origin => {
    const { data } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    data.activeProviderId = 'http-template'; data.sourceLang = 'en'; data.targetLang = 'zh-CN'; data.cacheEnabled = false;
    Object.assign(data.providers.find(item => item.id === 'http-template'), { label: '本地测试翻译', enabled: true,
      url: `${origin}/translate`, method: 'POST', headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"texts":{{json texts}},"source":"{{sourceLang}}","target":"{{targetLang}}"}', responsePath: 'translations' });
    const saved = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: data });
    if (!saved.ok) throw new Error(saved.error);
  }, origin);
  await settings.reload();
  await settings.waitForFunction(() => document.querySelector('#providerTriggerLabel').textContent === '本地测试翻译');
  checks.push('default settings and category navigation');
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('#wupage-selection-tools').waitFor({ state: 'attached' });
  const selector = '#wupage-selection-tools';
  const card = page.locator(`${selector} .card`);
  async function select(id) {
    await page.locator(id).scrollIntoViewIfNeeded();
    // Let the scroll event close the old card before capturing a new selection.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator(id).evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
    });
    await page.locator(`${selector} .trigger-dot,${selector} .trigger-line`).first().waitFor();
  }
  async function open(id = '#first') {
    await select(id);
    await page.locator(`${selector} .trigger-dot,${selector} .trigger-line`).first().click();
    await card.waitFor();
  }
  // Native mouse selection and pointer activation, rather than only programmatic ranges.
  await page.locator('#first').dblclick({ position: { x: 25, y: 14 } });
  await page.locator(`${selector} .trigger-dot`).waitFor();
  assert.equal(await worker.evaluate(() => globalThis.dictionaryCalls.length), 0);
  await page.screenshot({ path: path.join(output, 'dot-trigger.png') });
  await page.locator(`${selector} .trigger-dot`).click();
  await card.locator('.meanings').waitFor();
  assert.match(await card.innerText(), /例子/);
  assert.equal(await card.locator('.speak').count(), 2);
  await card.screenshot({ path: path.join(output, 'youdao-card.png') });
  checks.push('native selection, dot entry, click-only query and Youdao card');
  await card.locator('.speak').first().click();
  await page.waitForFunction(() => document.querySelector('#wupage-selection-tools').shadowRoot.querySelector('footer [role="status"]').textContent === '');
  assert.equal(await worker.evaluate(() => globalThis.dictionaryCalls.filter(call => call.voice).length), 1);
  assert.equal(await worker.evaluate(() => chrome.offscreen.hasDocument()), true);
  checks.push('real offscreen audio playback despite page media-src none');
  await card.locator('select').selectOption('bing');
  await card.locator('.meanings').waitFor();
  assert.match(await card.innerText(), /示例/);
  await card.locator('.speak').last().click();
  await page.waitForFunction(() => document.querySelector('#wupage-selection-tools').shadowRoot.querySelector('footer [role="status"]').textContent === '');
  await card.screenshot({ path: path.join(output, 'bing-card.png') });
  checks.push('Bing HTML parsed inside the extension and both voice endpoints');
  await page.keyboard.press('Escape'); assert.equal(await card.isVisible(), false);
  await open('#slow');
  await page.locator('#second').click(); await open('#second');
  await card.locator('.meanings').waitFor();
  await page.waitForTimeout(550);
  assert.equal(await card.locator('.word').inputValue(), 'running');
  checks.push('late lookup cannot replace a newer selection');
  await page.keyboard.press('Escape'); await open('#missing');
  await card.locator('.selection-translation').waitFor();
  assert.equal(await card.locator('.selection-translation').innerText(), '译文：missing');
  assert.equal(await card.locator('.translation-service').innerText(), '本地测试翻译');
  assert.equal(translationCalls.at(-1).target, 'zh-CN');
  assert.equal(translationCalls.at(-1).source, 'en');
  checks.push('unlisted single word falls back to the configured translation service');
  await page.keyboard.press('Escape'); await open('#failure');
  await card.getByText(/词典请求过于频繁/).waitFor();
  assert.equal(await card.getByRole('button', { name: '重试', exact: true }).count(), 1);
  checks.push('dictionary request errors retain their retry action');
  await page.keyboard.press('Escape');
  const dictionaryCount = await worker.evaluate(() => globalThis.dictionaryCalls.length);
  await open('#title'); await card.locator('.selection-translation').waitFor();
  assert.match(await card.locator('.selection-translation').innerText(), /译文：feat: add selection/);
  assert.equal(await worker.evaluate(() => globalThis.dictionaryCalls.length), dictionaryCount);
  assert.equal(await card.locator('select').isVisible(), false);
  assert.equal(await card.locator('.word').evaluate(element => getComputedStyle(element).fontSize), '13px');
  assert.equal(await card.locator('.selection-translation').evaluate(element => getComputedStyle(element).fontSize), '14px');
  assert.equal(await card.locator('.body').evaluate(element => element.scrollWidth > element.clientWidth), false);
  await card.screenshot({ path: path.join(output, 'text-translation.png') });
  checks.push('multiword titles bypass dictionaries and use a compact source heading');
  const editor = card.getByRole('textbox', { name: '原文', exact: true });
  const originalTitle = await page.locator('#title').innerText();
  const callsBeforeEdit = translationCalls.length;
  const editedText = 'OpenCode Go is designed for OpenCode and other coding agents.\nThe source can be edited inside this card.';
  await editor.fill(editedText);
  assert.equal(translationCalls.length, callsBeforeEdit);
  assert.equal(await card.locator('.body').isVisible(), false);
  await card.screenshot({ path: path.join(output, 'source-editor.png') });
  await card.getByRole('button', { name: '翻译', exact: true }).click();
  await card.locator('.selection-translation').waitFor();
  assert.equal(translationCalls.at(-1).texts[0], editedText);
  assert.equal(await page.locator('#title').innerText(), originalTitle);
  assert.equal(await editor.inputValue(), editedText);
  await card.screenshot({ path: path.join(output, 'edited-translation.png') });
  checks.push('source editing submits only on request and leaves the original webpage unchanged');
  await editor.fill('example'); await editor.press('Control+Enter');
  await card.locator('.meanings').waitFor();
  assert.equal(await card.getAttribute('data-mode'), 'dictionary');
  assert.equal(await worker.evaluate(() => globalThis.dictionaryCalls.at(-1).q), 'example');
  const callsBeforeInvalid = await worker.evaluate(() => globalThis.dictionaryCalls.length);
  await editor.fill(''); await card.getByRole('button', { name: '翻译', exact: true }).click();
  await card.getByText('请输入要查询或翻译的文字。').waitFor();
  assert.equal(await worker.evaluate(() => globalThis.dictionaryCalls.length), callsBeforeInvalid);
  await editor.fill('edited sentence\nwith a new line'); await editor.press('Control+Enter');
  await card.locator('.selection-translation').waitFor();
  assert.equal(translationCalls.at(-1).texts[0], 'edited sentence\nwith a new line');
  checks.push('Ctrl+Enter reclassifies edited text, preserves newlines and rejects an empty draft');
  await page.keyboard.press('Escape');
  const started = context.waitForEvent('request', { predicate: request => request.url() === `${origin}/translate` });
  await open('#slowTranslation'); await started;
  await page.locator('#second').click(); await open('#second'); await card.locator('.meanings').waitFor();
  await page.waitForTimeout(550);
  assert.equal(await card.locator('.word').inputValue(), 'running');
  assert.equal(await card.locator('.selection-translation').count(), 0);
  checks.push('late text translations cannot replace a newer word result');
  await page.keyboard.press('Escape'); await open(); await card.locator('.meanings').waitFor();
  await worker.evaluate(() => { globalThis.dictionaryBadAudio = true; });
  await card.locator('.speak').first().click();
  await card.getByText('词典未返回有效发音，请稍后重试。').waitFor();
  await worker.evaluate(() => { globalThis.dictionaryBadAudio = false; });
  checks.push('invalid audio response is reported');
  await page.keyboard.press('Escape');
  await settings.locator('#selectionTriggerStyle').selectOption('underline');
  await settings.locator('#selectionDictionary').selectOption('bing');
  await settings.locator('#save').click();
  await settings.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).data.selectionTranslation.style === 'underline');
  await page.locator('#multiline').scrollIntoViewIfNeeded();
  await select('#multiline');
  assert.ok(await page.locator(`${selector} .trigger-line`).count() >= 2);
  assert.equal(await page.locator('#multiline').innerHTML(), 'take off and explore a wider world');
  await page.screenshot({ path: path.join(output, 'underline-trigger.png') });
  await page.locator(`${selector} .trigger-line`).first().click(); await card.locator('.selection-translation').waitFor();
  assert.equal(await card.locator('.translation-service').innerText(), '本地测试翻译');
  checks.push('live settings changes and multiline selection translation');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 650 }); await page.locator('#first').scrollIntoViewIfNeeded(); await open(); await card.locator('.meanings').waitFor();
  assert.equal(await card.locator('select').inputValue(), 'bing');
  const bounds = await card.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await card.screenshot({ path: path.join(output, 'narrow-card.png') });
  checks.push('narrow viewport positioning');
  await page.keyboard.press('Escape');
  const translationsBeforeChinese = translationCalls.length;
  await page.locator('#chinese').scrollIntoViewIfNeeded(); await select('#chinese');
  const callsBeforeChinese = await worker.evaluate(() => globalThis.dictionaryCalls.length);
  await page.waitForTimeout(80);
  assert.equal(await worker.evaluate(() => globalThis.dictionaryCalls.length), callsBeforeChinese);
  assert.equal(await page.locator(`${selector} .trigger-line`).first().getAttribute('title'), '查词');
  await page.locator(`${selector} .trigger-line`).first().click(); await card.locator('.meanings').waitFor();
  assert.match(await card.locator('.phonetics').innerText(), /拼音 nàng/);
  assert.match(await card.locator('.meanings').innerText(), /鼻子不通气/);
  assert.equal(await card.locator('select').inputValue(), 'youdao');
  assert.equal(await card.locator('option[value="bing"]').isDisabled(), true);
  const chineseCall = await worker.evaluate(() => globalThis.dictionaryCalls.at(-1));
  assert.equal(chineseCall.provider, 'youdao');
  assert.equal(chineseCall.language, 'zh');
  assert.ok(JSON.parse(chineseCall.dictionaries).dicts[0].includes('newhh'));
  assert.equal(translationCalls.length, translationsBeforeChinese);
  assert.equal(await card.locator('.body').evaluate(element => element.scrollWidth > element.clientWidth), false);
  await card.screenshot({ path: path.join(output, 'chinese-card.png') });
  checks.push('click-only Chinese lookup displays tone-marked pinyin and Chinese definitions with Bing as the default');
  await page.keyboard.press('Escape');
  await page.locator('#polyphonic').scrollIntoViewIfNeeded(); await open('#polyphonic'); await card.locator('.meanings').waitFor();
  assert.match(await card.locator('.phonetics').innerText(), /chóng/);
  assert.match(await card.locator('.phonetics').innerText(), /zhòng/);
  assert.equal(await card.locator('.meaning-pronunciation').count(), 2);
  assert.match(await card.locator('.meanings li').first().innerText(), /chóng.*重叠/s);
  await card.screenshot({ path: path.join(output, 'chinese-polyphonic-card.png') });
  checks.push('polyphonic readings remain associated with their definitions in a narrow viewport');
  await page.keyboard.press('Escape');
  await page.locator('#chinesePinyin').scrollIntoViewIfNeeded(); await open('#chinesePinyin'); await card.locator('.phonetics').waitFor();
  assert.match(await card.locator('.phonetics').innerText(), /拼音 nǐ hǎo/);
  assert.equal(translationCalls.length, translationsBeforeChinese);
  checks.push('Chinese pinyin remains visible even without dictionary meanings');
  await page.keyboard.press('Escape');
  await page.locator('#chineseMissing').scrollIntoViewIfNeeded(); await open('#chineseMissing'); await card.locator('.selection-translation').waitFor();
  assert.equal(translationCalls.at(-1).texts[0], '龘');
  await page.keyboard.press('Escape');
  const dictionaryCallsBeforeSentence = await worker.evaluate(() => globalThis.dictionaryCalls.length);
  await page.locator('#chineseSentence').scrollIntoViewIfNeeded(); await open('#chineseSentence'); await card.locator('.selection-translation').waitFor();
  assert.equal(translationCalls.at(-1).texts[0], '这是一句需要直接翻译的中文。');
  assert.equal(await worker.evaluate(() => globalThis.dictionaryCalls.length), dictionaryCallsBeforeSentence);
  checks.push('unlisted Han selections fall back to translation while Chinese sentences bypass dictionaries');
  await page.keyboard.press('Escape');
  await page.locator('#first').scrollIntoViewIfNeeded(); await open(); await card.locator('.meanings').waitFor();
  assert.equal(await card.locator('select').inputValue(), 'bing');
  assert.equal(await card.locator('option[value="bing"]').isDisabled(), false);
  checks.push('Chinese lookup preserves the default dictionary for the next alphabetic word');
  await page.keyboard.press('Escape');
  await page.locator('#editable').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); });
  await page.waitForTimeout(80); assert.equal(await page.locator(`${selector} .trigger-line`).count(), 0);
  await settings.locator('label:has(#selectionTranslationEnabled)').click(); await settings.locator('#save').click();
  await settings.waitForFunction(async () => !(await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).data.selectionTranslation.enabled);
  await page.locator('#first').dblclick({ position: { x: 25, y: 14 } }); await page.waitForTimeout(80);
  assert.equal(await page.locator(`${selector} .trigger-line`).count(), 0);
  checks.push('editable text exclusion and disabled feature');
  assert.ok(await worker.evaluate(() => globalThis.dictionaryCalls.every(call => call.credentials === 'omit')));
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
  for (const [index, page] of (context?.pages() ?? []).entries()) {
    await page.screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => undefined);
    if (page.url().startsWith(origin)) console.log(JSON.stringify(await page.evaluate(() => {
      const host = document.getElementById('wupage-selection-tools'); const selection = window.getSelection();
      const trigger = host?.shadowRoot?.querySelector('.trigger-dot,.trigger-line');
      return { url: location.href, selection: selection?.toString(), active: document.activeElement?.outerHTML?.slice(0, 200),
        host: !!host, trigger: trigger?.outerHTML, triggerStyle: trigger ? { width: getComputedStyle(trigger).width, height: getComputedStyle(trigger).height, display: getComputedStyle(trigger).display } : null,
        rects: selection?.rangeCount ? Array.from(selection.getRangeAt(0).getClientRects()).map(rect => rect.toJSON()) : [], errors: [] };
    })));
  }
  throw error;
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
