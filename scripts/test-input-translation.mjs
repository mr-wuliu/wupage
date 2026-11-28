import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const calls = [];
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    const ai = request.url === '/v1/chat/completions';
    const source = ai ? JSON.parse(data.messages.at(-1).content) : data;
    calls.push({ ai, source, prompt: ai ? data.messages[0].content : '', auth: request.headers.authorization });
    if (source.texts[0] === '等待') await delay(500);
    const text = source.texts.map(value => ai && source.targetLang === 'original' ? value + '喵' : 'Translated ' + value);
    const payload = ai ? { choices: [{ message: { content: JSON.stringify(text) } }] } : { translations: text };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (request.url === '/frame') {
    response.end('<input id="embedded" type="search" value="嵌入">');
    return;
  }
  response.end(`<!doctype html><meta charset="utf-8"><style>
    body { font: 16px system-ui; margin: 24px; }
    input,textarea,[contenteditable] { display: block; margin: 10px 0; padding: 8px; border: 1px solid; width: 290px; }
  </style><input type="search" id="query" value="原稿  "><output id="value"></output>
  <textarea id="draft"></textarea><div id="editable" contenteditable="true"></div>
  <input id="password" type="password" value="private"><input id="otp" autocomplete="one-time-code" value="123456">
  <iframe src="/frame" title="Embedded field"></iframe><script>
    window.draftEvents=[];
    const field=document.querySelector('#query');
    field.addEventListener('input',event=>{document.querySelector('#value').textContent=field.value;window.draftEvents.push([event.inputType,event.data,field.value]);});
  </script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const host = "document.querySelector('#wupage-input-translation')";
const menu = host + '?.shadowRoot';
let browser;

async function waitFor(source) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await browser.evaluate(source)) return;
    await delay(40);
  }
  throw new Error('Timed out: ' + source + '\n' + JSON.stringify(await browser.evaluate(
    "return { url: location.href, value: document.querySelector('#query')?.value, events: window.draftEvents, menu: " + menu + "?.textContent };"
  )));
}

async function open(id = 'query', value) {
  await browser.evaluate("const field=document.getElementById(" + JSON.stringify(id) + ");field.focus();"
    + "const value=" + JSON.stringify(value ?? null) + ";if(value!==null){if(field.isContentEditable)field.textContent=value;else field.value=value;}"
    + "if(field.isContentEditable){const range=document.createRange();range.selectNodeContents(field);range.collapse(false);window.getSelection().removeAllRanges();window.getSelection().addRange(range);}"
    + "else field.setSelectionRange(field.value.length,field.value.length);");
  await pressGesture();
  await waitFor('return !!' + menu + '?.querySelector("button");');
}

async function pressGesture() {
  for (let count = 0; count < 3; count++) await browser.press('Space');
}

function buttonSelector(id) {
  return menu + '.querySelector(' + JSON.stringify('[data-template-id="' + id + '"]') + ')';
}

async function choose(id) {
  const center = await browser.evaluate("const rect=" + buttonSelector(id)
    + ".getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};");
  await browser.pointer([{ type: 'move', ...center }, { type: 'down' }, { type: 'up' }]);
}

function menuGeometry(id) {
  return browser.evaluate(`
    const field = document.getElementById(${JSON.stringify(id)});
    const caret = field.isContentEditable ? getSelection().getRangeAt(0).getBoundingClientRect().toJSON() : null;
    return { field: field.getBoundingClientRect().toJSON(), caret, viewportWidth: innerWidth,
      popup: ${menu}.querySelector('.popup').getBoundingClientRect().toJSON() };`);
}

function menuColors() {
  return browser.evaluate(`
    const popup = ${menu}.querySelector('.popup');
    const read = element => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color, style.borderTopWidth, style.boxShadow];
    };
    const [background, , border, shadow] = read(popup);
    return { shell: [background, border, shadow], buttons: [...popup.querySelectorAll('button')].map(read) };`);
}

try {
  browser = await openExtensionBrowser(root, path.join(root, '.npm-cache/input-translation', target.kind), target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const options = await browser.api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
  Object.assign(settings.providers.find(provider=>provider.id==='http-template'), {
    url: input[0] + '/translate', bodyTemplate:'{"texts":{{json texts}},"source":"{{sourceLang}}","target":"{{targetLang}}"}'
  });
  Object.assign(settings.providers.find(provider=>provider.id==='openai-compatible'), {
    baseURL: input[0] + '/v1', apiKey:'local-test-key', ollamaCompatibility:false, systemPrompt:'PAGE_PROMPT'
  });
  settings.inputTranslation.templates[0].providerId='http-template';
  Object.assign(settings.inputTranslation.templates[1], {providerId:'openai-compatible',prompt:'Playful cat voice'});
  Object.assign(settings.appearance, {mode:'light',lightSchemeId:'sakura'});
  const saved=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings,interfaceLanguage:'zh-CN'});
  if(!saved.ok)throw new Error(saved.error);return chrome.runtime.getURL('options.html#inputTranslationSettings');`, [origin]);
  await browser.navigate(origin);
  await waitFor('return Boolean(document.querySelector("#wupage-selection-tools"));');
  await waitFor('return getComputedStyle(document.documentElement).getPropertyValue("--wp-input-button-background").trim() === "#b33970";');
  await open();
  assert.equal(await browser.evaluate('return document.querySelector("#query").value;'), '原稿  ');
  assert.deepEqual(await browser.evaluate('return [...' + menu + '.querySelectorAll("button")].map(button=>button.textContent);'), ['英文', '喵']);
  const lightMenu = await menuColors();
  assert.deepEqual(lightMenu.shell, ['rgba(0, 0, 0, 0)', '0px', 'none'], 'no shared border, fill or shadow');
  assert.deepEqual(lightMenu.buttons, Array.from({ length: 2 }, () => ['rgb(179, 57, 112)', 'rgb(255, 255, 255)', '0px', 'none']));
  const search = await menuGeometry('query');
  assert.ok(search.popup.left > search.field.left + 20 && search.popup.top < search.field.bottom, 'single-line menu sits after the text');
  assert.equal(calls.length, 0, 'opening a menu never sends text');
  await browser.evaluate(buttonSelector('english') + '.click();');
  assert.equal(await browser.evaluate('return ' + menu + '.querySelector(".popup").hasAttribute("aria-busy");'), false);
  await browser.press('Tab');
  await browser.press('Enter');
  await waitFor('return document.querySelector("#query").value === "Translated 原稿  ";');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].source, { texts: ['原稿'], source: 'auto', target: 'en' });
  assert.equal(await browser.evaluate('return document.querySelector("#value").textContent;'), 'Translated 原稿  ');
  await browser.press('Control+Z');
  assert.equal(await browser.evaluate('return document.querySelector("#query").value;'), '原稿  ', 'native undo restores the draft with its original spaces');

  await browser.evaluate(`
    Object.assign(document.querySelector('#draft').style,
      { font: '16px/20px monospace', width: 'calc(10.5ch + 18px)', height: '100px', boxSizing: 'border-box' });`);
  await open('draft', '12345678');
  const firstLine = await menuGeometry('draft');
  assert.ok(firstLine.popup.left > firstLine.field.left + 70 && firstLine.popup.top < firstLine.field.top + 20,
    'a tall textarea opens the menu by the first line');
  await browser.press('Escape');
  await open('draft', '1234567890abc');
  const wrapped = await menuGeometry('draft');
  assert.ok(Math.abs(wrapped.popup.top - firstLine.popup.top - 20) < 1
    && firstLine.popup.left - wrapped.popup.left > 32, 'soft wrapping moves the caret one line down and back to the left');
  await browser.press('Escape');
  await open('draft', '12345678\n');
  const emptyLine = await menuGeometry('draft');
  assert.ok(Math.abs(emptyLine.popup.top - firstLine.popup.top - 20) < 1
    && firstLine.popup.left - emptyLine.popup.left > 60,
  'a final line break anchors the menu to the new line: ' + JSON.stringify({ firstLine, emptyLine }));
  await browser.press('Escape');

  await browser.evaluate(`
    Object.assign(document.querySelector('#draft').style, { width: '210px', height: '106px', paddingBottom: '34px' });`);
  await open('draft', 'above\n'.repeat(9) + 'end');
  await browser.evaluate("const draft=document.querySelector('#draft');draft.scrollTop=draft.scrollHeight;");
  await waitFor('return document.querySelector("#draft").scrollTop > 80;');
  await waitFor('return ' + menu + '.querySelector(".popup").getBoundingClientRect().top'
    + ' < document.querySelector("#draft").getBoundingClientRect().bottom - 30;');
  const scrolled = await menuGeometry('draft');
  assert.ok(scrolled.popup.top < scrolled.field.bottom - 30, 'menu uses the scrolled textarea caret rather than its bottom edge');
  await browser.evaluate("document.querySelector('#draft').scrollTop -= 12;");
  await waitFor('return ' + menu + '.querySelector(".popup").getBoundingClientRect().top > ' + (scrolled.popup.top + 8) + ';');
  assert.ok(Math.abs((await menuGeometry('draft')).popup.top - scrolled.popup.top - 12) < 1, 'menu follows scroll inside the textarea');
  await browser.press('Escape');
  await browser.evaluate("document.querySelector('#draft').style.cssText='width:480px;height:120px;';");

  await open('draft', '保持语言');
  await browser.capture('input-menu-at-caret.png');
  await choose('meow');
  await waitFor('return document.querySelector("#draft").value === "保持语言喵";');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].auth, 'Bearer local-test-key');
  assert.equal(calls[1].source.targetLang, 'original');
  assert.match(calls[1].prompt, /Playful cat voice/u);
  assert.doesNotMatch(calls[1].prompt, /PAGE_PROMPT/u);
  const pageResult = await browser.api("return chrome.runtime.sendMessage({type:'TRANSLATE_BATCH',texts:['页面'],providerId:'openai-compatible',targetLang:'en'});");
  assert.equal(pageResult.ok, true);
  assert.match(calls[2].prompt, /PAGE_PROMPT/u);
  assert.doesNotMatch(calls[2].prompt, /Playful cat voice/u);

  await open('editable', '编辑内容');
  const editable = await menuGeometry('editable');
  assert.ok(Math.abs(editable.popup.left - editable.caret.right - 6) < 1 && editable.popup.top < editable.caret.bottom,
    'contenteditable uses the native caret range');
  await choose('meow');
  await waitFor('return document.querySelector("#editable").innerText === "编辑内容喵";');
  await browser.press('Control+Z');
  assert.equal(await browser.evaluate('return document.querySelector("#editable").innerText;'), '编辑内容');

  await open('query', '等待');
  await choose('english');
  await browser.press('x');
  await delay(650);
  assert.equal(await browser.evaluate('return document.querySelector("#query").value;'), '等待x');
  assert.equal(await browser.evaluate('return Boolean(' + host + ');'), false);

  for (const field of ['password', 'otp']) {
    await browser.evaluate("const field=document.querySelector('#" + field + "');field.focus();");
    await pressGesture();
    assert.equal(await browser.evaluate('return Boolean(' + host + ');'), false, field + ' does not trigger the menu');
  }
  await open('query', '取消');
  await browser.press('Escape');
  assert.equal(await browser.evaluate('return Boolean(' + host + ');'), false);
  assert.equal(await browser.evaluate('return document.querySelector("#query").value;'), '取消');
  await browser.evaluate(`
    Object.assign(document.querySelector('#query').style,
      { position: 'fixed', right: '8px', bottom: '0', width: '106px', margin: '0', textAlign: 'right' });`);
  await open('query', 'near edge');
  const edge = await menuGeometry('query');
  assert.ok(edge.popup.right <= edge.viewportWidth - 7 && edge.popup.bottom < edge.field.top + 8,
    'menu flips above the caret when it is near the bottom-right corner');
  await browser.press('Escape');
  await browser.evaluate("document.querySelector('#query').removeAttribute('style');");
  assert.equal(calls.length, 5, 'only chosen, available templates contact a service');

  await browser.evaluate("const frame=document.querySelector('iframe');const field=frame.contentDocument.querySelector('#embedded');"
    + "field.focus();field.setSelectionRange(field.value.length,field.value.length);");
  const frameMenu = "document.querySelector('iframe').contentDocument.querySelector('#wupage-input-translation')?.shadowRoot";
  await waitFor("return !!document.querySelector('iframe').contentDocument.querySelector('#wupage-selection-tools');");
  await pressGesture();
  await waitFor("return !!" + frameMenu + "?.querySelector('button');");
  await browser.press('Tab');
  await browser.press('Enter');
  await waitFor("return document.querySelector('iframe').contentDocument.querySelector('#embedded').value === 'Translated 嵌入';");

  const seededPicker = await browser.api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    settings.providers.find(provider=>provider.id==='microsoft-web-translate').enabled=false;
    settings.providers.find(provider=>provider.id==='deepseek').enabled=false;
    settings.inputTranslation.templates[0].providerId='microsoft-web-translate';
    return chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});`);
  assert.equal(seededPicker.ok, true);
  await browser.navigate(options);
  await waitFor('return document.querySelectorAll("#inputTemplates article").length === 2;');
  await waitFor('const toggle = document.querySelector("#inputTranslationEnabled");'
    + 'return toggle.checked && toggle.parentElement.getAnimations({ subtree: true }).length === 0;');
  const services = await browser.evaluate(`
    const picker = id => document.querySelector('[data-template-id="' + id + '"] .wupage-provider-picker');
    const choices = id => [...picker(id).querySelectorAll('.wupage-provider-choice')].filter(option => option.dataset.value).map(option => option.dataset.value);
    const trigger = id => picker(id).querySelector('.wupage-provider-trigger');
    const style = element => {
      const { borderTopColor, borderTopWidth, backgroundColor, fontWeight, minHeight } = getComputedStyle(element);
      return [borderTopColor, borderTopWidth, backgroundColor, fontWeight, minHeight];
    };
    return { machine: choices('english'), ai: choices('meow'), missingBinding: trigger('english').textContent.trim(),
      aiIcon: trigger('meow').querySelector('[data-provider-icon]')?.dataset.providerIcon,
      inputStyle: style(trigger('english')), serviceStyle: style(document.querySelector('#providerTrigger')) };`);
  assert.equal(services.machine.includes('microsoft-web-translate'), false);
  assert.equal(services.machine.includes('google-web-translate'), true);
  assert.equal(services.machine.includes('openai-compatible'), false);
  assert.equal(services.ai.includes('deepseek'), false);
  assert.equal(services.ai.includes('openai-compatible'), true);
  assert.equal(services.ai.includes('google-web-translate'), false);
  assert.equal(services.missingBinding, '选择服务');
  assert.equal(services.aiIcon, 'openai');
  assert.deepEqual(services.inputStyle, services.serviceStyle);
  for (const width of [1400, 320, 390]) {
    await browser.resize(width, width === 1400 ? 1000 : 760);
    const layout = await browser.evaluate(`
      const templates = [...document.querySelectorAll('.input-template-heading')].map(heading =>
        [...heading.querySelectorAll('input[type="text"], .setting-toggle, .input-template-actions button')].map(control => {
          const { top, bottom, left, right, height } = control.getBoundingClientRect();
          return { top, bottom, left, right, height };
        }));
      return { templates, fits: document.documentElement.scrollWidth <= innerWidth };`);
    assert.equal(layout.fits, true, width + 'px settings fit the viewport');
    for (const controls of layout.templates) {
      const [name, toggle, ...buttons] = controls;
      assert.ok(controls.every(control => Math.abs(control.height - name.height) < 1), width + 'px control heights match');
      assert.ok(buttons.every(button => Math.abs(button.top - buttons[0].top) < 1), width + 'px action buttons align');
      if (width === 1400) {
        assert.ok(controls.every(control => Math.abs(control.top - name.top) < 1), 'desktop controls share both edges');
      } else {
        assert.ok(toggle.top > name.bottom && toggle.left === name.left && buttons.at(-1).right <= name.right + 1,
          width + 'px toolbar fits below the name field');
      }
    }
    if (width !== 320) {
      await browser.capture(width === 1400 ? 'input-settings-desktop.png' : 'input-settings.png');
      const triggerSelector = '[data-template-id="english"] .wupage-provider-trigger';
      await browser.evaluate(`document.querySelector(${JSON.stringify(triggerSelector)}).scrollIntoView({ block: 'center' });`);
      await delay(40);
      const picker = await browser.evaluate(`
        const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
        trigger.click();
        const menu = document.getElementById(trigger.getAttribute('aria-controls'));
        const box = menu.getBoundingClientRect();
        const triggerBox = trigger.getBoundingClientRect();
        return { open: !menu.hidden, fits: box.width > 0 && box.left >= 0 && box.right <= innerWidth
          && box.top >= 0 && box.bottom <= innerHeight,
          aligned: Math.abs(box.left - triggerBox.left) < 1 && Math.abs(box.right - triggerBox.right) < 1 };`);
      assert.deepEqual(picker, { open: true, fits: true, aligned: true }, width + 'px service menu aligns with its trigger');
      await delay(160);
      await browser.capture(width === 1400 ? 'input-services-desktop.png' : 'input-services.png');
      await browser.press('Escape');
    }
  }
  await browser.evaluate(`const meow=document.querySelector('[data-template-id="meow"]');
    meow.querySelector('.input-template-up').click();meow.querySelector('input[type=text]').value='猫语';
    document.querySelector('[data-template-id="english"] input[type=checkbox]').click();
    document.querySelector('#save').click();`);
  await waitFor("return document.querySelector('#status').textContent === '已保存。';");
  const stored = await browser.api("return (await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data.inputTranslation;");
  assert.deepEqual(stored.templates.map(entry => [entry.id, entry.label, entry.enabled]), [['meow', '猫语', true], ['english', '', false]]);
  assert.equal(stored.templates.find(entry => entry.id === 'english').providerId, 'microsoft-web-translate');
  await browser.evaluate(`const picker = document.querySelector('[data-template-id="english"] .wupage-provider-picker');
    picker.querySelector('.wupage-provider-trigger').click();`);
  assert.equal(await browser.evaluate('return document.querySelector(\'[data-template-id="english"] .wupage-provider-list\').hidden;'), false);
  await browser.evaluate(`const picker = document.querySelector('[data-template-id="english"] .wupage-provider-picker');
    picker.querySelector('[data-value="google-web-translate"]').click();
    document.querySelector('#save').click();`);
  await waitFor("return document.querySelector('#status').textContent === '已保存。';");
  const rebound = await browser.api("return (await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data.inputTranslation.templates.find(entry=>entry.id==='english').providerId;");
  assert.equal(rebound, 'google-web-translate');
  await browser.api("const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});"
    + "Object.assign(settings.appearance,{mode:'dark',darkSchemeId:'midnight'});"
    + "return chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});");
  await browser.navigate(origin);
  await waitFor('return Boolean(document.querySelector("#wupage-selection-tools"));');
  await waitFor('return getComputedStyle(document.documentElement).getPropertyValue("--wp-input-button-background").trim() === "#9cbcff";');
  await open('query', '调整后的菜单');
  assert.deepEqual(await browser.evaluate('return [...' + menu + '.querySelectorAll("button")].map(button=>button.textContent);'), ['猫语']);
  assert.deepEqual((await menuColors()).buttons, [['rgb(156, 188, 255)', 'rgb(0, 0, 0)', '0px', 'none']]);
  await browser.capture('input-menu.png');
  await browser.api("const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});"
    + "settings.inputTranslation.templates[0].providerId='';"
    + "return chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});");
  await waitFor('return !' + host + ';');
  await open('query', '尚未绑定');
  assert.equal(await browser.evaluate('return ' + buttonSelector('meow') + '.title;'), '配置模板');
  const beforeConfiguration = calls.length;
  await choose('meow');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await browser.api('return (await chrome.tabs.query({})).some(tab=>tab.url===input[0]);', [options])) break;
    await delay(40);
  }
  assert.equal(await browser.api('return (await chrome.tabs.query({})).some(tab=>tab.url===input[0]);', [options]), true);
  assert.equal(calls.length, beforeConfiguration);
  await browser.navigate(options.replace('#inputTranslationSettings', '#appearanceSettings'));
  await browser.resize(1400, 1000);
  await waitFor("return getComputedStyle(document.querySelector('.appearance-preview-input-button')).backgroundColor === 'rgb(156, 188, 255)';");
  await browser.evaluate("for (const group of document.querySelectorAll('details[data-color-group]')) group.open=group.dataset.colorGroup==='input';");
  await browser.capture('input-appearance.png');
  process.stdout.write(JSON.stringify({ ...identity, checks: [
    'trusted triple Space and template activation, trailing-space cleanup, keyboard choice and native undo',
    'machine service routing, shared AI credential, same-language rewrite and prompt isolation',
    'caret anchors in single-line and wrapped or scrolled controls, native editable ranges and viewport-edge placement',
    'borderless template buttons use the active light or dark palette and appear in its settings preview',
    'simple contenteditable, embedded input, native undo, stale response and sensitive fields',
    'template pickers use the service UI and compatibly retain, hide, and replace unavailable bindings',
    'Escape, aligned desktop and narrow settings, persisted template order, visibility and unconfigured template guidance'
  ] }, null, 2) + '\n');
} finally {
  try { await browser?.close(); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
