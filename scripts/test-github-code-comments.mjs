// Optional browser layout regression; see docs/development.md.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.join(root, ".npm-cache/github-code-comments");
await fs.mkdir(output, { recursive: true });
const bundle = path.join(output, "content.js");
await build({
  stdin: { contents: `export { collectTextSegmentsProgressive, renderTranslationPlaceholders, clearTranslations, renderTranslations, setTranslationDisplayMode } from "./src/content/dom";
    export { injectContentStyles } from "./src/content/styles";`, resolveDir: root, loader: "ts" },
  bundle: true, format: "iife", globalName: "WuPageTest", outfile: bundle
});
const moduleName = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const lines = (await fs.readFile(path.join(root, "src/ocr/ort-runtime.ts"), "utf8")).trimEnd().split(/\r?\n/u);
const escape = (text) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const highlight = (line) => /^\s*\/\//u.test(line) ? `<span class="pl-c">${escape(line)}</span>` : escape(line);
const html = (layout) => {
  const numbers = lines.map((_, index) => `<div class="react-line-number react-code-text" data-line-number="${index + 1}">${index + 1}</div>`).join("");
  const code = lines.map((line, index) => `<div id="LC${index + 1}" class="react-code-text react-file-line" style="${layout === "virtual" ? `position:absolute;top:${index * 20}px;height:20px;` : ""}">${highlight(line) || "\n"}</div>`).join("");
  return `<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:24px;font:14px Arial}h1{font:18px Arial}
    .viewport{width:100%;overflow:auto;border:1px solid #ccd4dc;padding:8px 0}
    .react-code-file-contents{display:flex;min-width:100%;width:max-content}
    .react-code-text,.blob-code,.blob-num{font:12px/20px Consolas,monospace;white-space:pre;}
    .react-line-number{height:20px;padding:0 16px;min-width:56px;text-align:right;color:#59636e}
    .react-code-lines{position:relative;min-width:0;flex:1}
    .react-file-line{min-height:20px;position:relative;padding-right:16px}
    .pl-c{display:inline-block;color:#59636e}.blob-code{padding:0 16px 0 8px}
    .blob-num{padding:0 16px;color:#59636e;vertical-align:top;text-align:right}
    table{border-collapse:collapse;min-width:100%}
    </style></head><body><h1>GitHub code comments: ${layout}</h1><main class="viewport">${layout === "table"
      ? `<table><tbody>${lines.map((line, index) => `<tr id="LC${index + 1}"><td class="blob-num">${index + 1}</td><td class="blob-code">${highlight(line) || "\n"}</td></tr>`).join("")}</tbody></table>`
      : `<div class="react-code-file-contents"><div>${numbers}</div><div class="react-code-lines" style="${layout === "virtual" ? `height:${lines.length * 20}px` : ""}">${code}</div></div>`}</main></body></html>`;
};

const browser = await chromium.launch({
  ...(process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : { channel: "chromium" }), headless: true
});
const reports = [];
try {
  for (const width of [1800, 600]) for (const layout of ["flow", "virtual", "table"]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1.25 });
    await page.setContent(html(layout));
    await page.addScriptTag({ path: bundle });
    for (const mode of ["bilingual", "bilingual-accent", "replace"]) {
      const report = await page.evaluate(async ({ mode, layout }) => {
        WuPageTest.injectContentStyles();
        const root = document.querySelector("main");
        const original = root.innerHTML;
        const rows = [...document.querySelectorAll('[id^="LC"]')];
        const measure = () => rows.map((row) => {
          const rect = row.getBoundingClientRect();
          return { top: rect.top, height: rect.height };
        });
        const before = measure();
        const segments = (await WuPageTest.collectTextSegmentsProgressive()).filter((segment) => segment.element.closest(".react-code-text,.blob-code"));
        WuPageTest.renderTranslationPlaceholders(segments);
        const pending = measure();
        WuPageTest.renderTranslations(segments.map((segment) => ({ id: segment.id,
          text: "注释译文用于检查固定行高与行号对齐。".repeat(12) + "\n译文中的换行也不能覆盖下一行代码。" })), mode);
        const translated = measure();
        const switches = ["replace", "bilingual-accent", "bilingual", mode].map((next) => {
          WuPageTest.setTranslationDisplayMode(next);
          return { mode: next, rows: measure(), count: root.querySelectorAll('.wupage-translation').length };
        });
        const output = [...root.querySelectorAll('.wupage-translation')];
        const collisions = output.flatMap((text) => {
          const row = text.closest('[id^="LC"]');
          const range = document.createRange();
          range.selectNodeContents(text);
          const glyphs = range.getBoundingClientRect();
          const bounds = row.getBoundingClientRect();
          return glyphs.top < bounds.top - 1 || glyphs.bottom > bounds.bottom + 1 ? [row.id] : [];
        });
        const aligned = layout === "table" || rows.every((row, index) =>
          Math.abs(row.getBoundingClientRect().top - document.querySelector(`[data-line-number="${index + 1}"]`).getBoundingClientRect().top) < 0.5);
        const viewport = document.querySelector('.viewport');
        const scrollable = viewport.scrollWidth > viewport.clientWidth;
        const end = output.at(-1)?.getBoundingClientRect().right ?? 0;
        viewport.scrollLeft = viewport.scrollWidth;
        const moved = !output.length || output.at(-1).getBoundingClientRect().right < end;
        viewport.scrollLeft = 0;
        WuPageTest.clearTranslations();
        return { before, pending, translated, restored: measure(), restoredDom: root.innerHTML === original,
          segments: segments.length, translations: output.length, aligned, collisions, scrollable, moved, switches };
      }, { mode, layout });
      assert.equal(report.segments, 3, `${layout}/${mode}: comment extraction`);
      assert.equal(report.translations, 3);
      for (const stage of ["pending", "translated", "restored"]) {
        assert.deepEqual(report[stage], report.before, `${layout}/${mode}: ${stage} changed source row positions`);
      }
      assert(report.aligned, `${layout}/${mode}: line numbers moved out of alignment`);
      assert.deepEqual(report.collisions, [], `${layout}/${mode}: translation crossed a row`);
      assert(report.scrollable && report.moved, `${layout}/${mode}: long translation cannot be read by scrolling`);
      assert(report.restoredDom, `${layout}/${mode}: clearing did not restore source DOM`);
      for (const change of report.switches) {
        assert.deepEqual(change.rows, report.before, `${layout}/${change.mode}: mode switch moved code rows`);
        assert.equal(change.count, 3, `${layout}/${change.mode}: mode switch duplicated or lost translations`);
      }
      reports.push({ width, layout, mode, ...report });
    }
    await page.close();
  }
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(reports, null, 2));
  console.log(`PASS: ${reports.length} GitHub code layouts; rows, line numbers, long translations, pending states and cleanup`);
} finally { await browser.close(); }
