// Exercise same-document post navigation with real extension/background messages.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openExtensionBrowser } from './lib/extension-browser.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const firefox = process.argv.includes('--firefox');
const target = firefox ? 'firefox' : process.argv.includes('--edge') ? 'edge' : 'chrome';
const output = path.join(root, '.npm-cache', `spa-translation-${target}`);
const requests = [];
let delay = 40;
const post = number => `<article><div data-testid="tweetText" lang="en"><span>Post #${number}: Moving between conversations should keep automatic translation working for every new post and reply.</span></div></article>`;
const server = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const { texts } = JSON.parse(body); requests.push(...texts);
    await new Promise(resolve => setTimeout(resolve, delay));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ translations: texts.map(text => text.replace(/Post #(\d+):[^⟪]*/g, '帖子 $1：切换帖子后也应持续翻译新内容。')) }));
    return;
  }
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Post navigation</title><style>main{width:600px;margin:40px auto}article{padding:24px;border:1px solid #ddd;margin:16px 0}[data-testid=tweetText]{white-space:pre-wrap;line-height:1.5;font:18px Arial}</style></head><body><main>${post(0)}</main><script>const post=${post.toString()};addEventListener('popstate',()=>{const number=location.pathname.split('/')[2];if(location.pathname.startsWith('/post/')&&number)document.querySelector('main').innerHTML=post(Number(number));});</script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, description, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await pause(80); }
  throw new Error(`Timed out: ${description}; state=${JSON.stringify(await state())}`);
}
async function state() {
  return browser.api(`const tab=(await chrome.tabs.query({})).find(tab=>tab.url?.startsWith(input[0]+'/'));
    const saved=await chrome.storage.session.get('wupage.frame-session.'+tab.id);
    return {session:saved['wupage.frame-session.'+tab.id],
    page:await chrome.tabs.sendMessage(tab.id,{type:'GET_TRANSLATION_STATE'})};`, [origin]);
}
async function translated(number) {
  // Replace mode can write into the original span without inserting a wrapper.
  return browser.evaluate(`return [...document.querySelectorAll('[data-testid="tweetText"]')].some(node=>node.textContent.includes('帖子 ${number}：'));`);
}
async function navigate(number, wait = 40) {
  await browser.evaluate(`history.pushState({},'', '/post/${number}');setTimeout(()=>{document.querySelector('main').innerHTML=${JSON.stringify(post(number))}},${wait});`);
}
async function action(type) {
  return browser.api(`const tab=(await chrome.tabs.query({})).find(tab=>tab.url?.startsWith(input[0]+'/'));
    if(!tab)throw new Error('Fixture tab was not found');return chrome.tabs.sendMessage(tab.id,{type:input[1]});`, [origin, type]);
}
try {
  browser = await openExtensionBrowser(root, output, firefox);
  await browser.api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    settings.activeProviderId='http-template';settings.cacheEnabled=true;settings.translationDisplayMode='replace';
    Object.assign(settings.providers.find(provider=>provider.id==='http-template'),{url:input[0]+'/translate',method:'POST',headers:{'Content-Type':'application/json'},bodyTemplate:'{"texts":{{json texts}}}',responsePath:'translations'});
    settings.autoTranslation={enabled:true,nonTargetLanguage:false,presetSites:[],customSites:[{id:'posts',pattern:input[0]+'/post/*',enabled:true}],excludedSites:[]};
    const saved=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});if(!saved.ok)throw new Error(saved.error);`, [origin]);
  await browser.navigate(origin + '/post/0');
  await waitFor(() => translated(0), 'first automatic translation');
  checks.push('initial post');
  for (let number = 1; number <= 12; number++) {
    await navigate(number, number % 2 ? 0 : 70);
    await waitFor(() => translated(number), `automatic translation of post ${number}`);
  }
  checks.push('12 consecutive post transitions');
  await browser.evaluate(`history.back();`);
  await waitFor(() => translated(11), 'back to the previous post');
  await browser.evaluate(`history.forward();`);
  await waitFor(() => translated(12), 'forward to the next post');
  checks.push('browser back and forward');
  await browser.evaluate(`history.pushState({},'', '/outside');`);
  await waitFor(async () => !await translated(12), 'stop outside the selected path without a DOM change');
  const outsideRequests = requests.length;
  await pause(600); assert.equal(requests.length, outsideRequests);
  await browser.evaluate(`history.pushState({},'', '/post/12');`);
  await waitFor(() => translated(12), 'resume in the selected path without a DOM change');
  checks.push('path boundaries with URL-only navigation');
  // Model the screenshot's configuration: language rule enabled, no site added.
  await browser.api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
    settings.autoTranslation.nonTargetLanguage=true;settings.autoTranslation.customSites=[];
    await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});`);
  await waitFor(() => translated(12), 'language-rule session');
  for (let number = 13; number <= 20; number++) {
    await navigate(number, number % 2 ? 0 : 70);
    await waitFor(() => translated(number), `language-rule translation of post ${number}`);
  }
  checks.push('8 post transitions using language detection only');
  delay = 650;
  for (let number = 21; number <= 25; number++) {
    await navigate(number, 0); await pause(160);
  }
  await waitFor(() => translated(25), 'last post after rapid navigation');
  await pause(800);
  assert.equal(await browser.evaluate(`return [...document.querySelectorAll('[data-testid="tweetText"]')].some(node=>/帖子 (21|22|23|24)：/.test(node.textContent));`), false,
    'late responses painted a previous post');
  delay = 40;
  checks.push('rapid navigation with delayed translation replies');
  await browser.evaluate(`document.querySelector('[data-testid="tweetText"] span').textContent='Post #26: This existing text node has been reused for a different post, and its old translation must be discarded.';`);
  await waitFor(() => translated(26), 'reused post text node');
  await browser.evaluate(`document.querySelector('main').insertAdjacentHTML('beforeend',${JSON.stringify(post(27))});`);
  await waitFor(() => translated(27), 'dynamically appended reply');
  checks.push('reused post nodes and dynamically loaded replies');
  await action('CLEAR_TRANSLATION');
  await waitFor(async () => !await translated(26), 'manual restoration');
  const before = requests.length;
  await browser.evaluate(`document.querySelector('main').insertAdjacentHTML('beforeend',${JSON.stringify(post(120))});`);
  await pause(700);
  assert.equal(await translated(120), false, 'manual restoration must remain respected');
  assert.equal(requests.length, before);
  const manual = await action('TRANSLATE_PAGE');
  assert.equal(manual.ok, true);
  assert.ok(manual.data.translated > 0, `manual translation reported zero: ${JSON.stringify(manual)}`);
  await waitFor(() => translated(120), 'manual translation of replies');
  checks.push('manual restoration and manual translation');
  await browser.capture('translated-post.png');
  await action('CLEAR_TRANSLATION');
  await browser.api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});settings.autoTranslation.enabled=false;
    await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});`);
  await browser.evaluate(`document.querySelector('main').replaceChildren();`);
  const empty = await action('TRANSLATE_PAGE');
  assert.equal(empty.ok, true); assert.equal(empty.data.translated, 0);
  await browser.evaluate(`document.querySelector('main').innerHTML=${JSON.stringify(post(28))};`);
  await waitFor(() => translated(28), 'post loaded after an initially empty manual scan');
  checks.push('manual translation survives an empty loading screen');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ target, checks, requests: requests.length }, null, 2));
  process.stdout.write(JSON.stringify({ target, checks, requests: requests.length }) + '\n');
} catch (error) {
  if (browser) await browser.capture('failure.png').catch(() => {});
  throw error;
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
