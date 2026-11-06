// Editable selections exercised in a real browser with an isolated profile and a local translation service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/selection-fields', target.kind);
const checks = [], calls = [];
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    const { texts } = JSON.parse(body); calls.push(...texts);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ translations: texts.map(text => `译文：${text}`) }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (request.url === '/frame') { response.end('<input id="field" value="before selected phrase after" style="margin:20px;width:80%">'); return; }
  response.end(`<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;margin:20px}input,textarea{display:block;padding:10px;margin:15px 0;width:80%}iframe{width:90%;height:100px}#rich{margin:20px 0}</style>
    <h1>Translate selected text</h1><form><input id="field" name="field" value="before selected phrase after"><textarea id="draft">before\nselected phrase\nafter</textarea></form>
    <output id="saved"></output><div id="rich" contenteditable="true"><strong>selected phrase</strong></div>
    <input id="readonly" readonly value="read only phrase"><input id="password" type="password" value="private password">
    <iframe src="/frame" title="Draft editor"></iframe><script>document.getElementById('field').addEventListener('input',event=>document.getElementById('saved').textContent=event.target.value)</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const ui = `document.getElementById('wupage-selection-tools')?.shadowRoot`;
async function waitFor(source) {
  for (let i = 0; i < 200; i++) { if (await browser.evaluate(source)) return; await delay(50); }
  throw new Error(`Timed out: ${source}`);
}
async function translate(id, start, end) {
  await browser.evaluate(`const field=document.getElementById('${id}');field.focus();field.setSelectionRange(${start},${end});`);
  await waitFor(`return !!${ui}?.querySelector('.trigger-dot');`);
  assert.equal(calls.length, 0, 'selection alone never sends draft content');
  await browser.evaluate(`${ui}.querySelector('.trigger-dot').click();`);
  await waitFor(`return !!${ui}?.querySelector('.selection-translation');`);
  calls.length = 0;
}
const replace = () => browser.evaluate(`${ui}.querySelector('.replace-selection').click();`);
const close = () => browser.evaluate(`${ui}.querySelector('.close').click();`);
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  await browser.api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    Object.assign(settings,{activeProviderId:'http-template',sourceLang:'en',targetLang:'zh-CN',cacheEnabled:false});
    Object.assign(settings.providers.find(provider=>provider.id==='http-template'),{enabled:true,label:'Local selection test',url:input[0]+'/translate',method:'POST',headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
    const result=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});if(!result.ok)throw new Error(result.error);`, [origin]);
  await browser.navigate(origin); await waitFor(`return !!${ui};`);
  await translate('field', 7, 22); await replace();
  assert.equal(await browser.evaluate(`return document.getElementById('field').value;`), 'before 译文：selected phrase after');
  assert.equal(await browser.evaluate(`return document.getElementById('saved').textContent;`), 'before 译文：selected phrase after');
  assert.equal(await browser.evaluate(`return new FormData(document.querySelector('form')).get('field');`), 'before 译文：selected phrase after');
  await browser.press('Control+z');
  assert.equal(await browser.evaluate(`return document.getElementById('field').value;`), 'before selected phrase after');
  checks.push('input partial replacement, input notification, form value and native undo');
  await close(); await translate('draft', 7, 22); await replace();
  assert.equal(await browser.evaluate(`return document.getElementById('draft').value;`), 'before\n译文：selected phrase\nafter');
  await browser.press('Control+z');
  assert.equal(await browser.evaluate(`return document.getElementById('draft').value;`), 'before\nselected phrase\nafter');
  checks.push('textarea selection and undo preserve surrounding newlines');
  await close();
  await browser.evaluate(`const element=document.querySelector('#rich strong'),range=document.createRange();range.selectNodeContents(element);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));`);
  await waitFor(`return !!${ui}?.querySelector('.trigger-dot');`);
  await browser.evaluate(`${ui}.querySelector('.trigger-dot').click();`);
  await waitFor(`return !!${ui}?.querySelector('.selection-translation');`);
  calls.length = 0; await replace();
  assert.equal(await browser.evaluate(`return document.getElementById('rich').textContent;`), '译文：selected phrase');
  await browser.press('Control+z');
  assert.equal(await browser.evaluate(`return document.getElementById('rich').textContent;`), 'selected phrase');
  checks.push('basic contenteditable replacement and native undo');
  await close(); await translate('readonly', 0, 16);
  assert.equal(await browser.evaluate(`return ${ui}.querySelector('.result-actions').hidden;`), true);
  await close();
  await browser.evaluate(`const field=document.getElementById('password');field.focus();field.select();`); await delay(100);
  assert.equal(await browser.evaluate(`return ${ui}.querySelector('.triggers').childElementCount;`), 0);
  checks.push('read-only translation and password-field exclusion');
  await browser.evaluate(`const frame=document.querySelector('iframe').contentDocument,field=frame.getElementById('field');field.focus();field.setSelectionRange(7,22);`);
  const frameUi = `document.querySelector('iframe').contentDocument.getElementById('wupage-selection-tools')?.shadowRoot`;
  await waitFor(`return !!${frameUi}?.querySelector('.trigger-dot');`);
  await browser.evaluate(`${frameUi}.querySelector('.trigger-dot').click();`);
  await waitFor(`return !!${frameUi}?.querySelector('.selection-translation');`);
  await browser.evaluate(`${frameUi}.querySelector('.replace-selection').click();`);
  assert.equal(await browser.evaluate(`return document.querySelector('iframe').contentDocument.getElementById('field').value;`), 'before 译文：selected phrase after');
  checks.push('dormant frame input selection and replacement');
  await browser.capture('editable-selections.png');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, ...identity, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, ...identity, checks: checks.length, output }));
} catch (error) {
  await fs.mkdir(output, { recursive: true });
  await browser?.capture('failure.png').catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, error: String(error) }, null, 2));
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
