// Isolated real extension, routed site fixtures and a localhost translator.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
if (target.kind === 'firefox') throw new Error('This fixture uses Chromium routing; Firefox behavior is covered by shared unit tests.');
const output = path.join(root, '.npm-cache/element-exclusions', target.kind);
await fs.mkdir(output, { recursive: true });
const requests = [], checks = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const part of request) body += part;
  const data = JSON.parse(body); requests.push(data);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ translations: data.texts.map(text => text.includes('⟪WUPAGESEGMENT')
    ? text.replace(/(⟪WUPAGESEGMENT\d+⟫\s*\n)/gu, '$1译文：') : `译文：${text}`) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pageHtml = url => {
  const frame = url.pathname.endsWith('/frame');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Element exclusion fixture</title>
    <style>body{margin:0;font:17px/1.6 Arial;color:#172026}header{position:fixed;inset:0 auto 0 0;width:220px;padding:24px;background:#f2f5f4}nav{display:grid;gap:20px}main{margin-left:280px;max-width:760px;padding:24px}p{margin:20px 0}.sponsored{padding:14px;border:1px solid #aaa}iframe{width:650px;height:220px}</style>
    <body>${frame ? '<main style="margin:0"><p id="framePublic">Embedded public reading content.</p><p class="sponsored">Embedded excluded recommendation.</p></main>'
      : `<header role="banner"><nav aria-label="Primary"><a href="/home">Home</a><a href="/explore">Explore</a><a href="/notifications">Notifications</a></nav></header>
      <main><article><p id="public">Public article content before <span class="sponsored">Excluded inline label.</span> and after this region.</p>
        <p id="dynamic">Dynamic public article content.</p><div class="sponsored">Excluded recommendation text.</div></article>
        ${url.hostname === 'example.com' ? '<iframe src="https://example.com/articles/frame"></iframe>' : ''}</main>`}</body></html>`;
};
let context;
try {
  const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1400, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']
  });
  await context.route(/^https:\/\/(?:x\.com|example\.com)\//, route => route.fulfill({ contentType: 'text/html', body: pageHtml(new URL(route.request().url())) }));
  const session = await context.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html#elementExclusionSettings`);
  const runtime = async request => {
    const result = await options.evaluate(request => chrome.runtime.sendMessage(request), request);
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  const settings = await runtime({ type: 'GET_SETTINGS' });
  settings.providers.push({ id: 'exclusion-test', type: 'http-template', label: 'Local test', method: 'POST', url: `${origin}/translate`,
    headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
  Object.assign(settings, { activeProviderId: 'exclusion-test', sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false,
    translationDisplayMode: 'replace', floatingBallEnabled: false, imageTranslationEnabled: false,
    autoTranslation: { ...settings.autoTranslation, enabled: false }, videoTranslation: { ...settings.videoTranslation, enabled: false },
    selectionTranslation: { ...settings.selectionTranslation, enabled: false } });
  await runtime({ type: 'SAVE_SETTINGS', settings }); await options.reload();
  await options.locator('#elementExclusionSettings:not([hidden])').waitFor();
  assert.equal(await options.locator('.exclusion-rule').count(), 1);
  assert.equal(await options.locator('.exclusion-rule [data-field="pattern"]').inputValue(), 'x.com');
  assert.equal(await options.locator('.exclusion-rule-details').isHidden(), true);
  for (const width of [1400, 820, 390]) {
    await options.setViewportSize({ width, height: 1000 });
    assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `options fit at ${width}px`);
    await options.screenshot({ path: path.join(output, `settings-${width}.png`), fullPage: true });
  }
  await options.setViewportSize({ width: 1400, height: 1000 });
  await options.locator('.exclusion-rule-toggle').click();
  assert.equal(await options.locator('.exclusion-rule-details').isVisible(), true);
  await options.screenshot({ path: path.join(output, 'settings-expanded-1400.png'), fullPage: true });
  await options.setViewportSize({ width: 390, height: 1000 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await options.screenshot({ path: path.join(output, 'settings-expanded-390.png'), fullPage: true });
  await options.setViewportSize({ width: 1400, height: 1000 });
  await options.locator('.exclusion-rule-toggle').press('Enter');
  assert.equal(await options.locator('.exclusion-rule-details').isHidden(), true);
  checks.push('one collapsed X rule; details expand by click and keyboard; collapsed and expanded settings fit desktop and narrow layouts');

  const page = await context.newPage(); await page.goto('https://x.com/home');
  const identity = verifyBrowserIdentity(target, await page.evaluate(() => navigator.userAgent));
  const action = async type => {
    const result = await options.evaluate(async ({ address, type }) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === address);
      return chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 });
    }, { address: page.url(), type });
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  const wait = async read => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Timed out waiting for fixture state');
  };
  await wait(async () => { try { await action('GET_TRANSLATION_STATE'); return true; } catch { return false; } });
  const originalNav = await page.locator('header[role="banner"]').innerHTML();
  await action('TRANSLATE_PAGE');
  await page.locator('#public .wupage-translation').first().waitFor();
  assert.equal(await page.locator('header[role="banner"]').innerHTML(), originalNav);
  assert.equal(requests.some(request => request.texts.some(text => /Home|Explore|Notifications/.test(text))), false);
  await page.screenshot({ path: path.join(output, 'x-preset.png') });
  const preset = options.locator('.exclusion-rule input[type="checkbox"]');
  await options.locator('.exclusion-rule .setting-toggle').click(); assert.equal(await preset.isChecked(), false); await options.locator('#save').click();
  assert.equal(await options.locator('.exclusion-rule-details').isHidden(), true);
  await page.locator('header[role="banner"] .wupage-translation').first().waitFor();
  await options.locator('.exclusion-rule .setting-toggle').click(); assert.equal(await preset.isChecked(), true); await options.locator('#save').click();
  await wait(async () => await page.locator('header[role="banner"]').innerHTML() === originalNav);
  checks.push('X navigation remains original; disabling and enabling the preset updates an active page');

  await options.locator('#addElementExclusion').click();
  const custom = options.locator('.exclusion-rule').nth(1);
  await custom.locator('[data-field="name"]').fill('推荐区域');
  await custom.locator('[data-field="pattern"]').fill('example.com/articles/*');
  await custom.locator('[data-field="selectors"]').fill('.sponsored\n[data-region="ads"]');
  await options.locator('#save').click();
  await wait(async () => (await runtime({ type: 'GET_SETTINGS' })).elementExclusions.length === 2);
  const start = requests.length;
  await page.goto('https://example.com/articles/one');
  await wait(async () => { try { await action('GET_TRANSLATION_STATE'); return true; } catch { return false; } });
  await new Promise(resolve => setTimeout(resolve, 450));
  await action('TRANSLATE_PAGE');
  await page.locator('#public .wupage-translation').first().waitFor();
  await page.locator('header[role="banner"] .wupage-translation').first().waitFor();
  const child = page.frames().find(frame => frame.url().endsWith('/articles/frame')); assert.ok(child);
  await child.locator('#framePublic .wupage-translation').waitFor();
  assert.equal(await page.locator('.sponsored .wupage-translation').count(), 0);
  assert.equal(await child.locator('.sponsored .wupage-translation').count(), 0);
  assert.equal(await page.locator('#public .sponsored').textContent(), 'Excluded inline label.');
  const sent = JSON.stringify(requests.slice(start));
  for (const text of ['Excluded recommendation text.', 'Excluded inline label.', 'Embedded excluded recommendation.']) assert.equal(sent.includes(text), false, text);
  await page.locator('#dynamic .wupage-translation').waitFor();
  await page.evaluate(() => document.querySelector('#dynamic').setAttribute('data-region', 'ads'));
  await wait(async () => await page.locator('#dynamic').textContent() === 'Dynamic public article content.');
  await page.evaluate(() => {
    const node = document.createElement('p'); node.className = 'sponsored'; node.textContent = 'Late excluded recommendation.'; document.querySelector('main').append(node);
    const publicNode = document.createElement('p'); publicNode.id = 'late-public'; publicNode.textContent = 'Late public reading content.'; document.querySelector('main').append(publicNode);
  });
  await page.locator('#late-public .wupage-translation').waitFor();
  assert.equal(JSON.stringify(requests.slice(start)).includes('Late excluded recommendation.'), false);
  await page.screenshot({ path: path.join(output, 'custom-regions.png') });
  checks.push('custom rules apply to matching paths and iframe documents; excluded regions stay out of texts and context; attribute changes and late content are handled');

  await action('CLEAR_TRANSLATION');
  const selector = custom.locator('[data-field="selectors"]'); await selector.fill('div..invalid');
  await options.locator('#save').click();
  await options.locator('#elementExclusionStatus').filter({ hasText: 'CSS 选择器无效' }).waitFor();
  assert.deepEqual((await runtime({ type: 'GET_SETTINGS' })).elementExclusions[1].selectors, ['.sponsored', '[data-region="ads"]']);
  await selector.fill('.sponsored');
  while (await options.locator('.exclusion-rule-remove').count()) await options.locator('.exclusion-rule-remove').first().click();
  await options.locator('#save').click(); await wait(async () => (await runtime({ type: 'GET_SETTINGS' })).elementExclusions.length === 0);
  await options.reload(); await options.locator('#elementExclusionSettings:not([hidden])').waitFor();
  assert.equal(await options.locator('.exclusion-rule').count(), 0);
  checks.push('invalid selectors cannot be saved; deleting presets persists after reload');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, fixture: true, checks, requests: requests.length }, null, 2));
  console.log(JSON.stringify({ ...identity, checks, output }, null, 2));
} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) await page.screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => {});
  throw error;
} finally { await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
