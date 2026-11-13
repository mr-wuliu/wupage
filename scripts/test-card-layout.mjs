// Browser regression for separate card fields and localized mixed-language pages.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserTarget, verifyBrowserIdentity } from "./lib/browser-target.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = browserTarget();
const output = path.join(root, ".npm-cache/card-layout", ...(target.kind === "edge" ? ["edge"] : []));
await fs.mkdir(output, { recursive: true });
const moduleName = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
const title = "A modular library for game extensions";
const summary = "Lightweight tools for creating and sharing extensions with other players.";
const listTranslations = [
  ["Lower your expectations for this puzzle", "降低你对这个谜题的期望"],
  ["Is there a special place for Hilbert's foundations of geometry?", "希尔伯特的《几何基础》在几何学基础中是否享有特殊地位？"],
  ["performance", "性能"], ["stream", "流"], ["memory-efficient", "节省内存"]
];
const translations = [[title, "游戏扩展模块库"], [summary, "用于创建扩展并与其他玩家分享的轻量级工具。"], ["by", "作者"],
  ["Extension overview", "扩展概述"], ["Store listings", "商店条目"], ["Submission status", "提交状态"],
  ["Extension ⟪WUPAGEOPEN0⟫overview⟪WUPAGECLOSE0⟫", "扩展⟪WUPAGEOPEN0⟫概述⟪WUPAGECLOSE0⟫"],
  ["Store ⟪WUPAGEOPEN0⟫listings⟪WUPAGECLOSE0⟫", "商店⟪WUPAGEOPEN0⟫条目⟪WUPAGECLOSE0⟫"],
  ["Submission ⟪WUPAGEOPEN0⟫status⟪WUPAGECLOSE0⟫", "提交⟪WUPAGEOPEN0⟫状态⟪WUPAGECLOSE0⟫"],
  ["Lower your ⟪WUPAGEOPEN0⟫expectations⟪WUPAGECLOSE0⟫ for this puzzle", "降低你对这个谜题的⟪WUPAGEOPEN0⟫期望⟪WUPAGECLOSE0⟫"],
  ["Type ⟪WUPAGE0⟫ to search", "输入 ⟪WUPAGE0⟫ 进行搜索"], ["Type / to search", "输入 / 进行搜索"],
  ["Auto", "自动"], ["Optimized for Balance", "针对平衡进行了优化"],
  ["Optimized for: Balance", "针对：平衡进行了优化"], ...listTranslations];
