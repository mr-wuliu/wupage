// Isolated browser check with a local provider; no real credentials or remote service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/statistics', target.kind);
let browser, providerCalls = 0;
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(404).end(); return; }
  let text = ''; for await (const chunk of request) text += chunk;
  const body = JSON.parse(text), texts = JSON.parse(body.messages.at(-1).content).texts;
  providerCalls++;
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map(text => `译文 ${text}`)) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  assert.equal(await browser.api(`const r=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});return r.data.statisticsEnabled;`), false);
  assert.equal(await browser.api(`return Object.hasOwn(await chrome.storage.local.get('wupage.statistics.v1'),'wupage.statistics.v1');`), false);
  await browser.api(`const r=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});const settings=r.data;
    settings.providers.push({id:'statistics-test',type:'openai-compatible',label:'统计测试服务',model:'sample-translation-model',apiKey:'',baseURL:input[0],systemPrompt:'Translate into {{targetLang}}.',ollamaCompatibility:false});
    settings.activeProviderId='statistics-test';settings.cacheEnabled=false;settings.statisticsEnabled=true;
    const saved=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});if(!saved.ok)throw Error(saved.error);`, [endpoint]);
  const results = await browser.api(`return Promise.all(Array.from({length:8},(_,i)=>chrome.runtime.sendMessage({type:'TRANSLATE_BATCH',texts:['Sample '+i],targetLang:'zh-CN'})));`);
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  const stats = await browser.api(`return (await chrome.runtime.sendMessage({type:'GET_STATISTICS'})).data;`);
  assert.equal(stats.days[0].requests, 8); assert.equal(stats.days[0].totalTokens, 120); assert.equal(stats.days[0].pages, 1);
  assert.equal(providerCalls, 8);
  await browser.api(`const {data:settings}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});settings.statisticsEnabled=false;
    await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings});await chrome.runtime.sendMessage({type:'TRANSLATE_BATCH',texts:['Disabled statistics'],targetLang:'zh-CN'});`);
  assert.deepEqual(await browser.api(`return (await chrome.runtime.sendMessage({type:'GET_STATISTICS'})).data;`), stats);
  await browser.navigate(await browser.api(`return chrome.runtime.getURL('options.html#statisticsSettings');`));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await browser.evaluate(`return document.querySelector('#statisticsModelRows')?.textContent.includes('sample-translation-model');`)) break;
    await delay(50);
  }
  assert.equal(await browser.evaluate(`return document.querySelector('#statisticsEnabled').checked;`), false);
  assert.ok(await browser.evaluate(`return document.querySelector('#statisticsModelRows').textContent.includes('sample-translation-model');`));
  // Populate preceding days for a representative layout, after checking the real recording path.
  await browser.api(`const {data}=await chrome.runtime.sendMessage({type:'GET_STATISTICS'}),template=data.days[0];
    for(let index=1;index<30;index++){const date=new Date();date.setDate(date.getDate()-index);const key=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
      const requests=4+index%9;data.days.push({...template,date:key,requests,succeeded:requests,pages:1+index%4,totalTokens:requests*(80+index*7),reportedUsage:requests,models:template.models.map(model=>({...model,requests,succeeded:requests,totalTokens:requests*(80+index*7),reportedUsage:requests}))});}
    await chrome.storage.local.set({'wupage.statistics.v1':data});`);
  await browser.evaluate(`document.querySelector('#refreshStatistics').click();`); await delay(150);
  const geometry = [];
  for (const width of [1400, 900, 720, 390]) {
    await browser.resize(width, 1080); await browser.evaluate('window.scrollTo(0,0);'); await delay(70);
    const value = await browser.evaluate(`const panel=document.querySelector('#statisticsSettings'),chart=document.querySelector('#statisticsTrend svg');
      return {viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,panelWidth:panel.getBoundingClientRect().width,chartWidth:chart.getBoundingClientRect().width,icons:document.querySelectorAll('.settings-nav a[aria-controls="statisticsSettings"] svg').length};`);
    assert.equal(value.overflow, false, `${width}: horizontal overflow`); assert.ok(value.chartWidth > 200); assert.equal(value.icons, 1);
    geometry.push({ width, ...value });
    await browser.capture(`statistics-${width}.png`);
  }
  await browser.evaluate(`const range=document.querySelector('#statisticsRange');range.value='7';range.dispatchEvent(new Event('change'));const metric=document.querySelector('#statisticsMetric');metric.value='requests';metric.dispatchEvent(new Event('change'));`);
  assert.equal(await browser.evaluate(`return document.querySelectorAll('#statisticsDailyRows tr').length;`), 7);
  await browser.api(`await chrome.runtime.sendMessage({type:'CLEAR_STATISTICS'});`);
  assert.deepEqual(await browser.api(`return (await chrome.runtime.sendMessage({type:'GET_STATISTICS'})).data.days;`), []);
  assert.equal(await browser.api(`return (await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).data.activeProviderId;`), 'statistics-test');
  const report = { ...identity, providerCalls, checks: ['default off', 'real provider usage', 'concurrent writes', 'document deduplication',
    'collection stops when disabled', 'retained history', 'range and metric switching', 'clear preserves settings', 'responsive layout'], geometry };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
