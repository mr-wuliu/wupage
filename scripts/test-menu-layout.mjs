// Real options and popup documents with isolated browser profiles; no remote service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openExtensionBrowser } from './lib/extension-browser.mjs';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), target = browserTarget();
const output = path.join(root, '.npm-cache/menu-layout', target.kind), checks = [];
await fs.mkdir(output, { recursive: true });
const waitFor = async (read, test, label) => {
  const until = Date.now() + 30000; let value;
  do { value = await read(); if (test(value)) return value; await delay(100); } while (Date.now() < until);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
};
let browser;
try {
  browser = await openExtensionBrowser(root, output, target.kind === 'firefox');
  const identity = verifyBrowserIdentity(target, await browser.evaluate('return navigator.userAgent;'));
  const runtime = async request => {
    const result = await browser.api('return chrome.runtime.sendMessage(input[0]);', [request]);
    assert.equal(result?.ok, true, JSON.stringify(result)); return result.data;
  };
  const initial = await runtime({ type: 'GET_SETTINGS' });
  const functionalState = value => JSON.stringify([value.floatingBallEnabled, value.contextMenuTranslationEnabled,
    value.selectionTranslation, value.imageTranslationEnabled, value.videoTranslation]);
  const popupUrl = await browser.api('return chrome.runtime.getURL("popup.html");');
  const optionsUrl = await browser.api('return chrome.runtime.getURL("options.html#appearanceSettings");');
  await browser.api('location.hash="appearanceSettings";');
  await waitFor(() => browser.api('return document.querySelectorAll("[data-menu-add]").length;'), count => count === 13, 'menu editor');
  await browser.api('document.querySelector("#appearanceMenuTab").click();');
  await browser.navigate(popupUrl); await browser.resize(330, 950);
  const inspect = () => browser.evaluate(`return {loading:document.querySelector('.popup')?.hasAttribute('data-menu-loading'),width:innerWidth,
    overflow:document.documentElement.scrollWidth>innerWidth,gridHidden:document.querySelector('[data-popup-menu-grid]').hidden,
    items:[...document.querySelectorAll('[data-popup-menu-item]')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.dataset.popupMenuItem),
    settingsVisible:document.querySelector('#openOptions').getBoundingClientRect().width>0,hintVisible:!document.querySelector('#paragraphModeHint').hidden};`);
  const defaultLayout = await waitFor(inspect, value => value.loading === false && value.items.length === 13, 'default popup');
  await browser.evaluate(`const w=window.wrappedJSObject||window;w.menuNodes=[...document.querySelectorAll('[data-popup-menu-item]')];`);
  await browser.capture('default-popup.png');
  const custom = ['clearCache', 'floatingBall', 'contextMenuTranslation', 'selectionTranslation', 'pageToggle', 'paragraphMode', 'openPdfWorkspace'];
  await browser.api(`for(const id of ['imageTranslation','videoTranslation','debug','openGithub','openWebsite','openSupport']){
    document.querySelector('#popupMenuPreview [data-popup-menu-item="'+id+'"]').click();}
    for(const id of ['floatingBall','clearCache'])document.querySelector('#popupMenuPreview [data-popup-menu-item="'+id+'"]')
      .dispatchEvent(new KeyboardEvent('keydown',{key:'Home',altKey:true,bubbles:true,cancelable:true}));`);
  const save = async () => {
    await browser.api('document.querySelector("#save").click();');
    await waitFor(() => browser.api(`const {data}=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
      const hidden=[...document.querySelectorAll('[data-menu-add]')].filter(e=>!e.hidden).map(e=>e.dataset.menuAdd).sort();
      const order=[...document.querySelectorAll('#popupMenuPreview [data-popup-menu-item]')].map(e=>e.dataset.popupMenuItem);
      return JSON.stringify(data.appearance.popupMenu.hidden.slice().sort())===JSON.stringify(hidden)&&JSON.stringify(data.appearance.popupMenu.order)===JSON.stringify(order);`), Boolean, 'stored draft');
  };
  const preview = await browser.api(`return [...document.querySelectorAll('#popupMenuPreview [data-popup-menu-item]')].filter(e=>!e.hasAttribute('data-popup-menu-hidden')).map(e=>e.dataset.popupMenuItem);`);
  assert.deepEqual(preview, custom);
  assert.deepEqual((await inspect()).items, defaultLayout.items, 'unsaved preview does not change the real popup');
  await save();
  await waitFor(inspect, value => JSON.stringify(value.items) === JSON.stringify(custom), 'live popup layout');
  assert.equal(await browser.evaluate(`const w=window.wrappedJSObject||window;return w.menuNodes.every(e=>e.isConnected&&document.querySelector('[data-popup-menu-item="'+e.dataset.popupMenuItem+'"]')===e);`), true);
  assert.equal(functionalState(await runtime({ type: 'GET_SETTINGS' })), functionalState(initial));
  checks.push('click to remove into the library, keyboard sorting across categories, unsaved preview, live saving and original controls retained');

  await browser.evaluate('document.querySelector("#floatingBall").click();');
  await waitFor(() => runtime({ type: 'GET_SETTINGS' }), value => value.floatingBallEnabled === false, 'reordered control works');
  await browser.evaluate('document.querySelector("#floatingBall").click();');
  const afterPopupSave = await waitFor(() => runtime({ type: 'GET_SETTINGS' }), value => value.floatingBallEnabled === true, 'control restored');
  assert.ok(afterPopupSave.appearance.popupMenu.hidden.includes('videoTranslation'));
  await browser.navigate(popupUrl);
  await waitFor(inspect, value => !value.loading && JSON.stringify(value.items) === JSON.stringify(custom), 'reopened popup');
  for (const width of [264, 330, 420]) {
    await browser.resize(width, 950); assert.equal((await inspect()).overflow, false); await browser.capture(`custom-popup-${width}.png`);
  }
  await browser.api(`document.querySelector('[data-menu-add="debug"]').click();`);
  const appended = await browser.api(`return [...document.querySelectorAll('#popupMenuPreview [data-popup-menu-grid] [data-popup-menu-item]')].filter(e=>!e.hasAttribute('data-popup-menu-hidden')).at(-1).dataset.popupMenuItem;`);
  assert.equal(appended, 'debug');
  await browser.api(`for(const e of document.querySelectorAll('#popupMenuPreview [data-popup-menu-item]'))if(!e.hasAttribute('data-popup-menu-hidden'))e.click();`);
  await save();
  const empty = await waitFor(inspect, value => !value.items.length, 'empty grid collapses');
  assert.equal(empty.gridHidden, true); assert.equal(empty.settingsVisible, true); assert.equal(empty.hintVisible, false);
  await browser.capture('minimal-popup.png');
  await browser.api('document.querySelector("#resetPopupMenu").click();'); await save();
  await waitFor(inspect, value => JSON.stringify(value.items) === JSON.stringify(defaultLayout.items), 'defaults restored');
  assert.equal(functionalState(await runtime({ type: 'GET_SETTINGS' })), functionalState(initial));
  checks.push('click to re-add at the end; reordered controls still work; saved layout survives reopening; empty grid collapses and defaults preserve features');

  await browser.navigate(optionsUrl); await browser.resize(1400, 1100);
  await waitFor(() => browser.evaluate('return document.querySelectorAll("[data-menu-add]").length;'), count => count === 13, 'options preview');
  await browser.evaluate('document.querySelector("#appearanceMenuTab").click();');
  const editorOrder = () => browser.evaluate(`return [...document.querySelectorAll('#popupMenuPreview [data-popup-menu-item]')].filter(e=>!e.hasAttribute('data-popup-menu-hidden')).map(e=>e.dataset.popupMenuItem);`);
  const point = id => browser.evaluate(`const e=document.querySelector('#popupMenuPreview [data-popup-menu-item="${id}"]');const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};`);
  const start = await point('contextMenuTranslation'), end = await point('floatingBall');
  await browser.pointer([{type:'move',...start},{type:'down'},{type:'move',...end}]);
  assert.equal(await browser.evaluate('return !!document.querySelector("[data-menu-dragging]")&&!!document.querySelector(".menu-drag-ghost");'), true, 'magnetic placeholder and floating card');
  await browser.capture('editor-dragging.png');
  await browser.pointer([{type:'up'}]); await delay(220);
  assert.deepEqual((await editorOrder()).slice(0,2), ['floatingBall','contextMenuTranslation']);
  assert.equal((await editorOrder()).length, 13, 'drop must not become a remove click');
  assert.equal(await browser.evaluate('return !!document.querySelector(".menu-drag-ghost");'), false);

  // Links remain in an independent footer and cannot be reordered by pointer or keyboard.
  const beforeLinks = await editorOrder();
  await browser.evaluate(`document.querySelector('#popupMenuPreview [data-popup-menu-item="openWebsite"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',altKey:true,bubbles:true,cancelable:true}));`);
  const linkFrom = await point('openWebsite'), linkTo = await point('floatingBall');
  await browser.pointer([{type:'move',...linkFrom},{type:'down'},{type:'move',...linkTo},{type:'up'}]);
  assert.deepEqual(await editorOrder(), beforeLinks);
  assert.equal(await browser.evaluate(`return !!document.querySelector('#popupMenuPreview [data-popup-menu-footer] [data-popup-menu-item="openGithub"]')&&!document.querySelector('#popupMenuPreview [data-popup-menu-grid] [data-popup-menu-item="openWebsite"]');`),true);
  checks.push('GitHub, website and support stay in their fixed footer and do not participate in pointer or keyboard sorting');

  // Pair a short button with PDF, pull it into a separate row, and cancel the entire gesture.
  const geometry = id => browser.evaluate(`const e=document.querySelector('#popupMenuPreview [data-popup-menu-item="${id}"]'),g=document.querySelector('#popupMenuPreview [data-popup-menu-grid]'),r=e.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height,grid:g.clientWidth};`);
  const pairFrom = await point('clearCache'), pdfBefore = await geometry('openPdfWorkspace');
  await browser.pointer([{type:'move',...pairFrom},{type:'down'},{type:'move',x:pdfBefore.x+pdfBefore.width*.75,y:pdfBefore.y+pdfBefore.height/2}]);
  await delay(220);
  const pairedPdf = await geometry('openPdfWorkspace'), pairedCache = await geometry('clearCache');
  assert.ok(pairedPdf.width < pairedPdf.grid*.6 && pairedCache.width < pairedCache.grid*.6,'long PDF row splits into two short buttons');
  assert.ok(Math.abs(pairedPdf.y-pairedCache.y)<1);
  await browser.capture('editor-paired-row.png');
  await browser.pointer([{type:'move',x:pairedPdf.x+pairedPdf.width/2,y:pairedPdf.y-5}]); await delay(220);
  const detachedPdf = await geometry('openPdfWorkspace');
  assert.ok(detachedPdf.width > detachedPdf.grid*.95,'pulling the partner away restores the long row');
  await browser.capture('editor-detached-row.png');
  await browser.press('Escape'); await browser.pointer([{type:'up'}]);
  assert.deepEqual(await editorOrder(),beforeLinks);
  // Saving must persist row geometry, not just the flattened button order.
  const saveFrom=await point('clearCache'),savePdf=await geometry('openPdfWorkspace');
  await browser.pointer([{type:'move',...saveFrom},{type:'down'},{type:'move',x:savePdf.x+savePdf.width*.75,y:savePdf.y+savePdf.height/2},{type:'up'}]);
  await browser.evaluate('document.querySelector("#save").click();');
  await waitFor(()=>runtime({type:'GET_SETTINGS'}),value=>value.appearance.popupMenu.rows.some(row=>row.includes('openPdfWorkspace')&&row.includes('clearCache')),'paired row saved');
  await browser.navigate(popupUrl); await waitFor(inspect,value=>!value.loading,'paired popup');
  const savedPair=await browser.evaluate(`const a=document.querySelector('#openPdfWorkspace').getBoundingClientRect(),b=document.querySelector('#clearCache').getBoundingClientRect();return {same:Math.abs(a.y-b.y)<1,equal:Math.abs(a.width-b.width)<1,wide:a.width>document.querySelector('[data-popup-menu-grid]').clientWidth*.9};`);
  assert.deepEqual(savedPair,{same:true,equal:true,wide:false});
  checks.push('long rows magnetically split and rejoin within one drag; cancellation restores rows; saved and reopened popup preserves paired geometry');
  await browser.navigate(optionsUrl);await browser.resize(1400,1100);
  await waitFor(()=>browser.evaluate('return document.querySelectorAll("[data-menu-add]").length;'),count=>count===13,'paired editor');
  await browser.evaluate('document.querySelector("#appearanceMenuTab").click();');

  // Cross-category pointer sorting, cancellation, and persistence in the real popup.
  const from = await point('debug'), to = await point('floatingBall');
  await browser.pointer([{type:'move',...from},{type:'down'},{type:'move',...to},{type:'up'}]); await delay(220);
  const dragged = await editorOrder(); assert.equal(dragged[0], 'debug');
  const cancelFrom = await point('debug'), cancelTo = await point('contextMenuTranslation');
  await browser.pointer([{type:'move',...cancelFrom},{type:'down'},{type:'move',...cancelTo}]);
  await browser.press('Escape'); await browser.pointer([{type:'up'}]);
  assert.deepEqual(await editorOrder(), dragged, 'Escape restores the complete original order');
  const outsideFrom = await point('debug');
  await browser.pointer([{type:'move',...outsideFrom},{type:'down'},{type:'move',x:1300,y:100},{type:'up'}]);
  assert.deepEqual(await editorOrder(), dragged, 'dropping outside the preview cancels');
  await browser.evaluate('document.querySelector("#save").click();');
  await waitFor(() => runtime({type:'GET_SETTINGS'}), value => value.appearance.popupMenu.order[0] === 'debug', 'pointer order saved');
  await browser.navigate(popupUrl);
  assert.deepEqual((await waitFor(inspect, value => !value.loading, 'saved popup')).items, dragged);
  checks.push('real pointer dragging snaps into grid slots, crosses categories, suppresses removal after drop, supports Escape and outside cancellation, and saves exact preview order');

  await browser.navigate(optionsUrl); await browser.resize(1400, 1100);
  await waitFor(() => browser.evaluate('return document.querySelectorAll("[data-menu-add]").length;'), count => count === 13, 'options editor');
  await browser.evaluate('document.querySelector("#appearanceMenuTab").click();');
  const clickFrom = await point('imageTranslation');
  await browser.pointer([{type:'move',...clickFrom},{type:'down'},{type:'up'}]);
  assert.equal(await browser.evaluate('return document.querySelector("[data-menu-add=imageTranslation]").hidden;'), false, 'real click removes into the library');
  const clickAdd = await browser.evaluate('const r=document.querySelector("[data-menu-add=imageTranslation]").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};');
  await browser.pointer([{type:'move',...clickAdd},{type:'down'},{type:'up'}]);
  assert.equal((await editorOrder()).filter(id=>!['openGithub','openWebsite','openSupport'].includes(id)).at(-1), 'imageTranslation', 'real click adds at the end');
  assert.equal((await editorOrder()).length, 13);
  await browser.evaluate(`document.querySelector('#appearanceMenuTab').click();document.querySelector('#resetPopupMenu').click();
    for(const id of ['imageTranslation','videoTranslation','debug','openGithub','openWebsite','openSupport'])document.querySelector('#popupMenuPreview [data-popup-menu-item="'+id+'"]').click();`);
  await browser.capture('editor-desktop.png');
  const position = await browser.evaluate(`return {preview:document.querySelector('#popupMenuPreview').getBoundingClientRect().left,library:document.querySelector('.menu-layout-library').getBoundingClientRect().left};`);
  assert.ok(position.preview < position.library, 'preview is on the left, available buttons on the right');
  for (const width of [720, 390]) {
    await browser.resize(width, 1100);
    assert.equal(await browser.evaluate('return document.documentElement.scrollWidth<=innerWidth;'), true);
    await browser.capture(`editor-${width}.png`);
  }
  checks.push('left preview and right button library; desktop and narrow layouts fit without horizontal overflow');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({...identity,checks,defaultLayout,custom},null,2));
  console.log(JSON.stringify({...identity,checks,output},null,2));
} catch(error) { await browser?.capture('failure.png').catch(()=>{}); throw error; }
finally { await browser?.close(); }
