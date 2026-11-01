// Real MV3 video pixels, local OCR models and a local text translation service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserTarget, verifyBrowserIdentity } from './lib/browser-target.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = browserTarget();
const output = path.join(root, '.npm-cache/video-frame', target.kind);
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const config = JSON.parse(await fs.readFile(path.join(root, 'build/ocr/runtime.json'), 'utf8'));
const models = await Promise.all(config.models.map(async model => {
  const file = path.join(process.env.OCR_MODEL_FIXTURE_DIR || path.join(root, '.npm-cache/firefox/models'), `${model.name}_onnx_infer.tar`);
  const bytes = await fs.readFile(file);
  assert.equal(bytes.length, model.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), model.sha256);
  return { ...model, data: bytes.toString('base64') };
}));
const requests = [], checks = [], errors = [];
let media;
const server = createServer(async (request, response) => {
  if (request.url === '/media') {
    if (request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk); media = Buffer.concat(chunks); response.end('ok'); return;
    }
    response.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': media.length }).end(media); return;
  }
  if (request.url === '/translate') {
    let body = ''; for await (const chunk of request) body += chunk;
    const { texts } = JSON.parse(body); requests.push(texts);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ translations: texts.map(text =>
      /Settings/i.test(text) ? '设置' : /Display/i.test(text) ? '显示语言' : /Save/i.test(text) ? '保存更改' : '界面译文') })); return;
  }
  const port = server.address().port;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/embedded') {
    response.end(`<!doctype html><meta charset="utf-8"><title>Embedded frame</title><style>body{margin:24px;background:#1c2431;color:white;font:18px Arial}iframe{border:2px solid #5c7182;width:900px;height:620px}</style><h1>Outside the video</h1><iframe src="http://localhost:${port}/cross"></iframe>`); return;
  }
  response.end(`<!doctype html><meta charset="utf-8"><title>Paused video frame</title>
    <style>body{margin:24px;background:#1c2431;color:#eef3f5;font:16px Arial}h1{font-size:22px}#player{position:relative;width:min(800px,100%);background:white}video{display:block;width:100%;aspect-ratio:16/9;object-fit:contain}button{padding:8px;margin-top:16px}</style>
    <h1>Outside the video</h1><div id="player"><video muted playsinline loop></video></div><button id="fullscreen">Player fullscreen</button>
    <script>
      document.querySelector('#fullscreen').onclick=()=>document.querySelector('#player').requestFullscreen();
      (async()=>{
        const video=document.querySelector('video');
        if(location.pathname==='/cross') video.src='http://'+(location.hostname==='localhost'?'127.0.0.1':'localhost')+':${port}/media';
        else {
          const canvas=document.createElement('canvas');canvas.width=800;canvas.height=450;const c=canvas.getContext('2d');
          const draw=()=>{c.fillStyle='#f8fafc';c.fillRect(0,0,800,450);c.fillStyle='#172d38';c.font='bold 44px Arial';c.fillText('Settings',60,100);c.font='32px Arial';c.fillText('Display language',60,195);c.fillStyle='#145d4e';c.fillRect(55,265,320,78);c.fillStyle='white';c.fillText('Save changes',78,314);};draw();
          const stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];
          recorder.ondataavailable=e=>chunks.push(e.data);const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();const timer=setInterval(draw,100);
          await new Promise(resolve=>setTimeout(resolve,1200));recorder.stop();await stopped;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
          const blob=new Blob(chunks,{type:'video/webm'});await fetch('/media',{method:'POST',body:blob});video.src=URL.createObjectURL(blob);
        }
        await new Promise(resolve=>video.addEventListener('loadeddata',resolve,{once:true}));await video.play();video.pause();window.fixtureReady=true;
      })();
    </script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, 'profile-' + Date.now()), {
    ...target.chromiumOptions, headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'], viewport: { width: 1200, height: 900 }
  });
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Extensions.loadUnpacked', { path: path.join(root, process.env.VIDEO_TEST_EXTENSION_DIR || 'dist') }); await session.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // Seed verified, already-downloaded models into this isolated test profile.
  await worker.evaluate(async models => {
    const cache = await caches.open('wupage-ocr-ppocrv5-v1');
    for (const model of models) {
      const url = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/' + model.name + '_onnx_infer.tar';
      const bytes = Uint8Array.from(atob(model.data), c => c.charCodeAt(0));
      await cache.put(url, new Response(bytes, { headers: { 'content-length': String(model.bytes) } }));
    }
    await cache.put('https://wupage.invalid/ocr/receipt', new Response('video-frame-regression'));
  }, models);
  const options = await context.newPage(); await options.goto('chrome-extension://' + new URL(worker.url()).host + '/options.html');
  await options.evaluate(async origin => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    Object.assign(settings, { imageTranslationEnabled: true, activeProviderId: 'http-template', sourceLang: 'en', targetLang: 'zh-CN', cacheEnabled: false });
    Object.assign(settings.providers.find(provider => provider.id === 'http-template'), { enabled: true, url: origin + '/translate', method: 'POST', headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"texts":{{json texts}}}', responsePath: 'translations' });
    const result = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }); if (!result.ok) throw new Error(result.error);
  }, origin);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000);
  const identity = verifyBrowserIdentity(target, await page.evaluate(() => navigator.userAgent));
  const translated = async scope => {
    await scope.locator('[data-wupage-video] canvas').waitFor({ timeout: 120000 });
    assert.match(await scope.locator('[data-wupage-video] canvas').getAttribute('aria-label'), /设置|显示语言|保存更改/);
    assert.equal(await scope.locator('video').evaluate(video => video.paused), true);
  };
  await page.goto(origin); await page.waitForFunction(() => window.fixtureReady);
  await page.locator('video').evaluate(video => video.play());
  await page.locator('video').hover(); await page.locator('.frame').click(); await translated(page);
  checks.push('decoded frame, real local OCR and text-only translation without subtitles');
  const count = requests.length;
  await page.locator('.frame').click(); assert.equal(await page.locator('[data-wupage-video] canvas').isVisible(), false);
  await page.locator('.frame').click(); assert.equal(await page.locator('[data-wupage-video] canvas').isVisible(), true); assert.equal(requests.length, count);
  await page.screenshot({ path: path.join(output, 'translated-frame.png') });
  await page.locator('video').evaluate(video => video.play()); await page.locator('[data-wupage-video] canvas').waitFor({ state: 'detached' });
  await page.locator('video').hover(); await page.locator('.frame').click(); await translated(page);
  await page.locator('video').evaluate(video => { video.currentTime = .5; }); await page.locator('[data-wupage-video] canvas').waitFor({ state: 'detached' });
  checks.push('cached original/translation toggle, playback and seek cleanup');
  await page.locator('#fullscreen').click(); await page.locator('video').hover(); await page.locator('.frame').click(); await translated(page);
  await page.evaluate(() => document.exitFullscreen()); checks.push('player fullscreen overlay');
  for (const pathname of ['/cross', '/embedded']) {
    await page.goto(origin + pathname);
    const scope = pathname === '/embedded' ? page.frames().find(frame => frame.url().includes('localhost')) : page;
    assert.ok(scope); await scope.waitForFunction(() => window.fixtureReady);
    assert.equal(await scope.locator('video').evaluate(video => {
      const canvas = document.createElement('canvas'); const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0); try { canvas.toDataURL(); return false; } catch (error) { return error.name === 'SecurityError'; }
    }), true, 'the cross-origin fixture must require the screenshot fallback');
    await page.bringToFront(); await scope.locator('video').hover(); await scope.locator('.frame').click(); await translated(scope);
    await page.screenshot({ path: path.join(output, pathname.slice(1) + '-translated.png') });
    checks.push(pathname === '/embedded' ? 'cross-origin iframe screenshot coordinates and crop' : 'tainted video canvas falls back to cropped tab screenshot');
  }
  assert.ok(requests.length >= 4); assert.ok(requests.flat().every(text => !/Outside/i.test(text)), 'surrounding page text must not reach OCR translation');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, identity, checks, recognizedTexts: requests, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, requests: requests.length, output }));
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, requests, errors, error: String(error) }, null, 2));
  throw error;
} finally { await context?.close(); await new Promise(resolve => server.close(resolve)); }
