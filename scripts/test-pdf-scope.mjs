// Optional extension browser regression; build dist/ first. No external translation API is used.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.join(root, ".npm-cache/pdf-scope");
await fs.mkdir(output, { recursive: true });
const fixture = await PDFDocument.create();
const font = await fixture.embedFont(StandardFonts.Helvetica);
for (let number = 1; number <= 40; number++) {
  fixture.addPage([595, 842]).drawText(`Scope page ${number}.`, { x: 60, y: 740, size: 12, font });
}
const file = path.join(output, "scope.pdf");
await fs.writeFile(file, await fixture.save());
const moduleName = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const calls = [];
const gates = [];
let holdFirstTwo = false;
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/scope.pdf") {
      response.setHeader("content-type", "application/pdf");
      response.end(await fs.readFile(file));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const texts = JSON.parse(JSON.parse(body).messages.at(-1).content).texts;
    calls.push(...texts.map(text => Number(/Scope page\s*(\d+)/u.exec(text)[1])));
    if (holdFirstTwo && gates.length < 2) await new Promise(resolve => gates.push(resolve));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify(texts.map(text => `第 ${/Scope page\s*(\d+)/u.exec(text)[1]} 页译文`))
    } }] }));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : { channel: "chromium" }),
    headless: true, ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging"],
    viewport: { width: 1600, height: 1000 }, acceptDownloads: true
  });
  const browserSession = await context.browser().newBrowserCDPSession();
  await browserSession.send("Extensions.loadUnpacked", { path: path.join(root, "dist") });
  await browserSession.detach();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const reader = await context.newPage();
  const errors = [];
  reader.on("pageerror", error => errors.push(error.message));
  // Explicit opt-out isolates the manual scheduling and direct-download checks below.
  await reader.goto(`${base}/pdf.html?translate=0`);
  await reader.waitForSelector("#provider option", { state: "attached" });
  await reader.evaluate(async (port) => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (settings.pdfTranslationPageRadius !== 5) throw new Error("Default scope must be five pages");
    const provider = settings.providers.find(entry => entry.type === "deepseek");
    provider.baseURL = `http://127.0.0.1:${port}/v1`; provider.apiKey = "test-only";
    settings.activeProviderId = provider.id; settings.cacheEnabled = false;
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
  }, server.address().port);
  const openFixture = async () => {
    await reader.reload();
    await reader.waitForSelector("#provider option", { state: "attached" });
    await reader.locator("#fileInput").setInputFiles(file);
    await reader.waitForFunction(() => !document.querySelector("#translateDocument").disabled);
  };
  const scrollTo = async (number) => reader.evaluate(number => {
    const page = document.querySelector(`article[data-page="${number}"]`);
    window.scrollTo({ top: page.getBoundingClientRect().top + window.scrollY - 110, behavior: "instant" });
  }, number);
  const clickTranslate = async () => reader.evaluate(() => document.querySelector("#translateDocument").click());
  const waitIdle = async (expected) => {
    await assertEventually(() => assert.equal(calls.length, expected));
    await reader.waitForFunction(() => !document.querySelector("#translateDocument").disabled
      && document.querySelector("#statusToast").textContent.includes("翻译完成"));
  };
  await openFixture();
  await scrollTo(20);
  await reader.waitForTimeout(300);
  assert.equal(calls.length, 0, "Scrolling before activation must not translate");
  await clickTranslate();
  await waitIdle(11);
  assert.equal(calls[0], 20);
  assert.deepEqual([...calls].sort((a, b) => a - b), Array.from({ length: 11 }, (_, i) => i + 15));
  await reader.waitForTimeout(400);
  assert.equal(calls.length, 11, "An idle viewport must not expand the paid range");

  const edited = reader.locator('article[data-page="20"] .translation-block-text').first();
  await edited.fill("手动校对的译文");
  await scrollTo(25);
  await waitIdle(16);
  assert.equal(calls[11], 26, "The current page is already translated, so its nearest missing page goes first");
  await scrollTo(20);
  await reader.waitForTimeout(400);
  assert.equal(calls.length, 16);
  assert.equal(await edited.textContent(), "手动校对的译文");
  await reader.screenshot({ path: path.join(output, "reading-translated.png") });

  // Jump through one viewport to another in the same frame. Only the settled range is submitted.
  await reader.evaluate(() => {
    for (const number of [5, 35]) {
      const page = document.querySelector(`article[data-page="${number}"]`);
      window.scrollTo({ top: page.getBoundingClientRect().top + window.scrollY - 110, behavior: "instant" });
    }
  });
  await waitIdle(26);
  assert.equal(calls[16], 35);
  assert.equal(new Set(calls).size, 26);
  assert(calls.every(number => number >= 15));

  const options = await context.newPage();
  options.on("pageerror", error => errors.push(error.message));
  await options.goto(`${base}/options.html#pdfSettings`);
  await options.waitForFunction(() => document.querySelector("#pdfTranslationPageRadius").value === "5");
  await options.locator("#pdfTranslationPageRadius").fill("0");
  await options.locator("#save").click();
  await options.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_SETTINGS" })).data.pdfTranslationPageRadius === 0);
  await clickTranslate();
  await waitIdle(26);
  await scrollTo(5);
  await waitIdle(27);
  assert.equal(calls.at(-1), 5);
  await scrollTo(6);
  await waitIdle(28);
  assert.equal(calls.at(-1), 6);
  assert(!calls.includes(4) && !calls.includes(7));

  // Download completes the entire document even when reading is limited to one page.
  const exportDocument = async (name) => {
    await reader.bringToFront();
    const downloadEvent = reader.waitForEvent("download", { timeout: 90_000 });
    await reader.evaluate(() => document.querySelector("#downloadDocument").click());
    await reader.waitForFunction(() => document.querySelector("#pdfFontDialog").open || !document.querySelector("#downloadDocument").textContent.includes("选择导出方式"));
    if (await reader.locator("#pdfFontDialog").evaluate(dialog => dialog.open)) await reader.locator("#pdfFontBasic").click();
    const downloaded = await downloadEvent;
    const pdf = path.join(output, name);
    await downloaded.saveAs(pdf);
    assert.equal((await PDFDocument.load(await fs.readFile(pdf))).getPageCount(), 40);
    await reader.waitForFunction(() => !document.querySelector("#downloadDocument").disabled);
  };
  await exportDocument("full-translated.pdf");
  assert.equal(calls.length, 40, "Export must translate every remaining page");
  assert.equal(new Set(calls).size, 40, "Export must reuse completed translations");
  assert.equal(await edited.textContent(), "手动校对的译文");
  assert.equal(await reader.locator(".translation-block-text").count(), 40);
  assert.equal(await reader.evaluate(async () => (await chrome.runtime.sendMessage({ type: "GET_SETTINGS" })).data.pdfTranslationPageRadius), 0);
  await exportDocument("full-translated-repeat.pdf");
  assert.equal(calls.length, 40, "Repeated downloads must preserve translations and edits");

  await options.locator("#pdfTranslationScope").selectOption("unlimited");
  assert.equal(await options.locator("#pdfTranslationPageRadiusField").isVisible(), false);
  await options.locator("#save").click();
  await options.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_SETTINGS" })).data.pdfTranslationPageRadius === null);
  await clickTranslate();
  await waitIdle(40);
  assert.equal(new Set(calls).size, 40);
  assert((await reader.locator("#translateDocument").textContent()).includes("翻译全文"));

  // A settled jump must preempt obsolete slow requests and start the new page.
  await options.locator("#pdfTranslationScope").selectOption("nearby");
  await options.locator("#pdfTranslationPageRadius").fill("5");
  await options.locator("#save").click();
  await options.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_SETTINGS" })).data.pdfTranslationPageRadius === 5);
  calls.length = 0;
  holdFirstTwo = true;
  await reader.bringToFront();
  await openFixture();
  await scrollTo(10);
  await clickTranslate();
  await assertEventually(() => assert.equal(gates.length, 2));
  assert.deepEqual(calls, [10, 11]);
  await scrollTo(30);
  await reader.waitForTimeout(300);
  assert(/第 25–35 页|翻译完成/u.test(await reader.locator("#statusToast").textContent()));
  await assertEventually(() => assert.equal(calls[2], 30));
  await waitIdle(13);
  gates.forEach(release => release());
  assert.deepEqual(calls.slice(2).sort((a, b) => a - b), Array.from({ length: 11 }, (_, i) => i + 25));
  assert.equal(new Set(calls).size, 13);
  const activeJumpCalls = [...calls];

  // A freshly opened PDF can be downloaded without first starting nearby translation.
  holdFirstTwo = false;
  calls.length = 0;
  await openFixture();
  assert.equal(calls.length, 0);
  assert.equal(await reader.locator("#downloadDocument").isEnabled(), true);
  await exportDocument("direct-translated.pdf");
  assert.equal(calls.length, 40);
  assert.equal(new Set(calls).size, 40);
  assert.equal(await reader.locator(".translation-block-text").count(), 40);

  // Normal document-open entry points start the configured nearby range automatically.
  const pdfBytes = await fs.readFile(file);
  const automaticSources = ["file", "drop", "url"];
  for (const source of automaticSources) {
    calls.length = 0;
    await reader.goto(`${base}/pdf.html`);
    await reader.waitForSelector("#provider option", { state: "attached" });
    assert.equal(calls.length, 0, "A blank workspace has no document to translate");
    if (source === "file") {
      await reader.locator("#fileInput").setInputFiles(file);
    } else if (source === "drop") {
      const transfer = await reader.evaluateHandle(bytes => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], "scope.pdf", { type: "application/pdf" }));
        return transfer;
      }, [...pdfBytes]);
      await reader.locator("#dropZone").dispatchEvent("drop", { dataTransfer: transfer });
      await transfer.dispose();
    } else {
      await reader.locator("#pdfUrl").fill(`http://127.0.0.1:${server.address().port}/scope.pdf`);
      await reader.locator("#pdfUrl").press("Enter");
    }
    await waitIdle(6);
    assert.equal(calls[0], 1, `${source}: automatic translation starts at the first page`);
    assert.deepEqual([...calls].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
    await reader.waitForTimeout(300);
    assert.equal(calls.length, 6, `${source}: automatic translation respects the nearby range`);
  }
  await reader.locator("#fileInput").setInputFiles({ name: "second.pdf", mimeType: "application/pdf", buffer: pdfBytes });
  await waitIdle(12);
  assert.equal(await reader.locator("#documentName").textContent(), "second.pdf");
  assert.deepEqual(calls.slice(6).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  await reader.screenshot({ path: path.join(output, "opened-auto-translated.png") });
  assert.deepEqual(errors, []);
  const report = { samplePages: 40, defaultPages: 11, afterOverlap: 16, afterJump: 26,
    afterCurrentOnly: 28, afterFullExport: 40, afterUnlimited: 40, activeJumpCalls,
    fullExportPages: 40, directExportPages: 40, preservedEdit: true, repeatedExportReused: true,
    automaticSources, automaticPages: 6, replacementDocumentAutoTranslated: true };
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  for (const release of gates) release();
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}

async function assertEventually(check) {
  for (let attempt = 0; ; attempt++) {
    try { check(); return; } catch (error) {
      if (attempt >= 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