const server = createServer((request, response) => {
  const chinese = request.url === "/zh";
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="${chinese ? "zh-CN" : "en"}"><head><meta charset="utf-8">
    <title>${chinese ? "模组列表" : "Extension catalog"}</title><style>
    body{margin:20px;font:16px/1.5 sans-serif;background:#171a1c;color:#b1b8bd}
    main{max-width:700px}.card{padding:16px;margin-bottom:16px;background:#23282c;border-radius:12px}
    .fields{gap:8px;align-items:center}.flex{display:flex}.grid{display:grid;grid-template-columns:minmax(0,1fr) auto}
    .title{font-size:20px;font-weight:600;line-height:24px;color:#f6f8fa;min-width:0;display:-webkit-box;
      -webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden}
    .author{flex-shrink:0;white-space:nowrap;font-weight:400;color:#b1b8bd}.author a{color:inherit}
    .summary{margin-top:8px;font-size:16px;font-weight:400;line-height:24px}
    #list-layout{max-width:300px;padding:12px;background:white;color:#0c0d0e}
    #list-layout a{color:#0074cc;text-decoration:none}
    .post-tags{padding:0;list-style:none}.post-tags li{display:inline;margin-right:4px}
    .post-tags a{display:inline-flex;align-items:center;padding:4px 6px;border-radius:4px;background:#edf0f2;font-size:13px}
    /* Stack Overflow's icon/link rows reserve 90% of the line for the link. */
    #hot-network-questions ul{margin:0;padding:0}
    #hot-network-questions li{list-style-type:none;white-space:nowrap;margin:0 0 10px}
    #hot-network-questions .favicon,#hot-network-questions a{display:inline-block;vertical-align:top}
    #hot-network-questions .favicon{width:16px;height:16px;margin:2px 6px 0 0;background:#0074cc}
    #hot-network-questions a{font-weight:normal;font-size:13px;white-space:normal;width:90%}
    .dynamic-wrapper{font:16px/24px sans-serif;margin:12px 0}
    .dynamic-source{display:block;font:italic small-caps 600 20px/28px serif;font-stretch:90%;
      letter-spacing:.5px;word-spacing:1px;text-transform:uppercase;color:#f6f8fa}
    @media(max-width:500px){.dynamic-source{font-size:18px;font-weight:700;line-height:26px;letter-spacing:.25px}}
    .search-control{display:flex;align-items:center;gap:8px;width:320px;max-width:100%;height:36px;padding:0 12px;font:14px/20px sans-serif}
    .search-label{flex:1;text-align:left}.search-label kbd{border:1px solid #9198a1;border-radius:3px;padding:0 3px;font:11px/16px monospace}
    .tier-control{display:flex;align-items:center;justify-content:space-between;gap:8px;height:32px;min-width:max-content;padding:0 12px;border:1px solid transparent;font:14px/21px sans-serif}
    .tier-content{display:grid;grid-template-columns:min-content minmax(0,auto) min-content;grid-template-areas:"leadingVisual text trailingVisual";align-items:center}
    .tier-label{grid-area:text;white-space:nowrap}.tier-action{display:inline-flex;margin-right:-4px}
    .model-list{padding:0;list-style:none}.action-content{display:grid;grid-template:"spacer leadingAction leadingVisual content" min-content/min-content min-content min-content minmax(0,auto)}
    .leading-visual{grid-area:leadingVisual;width:24px}.action-subcontent{display:grid;grid-area:content;grid-template:"label trailingVisual trailingAction" min-content/minmax(0,auto) min-content min-content;gap:8px}
    .description-wrap{display:flex;flex-direction:column;gap:4px;grid-area:label}.model-label{font:600 14px/20px sans-serif}.model-description{font:400 12px/16px sans-serif}.trailing-visual{grid-area:trailingVisual;white-space:nowrap}
    .sidebar-regression{width:280px;padding:8px;background:white;color:#222}
    .sidebar-regression ul{margin:0;padding:0;list-style:none}
    .sidebar-regression a{height:36px;overflow:hidden;align-items:center;color:#222;text-decoration:none;font:14px/36px sans-serif}
    .sidebar-regression .nav-label{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sidebar-regression .status-slot{width:16px;height:16px;margin-left:auto;overflow:hidden;font-size:0;background:#168317;border-radius:50%}
    #sidebar-grid{display:grid;grid-template-columns:minmax(0,1fr) 24px;grid-auto-rows:36px}
    #sidebar-flex{display:flex;justify-content:space-between}.sidebar-regression #sidebar-flex .nav-label{flex:1}
    #sidebar-css{display:grid;grid-template-columns:minmax(0,1fr) 24px;grid-auto-rows:36px}
    #sidebar-css span{display:none;position:absolute;font-size:0;line-height:0;visibility:hidden;opacity:0}
    #sidebar-css>.nav-label{display:block;position:static;font:14px/36px sans-serif;visibility:visible;opacity:1}
    </style></head><body><main role="main">
    <header><button class="search-control" type="button"><svg aria-hidden="true" width="16" height="16"></svg>
      <span class="search-label">Type <kbd>/</kbd> to search</span></button></header>
    <button class="tier-control" type="button" aria-expanded="false" aria-label="Optimized for: Balance">
      <span class="tier-content" data-component="buttonContent"><span class="tier-label" data-component="text"></span></span>
      <span class="tier-action" data-component="trailingAction"><svg aria-hidden="true" width="16" height="16"></svg></span>
    </button>
    <ul class="model-list" role="menu"><li role="menuitemradio" aria-checked="true" tabindex="0" aria-labelledby="model-label" aria-describedby="model-description" data-component="ActionList.Item">
      <div class="action-content"><span class="leading-visual"><svg aria-hidden="true" width="16" height="16"></svg></span>
        <span class="action-subcontent" data-component="ActionList.Item--DividerContainer"><div class="description-wrap" data-description-variant="block">
          <span id="model-label" class="model-label" data-component="ActionList.Item.Label"><span>Auto</span></span>
          <span id="model-description" class="model-description" data-component="ActionList.Description"><span>Optimized for Balance</span></span>
        </div><span class="trailing-visual" aria-hidden="true">Balance ›</span></span></div></li></ul>
    <aside class="sidebar-regression" aria-label="Extension navigation"><ul>
      <li><a id="sidebar-grid" href="/overview"><span class="nav-label">Extension <strong>overview</strong></span><i class="status-slot" aria-hidden="true">done</i></a></li>
      <li><a id="sidebar-flex" href="/listing"><span class="nav-label">Store <strong>listings</strong></span><i class="status-slot" aria-hidden="true">done</i></a></li>
      <li><a id="sidebar-css" href="/submission"><span class="nav-label">Submission <strong>status</strong></span><i class="status-slot" aria-hidden="true">done</i></a></li>
    </ul></aside>
    <p>${chinese ? "游戏版本 · 加载器 · 排序方式 · 客户端或服务端" : "Browse community extensions and tools for your game."}</p>
    ${["flex", "grid"].map(layout => `<div class="card" id="${layout}"><div class="fields ${layout}">
      <span class="title">${title}</span><span class="author">by <a href="/user/developer">developer</a></span>
      </div><div class="summary">${summary}</div></div>`).join("")}
    <div id="list-layout"><ul class="post-tags">${listTranslations.slice(2).map(([text]) =>
      `<li><a class="layout-link" href="/tag/${text}" rel="tag">${text}</a></li>`).join("")}</ul>
      <div id="hot-network-questions"><h4>Hot Network Questions</h4><ul>
        <li><div class="favicon" title="Puzzling"></div><a class="layout-link" href="/question/1">Lower your <em>expectations</em> for this puzzle</a></li>
        <li><div class="favicon" title="Mathematics"></div><a class="layout-link" href="/question/2">${listTranslations[1][0]}</a></li>
      </ul></div>
    </div>
    ${[title, summary].map(text => `<p class="dynamic-wrapper"><span class="dynamic-source">${text}</span></p>`).join("")}
    </main><script>
      // React renders the prefix and selected value as separate Text nodes.
      document.querySelector(".tier-label").append(document.createTextNode("Optimized for: "), document.createTextNode("Balance"));
    </script></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...(target.kind === "edge" || process.env.CHROME_TEST_BROWSER ? target.chromiumOptions
      : process.env.PDF_TEST_BROWSER ? { executablePath: process.env.PDF_TEST_BROWSER } : target.chromiumOptions),
    headless: true, ignoreDefaultArgs: ["--disable-extensions"],
    args: target.kind === "edge" || process.env.CHROME_TEST_BROWSER ? ['--lang=zh-CN', "--enable-unsafe-extension-debugging"] : ['--lang=zh-CN', `--load-extension=${path.join(root, "dist")}`],
    viewport: { width: 1000, height: 900 }
  });
  if (target.kind === "edge" || process.env.CHROME_TEST_BROWSER) {
    const session = await context.browser().newBrowserCDPSession();
    await session.send("Extensions.loadUnpacked", { path: path.join(root, "dist") }); await session.detach();
  }
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const control = await context.newPage();
  await control.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await control.evaluate(async () => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    settings.activeProviderId = settings.providers.find(provider => provider.type === "google-web-translate").id;
    settings.cacheEnabled = false; settings.sourceLang = "auto"; settings.targetLang = "zh-CN";
    settings.translationDisplayMode = "replace";
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
  });
  await worker.evaluate(translations => {
    const originalFetch = globalThis.fetch;
    globalThis.cardRequests = [];
    globalThis.fetch = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.hostname === "translate.googleapis.com") return new Response(parsed.pathname.includes("/translate_a/element.js")
        ? "_loadJs('https://translate.googleapis.com/_/translate_http/_/js/k=fixture/m=el_main')"
        : `({'x-goog-api-key':'${'A'.repeat(39)}'})`);
      if (parsed.hostname !== "translate-pa.googleapis.com") return originalFetch(url, init);
      const sources = JSON.parse(init.body)[0][0];
      globalThis.cardRequests.push(...sources);
      // Simulate the endpoint detecting a Chinese catalog as already Chinese,
      // including its embedded English descriptions. Individual items translate.
      const translated = sources.map(source => {
        if (source.startsWith("<pre><a i=0>Page title: 模组列表")) return source;
        const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
        for (const [original, target] of translations) source = source.replaceAll(escape(original), escape(target));
        return source;
      });
      return new Response(JSON.stringify([translated]), {
        headers: { "Content-Type": "application/json" }
      });
    };
  }, translations);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  control.setDefaultTimeout(10_000);
  const identity = verifyBrowserIdentity(target, await page.evaluate(() => navigator.userAgent));
  const setMode = mode => control.evaluate(async mode => {
    const { data: settings } = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { ...settings, translationDisplayMode: mode } });
  }, mode);
  const waitForMode = mode => page.waitForFunction(mode => [...document.querySelectorAll(".wupage-translation")]
    .every(node => node.dataset.wupageDisplayMode === mode), mode);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const reports = [];
  for (const locale of ["en", "zh"]) {
    const url = `http://127.0.0.1:${server.address().port}/${locale}`;
    await page.goto(url);
    await page.waitForSelector("#wupage-floating-ball", { state: "attached" });
    const original = await page.locator("main").innerHTML();
    const listLinks = await page.locator(".layout-link").evaluateAll(nodes => nodes.map(node => ({
      href: node.getAttribute("href"), color: getComputedStyle(node).color
    })));
    const searchLabelHeight = await page.locator(".search-label").evaluate(node => node.getBoundingClientRect().height);
    const typography = await page.locator(".title").evaluateAll(nodes => nodes.map(node => {
      const { fontSize, fontWeight, lineHeight, color } = getComputedStyle(node);
      return { fontSize, fontWeight, lineHeight, color };
    }));
    const message = request => worker.evaluate(async ({ url, request }) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab.id, request);
    }, { url, request });
    await setMode("replace");
    const result = await message({ type: "TRANSLATE_PAGE" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.failed, 0);
    assert.equal(await page.locator(".summary .wupage-translation").count(), 2);
    for (const description of await page.locator(".summary .wupage-translation").allTextContents()) {
      assert.equal(description, translations[1][1], `${locale}: English descriptions must translate`);
    }
    const requestCount = await worker.evaluate(() => globalThis.cardRequests.length);
    const status = page.locator("#wupage-floating-menu [data-role='translation-status']");
    const progress = await status.textContent();
    assert.ok(progress.includes(`已翻译 ${result.data.translated} 段`));
    const initialOutputs = await page.locator(".dynamic-source .wupage-translation").elementHandles();
    assert.equal(initialOutputs.length, 2);
    // Host truncators may restore text in place or discard the output while rebuilding it.
    await page.locator(".dynamic-source").evaluateAll((sources, texts) => {
      sources[0].firstChild.data = texts[0];
      sources[1].replaceChildren(document.createTextNode(texts[1]));
    }, [title, summary]);
    await page.waitForFunction(() => document.querySelectorAll(
      '.dynamic-wrapper > .wupage-translation[data-wupage-container="stable-replacement"]'
    ).length === 2);
    assert.equal(await initialOutputs[0].evaluate(node => node.isConnected), true);
    assert.equal(await initialOutputs[1].evaluate(node => node.isConnected), false);
    for (const width of [1000, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator(".dynamic-source").evaluateAll((sources, texts) => {
        sources.forEach((source, index) => source.replaceChildren(document.createTextNode(texts[index])));
        window.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("scroll"));
      }, [title, summary]);
      await page.waitForTimeout(250);
      for (const mode of ["replace", "bilingual", "bilingual-accent"]) {
        await setMode(mode);
        await waitForMode(mode);
        assert.equal(await page.locator(".fields > .wupage-translation").count(), 0);
        assert.equal(await page.locator(".sidebar-regression a > .wupage-translation").count(), 0,
          "Sidebar translations must stay in their text cell, not become a clipped third item");
        const sidebar = await page.locator(".sidebar-regression a").evaluateAll((links, mode) => links.map(link => {
          const label = link.querySelector('.nav-label');
          const text = label.querySelector('.wupage-translation') ?? (mode === 'replace' && label.hasAttribute('data-wupage-translated') ? label : null);
          const icon = link.querySelector('.status-slot');
          if(!text)return {missing:true};
          const row = link.getBoundingClientRect(), style = getComputedStyle(text);
          const range = document.createRange();range.selectNodeContents(text);
          return {text:text.textContent,display:style.display,fontSize:parseFloat(style.fontSize),visibility:style.visibility,opacity:style.opacity,
            visible:[...range.getClientRects()].some(box=>box.width>0&&box.height>0&&box.left<row.right&&box.right>row.left&&box.top<row.bottom&&box.bottom>row.top),
            iconVisible:icon.getBoundingClientRect().width===16,href:link.getAttribute('href')};
        }), mode);
        if (sidebar.some(row => row.missing)) {
          await fs.writeFile(path.join(output, 'missing-sidebar.json'), JSON.stringify({ locale, width, mode, sidebar,
            requests: await worker.evaluate(() => globalThis.cardRequests.filter(source => /Extension|Store|Submission/.test(source))),
            html: await page.locator('.sidebar-regression').innerHTML() }, null, 2));
        }
        assert.deepEqual(sidebar.map(row=>row.text),['扩展概述','商店条目','提交状态']);
        assert.ok(sidebar.every(row=>row.visible&&row.iconVisible&&row.display!=='none'&&row.fontSize>0&&row.visibility==='visible'&&row.opacity==='1'),
          JSON.stringify({locale,width,mode,sidebar}));
        assert.deepEqual(sidebar.map(row=>row.href),['/overview','/listing','/submission']);
        assert.equal(await page.locator("#list-layout li > .wupage-translation").count(), 0);
        assert.equal(await page.locator(".layout-link").evaluateAll(nodes => nodes.filter(node =>
          node.querySelector('.wupage-translation') || node.hasAttribute('data-wupage-translated')).length), 5);
        assert.deepEqual(await page.locator(".layout-link").evaluateAll(nodes => nodes.map(node => ({
          href: node.getAttribute("href"), color: getComputedStyle(node).color
        }))), listLinks);
        const listLayout = await page.locator(".layout-link").evaluateAll(nodes => nodes.map(node => {
          const translation = node.querySelector(".wupage-translation") ?? node;
          const box = node.getBoundingClientRect();
          const insideLink = [...translation.getClientRects()].every(rect => rect.left >= box.left - 1
            && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1);
          const row = node.closest("li").getBoundingClientRect();
          return { insideLink, insideRow: box.right <= row.right + 1, color: getComputedStyle(translation).color };
        }));
        assert.ok(listLayout.every(row => row.insideLink && row.insideRow), JSON.stringify({ locale, width, mode, listLayout }));
        assert.deepEqual(await page.locator(".author a").evaluateAll(nodes => nodes.filter(node => !node.closest('.wupage-translation')).map(node => node.getAttribute("href"))),
          ["/user/developer", "/user/developer"]);
        assert.equal(await page.locator("main").evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
        const tier = await page.locator(".tier-control").evaluate(button => {
          const output = button.querySelector(".wupage-translation") ?? button.querySelector('.tier-label[data-wupage-translated]');
          const rect = button.getBoundingClientRect(), translated = output.getBoundingClientRect();
          return { text: output.textContent, field: output.closest('[data-component="text"]')?.dataset.component,
            singleLine: translated.height <= Number.parseFloat(getComputedStyle(button).lineHeight),
            fits: translated.left >= rect.left && translated.right <= rect.right && translated.top >= rect.top && translated.bottom <= rect.bottom,
            fontSize: getComputedStyle(output).fontSize, expanded: button.getAttribute("aria-expanded") };
        });
        assert.deepEqual(tier, { text: "针对：平衡进行了优化", field: "text", singleLine: true, fits: true,
          fontSize: mode === "replace" ? "14px" : "12.88px", expanded: "false" },
        "Split button labels must remain in their original text column");
        if (mode === "replace") {
          assert.deepEqual(listLayout.map(row => row.color), listLinks.map(link => link.color));
          const search = await page.locator(".search-control").evaluate((button, originalHeight) => {
            const rect = button.getBoundingClientRect(), label = button.querySelector(".search-label").getBoundingClientRect();
            return { text: button.querySelector(".wupage-translation")?.textContent,
              translatedKey: button.querySelector(".wupage-translation kbd")?.textContent,
              keys: [...button.querySelectorAll("kbd")].filter(key => key.getBoundingClientRect().width > 0).length,
              fits: label.height <= originalHeight && label.left >= rect.left && label.right <= rect.right && label.top >= rect.top && label.bottom <= rect.bottom };
          }, searchLabelHeight);
          assert.deepEqual(search, { text: "输入 / 进行搜索", translatedKey: "/", keys: 1, fits: true }, "Search shortcut must stay inline without a duplicate key");
          const rendered = await page.locator(".title .wupage-translation").evaluateAll(nodes => nodes.map(node => {
            const { fontSize, fontWeight, lineHeight, color } = getComputedStyle(node);
            return { fontSize, fontWeight, lineHeight, color };
          }));
          assert.deepEqual(rendered, typography, "Replacement titles must retain their original typography");
          assert.deepEqual(await page.locator(".title").allTextContents(), [translations[0][1], translations[0][1]]);
          const recovered = await page.locator(".dynamic-source").evaluateAll(sources => sources.map(source => {
            const properties = ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant",
              "line-height", "letter-spacing", "word-spacing", "text-transform", "color"];
            const read = element => Object.fromEntries(properties.map(name => [name, getComputedStyle(element).getPropertyValue(name)]));
            return { source: read(source), output: read(source.parentElement.querySelector(":scope > .wupage-translation")) };
          }));
          for (const entry of recovered) assert.deepEqual(entry.output, entry.source,
            `Recovered replacement must retain source typography (${locale}, ${width})`);
          assert.deepEqual(await page.locator(".dynamic-wrapper > .wupage-translation").allTextContents(),
            [translations[0][1], translations[1][1]]);
        }
        for (const [selector, text, size] of [["#model-label", "自动", "14px"], ["#model-description", "针对平衡进行了优化", "12px"]]) {
          const rendered = await page.locator(selector).evaluate(label => {
            const output = label.querySelector('.wupage-translation') ?? label;
            return { text: output.textContent, fontSize: getComputedStyle(output).fontSize };
          });
          assert.equal(rendered.text, text);
          if (mode === "replace") assert.equal(rendered.fontSize, size);
        }
        assert.equal(await page.locator(".model-list li > .wupage-translation,.action-content > .wupage-translation,.action-subcontent > .wupage-translation").count(), 0);
        assert.deepEqual(await page.locator(".model-list li").evaluate(node => ["role", "aria-checked", "tabindex", "aria-labelledby", "aria-describedby"].map(name => node.getAttribute(name))),
          ["menuitemradio", "true", "0", "model-label", "model-description"]);
        assert.equal(await worker.evaluate(() => globalThis.cardRequests.length), requestCount);
        assert.equal(await status.textContent(), progress, "Host rewrites must not increase translated segment counts");
        reports.push({ locale, width, mode, independentFields: true, linksPreserved: true, dynamicRecovery: true, listLayout });
        await page.screenshot({ path: path.join(output, `${locale}-${width}-${mode}.png`) });
      }
      // Resize an existing replacement on the next iteration, without rendering a new one.
      await setMode("replace");
      await waitForMode("replace");
    }
    // A visible field can become screen-reader-only while its host restores the source text.
    await page.locator(".dynamic-source").first().evaluate((source, text) => {
      source.style.cssText = "position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden;white-space:nowrap";
      source.replaceChildren(document.createTextNode(text));
    }, title);
    await page.waitForFunction(() => !document.querySelector(".dynamic-source").parentElement.querySelector(":scope > .wupage-translation"));
    await message({ type: "CLEAR_TRANSLATION" });
    await page.locator(".dynamic-source").first().evaluate(source => source.removeAttribute("style"));
    assert.equal(await page.locator("main").innerHTML(), original);
  }
  const requests = await worker.evaluate(() => globalThis.cardRequests);
  assert.ok(requests.some(source => source.startsWith("<pre><a i=0>Page title: 模组列表")), "Exercise combined language detection");
  assert.ok(requests.includes(`<pre>${summary}</pre>`), "Retry the untranslated description independently");
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ ...identity, reports, errors }, null, 2));
  console.log("PASS: localized card pages; 12 locale/viewport/mode combinations, sidebar font-icon rows and hidden-span styles, title and recovered typography, stable dynamic counts, author links, icon/link rows, tag labels, mixed-language recovery and source restoration");
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
