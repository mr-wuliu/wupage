// Destructive settings control exercised only in fresh, isolated browser profiles.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/settings-reset', target.kind, String(Date.now()));
const checks = [];
let browser;
async function waitFor(source) {
  for (let i = 0; i < 100; i++) { if (await browser.evaluate(source)) return; await delay(50); }
  throw new Error(`Timed out: ${source}`);
}
const click = id => browser.evaluate(`document.getElementById(${JSON.stringify(id)}).click();`);
const settings = () => browser.api('return (await chrome.runtime.sendMessage({type:"GET_SETTINGS"})).data;');
const open = async () => { await click('restore'); await waitFor('return document.getElementById("settingsResetDialog").open;'); };
const closed = () => waitFor('return !document.getElementById("settingsResetDialog").open;');
function luminance(color) {
  const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }

try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const defaults = await settings();
  await browser.api(`const result=await chrome.runtime.sendMessage({type:'GET_SETTINGS'}), value=result.data;
    value.targetLang='ja';value.activeProviderId='deepseek';value.chunkSize=2400;
    value.appearance={...value.appearance,mode:'light',lightSchemeId:'sakura'};
    value.providers.find(p=>p.type==='deepseek').apiKey='reset-fixture-private-key';
    value.providers.push({type:'http-template',id:'custom-reset-fixture',label:'Private service',method:'POST',
      url:'https://example.com',headers:{Authorization:'reset-fixture-header'},bodyTemplate:'{{texts}}',responsePath:'translations'});
    const saved=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings:value});if(!saved.ok)throw new Error(saved.error);
    await chrome.storage.local.set({'reset-test-unrelated':'keep-me'});`);
  const before = await settings();
  const url = await browser.api('return chrome.runtime.getURL("options.html#backupSettings");');
  await browser.navigate(url);
  await waitFor('return document.getElementById("providerTriggerLabel").textContent==="DeepSeek";');
  assert.equal(await browser.evaluate('return document.getElementById("restore").textContent;'), '完全重置设置');
  await browser.evaluate('document.getElementById("chunkSize").value="777";');
  for (const mode of ['button', 'Escape', 'Enter']) {
    await open();
    assert.equal(await browser.evaluate('return document.activeElement.id;'), 'cancelSettingsReset');
    assert.match(await browser.evaluate('return document.getElementById("settingsResetWarning").textContent;'), /所有设置.*全部已保存的密钥/);
    assert.deepEqual(await settings(), before, 'opening a confirmation must not write settings');
    if (mode === 'button') await click('cancelSettingsReset'); else await browser.press(mode);
    await closed();
    assert.deepEqual(await settings(), before, `${mode}: credentials and settings survive cancellation`);
    assert.equal(await browser.evaluate('return document.getElementById("chunkSize").value;'), '777');
  }
  checks.push('explicit all-settings/key warning, safe default focus, cancel button, native Escape and Enter leave credentials and drafts intact');

  for (const [tone, scheme, expectedDanger] of [['light','wupage-light','#b42318'], ['light','sakura','#b4233c'], ['dark','wupage-dark','#ffaaa2'], ['light','monochrome-light','#171717'], ['dark','monochrome-dark','#ffffff']]) {
    await browser.api(`const response=await chrome.runtime.sendMessage({type:'GET_SETTINGS'}),value=response.data;
      value.appearance={...value.appearance,mode:input[0],[input[0]==='dark'?'darkSchemeId':'lightSchemeId']:input[1]};
      const result=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings:value});if(!result.ok)throw new Error(result.error);`, [tone, scheme]);
    const paletteUrl = new URL(url); paletteUrl.searchParams.set('resetPalette', scheme);
    await browser.navigate(paletteUrl.href);
    await waitFor(`return document.documentElement.style.getPropertyValue('--wp-danger')===${JSON.stringify(expectedDanger)}
      && document.documentElement.dataset.wupageTheme===${JSON.stringify(tone)}
      && document.getElementById('providerTriggerLabel')?.textContent==='DeepSeek';`);
    assert.equal(await browser.evaluate('return document.documentElement.style.getPropertyValue("--wp-danger");'), expectedDanger);
    assert.equal(await browser.evaluate('return document.documentElement.dataset.wupageTheme;'), tone);
    await open();
    const colors = await browser.evaluate(`const style=id=>{const s=getComputedStyle(document.getElementById(id));return {background:s.backgroundColor,foreground:s.color};};
      const probe=document.createElement('span');probe.style.color='var(--wp-danger)';document.body.append(probe);
      const danger=getComputedStyle(probe).color;probe.remove();return {entry:style('restore'),confirm:style('confirmSettingsReset'),danger};`);
    for (const [name, color] of Object.entries({ entry: colors.entry, confirm: colors.confirm })) {
      assert.equal(color.background, colors.danger, `${scheme}: ${name} uses the warning color`);
      assert.ok(contrast(color.background, color.foreground) >= 4.5, `${scheme}: ${name} text remains readable`);
    }
    if (scheme === 'sakura' || scheme === 'wupage-dark') await browser.capture(`confirm-${scheme}.png`);
    await click('cancelSettingsReset'); await closed();
  }
  checks.push('entry and confirmation use the theme danger color with at least 4.5:1 text contrast in light, pink, dark and both monochrome schemes');

  await browser.resize(390, 900); await open();
  assert.equal(await browser.evaluate(`const dialog=document.getElementById('settingsResetDialog'),r=dialog.getBoundingClientRect();
    return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&dialog.scrollWidth<=dialog.clientWidth;`), true);
  await browser.capture('confirm-narrow.png');
  await click('cancelSettingsReset'); await closed();
  await browser.resize(1400, 900);
  await browser.evaluate('document.getElementById("chunkSize").value="777";');
  await open(); await click('confirmSettingsReset');
  await closed();
  await waitFor('return document.getElementById("status").textContent==="已完全重置设置。";');
  assert.deepEqual(await settings(), defaults);
  assert.equal(await browser.evaluate('return document.getElementById("chunkSize").value;'), String(defaults.chunkSize));
  assert.equal(await browser.api('return (await chrome.storage.local.get("reset-test-unrelated"))["reset-test-unrelated"];'), 'keep-me');
  await browser.evaluate(`document.querySelector('.settings-nav a[aria-controls="generalSettings"]').click();document.getElementById('save').click();`);
  await waitFor('return document.getElementById("status").textContent==="已保存。";');
  assert.equal((await settings()).providers.find(p=>p.type==='deepseek').apiKey, '');
  assert.equal((await settings()).providers.some(p=>p.id==='custom-reset-fixture'), false);
  await browser.navigate(url); await waitFor('return document.getElementById("providerTriggerLabel").textContent==="Microsoft 翻译";');
  assert.equal((await settings()).targetLang, defaults.targetLang);
  checks.push('narrow dialog fits, explicit confirmation resets all settings and credentials, unrelated storage survives, subsequent save and reload cannot restore old keys');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, checks }, null, 2));
  console.log(JSON.stringify({ ...identity, checks, output }, null, 2));
} finally { await browser?.close(); }
