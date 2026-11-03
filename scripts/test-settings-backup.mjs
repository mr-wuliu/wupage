// Real extension storage, downloads and form synchronization in isolated profiles.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/settings-backup', target.kind, String(Date.now()));
const checks = [];
let browser;
async function waitFor(source) {
  for (let i = 0; i < 100; i++) {
    if (await browser.evaluate(source)) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${source}`);
}
const click = id => browser.evaluate(`document.getElementById(${JSON.stringify(id)}).click();`);
const stored = () => browser.api('return (await chrome.storage.local.get("wupage.settings"))["wupage.settings"];');
async function choose(text) {
  await browser.evaluate(`const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(text)}], 'settings.toml', {type:'application/toml'}));
    const input = document.getElementById('settingsBackupFile'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));`);
}
async function preview() { await waitFor('return document.getElementById("settingsBackupDialog").open;'); }

try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const url = await browser.api('return chrome.runtime.getURL("options.html#backupSettings");');
  const seed = await browser.api(`const response = await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    if (!response.ok) throw new Error(response.error);
    const settings = response.data; settings.targetLang = 'ja'; settings.pdfTranslationPageRadius=null;
    const llm = settings.providers.find(p=>p.type==='deepseek'); llm.apiKey='fixture-llm-secret';
    llm.systemPrompt=input[0];
    llm.requestTemplate={enabled:true,headers:'{"X-Signature2":"fixture-header-secret"}',body:'{"token":"fixture-body-secret"}'};
    settings.providers[0].serviceMode='api'; settings.providers[0].api={apiKey:'fixture-service-secret',endpoint:'https://translation.example/CaseSensitive'};
    settings.providers.push({type:'http-template',id:'custom-backup-test',label:'<b>Example</b>',method:'POST',
      url:'https://user:fixture-password@translation.example/Path@proxy?signature=fixture-url-secret',
      headers:{'X-Opaque':'fixture-opaque-secret'},bodyTemplate:'{"api_key":"fixture-template-secret","q":{{json texts}}}',responsePath:'translations'});
    const result=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings}); if(!result.ok)throw new Error(result.error);
    await chrome.storage.local.set({'backup-test-unrelated':'keep-me'}); return settings;`, ['多行提示词 """\n保留中文、引号与 C:\\Users\\test\n{{targetLang}}']);
  await browser.navigate(url);
  await waitFor('return !!document.querySelector("#providerForm [data-field]");');
  await browser.evaluate('document.getElementById("chunkSize").value="777";');
  await click('exportSettings'); await preview();
  assert.equal(await browser.evaluate('return document.activeElement.id;'), 'cancelSettingsBackup');
  assert.match(await browser.evaluate('return document.getElementById("settingsBackupWarning").textContent;'), /不包含密钥/);
  assert.equal(await browser.evaluate('return document.getElementById("settingsBackupIncludeKeys").checked;'), false);
  await click('cancelSettingsBackup');
  assert.equal((await stored()).chunkSize, seed.chunkSize);
  checks.push('credential warning, safe initial focus and export cancellation');

  // A second settings entry point saves after the options page was opened.
  await browser.api(`const result=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});result.data.targetLang='fr';
    const saved=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings:result.data});if(!saved.ok)throw new Error(saved.error);`);
  await click('exportSettings'); await preview();
  const defaultDestination = path.join(output, 'without-keys.toml');
  await browser.download('document.getElementById("confirmSettingsBackup").click();', defaultDestination);
  const defaultText = await fs.readFile(defaultDestination, 'utf8'), keyless = parseToml(defaultText);
  assert.equal(keyless.version, 1); assert.equal(keyless.includesKeys, false);
  assert.equal(keyless.settings.pdfTranslationPageRadius, 'all');
  assert.equal(keyless.settings.targetLang, 'fr'); assert.equal(keyless.settings.chunkSize, seed.chunkSize);
  for (const secret of ['llm','header','body','service','url','opaque','template']) assert.ok(!defaultText.includes(`fixture-${secret}-secret`));
  assert.ok(!defaultText.includes('fixture-password')); assert.ok(!defaultText.includes('keep-me'));
  assert.equal(keyless.settings.providers.find(p=>p.id==='custom-backup-test').url, '');
  assert.deepEqual(Object.entries(keyless.settings.providers.find(p=>p.id==='custom-backup-test').headers), []);
  assert.ok(stringifyToml(await stored()).includes('fixture-llm-secret'), 'export must not modify stored credentials');
  checks.push('default download omits all dedicated and arbitrary credential carriers while preserving saved preferences');

  await click('exportSettings'); await preview();
  assert.equal(await browser.evaluate('return document.getElementById("settingsBackupIncludeKeys").checked;'), false);
  await click('settingsBackupIncludeKeys');
  assert.match(await browser.evaluate('return document.getElementById("settingsBackupWarning").textContent;'), /未加密/);
  const destination = path.join(output, 'with-keys.toml');
  await browser.download('document.getElementById("confirmSettingsBackup").click();', destination);
  const text = await fs.readFile(destination, 'utf8'), backup = parseToml(text);
  assert.equal(backup.kind, 'wupage-settings-backup'); assert.equal(backup.version, 1); assert.equal(backup.includesKeys, true);
  assert.ok(text.includes('systemPrompt = """'));
  assert.equal(backup.settings.providers.find(p=>p.type==='deepseek').systemPrompt, seed.providers.find(p=>p.type==='deepseek').systemPrompt);
  assert.equal(backup.settings.targetLang, 'fr'); assert.equal(backup.settings.chunkSize, seed.chunkSize);
  for (const secret of ['llm','header','body','service','url','opaque','template']) assert.ok(text.includes(`fixture-${secret}-secret`));
  assert.ok(text.includes('fixture-password')); assert.ok(!text.includes('keep-me'));
  checks.push('explicit opt-in download includes every credential carrier, excludes drafts and unrelated storage');

  backup.settings.targetLang = 'de'; backup.settings.activeProviderId = 'custom-backup-test';
  backup.settings.imageTranslationEnabled = true;
  await choose(stringifyToml(backup)); await preview();
  assert.equal((await stored()).targetLang, 'fr');
  await click('cancelSettingsBackup');
  assert.equal(await browser.evaluate('return document.getElementById("chunkSize").value;'), '777');
  await choose(stringifyToml(backup)); await preview();
  await click('confirmSettingsBackup');
  await waitFor('return !document.getElementById("settingsBackupDialog").open && document.getElementById("status").textContent.includes("已导入");');
  const restored = await stored();
  assert.equal(restored.targetLang, 'de'); assert.equal(restored.imageTranslationEnabled, false);
  assert.equal(restored.activeProviderId, 'custom-backup-test');
  assert.equal(restored.pdfTranslationPageRadius, null);
  assert.equal(await browser.evaluate('return document.getElementById("providerTriggerLabel").textContent;'), '<b>Example</b>');
  assert.equal(await browser.evaluate('return !!document.querySelector("#providerTriggerLabel b");'), false);
  assert.equal(await browser.api('return (await chrome.storage.local.get("backup-test-unrelated"))["backup-test-unrelated"];'), 'keep-me');
  await click('save');
  await waitFor('return document.getElementById("status").textContent==="已保存。";');
  assert.deepEqual(await stored(), restored);
  checks.push('import preview, same-file retry, complete restore, unavailable OCR handling, escaped labels and subsequent ordinary save');

  await browser.navigate(url); await waitFor('return !!document.querySelector("#providerForm [data-field]");');
  assert.equal(await browser.evaluate('return document.getElementById("targetLang").value;'), 'de');
  await choose('kind = "another-extension"');
  await waitFor('return document.getElementById("status").textContent.includes("不是 WuPage");');
  assert.deepEqual(await stored(), restored);
  const bad = structuredClone(backup); bad.settings.providers[0].api.apiKey = {};
  await choose(stringifyToml(bad));
  await waitFor('return document.getElementById("status").textContent.includes("字段无效");');
  assert.deepEqual(await stored(), restored);
  await choose('{"kind":"wupage-settings-backup","version":1}');
  await waitFor('return document.getElementById("status").textContent.includes("TOML");');
  assert.deepEqual(await stored(), restored);
  checks.push('reload persistence and malformed files rejected without changing storage');

  // Importing a full backup never carries an unrelated local key to a new URL.
  const changed = structuredClone(backup);
  const incoming = changed.settings.providers.find(p=>p.type==='deepseek');
  incoming.baseURL='https://different.example/proxy@translation.example/v1'; incoming.apiKey=''; incoming.requestTemplate={enabled:false,headers:'{}',body:'{}'};
  await choose(stringifyToml(changed)); await preview(); await click('confirmSettingsBackup');
  await waitFor('return !document.getElementById("settingsBackupDialog").open && document.getElementById("status").textContent.includes("已导入");');
  assert.equal((await stored()).providers.find(p=>p.type==='deepseek').apiKey, '');
  checks.push('full replacement does not merge old credentials into changed endpoints');

  await choose(defaultText); await preview();
  assert.equal(await browser.evaluate('return document.getElementById("settingsBackupKeysField").hidden;'), true);
  assert.match(await browser.evaluate('return document.getElementById("settingsBackupWarning").textContent;'), /不包含密钥.*清空本机旧凭据/);
  await click('confirmSettingsBackup');
  await waitFor('return !document.getElementById("settingsBackupDialog").open && document.getElementById("status").textContent.includes("无密钥备份");');
  for (const secret of ['llm','header','body','service','url','opaque','template']) assert.ok(!stringifyToml(await stored()).includes(`fixture-${secret}-secret`));
  await click('save');
  await waitFor('return document.getElementById("status").textContent==="已保存。";');
  assert.ok(!stringifyToml(await stored()).includes('fixture-'));
  checks.push('keyless import clears local credentials and subsequent ordinary saves cannot restore them');

  for (const width of [1400, 390]) {
    await browser.resize(width, 900);
    assert.equal(await browser.evaluate('return document.documentElement.scrollWidth>innerWidth;'), false);
    await browser.capture(`backup-${width}.png`);
    await click('exportSettings'); await preview();
    assert.equal(await browser.evaluate('return document.getElementById("settingsBackupIncludeKeys").checked;'), false);
    const geometry = await browser.evaluate(`const r=document.getElementById('settingsBackupDialog').getBoundingClientRect();
      const buttons=[...document.querySelectorAll('#settingsBackupDialog button')].map(b=>b.getBoundingClientRect());
      return {inside:r.left>=0&&r.right<=innerWidth,buttons:buttons.every(b=>b.left>=r.left&&b.right<=r.right)};`);
    assert.deepEqual(geometry, { inside: true, buttons: true });
    await browser.capture(`confirm-${width}.png`); await click('cancelSettingsBackup');
  }
  checks.push('desktop and narrow-screen panel/dialog geometry');
  await fs.writeFile(path.join(output, 'report.toml'), stringifyToml({ ...identity, checks }));
  console.log(stringifyToml({ ...identity, checks, output }));
} finally { await browser?.close(); }
