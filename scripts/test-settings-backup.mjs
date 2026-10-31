// Optional end-to-end check of the settings backup in the built extension.
// The real options page, the real download path and the real storage are used; nothing is
// stubbed, so the run proves the file a user actually receives carries no key by default.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, '.npm-cache/settings-backup');
await fs.mkdir(output, { recursive: true });

const DEEPSEEK_KEY = 'sk-smoke-deepseek-0123456789';
const AZURE_KEY = 'azure-smoke-0123456789';

const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const edge = process.argv.includes('--edge');
const executablePath = edge
  ? (process.env.EDGE_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  : process.env.PDF_TEST_BROWSER;
const context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  viewport: { width: 1000, height: 900 }, acceptDownloads: true
});

/** Writes a settings object holding two keys in the two shapes into extension storage. */
const seed = `const stored=await chrome.storage.local.get('wupage.settings');
  let base=stored['wupage.settings'];
  if(!base){const answer=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});base=answer&&answer.data;}
  const providers=((base&&base.providers)||[]).map(provider=>provider.id==='deepseek'
    ?{...provider,apiKey:${JSON.stringify(DEEPSEEK_KEY)}}
    :provider.id==='microsoft-web-translate'
      ?{...provider,serviceMode:'api',api:{...provider.api,apiKey:${JSON.stringify(AZURE_KEY)}}}
      :provider);
  await chrome.storage.local.set({'wupage.settings':{...base,providers,activeProviderId:'deepseek'}});
  return providers.length;`;

const readStored = `const stored=await chrome.storage.local.get('wupage.settings');
  const settings=stored['wupage.settings']||{};
  const deepseek=(settings.providers||[]).find(provider=>provider.id==='deepseek')||{};
  const microsoft=(settings.providers||[]).find(provider=>provider.id==='microsoft-web-translate')||{};
  return {targetLang:settings.targetLang,chunkSize:settings.chunkSize,
    deepseekKey:deepseek.apiKey||'',azureKey:(microsoft.api||{}).apiKey||'',
    providers:(settings.providers||[]).length};`;

const reports = [];
try {
  const session = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
  await session.detach();

  const control = await context.newPage();
  const controlErrors = [];
  control.on('pageerror', error => controlErrors.push(String(error)));
  await control.goto(`chrome-extension://${extensionId}/options.html`);
  await control.waitForSelector('#backupIncludesKeys');
  const api = source => control.evaluate(`(async()=>{${source}})()`);

  const seeded = await api(seed);
  assert.ok(seeded > 0, 'the extension had no providers to seed');

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.waitForSelector('#backupIncludesKeys');
  await page.waitForFunction(() => document.querySelector('#chunkSize')?.value !== '');

  // The switch must be off on load, so the safe path is what a user gets without reading the hint.
  assert.equal(await page.locator('#backupIncludesKeys').isChecked(), false, 'the key switch must default to off');
  assert.match(await page.locator('#backupHint').textContent(), /默认不写入翻译服务密钥/u);

  const exportTo = async (name) => {
    const pending = page.waitForEvent('download', { timeout: 120000 });
    await page.click('#exportSettings');
    const destination = path.join(output, name);
    await (await pending).saveAs(destination);
    return destination;
  };

  const defaultPath = await exportTo('default.json');
  const defaultText = await fs.readFile(defaultPath, 'utf8');
  const defaultFile = JSON.parse(defaultText);
  assert.equal(defaultFile.includesKeys, false, 'the default export must declare that it carries no keys');
  assert.ok(!defaultText.includes(DEEPSEEK_KEY), 'the default export leaked a provider key');
  assert.ok(!defaultText.includes(AZURE_KEY), 'the default export leaked a service key');
  assert.equal(defaultFile.settings.providers.length, seeded, 'stripping keys dropped providers');
  assert.equal(defaultFile.settings.activeProviderId, 'deepseek', 'stripping keys changed the active provider');
  assert.match(await page.locator('#backupStatus').textContent(), /未包含翻译服务密钥/u);
  reports.push({ case: 'default export', includesKeys: false, providers: defaultFile.settings.providers.length });

  // Opting in must still produce a usable file, otherwise the option would be useless.
  // The input is visually hidden, so click the toggle the way a user does.
  await page.click('.backup-keys-toggle');
  await page.waitForFunction(() => document.querySelector('#backupIncludesKeys').checked);
  const withKeysPath = await exportTo('with-keys.json');
  const withKeysText = await fs.readFile(withKeysPath, 'utf8');
  const withKeys = JSON.parse(withKeysText);
  assert.equal(withKeys.includesKeys, true);
  assert.ok(withKeysText.includes(DEEPSEEK_KEY), 'opting in did not write the provider key');
  assert.ok(withKeysText.includes(AZURE_KEY), 'opting in did not write the service key');
  assert.match(await page.locator('#backupStatus').textContent(), /文件包含翻译服务密钥/u);
  reports.push({ case: 'opt-in export', includesKeys: true, providers: withKeys.settings.providers.length });

  // Importing the key-less file must keep what is stored here instead of blanking it.
  const before = await api(readStored);
  assert.equal(before.deepseekKey, DEEPSEEK_KEY);
  assert.equal(before.azureKey, AZURE_KEY);
  await page.setInputFiles('#importSettingsFile', defaultPath);
  await page.waitForFunction(() => document.querySelector('#status').textContent === '已导入设置。');
  const after = await api(readStored);
  assert.equal(after.deepseekKey, DEEPSEEK_KEY, 'importing a key-less file blanked the stored provider key');
  assert.equal(after.azureKey, AZURE_KEY, 'importing a key-less file blanked the stored service key');
  assert.match(await page.locator('#backupStatus').textContent(), /本机已保存的密钥保持原样/u);
  reports.push({ case: 'import without keys', keptStoredKeys: true, providers: after.providers });

  // A file that carries keys must still replace them.
  await page.setInputFiles('#importSettingsFile', withKeysPath);
  await page.waitForFunction(() => document.querySelector('#status').textContent === '已导入设置。');
  const replaced = await api(readStored);
  assert.equal(replaced.deepseekKey, DEEPSEEK_KEY);
  assert.equal(replaced.azureKey, AZURE_KEY);
  reports.push({ case: 'import with keys', keptStoredKeys: false, providers: replaced.providers });

  assert.deepEqual(errors, [], `the options page threw: ${errors.join('; ')}`);
  assert.deepEqual(controlErrors, []);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  if (edge) assert.match(userAgent, /\bEdg\//u, `expected Microsoft Edge; got ${userAgent}`);
  console.log(JSON.stringify({ ok: true, browser: edge ? 'Edge' : 'Chromium', reports }, null, 2));
} finally {
  await context.close();
}
