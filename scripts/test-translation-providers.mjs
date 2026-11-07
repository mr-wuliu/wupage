// Real extension requests and settings UI against a local protocol fixture.
// No API credentials, external translation requests or model downloads are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
const output = path.join(root, '.npm-cache/translation-providers', target.kind, String(Date.now()));
const calls = [];
const server = http.createServer(async (req, res) => {
  try {
    let content = '';
    for await (const chunk of req) content += chunk;
    const body = JSON.parse(content);
    calls.push({ url: req.url, headers: req.headers, body });
    const deepl = req.url === '/deepl/v2/translate';
    assert.ok(deepl || req.url === '/index/v1/chat/completions');
    const texts = deepl ? body.text : JSON.parse(body.messages.at(-1).content).texts;
    const translated = texts.map((_, i) => `测试译文 ${i + 1}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Intentionally omit CORS headers: these requests belong to the extension background.
    res.end(JSON.stringify(deepl ? { translations: translated.map(text => ({ text })) }
      : { choices: [{ message: { content: `<think>fixture reasoning</think>\n${JSON.stringify(translated)}` } }] }));
  } catch (error) {
    res.writeHead(400); res.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
let browser;
async function waitFor(source) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await browser.evaluate(source)) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${source}`);
}
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  await browser.api(`const result=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    if(!result.ok)throw new Error(result.error);
    const settings=result.data; settings.cacheEnabled=false; settings.targetLang='zh-TW';
    Object.assign(settings.providers.find(p=>p.type==='deepl'),{endpoint:input[0]+'/deepl',apiKey:'fixture-deepl:fx'});
    Object.assign(settings.providers.find(p=>p.type==='index-translate'),{baseURL:input[0]+'/index/v1',model:'IndexTeam/Index-Translate-9B',apiKey:''});
    const saved=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});if(!saved.ok)throw new Error(saved.error);`, [address]);

  for (const providerId of ['deepl', 'index-translate']) {
    const result = await browser.api(`return chrome.runtime.sendMessage({type:'TRANSLATE_BATCH',providerId:input[0],
      texts:['Hello','World'],sourceLang:'auto',targetLang:'zh-TW',context:'A greeting'});`, [providerId]);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.data.translations, ['测试译文 1', '测试译文 2']);
  }
  assert.equal(calls.length, 2, JSON.stringify(calls.map(call => ({ url: call.url, body: call.body }))));
  assert.equal(calls[0].headers.authorization, 'DeepL-Auth-Key fixture-deepl:fx');
  assert.equal(calls[0].headers.origin, undefined, 'DeepL must not receive a browser Origin header');
  assert.deepEqual(calls[0].body.text, ['Hello', 'World']);
  assert.equal(calls[0].body.target_lang, 'ZH-HANT');
  assert.equal(calls[0].body.source_lang, undefined);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].body.model, 'IndexTeam/Index-Translate-9B');
  assert.equal(calls[1].body.chat_template_kwargs.enable_thinking, false);

  const url = await browser.api('return chrome.runtime.getURL("options.html#providerSettings");');
  await browser.navigate(url);
  await waitFor('return !document.getElementById("providerSettings").hidden && !!document.querySelector("[data-action=select][data-provider-id=deepl]");');
  for (const providerId of ['deepl', 'index-translate']) {
    await browser.evaluate(`document.getElementById('providerTrigger').click();
      document.querySelector('[data-action="select"][data-provider-id="${providerId}"]').click();`);
    await waitFor(`return document.getElementById('providerForm').dataset.providerId==='${providerId}';`);
    assert.equal(await browser.evaluate(`return document.querySelector('[data-field="apiKey"]').type;`), 'password');
    await browser.capture(`${providerId}-desktop.png`);
    await browser.resize(390, 844);
    await delay(100);
    assert.ok(await browser.evaluate('return document.documentElement.scrollWidth<=window.innerWidth+1;'), `${providerId}: horizontal overflow`);
    await browser.capture(`${providerId}-mobile.png`);
    await browser.resize(1400, 1000);
  }
  const report = { ...identity, checks: ['DeepL authenticated batch and language mapping', 'Index bridge batch, local model and thinking suppression',
    'Settings selection on desktop and 390px screens'], origins: calls.map(call => ({ url: call.url, origin: call.headers.origin ?? null })) };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
