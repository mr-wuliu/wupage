// Optional browser regression against the built MV3 extension and a local model stub.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const chromeBrowser = process.env.CHROME_TEST_BROWSER;
const output = path.join(root, chromeBrowser ? ".npm-cache/chrome-translation" : ".npm-cache/page-translation");
await fs.mkdir(output, { recursive: true });
// A content script must parse as a classic script even when it reuses helpers
// also imported by the background worker or the PDF reader.
new vm.Script(await fs.readFile(path.join(root, "dist/content.js"), "utf8"));
const moduleName = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const calls = [];
let damagedOnce = false;
let releaseSlow;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Translation regression</title>
<style>body{margin:24px;font:16px/1.5 sans-serif}main{max-width:700px}code{white-space:nowrap}</style></head><body><main>
<h2>Review <em>request</em></h2>
<p id="rich">Use <code>first()</code> instead of <code>second()</code> before continuing.</p>
<div id="prose">Please <strong>review</strong> the attached contract.</div>
<p>Published <em>message</em>.<span contenteditable="plaintext-only">Unsent inline draft.</span></p>
<p hidden>Hidden private message.</p></main></body></html>`;
const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html);
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(JSON.parse(body).messages.at(-1).content);
    calls.push(input);
    if (input.texts.includes("Old pending message.")) await new Promise(resolve => { releaseSlow = resolve; });
    const translations = input.texts.map(text => {
      if (!text.includes("WUPAGE")) return `译文：${text}`;
      if (!damagedOnce) {
        damagedOnce = true;
        return "⟪WUPAGE0⟫ 替代 ⟪WUPAGE0⟫。";
      }
      return "先检查 ⟪WUPAGE1⟫，再使用 ⟪WUPAGE0⟫。";
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(translations) } }] }));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...(chromeBrowser || process.env.PDF_TEST_BROWSER ? { executablePath: chromeBrowser || process.env.PDF_TEST_BROWSER } : { channel: "chromium" }),
    headless: true, ignoreDefaultArgs: ["--disable-extensions"],
    args: chromeBrowser ? ["--enable-unsafe-extension-debugging"] : [`--load-extension=${path.join(root, "dist")}`],
    viewport: { width: 1000, height: 900 }
  });
  if (chromeBrowser) {
    // Branded Chrome loads test extensions through CDP in the isolated profile.
    const session = await context.browser().newBrowserCDPSession();
    await session.send("Extensions.loadUnpacked", { path: path.join(root, "dist") });
    await session.detach();
  }
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const control = await context.newPage();
  await control.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await control.evaluate(async (baseURL) => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    const provider = settings.providers.find(entry => entry.type === "deepseek");
    provider.baseURL = `${baseURL}v1`; provider.apiKey = "test-only";
    settings.activeProviderId = provider.id; settings.cacheEnabled = false;
    settings.sourceLang = "en"; settings.targetLang = "zh-CN"; settings.translationDisplayMode = "bilingual";
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
  }, url);
  await page.goto(url);
  await page.waitForSelector("#wupage-floating-ball", { state: "attached" });
  const original = await page.locator("main").innerHTML();
  const originalText = await page.locator("main").textContent();
  const message = request => worker.evaluate(async ({ url, request }) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.tabs.sendMessage(tab.id, request);
  }, { url, request });
  const result = await message({ type: "TRANSLATE_PAGE" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.failed, 0);
  assert.equal(result.data.translated, 4);
  assert.equal(damagedOnce, true);
  assert.equal(calls.filter(call => call.texts.length === 1 && call.texts[0].includes("WUPAGE")).length, 1);
  assert.equal(calls.some(call => /Unsent|Hidden private/u.test(JSON.stringify(call))), false);
  assert.deepEqual(await page.locator(".wupage-translation code").allTextContents(), ["second()", "first()"]);

  const modeReports = [];
  for (const width of [1000, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["replace", "bilingual-accent", "bilingual"]) {
      const before = calls.length;
      await control.evaluate(async (mode) => {
        const { data: settings } = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
        await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { ...settings, translationDisplayMode: mode } });
      }, mode);
      await page.waitForFunction(mode => [...document.querySelectorAll(".wupage-translation")]
        .every(node => node.dataset.wupageDisplayMode === mode), mode);
      await page.waitForTimeout(250);
      assert.equal(calls.length, before, `Switching modes must reuse translations (${width}, ${mode}): ${JSON.stringify(calls)}`);
      assert.equal(await page.locator(".wupage-translation").count(), 4);
      assert.equal(await page.locator(".wupage-translation-pending").count(), 0);
      assert.equal(await page.locator("main").evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
      modeReports.push({ width, mode });
    }
  }
  await message({ type: "CLEAR_TRANSLATION" });
  assert.equal(await page.locator("main").innerHTML(), original);

  // Verify the Ctrl-click paragraph path uses the same protected-token pipeline.
  await message({ type: "SET_PARAGRAPH_MODE", enabled: true });
  await page.locator("#rich").dispatchEvent("click", { ctrlKey: true });
  await page.waitForSelector(".wupage-translation code");
  assert.deepEqual(await page.locator(".wupage-translation code").allTextContents(), ["second()", "first()"]);
  await message({ type: "CLEAR_TRANSLATION" });
  await message({ type: "SET_PARAGRAPH_MODE", enabled: false });
  assert.equal(await page.locator("main").textContent(), originalText);
  assert.equal(await page.locator(".wupage-translation").count(), 0);
  assert.deepEqual(await page.locator("#rich code").allTextContents(), ["first()", "second()"]);

  // Updates feeds can mix loose list items with paragraph-wrapped items.
  // Both must put bilingual prose below the source, including one-link items.
  await page.locator("main").evaluate(node => {
    node.innerHTML = `<ul id="updates">
      <li>2026-09-15 - The latest <a href="/release">release</a> improves training and retires support for older versions.</li>
      <li><p>2025-05-16 - Please upgrade to the latest <a href="/previous">release</a> to continue contributing training games.</p></li>
      <li>Support for older versions has been retired.</li>
      <li><a href="/install">Download and install the latest version</a></li>
    </ul><nav><ul><li><a href="/guide">User guide</a></li></ul></nav>
    <table><tbody><tr><td>Training status</td></tr></tbody></table>`;
  });
  const originalLists = await page.locator("main").innerHTML();
  const listResult = await message({ type: "TRANSLATE_PAGE" });
  assert.equal(listResult.ok, true, JSON.stringify(listResult));
  assert.equal(listResult.data.failed, 0);
  assert.equal(listResult.data.translated, 6);
  const listRequests = calls.length;
  const listReports = [];
  for (const width of [1000, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["bilingual", "bilingual-accent", "replace"]) {
      await control.evaluate(async mode => {
        const { data: settings } = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
        await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { ...settings, translationDisplayMode: mode } });
      }, mode);
      await page.waitForFunction(mode => [...document.querySelectorAll(".wupage-translation")]
        .every(node => node.dataset.wupageDisplayMode === mode), mode);
      const items = await page.locator("#updates > li").evaluateAll(items => items.map(item => {
        const output = item.querySelector(".wupage-translation");
        const sourceRects = [];
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (!text.textContent.trim() || text.parentElement.closest(".wupage-translation")) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          sourceRects.push(...range.getClientRects());
        }
        return { mode: output.dataset.wupageMode, display: getComputedStyle(output).display,
          top: output.getBoundingClientRect().top, sourceBottom: Math.max(...sourceRects.map(rect => rect.bottom)) };
      }));
      for (const item of items) {
        assert.equal(item.mode, "block");
        assert.equal(item.display, mode === "replace" ? "inline" : "block");
        if (mode !== "replace") assert.ok(item.top >= item.sourceBottom - 1, `Translation must follow the source: ${JSON.stringify(item)}`);
      }
      assert.deepEqual(await page.locator("nav .wupage-translation, td .wupage-translation")
        .evaluateAll(outputs => outputs.map(output => getComputedStyle(output).display)), ["inline", "inline"]);
      assert.equal(await page.locator("#updates").evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
      assert.equal(calls.length, listRequests, "List mode changes must reuse translations");
      listReports.push({ width, mode, items });
      if (mode === "bilingual") await page.screenshot({ path: path.join(output, `lists-${width}.png`) });
    }
  }
  await message({ type: "CLEAR_TRANSLATION" });
  assert.equal(await page.locator("main").innerHTML(), originalLists);

  // Check rendered colors in Chromium: jsdom does not resolve modern CSS color
  // spaces or inherited WebKit text fill, and tiny RGB changes look identical.
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.locator("main").evaluate(node => {
    const cases = [
      ["Black text", "rgb(0, 0, 0)", "rgb(255, 255, 255)"],
      ["Light text", "rgb(240, 240, 240)", "rgb(18, 24, 28)"],
      ["Teal text", "rgb(15, 118, 110)", "rgb(255, 255, 255)"],
      ["Modern light page", "oklch(0.25 0.02 250)", "oklch(1 0 0)"],
      ["Modern dark page", "oklch(0.95 0.02 250)", "oklch(0.18 0.02 250)"],
      ["Wide gamut text", "color(display-p3 0.15 0.2 0.3)", "color(srgb 1 1 1)"]
    ];
    node.innerHTML = '<style>#color-cases span { color: inherit !important; }</style><section id="color-cases"></section>';
    const section = node.querySelector("section");
    cases.forEach(([text, color, background]) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = `${text} should retain a visible translation accent.`;
      paragraph.dataset.colorCase = text;
      Object.assign(paragraph.style, { color, backgroundColor: background, padding: "12px" });
      paragraph.style.setProperty("-webkit-text-fill-color", color);
      section.append(paragraph);
    });
  });
  const colorResult = await message({ type: "TRANSLATE_PAGE" });
  assert.equal(colorResult.ok, true, JSON.stringify(colorResult));
  assert.equal(colorResult.data.failed, 0);
  assert.equal(await page.locator(".wupage-translation").count(), 6);
  const colorReports = [];
  const colorRequests = calls.length;
  for (const mode of ["bilingual", "bilingual-accent", "replace", "bilingual-accent", "bilingual"]) {
    await control.evaluate(async mode => {
      const { data: settings } = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
      await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { ...settings, translationDisplayMode: mode } });
    }, mode);
    await page.waitForFunction(mode => [...document.querySelectorAll(".wupage-translation")]
      .every(node => node.dataset.wupageDisplayMode === mode), mode);
    const reports = await page.locator("#color-cases p").evaluateAll(paragraphs => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const rgb = css => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = css;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const luminance = channels => {
        const [r, g, b] = channels.map(channel => channel / 255).map(channel => channel <= 0.04045
          ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      return paragraphs.map(paragraph => {
        const source = getComputedStyle(paragraph);
        const output = getComputedStyle(paragraph.querySelector(".wupage-translation"));
        const originalColor = rgb(source.color);
        const translatedColor = rgb(output.color);
        const background = rgb(source.backgroundColor);
        const lighter = Math.max(luminance(translatedColor), luminance(background));
        const darker = Math.min(luminance(translatedColor), luminance(background));
        return { name: paragraph.dataset.colorCase, originalColor, translatedColor,
          paintedColor: rgb(output.webkitTextFillColor),
          difference: Math.hypot(...translatedColor.map((channel, index) => channel - originalColor[index])),
          contrast: (lighter + 0.05) / (darker + 0.05) };
      });
    });
    for (const report of reports) {
      assert.deepEqual(report.paintedColor, report.translatedColor, `Text fill must follow ${mode}: ${report.name}`);
      if (mode === "bilingual-accent") {
        assert.ok(report.difference >= 48, `Accent must be visibly different: ${JSON.stringify(report)}`);
        assert.ok(report.contrast >= 4.5, `Accent must remain readable: ${JSON.stringify(report)}`);
      } else assert.deepEqual(report.translatedColor, report.originalColor, `${mode} must preserve source color: ${report.name}`);
    }
    assert.equal(calls.length, colorRequests, "Color mode changes must not request new translations");
    colorReports.push({ mode, cases: reports });
    await page.screenshot({ path: path.join(output, `colors-${mode}.png`) });
  }
  await message({ type: "CLEAR_TRANSLATION" });

  // A reused application row must reject the previous source's late response.
  await page.locator("main").evaluate(node => { node.innerHTML = '<p id="pending">Old pending message.</p>'; });
  const pending = message({ type: "TRANSLATE_PAGE" });
  await page.waitForSelector(".wupage-translation-pending");
  await assertEventually(() => assert.equal(typeof releaseSlow, "function"));
  await page.locator("#pending").evaluate(node => { node.firstChild.data = "Current message."; });
  releaseSlow();
  await pending;
  await page.waitForFunction(() => document.querySelector("#pending .wupage-translation")?.textContent === "译文：Current message.");
  assert.equal(await page.locator("main").textContent(), "Current message.译文：Current message.");
  await message({ type: "CLEAR_TRANSLATION" });
  assert.equal(await page.locator("main").textContent(), "Current message.");
  assert.deepEqual(errors, []);
  const report = { browser: context.browser().version(), modes: modeReports, lists: listReports, colors: colorReports, placeholderRecovery: true, paragraphTranslation: true,
    hiddenAndDraftTextExcluded: true, sourceRestored: true, staleResponseDiscarded: true, errors };
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log("PASS: built MV3 extension; 6 viewport/mode combinations, 6 list layouts, 30 rendered color cases, protected text, drafts, Ctrl-click, source restoration and stale responses");
} finally {
  releaseSlow?.();
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}

async function assertEventually(check) {
  for (let attempt = 0; ; attempt++) {
    try { check(); return; } catch (error) {
      if (attempt >= 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
