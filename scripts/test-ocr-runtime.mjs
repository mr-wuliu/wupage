// Run the real model pipeline with the shipped libraries, optionally comparing
// an unmodified runtime saved before rebuilding (OCR_BASELINE_DIR).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, '.npm-cache/ocr-runtime');
await fs.mkdir(output, { recursive: true });
const config = JSON.parse(await fs.readFile(path.join(root, 'build/ocr/runtime.json'), 'utf8'));
const modelDirectory = process.env.OCR_MODEL_FIXTURE_DIR || path.join(root, '.npm-cache/firefox/models');
await fs.mkdir(modelDirectory, { recursive: true });
const models = [];
for (const model of config.models) {
  const name = `${model.name}_onnx_infer.tar`;
  const file = path.join(modelDirectory, name);
  let bytes;
  try { bytes = await fs.readFile(file); }
  catch {
    const response = await fetch(`https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${name}`);
    assert.ok(response.ok, `Model download failed: ${name} (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(file, bytes);
  }
  assert.equal(bytes.length, model.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), model.sha256);
  models.push(bytes.toString('base64'));
}

const directories = { custom: path.join(root, 'dist') };
if (process.env.OCR_BASELINE_DIR) directories.baseline = path.resolve(process.env.OCR_BASELINE_DIR);
const server = createServer(async (request, response) => {
  try {
    response.setHeader('access-control-allow-origin', '*');
    const [, variant, ...parts] = new URL(request.url, 'http://localhost').pathname.split('/');
    if (!variant) return response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><title>OCR runtime regression</title>');
    const directory = directories[variant];
    if (!directory) return response.writeHead(404).end();
    const relative = parts.join('/');
    const file = path.resolve(directory, relative);
    if (!file.startsWith(directory + path.sep)) return response.writeHead(403).end();
    const bytes = relative === 'ocr-sandbox.html'
      ? await fs.readFile(path.join(root, 'public/ocr-sandbox.html')) : await fs.readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' }[path.extname(file)];
    response.writeHead(200, { 'content-type': type || 'application/octet-stream' }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : {}) });
  const results = {};
  const variants = Object.keys(directories);
  if (process.env.OCR_BASELINE_FIRST === '1') variants.reverse();
  for (const variant of variants) {
    console.log(`Testing ${variant} runtime`);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(`${variant}: ${error.message}`); });
    page.on('console', message => console.log(`${variant}: ${message.text()}`));
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin);
    console.log(`${variant}: loading sandbox`);
    results[variant] = await page.evaluate(async ({ origin, variant, models }) => {
      const frame = document.createElement('iframe');
      frame.sandbox.add('allow-scripts');
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('OCR sandbox load timed out')), 15_000);
        frame.onload = () => { clearTimeout(timer); resolve(); };
      });
      frame.src = `${origin}/${variant}/ocr-sandbox.html`;
      document.body.append(frame);
      await loaded;
      console.log('Sandbox loaded; initializing models');
      let id = 0;
      const call = (action, data) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error(`OCR ${action} timed out`)); }, 120_000);
        const receive = event => {
          if (event.source !== frame.contentWindow || event.data?.target !== 'wupage-ocr-result' || event.data.id !== requestId) return;
          clearTimeout(timer); window.removeEventListener('message', receive);
          event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);
        };
        window.addEventListener('message', receive);
        frame.contentWindow.postMessage({ target: 'wupage-ocr-engine', id: requestId, action, data }, '*');
      });
      const started = performance.now();
      await call('init', { models: models.map(base64 => Uint8Array.from(atob(base64), char => char.charCodeAt(0)).buffer), wasmPath: `${origin}/${variant}/ocr-runtime/` });
      const initializationMs = performance.now() - started;
      console.log(`Models initialized in ${initializationMs.toFixed(0)}ms`);
      const cases = [
        { name: 'english', text: 'Cache performance', detail: 'Hit rate 41.7%', expected: 'Cache' },
        { name: 'chinese', text: '图片文字识别', detail: '本地翻译测试', expected: '文字' },
        { name: 'japanese', text: '日本語の画像翻訳', detail: '文字を読み取ります', expected: '日本語' },
        { name: 'transparent-dark', text: 'Transparent text — 2026', transparent: true },
        { name: 'transparent-light', text: 'White text on transparency', transparent: true, light: true },
        { name: 'rotated', text: 'Perspective recognition', detail: 'Translation test', angle: -7 },
      ];
      const samples = [];
      for (const test of cases) {
        const canvas = document.createElement('canvas');
        canvas.width = 900; canvas.height = test.detail ? 240 : 120;
        const context = canvas.getContext('2d');
        if (!test.transparent) { context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); }
        context.fillStyle = test.light ? 'white' : '#172026';
        context.font = '36px Arial, "Microsoft YaHei", "Yu Gothic", sans-serif';
        context.translate(35, test.angle ? 130 : 65);
        if (test.angle) context.rotate(test.angle * Math.PI / 180);
        context.fillText(test.text, 0, 0);
        if (test.detail) context.fillText(test.detail, 0, 75);
        const data = { dataUrl: canvas.toDataURL() };
        const times = [];
        let lines;
        for (let repeat = 0; repeat < 3; repeat++) {
          const start = performance.now();
          lines = await call('recognize', data);
          times.push(performance.now() - start);
        }
        samples.push({ name: test.name, expected: test.expected, lines, times });
        console.log(`${test.name}: ${lines.map(line => line.text).join(' / ')}`);
      }
      return { initializationMs, samples };
    }, { origin, variant, models });
    assert.deepEqual(errors, [], `${variant}: browser errors`);
    for (const sample of results[variant].samples) {
      assert.ok(sample.lines.length, `${variant}/${sample.name}: no text detected`);
      if (sample.expected) assert.ok(sample.lines.map(line => line.text).join(' ').includes(sample.expected), `${variant}/${sample.name}: ${JSON.stringify(sample.lines)}`);
    }
    await page.close();
  }
  if (results.baseline) {
    for (let index = 0; index < results.baseline.samples.length; index++) {
      const before = results.baseline.samples[index], after = results.custom.samples[index];
      assert.deepEqual(after.lines.map(line => line.text.normalize('NFKC')), before.lines.map(line => line.text.normalize('NFKC')), `${after.name}: recognized text changed`);
      for (let line = 0; line < before.lines.length; line++) {
        for (let point = 0; point < 4; point++) for (let axis = 0; axis < 2; axis++) {
          assert.ok(Math.abs(after.lines[line].poly[point][axis] - before.lines[line].poly[point][axis]) <= 2, `${after.name}: text position changed by more than 2px`);
        }
      }
    }
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, results }, null, 2));
  console.log(JSON.stringify({ passed: true, variants: Object.keys(results), samples: results.custom.samples.length, report: path.join(output, 'report.json') }));
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
