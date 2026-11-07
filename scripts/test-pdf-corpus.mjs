// Optional browser regression: see docs/pdf-regression.md for prerequisites.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cache = path.join(root, ".npm-cache/pdf-corpus");
const args = process.argv.slice(2);
const repeat = Number(args.find((value) => value.startsWith("--repeat="))?.slice(9) || 0);
const minimumFont = Number(args.find((value) => value.startsWith("--minimum-font="))?.slice(15) || 0);
assert(Number.isInteger(repeat) && repeat >= 0 && repeat <= 10, "Invalid repeat count");
assert(Number.isInteger(minimumFont) && minimumFont >= 0 && minimumFont <= 72, "Invalid minimum font size");
const mode = [args.includes("--expanded") && "expanded", args.includes("--damage-markers") && "recovery",
  repeat && `repeat-${repeat}`, args.includes("--auto-open") && "auto", minimumFont && `min-font-${minimumFont}`].filter(Boolean).join("-") || "latest";
const output = path.join(cache, mode);
const ids = args.find((value) => value.startsWith("--ids="))?.slice(6).split(",");
const expansion = args.includes("--expanded") ? 0.65 : 0.4;
const deviceScaleFactor = Number(args.find((value) => value.startsWith("--device-scale="))?.slice(15) || 1);
assert(deviceScaleFactor >= 1 && deviceScaleFactor <= 3, "Invalid device scale");
const admmTranslations = JSON.parse(await fs.readFile(path.join(root, "tests/fixtures/pdf-admm-translations.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(root, "tests/fixtures/pdf-corpus.json"), "utf8"));
const corpus = manifest.filter((entry) => !ids || ids.includes(entry.id));
assert(!ids || ids.every((id) => manifest.some((entry) => entry.id === id)), "Unknown corpus id");
await fs.mkdir(output, { recursive: true });
for (const entry of corpus) {
  entry.file = path.join(cache, `${entry.id}.pdf`);
  if (await fs.stat(entry.file).catch(() => false)) continue;
  assert(args.includes("--download"), `Missing ${entry.file}; pass --download to fetch public samples.`);
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(60_000) });
  assert(response.ok, `${entry.id}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")), `${entry.id}: response is not a PDF`);
  await fs.writeFile(entry.file, bytes);
}

// Deterministic, locally generated edge cases complement the public papers.
const edge = await PDFDocument.create();
const font = await edge.embedFont(StandardFonts.Helvetica);
const landscape = edge.addPage([792, 612]);
landscape.drawText("Landscape table and a long English caption for browser wrapping.", { x: 50, y: 550, size: 13, font });
for (let row = 0; row < 4; row++) {
  landscape.drawText(`Metric ${row + 1}`, { x: 50, y: 480 - row * 25, size: 11, font });
  landscape.drawText(`${row + 1}.25`, { x: 200, y: 480 - row * 25, size: 11, font });
  landscape.drawText("Unit", { x: 280, y: 480 - row * 25, size: 11, font });
}
const rotated = edge.addPage([612, 792]);
rotated.setRotation(degrees(90));
rotated.drawText("Upright text on a rotated PDF page.", { x: 100, y: 100, size: 16, rotate: degrees(90), font });
const cropped = edge.addPage([612, 792]);
cropped.setCropBox(50, 80, 500, 600);
cropped.drawText("A cropped page with a nonzero origin.", { x: 90, y: 600, size: 14, font });
const edgeFile = path.join(cache, "geometry.pdf");
await fs.writeFile(edgeFile, await edge.save());
corpus.push({ id: "geometry", file: edgeFile, pages: 3, inspect: [1, 2, 3] });
const localFile = args.find((value) => value.startsWith("--file="))?.slice(7);
if (localFile) {
  const document = await PDFDocument.load(await fs.readFile(localFile));
  corpus.push({ id: "local", file: path.resolve(localFile), pages: document.getPageCount(), inspect: [3, 5, 8].filter((n) => n <= document.getPageCount()) });
}

const moduleName = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
let calls = 0;
let damaged = 0;
const translate = (source) => source.split(/(⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫)/gu).map((part) => {
  if (/^⟪WUPAGE/u.test(part) || !/\p{L}/u.test(part)) return part;
  if (!args.includes("--expanded") && Object.hasOwn(admmTranslations, part.trim())) {
    return part.replace(part.trim(), admmTranslations[part.trim()]);
  }
  const count = Math.max(1, Math.ceil(part.length * expansion));
  return "这是用于检查复杂排版与公式表格的测试译文".repeat(Math.ceil(count / 20)).slice(0, count);
}).join("");
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET") {
      const entry = corpus.find((entry) => request.url === `/pdf/${entry.id}.pdf`);
      if (!entry) { response.writeHead(404).end(); return; }
      response.setHeader("content-type", "application/pdf");
      response.end(await fs.readFile(entry.file));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(JSON.parse(body).messages.at(-1).content);
    calls++;
    const translations = input.texts.map((text) => {
      let result = translate(text);
      if (args.includes("--damage-markers") && /⟪WUPAGE\d+⟫/u.test(text)) {
        // Persist on single-paragraph retries, forcing prose-only recovery.
        result = result.replace(/⟪WUPAGE\d+⟫/u, "");
        damaged++;
      }
      return result;
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(translations) } }] }));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let context;
const reports = [];
try {
  const profile = path.join(cache, `profile-${mode}-${Date.now()}`);
  if (minimumFont) {
    await fs.mkdir(path.join(profile, "Default"), { recursive: true });
    await fs.writeFile(path.join(profile, "Default/Preferences"), JSON.stringify({
      webkit: { webprefs: { minimum_font_size: minimumFont, minimum_logical_font_size: minimumFont } }
    }));
  }
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : { channel: "chromium" }),
    headless: true, ignoreDefaultArgs: ["--disable-extensions"],
    args: ['--lang=zh-CN', `--load-extension=${path.join(root, "dist")}`],
    viewport: { width: 2000, height: 1400 }, deviceScaleFactor, acceptDownloads: true
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const setup = await context.newPage();
  await setup.goto(`${base}/pdf.html`);
  await setup.waitForSelector("#provider option", { state: "attached" });
  await setup.evaluate(async ({ url, cacheEnabled }) => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    const provider = settings.providers.find((entry) => entry.type === "deepseek");
    provider.baseURL = url;
    provider.apiKey = "local-corpus-test";
    settings.activeProviderId = provider.id;
    settings.cacheEnabled = cacheEnabled;
    settings.pdfTranslationPageRadius = null; // This corpus test deliberately translates every page.
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
  }, { url: `http://127.0.0.1:${server.address().port}/v1`, cacheEnabled: repeat > 0 });
  await setup.close();

  for (const entry of corpus) {
    const page = await context.newPage();
    const errors = [];
    const previewChecks = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sourceUrl = `http://127.0.0.1:${server.address().port}/pdf/${entry.id}.pdf`;
    await page.goto(`${base}/pdf.html${args.includes("--auto-open") ? `?url=${encodeURIComponent(sourceUrl)}&translate=1` : ""}`);
    if (!args.includes("--auto-open")) {
      await page.waitForSelector("#provider option", { state: "attached" });
      await page.locator("#fileInput").setInputFiles(entry.file);
    }
    await page.waitForFunction(() => !document.querySelector("#translateDocument").disabled
      && document.querySelector("#statusToast").textContent.includes("翻译完成"), undefined, { timeout: 180_000 });
    const checkPreview = async (label) => {
      await page.locator('article[data-page="1"]').scrollIntoViewIfNeeded();
      await page.locator('article[data-page="1"] .translation-block-text').first().waitFor();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const check = await page.evaluate(() => ({
        blocks: document.querySelectorAll('.translation-block-text').length,
        invalid: Array.from(document.querySelectorAll('.translation-block-text')).flatMap((text) => {
          const block = text.parentElement;
          const bounds = text.getBoundingClientRect();
          const style = getComputedStyle(text);
          const size = Number.parseFloat(text.style.fontSize);
          const preferred = Number(block.dataset.preferredFontSize);
          const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const offset = node.textContent.search(/\S/u);
            if (offset < 0) continue;
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const glyph = range.getBoundingClientRect();
            const visible = glyph.width > 0 && glyph.height > 0 && glyph.bottom > bounds.top
              && glyph.top < bounds.bottom && glyph.right > bounds.left && glyph.left < bounds.right;
            return !visible || block.dataset.layoutOverflow || style.visibility === 'hidden' || Number(style.opacity) === 0
              || size < preferred * 0.5 ? [{ id: block.dataset.blockId, size, preferred, visible }] : [];
          }
          return [];
        })
      }));
      previewChecks.push({ label, ...check });
      assert(check.blocks > 0, `${entry.id}: preview has no translation blocks before export`);
      assert.deepEqual(check.invalid, [], `${entry.id}: blank/clipped preview before export (${label})`);
    };
    await checkPreview('first translation');
    for (let attempt = 0; attempt < repeat; attempt++) {
      const before = calls;
      if (attempt === 0 && args.includes("--auto-open")) await page.reload();
      else {
        const number = entry.inspect[attempt % entry.inspect.length];
        await page.locator(`article[data-page="${number}"]`).scrollIntoViewIfNeeded();
        await page.locator(`article[data-page="${number}"] .translation-canvas-shell.is-rendered`).waitFor();
        await page.locator('#translateDocument').click();
      }
      const completed = await page.waitForFunction(() => {
        const match = /翻译完成：(\d+) 段译文，缓存命中 (\d+) 段。/u.exec(document.querySelector('#statusToast').textContent);
        return !document.querySelector('#translateDocument').disabled && match ? match.slice(1) : false;
      }, undefined, { timeout: 180_000 });
      assert.equal(calls, before, `${entry.id}: cached translation called the service again`);
      const [translated, cached] = await completed.jsonValue();
      assert.equal(cached, translated, `${entry.id}: repeat did not hit every cached paragraph`);
      if (attempt > 0 || !args.includes("--auto-open")) {
        assert.equal(Number(translated), 0, `${entry.id}: same-document repeat should reuse completed translations`);
      } else {
        assert(Number(translated) > 0, `${entry.id}: reloaded document did not read cached translations`);
      }
      await checkPreview(`cache repeat ${attempt + 1}`);
      await page.waitForTimeout(600);
      await checkPreview(`cache repeat ${attempt + 1} settled`);
    }
    if (entry.id === "attention") {
      // These subplot titles are outside their figure's crop box. Extraction
      // still includes them; translations must not cover the visible chart.
      const textLayer = page.locator('article[data-page="14"] .original-text-layer');
      await page.locator('article[data-page="14"]').scrollIntoViewIfNeeded();
      await page.locator('article[data-page="14"] .translation-canvas-shell.is-rendered').waitFor();
      assert(!(await textLayer.textContent()).includes("Input-Input"), "Clipped figure titles leaked into extracted text");
    }
    const downloadEvent = page.waitForEvent("download", { timeout: 180_000 });
    const downloadFailure = page.waitForFunction(() => document.querySelector("#statusToast").dataset.tone === "error",
      undefined, { timeout: 180_000 }).then(async () => { throw new Error(`${entry.id}: ${await page.locator("#statusToast").textContent()}`); });
    await page.locator("#downloadDocument").click();
    await page.waitForFunction(() => document.querySelector("#pdfFontDialog").open || !document.querySelector("#downloadDocument").textContent.includes("选择导出方式"));
    if (await page.locator("#pdfFontDialog").evaluate(dialog => dialog.open)) await page.locator("#pdfFontBasic").click();
    const debugTimer = args.includes("--debug") ? setInterval(() => {
      void page.evaluate(() => ({ status: document.querySelector("#statusToast").textContent, button: document.querySelector("#downloadDocument").textContent,
        progress: document.querySelector("#progressBar").style.width, errors: Array.from(document.querySelectorAll(".has-error")).map((el) => el.textContent) }))
        .then((status) => console.log(entry.id, status)).catch(() => undefined);
    }, 5000) : undefined;
    let download;
    try { download = await Promise.race([downloadEvent, downloadFailure]); }
    finally { clearInterval(debugTimer); }
    const pdfPath = path.join(output, `${entry.id}-translated.pdf`);
    await download.saveAs(pdfPath);
    const exported = await PDFDocument.load(await fs.readFile(pdfPath));
    const report = await page.evaluate(() => ({
      pages: document.querySelectorAll("article").length,
      failed: Array.from(document.querySelectorAll("article")).filter((row) => row.querySelector(".has-error")).map((row) => row.dataset.page),
      layoutErrors: Array.from(document.querySelectorAll('.translation-block[data-layout-overflow]'), (block) => block.dataset.blockId),
      blocks: document.querySelectorAll(".translation-block").length,
      formulas: document.querySelectorAll(".pdf-inline-formula").length,
      overflow: Array.from(document.querySelectorAll(".translation-block-text")).filter((text) =>
        text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1
      ).map((text) => text.parentElement.dataset.blockId),
      tiny: Array.from(document.querySelectorAll(".translation-block-text")).filter((text) =>
        Number.parseFloat(text.style.fontSize) < 4
      ).map((text) => ({ id: text.parentElement.dataset.blockId, size: text.style.fontSize })),
      fonts: Array.from(document.querySelectorAll(".translation-block-text"), (text) => ({
        id: text.parentElement.dataset.blockId, size: Number.parseFloat(text.style.fontSize),
        preferred: Number(text.parentElement.dataset.preferredFontSize)
      })),
      overshrunk: Array.from(document.querySelectorAll(".translation-block-text")).filter((text) =>
        Number.parseFloat(text.style.fontSize) < Number(text.parentElement.dataset.preferredFontSize) * 0.5
      ).map((text) => text.parentElement.dataset.blockId),
      dimensions: Array.from(document.querySelectorAll(".original-panel .canvas-shell")).map((shell) =>
        shell.style.aspectRatio.split("/").map(Number))
    }));
    report.id = entry.id;
    report.previewChecks = previewChecks;
    report.errors = errors;
    report.exportPages = exported.getPageCount();
    report.preservedRegions = await page.evaluate((regions) => regions.map((region) => {
      const row = document.querySelector(`article[data-page="${region.page}"]`);
      const original = row.querySelector(".original-panel canvas");
      const translated = row.querySelector(".translated-panel > .canvas-shell > canvas");
      const [pdfWidth, pdfHeight] = row.querySelector(".original-panel .canvas-shell").style.aspectRatio.split("/").map(Number);
      const scale = original.width / pdfWidth;
      const x = Math.ceil(region.x * scale);
      const y = Math.ceil((pdfHeight - region.y - region.height) * scale);
      const width = Math.floor(region.width * scale);
      const height = Math.floor(region.height * scale);
      const left = original.getContext("2d").getImageData(x, y, width, height).data;
      const right = translated.getContext("2d").getImageData(x, y, width, height).data;
      let differences = 0;
      let maximumDelta = 0;
      let largeDifferences = 0;
      for (let offset = 0; offset < left.length; offset += 4) {
        const delta = Math.max(Math.abs(left[offset] - right[offset]), Math.abs(left[offset + 1] - right[offset + 1]), Math.abs(left[offset + 2] - right[offset + 2]));
        if (delta > (region.tolerance || 0)) differences++;
        maximumDelta = Math.max(maximumDelta, delta);
        if (delta > 8) largeDifferences++;
      }
      return { ...region, differences, maximumDelta, largeDifferences, pixelsChecked: width * height };
    }), entry.preservedRegions || []);
    reports.push(report);
    for (const number of entry.inspect) {
      const row = page.locator(`article[data-page="${number}"]`);
      await row.scrollIntoViewIfNeeded();
      await row.screenshot({ path: path.join(output, `${entry.id}-page-${number}.png`) });
    }
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ expansion, deviceScaleFactor, calls, damaged, reports }, null, 2));
    console.log(`${entry.id}: ${report.pages} pages, ${report.blocks} blocks, ${report.formulas} inline formulas, ${report.overflow.length} overflows, ${report.overshrunk.length} severely shrunk blocks`);
    assert.equal(report.pages, entry.pages, `${entry.id}: source page count`);
    assert.equal(report.exportPages, entry.pages, `${entry.id}: exported page count`);
    assert.deepEqual(report.failed, [], `${entry.id}: failed pages`);
    assert.deepEqual(report.layoutErrors, [], `${entry.id}: no font size could fit`);
    assert.deepEqual(errors, [], `${entry.id}: uncaught browser errors`);
    assert.deepEqual(report.overflow, [], `${entry.id}: clipped translation blocks`);
    if (!args.includes("--expanded")) assert.deepEqual(report.overshrunk, [], `${entry.id}: font shrunk below half the source size`);
    if (entry.id === "admm" && !args.includes("--expanded")) {
      const fonts = report.fonts.filter((font) => /^page-(2|5)-/u.test(font.id));
      assert(fonts.every((font) => font.size >= font.preferred * 0.75), "ADMM: ordinary text/formulas shrunk far below source size");
      const row = page.locator('article[data-page="5"]');
      assert.equal(await row.locator('.translation-block-text').evaluateAll((texts) =>
        texts.filter((text) => text.textContent.startsWith("• ")).length), 3, "ADMM: bullet items merged");
      const block = row.locator('.translation-block').filter({ has: page.locator('.pdf-inline-formula') }).first();
      await block.scrollIntoViewIfNeeded();
      await block.hover();
      const sizes = () => block.evaluate((element) => ({
        font: Number.parseFloat(element.querySelector('.translation-block-text').style.fontSize),
        formula: Number.parseFloat(element.querySelector('.pdf-inline-formula').style.width)
      }));
      const before = await sizes();
      await block.getByRole('button', { name: '增大字号', exact: true }).click();
      const enlarged = await sizes();
      assert(enlarged.font > before.font && enlarged.formula > before.formula, "ADMM: font toolbar did not rescale formula");
      await block.getByRole('button', { name: '减小字号', exact: true }).click();
      const restored = await sizes();
      assert(Math.abs(restored.font - before.font) < 0.001 && Math.abs(restored.formula - before.formula) < 0.001, "ADMM: font toolbar did not restore size");
      await row.screenshot({ path: path.join(output, 'admm-font-toolbar.png') });
    }
    for (const region of report.preservedRegions) {
      const allowed = Math.floor(region.pixelsChecked * (region.maximumDifferentRatio || 0));
      assert(region.differences <= allowed, `${entry.id}: original region changed on page ${region.page} (${region.differences} pixels, allowed ${allowed})`);
    }
    exported.getPages().forEach((p, i) => {
      const [width, height] = report.dimensions[i];
      assert(Math.abs(p.getWidth() - width) < 0.1 && Math.abs(p.getHeight() - height) < 0.1, `${entry.id}: exported page ${i + 1} changed dimensions`);
    });
    await page.close();
  }
  if (args.includes("--damage-markers")) assert(damaged > 0, "No formula recovery was exercised");
  console.log(`PASS: ${reports.reduce((sum, report) => sum + report.pages, 0)} pages; ${calls} local mock requests; artifacts: ${output}`);
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
}
