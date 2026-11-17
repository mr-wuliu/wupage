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
    <style>body{margin:0;font:17px/1.6 Arial;color:#172026}header{position:fixed;inset:0 auto 0 0;width:220px;padding:24px;background:#f2f5f4}nav{display:grid;gap:20px}main{margin-left:280px;max-width:600px;padding:24px}p{margin:20px 0}.sponsored{padding:14px;border:1px solid #aaa}iframe{width:650px;height:220px}[data-testid="sidebarColumn"]{position:absolute;left:970px;top:24px;width:350px}[data-testid="sidebarColumn"]>div,[data-testid="sidebarColumn"]>section{padding:12px;border:1px solid #ddd;margin-bottom:16px}h2{font-size:22px;margin:0}</style>
    <body>${frame ? '<main style="margin:0"><p id="framePublic">Embedded public reading content.</p><p class="sponsored">Embedded excluded recommendation.</p></main>'
      : `<header role="banner"><nav aria-label="Primary"><a href="/home">Home</a><a href="/explore">Explore</a><a href="/notifications">Notifications</a></nav></header>
      <main><article><p id="public">Public article content before <span class="sponsored">Excluded inline label.</span> and after this region.</p>
        <p id="dynamic">Dynamic public article content.</p><div class="sponsored">Excluded recommendation text.</div></article>
        ${url.hostname === 'example.com' ? '<iframe src="https://example.com/articles/frame"></iframe>' : ''}</main>
      <aside data-testid="sidebarColumn">
        <div id="premium"><h2>Subscribe to Premium</h2><p>Enjoy more premium features.</p></div>
        <div id="news"><div data-testid="news_sidebar"></div><h2>Today’s News</h2><a id="news-link" href="/news">Technology news headline.</a><p>Three hours ago.</p></div>
        <section id="trends"><h2>What’s happening</h2><div data-testid="trend"><p>Trending topic.</p><p>Many posts.</p></div>
          <div><a href="/explore/tabs/for-you">Show more</a></div></section>
        <aside id="follow" aria-label="おすすめユーザー"><h2>Who to follow</h2><ul><li data-testid="UserCell"><span>A recommended account.</span>
          <button id="follow-button" data-testid="123-follow">Follow</button></li></ul><a href="/i/connect_people?user_id=123">Show more</a></aside>
        <nav id="footer" aria-label="フッター"><a id="terms-link" href="https://x.com/tos">Terms</a><a href="https://x.com/privacy">Privacy</a>
          <a href="https://help.x.com/rules-and-policies/x-cookies">Cookies</a><span>Accessibility</span><span>Ads info</span><button>More</button><span>© 2026 X Corp.</span></nav>
      </aside>`}</body></html>`;
};
let context;
try {
  const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...target.chromiumOptions, headless: true, viewport: { width: 1400, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
  });
  await context.route(/^https?:\/\/(?:x\.com|example\.com|news\.example\.org)\//, route => route.fulfill({ contentType: 'text/html', body: pageHtml(new URL(route.request().url())) }));
  const session = await context.browser().newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html#elementExclusionSettings`);
  const runtime = async request => {
    const result = await options.evaluate(request => chrome.runtime.sendMessage(request), request);
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  const settings = await runtime({ type: 'GET_SETTINGS' });
  assert.deepEqual(settings.elementExclusions.map(rule => rule.id), ['x-sidebar', 'x-news', 'x-trends', 'x-follow', 'x-footer']);
  const legacy = structuredClone(settings);
  legacy.elementExclusions = legacy.elementExclusions.slice(0, 1);
  delete legacy.elementExclusionDefaultsVersion;
  await options.evaluate(settings => chrome.storage.local.set({ 'wupage.settings': settings }), legacy);
  assert.deepEqual((await runtime({ type: 'GET_SETTINGS' })).elementExclusions, settings.elementExclusions);
  const versionOne = { ...legacy, elementExclusionDefaultsVersion: 1 };
  await options.evaluate(settings => chrome.storage.local.set({ 'wupage.settings': settings }), versionOne);
  assert.deepEqual((await runtime({ type: 'GET_SETTINGS' })).elementExclusions.map(rule => rule.id), ['x-sidebar', 'x-follow', 'x-footer']);
  checks.push('legacy settings receive new presets; version 1 preserves previously deleted news and trends rules');
  settings.providers.push({ id: 'exclusion-test', type: 'http-template', label: 'Local test', method: 'POST', url: `${origin}/translate`,
    headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
  Object.assign(settings, { activeProviderId: 'exclusion-test', sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false,
    translationDisplayMode: 'replace', floatingBallEnabled: false, imageTranslationEnabled: false,
    autoTranslation: { ...settings.autoTranslation, enabled: false }, videoTranslation: { ...settings.videoTranslation, enabled: false },
    selectionTranslation: { ...settings.selectionTranslation, enabled: false } });
  await runtime({ type: 'SAVE_SETTINGS', settings }); await options.reload();
  await options.locator('#elementExclusionSettings:not([hidden])').waitFor();
  assert.equal(await options.locator('.exclusion-rule').count(), 5);
  const navRule = options.locator('[data-rule-id="exclude:x-sidebar"]');
  assert.equal(await navRule.locator('[data-field="pattern"]').inputValue(), 'x.com');
  assert.equal(await options.locator('.exclusion-rule-details').evaluateAll(nodes => nodes.every(node => node.hidden)), true);
  for (const width of [1400, 820, 390]) {
    await options.setViewportSize({ width, height: 1000 });
    assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `options fit at ${width}px`);
    await options.screenshot({ path: path.join(output, `settings-${width}.png`), fullPage: true });
  }
  await options.setViewportSize({ width: 1400, height: 1000 });
  await navRule.locator('.exclusion-rule-toggle').click();
  assert.equal(await navRule.locator('.exclusion-rule-details').isVisible(), true);
  await options.screenshot({ path: path.join(output, 'settings-expanded-1400.png'), fullPage: true });
  await options.setViewportSize({ width: 390, height: 1000 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await options.screenshot({ path: path.join(output, 'settings-expanded-390.png'), fullPage: true });
  await options.setViewportSize({ width: 1400, height: 1000 });
  await navRule.locator('.exclusion-rule-toggle').press('Enter');
  assert.equal(await navRule.locator('.exclusion-rule-details').isHidden(), true);
  checks.push('five collapsed X rules; details expand by click and keyboard; collapsed and expanded settings fit desktop and narrow layouts');

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
  const translated = (frame, selector) => frame.locator(selector).filter({ hasText: '译文：' }).first().waitFor();
  await wait(async () => { try { await action('GET_TRANSLATION_STATE'); return true; } catch { return false; } });
  const originalNav = await page.locator('header[role="banner"]').innerHTML();
  const originalNews = await page.locator('#news').innerHTML(), originalTrends = await page.locator('#trends').innerHTML();
  const originalFollow = await page.locator('#follow').innerHTML(), originalFooter = await page.locator('#footer').innerHTML();
  await action('TRANSLATE_PAGE');
  await translated(page, '#public');
  assert.equal(await page.locator('header[role="banner"]').innerHTML(), originalNav);
  assert.equal(requests.some(request => request.texts.some(text => /Home|Explore|Notifications/.test(text))), false);
  await translated(page, '#premium');
  assert.equal(await page.locator('#news').innerHTML(), originalNews);
  assert.equal(await page.locator('#trends').innerHTML(), originalTrends);
  assert.equal(await page.locator('#follow').innerHTML(), originalFollow);
  assert.equal(await page.locator('#footer').innerHTML(), originalFooter);
  await page.locator('#news-link').evaluate(link => link.addEventListener('click', event => { event.preventDefault(); link.dataset.clicked = 'yes'; }));
  await page.locator('#news-link').click();
  assert.equal(await page.locator('#news-link').getAttribute('data-clicked'), 'yes');
  for (const selector of ['#follow-button', '#terms-link']) {
    await page.locator(selector).evaluate(element => element.addEventListener('click', event => { event.preventDefault(); element.dataset.clicked = 'yes'; }));
    await page.locator(selector).click();
    assert.equal(await page.locator(selector).getAttribute('data-clicked'), 'yes');
  }
  await page.evaluate(() => {
    document.querySelector('#news').insertAdjacentHTML('beforeend', '<p>Late news headline.</p>');
    document.querySelector('#trends').insertAdjacentHTML('beforeend', '<div data-testid="trend"><p>Late trending topic.</p></div>');
    document.querySelector('#follow ul').insertAdjacentHTML('beforeend', '<li data-testid="UserCell"><span>Late recommended account.</span><button data-testid="456-follow">Follow</button></li>');
    document.querySelector('main').insertAdjacentHTML('beforeend', '<p id="late-x-public">Late public post on X.</p>');
  });
  await translated(page, '#late-x-public');
  for (const text of ['Today’s News', 'Technology news headline.', 'Three hours ago.', 'What’s happening', 'Trending topic.', 'Many posts.', 'Late news headline.', 'Late trending topic.',
    'Who to follow', 'A recommended account.', 'Late recommended account.', 'Follow', 'Show more', 'Terms', 'Privacy', 'Cookies', 'Accessibility', 'Ads info', 'More', '© 2026 X Corp.']) {
    assert.equal(JSON.stringify(requests).includes(text), false, text);
  }
  checks.push('news, trends, follow suggestions and footer stay out of requests; show-more links, follow buttons and legal links remain original and clickable; late content is excluded');
  await page.screenshot({ path: path.join(output, 'x-preset.png') });
  const preset = navRule.locator('input[type="checkbox"]');
  await navRule.locator('.setting-toggle').click(); assert.equal(await preset.isChecked(), false); await options.locator('#save').click();
  assert.equal(await navRule.locator('.exclusion-rule-details').isHidden(), true);
  await translated(page, 'header[role="banner"]');
  await navRule.locator('.setting-toggle').click(); assert.equal(await preset.isChecked(), true); await options.locator('#save').click();
  await wait(async () => await page.locator('header[role="banner"]').innerHTML() === originalNav);
  checks.push('X navigation remains original; disabling and enabling the preset updates an active page');

  for (const [id, selector, other] of [['x-news', '#news', '#trends'], ['x-trends', '#trends', '#news'], ['x-follow', '#follow', '#footer'], ['x-footer', '#footer', '#follow']]) {
    const rule = options.locator(`[data-rule-id="exclude:${id}"]`);
    const original = await page.locator(selector).innerHTML(), otherOriginal = await page.locator(other).innerHTML();
    await rule.locator('.setting-toggle').click(); await options.locator('#save').click();
    await translated(page, selector);
    assert.equal(await page.locator(other).innerHTML(), otherOriginal);
    await rule.locator('.setting-toggle').click(); await options.locator('#save').click();
    await wait(async () => await page.locator(selector).innerHTML() === original);
  }
  checks.push('news, trends, follow and footer presets can each be disabled and enabled independently on an active page');

  await options.locator('#addElementInclusion').click();
  const inclusion = options.locator('.exclusion-rule').nth(5);
  await inclusion.locator('[data-field="name"]').fill('媒体下载器设置');
  await inclusion.locator('[data-field="pattern"]').fill('x.com');
  await inclusion.locator('[data-field="selectors"]').fill('[data-dialog="media"]');
  assert.equal(await inclusion.locator('[data-field="action"]').inputValue(), 'include');
  await options.locator('#save').click();
  await wait(async () => (await runtime({ type: 'GET_SETTINGS' })).elementInclusions.length === 1);
  await page.evaluate(() => {
    const dialog = document.createElement('aside');
    dialog.id = 'media-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('translate', 'no');
    dialog.innerHTML = `<div id="media-title">Media Downloader Settings</div>
      <label id="filename-label" for="filename">Filename Format</label>
      <input id="filename" value="{userId}-{postId}">
      <div hidden>Hidden media configuration.</div>
      <div contenteditable>Private editable data.</div>`;
    document.querySelector('main').append(dialog);
    dialog.setAttribute('data-dialog', 'media');
  });
  await translated(page, '#media-title');
  await translated(page, '#filename-label');
  assert.equal(await page.locator('#filename').inputValue(), '{userId}-{postId}');
  assert.equal(await page.locator('header[role="banner"]').innerHTML(), originalNav);
  for (const text of ['Hidden media configuration.', 'Private editable data.', '{userId}-{postId}']) {
    assert.equal(JSON.stringify(requests).includes(text), false, text);
  }
  await page.screenshot({ path: path.join(output, 'force-dialog.png') });
  await page.locator('#media-dialog').evaluate(dialog => dialog.removeAttribute('data-dialog'));
  await wait(async () => await page.locator('#media-title').textContent() === 'Media Downloader Settings');
  await page.locator('#media-dialog').evaluate(dialog => dialog.setAttribute('data-dialog', 'media'));
  await translated(page, '#media-title');
  await inclusion.locator('.exclusion-rule-remove').click();
  await options.locator('#save').click();
  await wait(async () => await page.locator('#media-title').textContent() === 'Media Downloader Settings');
  checks.push('region rule translates a late dialog title and label, leaves fields untouched, and restores source on unmatch or removal');

  await options.locator('#addElementExclusion').click();
  const custom = options.locator('.exclusion-rule').nth(5);
  await custom.locator('[data-field="name"]').fill('推荐区域');
  await custom.locator('[data-field="pattern"]').fill('example.com/articles/*');
  await custom.locator('[data-field="selectors"]').fill('.sponsored\n[data-region="ads"]');
  await options.locator('#save').click();
  await wait(async () => (await runtime({ type: 'GET_SETTINGS' })).elementExclusions.length === 6);
  const start = requests.length;
  await page.goto('https://example.com/articles/one');
  await wait(async () => { try { await action('GET_TRANSLATION_STATE'); return true; } catch { return false; } });
  await new Promise(resolve => setTimeout(resolve, 450));
  await action('TRANSLATE_PAGE');
  await translated(page, '#public');
  await translated(page, 'header[role="banner"]');
  const child = page.frames().find(frame => frame.url().endsWith('/articles/frame')); assert.ok(child);
  await translated(child, '#framePublic');
  assert.equal(await page.locator('.sponsored .wupage-translation').count(), 0);
  assert.equal(await child.locator('.sponsored .wupage-translation').count(), 0);
  assert.equal(await page.locator('#public .sponsored').textContent(), 'Excluded inline label.');
  const sent = JSON.stringify(requests.slice(start));
  for (const text of ['Excluded recommendation text.', 'Excluded inline label.', 'Embedded excluded recommendation.']) assert.equal(sent.includes(text), false, text);
  await translated(page, '#dynamic');
  await page.evaluate(() => document.querySelector('#dynamic').setAttribute('data-region', 'ads'));
  await wait(async () => await page.locator('#dynamic').textContent() === 'Dynamic public article content.');
  await page.evaluate(() => {
    const node = document.createElement('p'); node.className = 'sponsored'; node.textContent = 'Late excluded recommendation.'; document.querySelector('main').append(node);
    const publicNode = document.createElement('p'); publicNode.id = 'late-public'; publicNode.textContent = 'Late public reading content.'; document.querySelector('main').append(publicNode);
  });
  await translated(page, '#late-public');
  assert.equal(JSON.stringify(requests.slice(start)).includes('Late excluded recommendation.'), false);
  await page.screenshot({ path: path.join(output, 'custom-regions.png') });
  checks.push('custom rules apply to matching paths and iframe documents; excluded regions stay out of texts and context; attribute changes and late content are handled');

  await action('CLEAR_TRANSLATION');
  const site = custom.locator('[data-field="pattern"]');
  const scopeCases = [
    { pattern: '', normalized: '*', urls: [['https://x.com/reading', true], ['https://example.com/home', true]] },
    { pattern: 'example.*', urls: [['https://example.com/home', true], ['https://x.com/reading', false]] },
    { pattern: '*://*.example.org/docs/*', urls: [['http://news.example.org/docs/guide', true], ['https://news.example.org/other', false]] },
    { pattern: String.raw`/^https?:\/\/example\.com\/docs\/[0-9]+(?:\?[^#]*)?$/i`, urls: [['https://example.com/docs/123?lang=en', true], ['https://example.com/docs/abc', false]] }
  ];
  for (const scope of scopeCases) {
    await site.fill(scope.pattern);
    await custom.locator('[data-field="selectors"]').fill('.sponsored');
    await options.locator('#save').click();
    try { await wait(async () => (await runtime({ type: 'GET_SETTINGS' })).elementExclusions[5].pattern === (scope.normalized ?? scope.pattern)); }
    catch (error) {
      throw new Error(JSON.stringify({ pattern: scope.pattern, rules: (await runtime({ type: 'GET_SETTINGS' })).elementExclusions,
        status: await options.locator('#status').textContent(), regionStatus: await options.locator('#elementExclusionStatus').textContent() }), { cause: error });
    }
    for (const [address, excluded] of scope.urls) {
      const requestStart = requests.length;
      await page.goto(address);
      await wait(async () => { try { await action('GET_TRANSLATION_STATE'); return true; } catch { return false; } });
      await action('TRANSLATE_PAGE');
      await translated(page, '#public');
      if (excluded) {
        assert.equal(await page.locator('article > .sponsored').textContent(), 'Excluded recommendation text.');
        assert.equal(JSON.stringify(requests.slice(requestStart)).includes('Excluded recommendation text.'), false);
      } else await translated(page, 'article > .sponsored');
      await action('CLEAR_TRANSLATION');
    }
  }
  checks.push('global empty scope, domain/protocol/path wildcards, and URL regexes save and match across websites; unmatched pages translate normally');
  await site.fill('/[/'); await options.locator('#save').click();
  await options.locator('#elementExclusionStatus').filter({ hasText: '正则表达式无效' }).waitFor();
  assert.equal((await runtime({ type: 'GET_SETTINGS' })).elementExclusions[5].pattern, scopeCases.at(-1).pattern);
  await site.fill('example.com/articles/*');
  const selector = custom.locator('[data-field="selectors"]'); await selector.fill('div..invalid');
  await options.locator('#save').click();
  await options.locator('#elementExclusionStatus').filter({ hasText: 'CSS 选择器无效' }).waitFor();
  assert.deepEqual((await runtime({ type: 'GET_SETTINGS' })).elementExclusions[5].selectors, ['.sponsored']);
  await selector.fill('.sponsored');
  while (await options.locator('.exclusion-rule-remove').count()) await options.locator('.exclusion-rule-remove').first().click();
  await options.locator('#save').click(); await wait(async () => (await runtime({ type: 'GET_SETTINGS' })).elementExclusions.length === 0);
  await options.reload(); await options.locator('#elementExclusionSettings:not([hidden])').waitFor();
  assert.equal(await options.locator('.exclusion-rule').count(), 0);
  checks.push('invalid regexes and selectors cannot be saved; deleting presets persists after reload');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...identity, fixture: true, checks, requests: requests.length }, null, 2));
  console.log(JSON.stringify({ ...identity, checks, output }, null, 2));
} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) await page.screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => {});
  throw error;
} finally { await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
