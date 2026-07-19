// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslationsIn,
  clearTranslationPlaceholders,
  clearTranslations,
  collectParagraphTextSegments,
  collectTextSegments,
  findTranslatableParagraph,
  hasPageTranslations,
  hasTranslationsIn,
  renderTargetPlaceholder,
  renderTargetTranslation,
  renderTranslationPlaceholders,
  renderTranslations
} from "../src/content/dom";

describe("content DOM translation extraction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.className = "";
    document.body.innerHTML = "";
  });

  it("translates code comments without translating code", () => {
    document.body.innerHTML = `
      <main>
        <p>Hello world</p>
        <pre><code>// Explain the next line</code></pre>
        <pre><code>const value = 1;</code></pre>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "Hello world",
      "Explain the next line"
    ]);

    renderTranslations([
      { id: segments[0].id, text: "你好世界" },
      { id: segments[1].id, text: "解释下一行" }
    ]);

    const translations = [...document.querySelectorAll<HTMLElement>(".wupage-translation")];
    expect(translations.map((node) => node.dataset.wupageMode)).toEqual(["block", "code-comment"]);
    expect(translations[1].textContent).toBe("// 解释下一行");
  });

  it("matches block translation color to the translated source element", () => {
    document.body.innerHTML = `
      <main>
        <p id="source">Readable text on a dark card.</p>
      </main>
    `;
    stubLayout("rgb(224, 232, 240)");
    const [segment] = collectTextSegments();

    renderTranslations([{ id: segment.id, text: "深色卡片上的可读文本。" }]);

    expect(document.querySelector<HTMLElement>(".wupage-translation")?.style.color)
      .toBe("rgb(224, 232, 240)");
  });

  it("skips code comments when comment translation is disabled", () => {
    document.body.innerHTML = `
      <main>
        <p>Hello world</p>
        <pre id="code"><code>// Explain the next line</code></pre>
      </main>
    `;
    stubLayout();

    expect(collectTextSegments(false).map((segment) => segment.text)).toEqual(["Hello world"]);
    expect(collectParagraphTextSegments(document.querySelector("#code")!, false)).toEqual([]);
  });

  it("clears translated comments", () => {
    document.body.innerHTML = `<pre><code># A comment</code></pre>`;
    stubLayout();
    const [segment] = collectTextSegments();

    renderTranslations([{ id: segment.id, text: "一条注释" }]);
    clearTranslations();

    expect(document.querySelector(".wupage-translation")).toBeNull();
  });

  it("collects text from a single paragraph target", () => {
    document.body.innerHTML = `
      <main>
        <p id="first">First paragraph text</p>
        <p id="second">Second paragraph text</p>
      </main>
    `;
    stubLayout();

    const paragraph = document.querySelector("#second");
    const segments = collectParagraphTextSegments(paragraph!);

    expect(segments.map((segment) => segment.text)).toEqual(["Second paragraph text"]);
  });

  it("finds the nearest translatable paragraph", () => {
    document.body.innerHTML = `
      <main>
        <p id="target"><span>Nested paragraph text</span></p>
      </main>
    `;
    stubLayout();

    const span = document.querySelector("span");

    expect(findTranslatableParagraph(span)?.id).toBe("target");
  });

  it("finds short issue metadata values", () => {
    document.body.innerHTML = `
      <div class="IssueMetadata-module__metadataValue__VpFzn" id="meta">No type</div>
    `;
    stubLayout();

    const meta = document.querySelector("#meta");

    expect(findTranslatableParagraph(meta)?.id).toBe("meta");
  });

  it("groups inline text nodes in the same paragraph", () => {
    document.body.innerHTML = `
      <p>If this mentions <em>any</em> specific language, keep it together.</p>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "If this mentions any specific language, keep it together."
    ]);
  });

  it("keeps inline code text inside readable paragraph segments", () => {
    document.body.innerHTML = `
      <main>
        <p id="doc">
          Create a new
          <a href="struct.WakerRef.html"><code>WakerRef</code></a>
          from a
          <a href="struct.Waker.html"><code>Waker</code></a>
          reference.
        </p>
      </main>
    `;
    stubLayout();

    const code = document.querySelector("code");
    const paragraph = document.querySelector("#doc");
    const segments = collectParagraphTextSegments(paragraph!);

    expect(findTranslatableParagraph(code)?.id).toBe("doc");
    expect(segments.map((segment) => segment.text)).toEqual([
      "Create a new ⟪WUPAGE0⟫ from a ⟪WUPAGE1⟫ reference."
    ]);
  });

  it("protects inline code terms and restores them in translated text", () => {
    document.body.innerHTML = `
      <main>
        <p id="doc">
          A <a href="struct.Waker.html"><code>Waker</code></a>
          that is only valid for a given lifetime.
        </p>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "A ⟪WUPAGE0⟫ that is only valid for a given lifetime."
    ]);

    renderTranslations([
      { id: segments[0].id, text: "一个仅在给定生命周期内有效的 ⟪WUPAGE0⟫。" }
    ]);

    const translation = document.querySelector<HTMLElement>(".wupage-translation");
    const restoredCode = translation?.querySelector("code");
    const restoredLink = translation?.querySelector("a");

    expect(translation?.textContent).toBe("一个仅在给定生命周期内有效的 Waker。");
    expect(restoredCode?.textContent).toBe("Waker");
    expect(restoredLink?.getAttribute("href")).toBe("struct.Waker.html");
  });

  it("restores inline code when a model changes placeholder brackets", () => {
    document.body.innerHTML = `
      <main>
        <p id="doc">
          A <a href="struct.Waker.html"><code>Waker</code></a>
          that is only valid for a given lifetime.
        </p>
      </main>
    `;
    stubLayout();
    const paragraph = document.querySelector("#doc")!;
    const segments = collectParagraphTextSegments(paragraph);

    renderTranslationPlaceholders(segments);
    renderTranslations([
      { id: segments[0].id, text: "一个《WUPAGE0》，它只在给定生命周期内有效。" }
    ]);

    const translation = document.querySelector<HTMLElement>(".wupage-translation");
    expect(translation?.textContent).toBe("一个Waker，它只在给定生命周期内有效。");
    expect(translation?.querySelector("code")?.textContent).toBe("Waker");
    expect(translation?.querySelector("a")?.getAttribute("href")).toBe("struct.Waker.html");
    expect(document.body.textContent).not.toContain("WUPAGE0");
  });

  it("repairs duplicated inline-code placeholder indexes by occurrence order", () => {
    document.body.innerHTML = `
      <main>
        <p id="doc">
          Both <code>tokio::spawn</code> and <code>select!</code> enable running
          concurrent asynchronous operations.
        </p>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "Both ⟪WUPAGE0⟫ and ⟪WUPAGE1⟫ enable running concurrent asynchronous operations."
    ]);
    renderTranslations([{
      id: segments[0].id,
      text: "⟪WUPAGE0⟫ 和 ⟪WUPAGE0⟫ 都能启用并发异步操作。"
    }]);

    const restoredCode = document.querySelectorAll(".wupage-translation code");
    expect([...restoredCode].map((node) => node.textContent)).toEqual([
      "tokio::spawn",
      "select!"
    ]);
    expect(document.querySelector(".wupage-translation")?.textContent)
      .toBe("tokio::spawn 和 select! 都能启用并发异步操作。");
  });

  it("restores distinct inline-code nodes without shifting their source paths", () => {
    document.body.innerHTML = `
      <main>
        <p id="doc">
          Both <code>tokio::spawn</code> and <code>select!</code> enable running
          concurrent asynchronous operations.
        </p>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();
    renderTranslations([{
      id: segments[0].id,
      text: "⟪WUPAGE0⟫ 和 ⟪WUPAGE1⟫ 都能启用并发异步操作。"
    }]);

    expect([...document.querySelectorAll(".wupage-translation code")]
      .map((node) => node.textContent)).toEqual(["tokio::spawn", "select!"]);
  });

  it("groups readable headings with inline code into one segment", () => {
    document.body.innerHTML = `
      <main id="main-content">
        <h3 id="impl">
          impl&lt;'a&gt;
          <a class="trait">Freeze</a>
          for
          <a class="struct">WakerRef</a>
          &lt;'a&gt;
        </h3>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "impl<'a> Freeze for WakerRef <'a>"
    ]);
  });

  it("does not include heading action buttons in grouped heading text", () => {
    document.body.innerHTML = `
      <main>
        <section id="main-content">
          <h1 id="title">
            Struct <span class="struct">WakerRef</span>
            <button id="copy-path" title="Copy item path to clipboard">Copy item path</button>
          </h1>
        </section>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual(["Struct WakerRef"]);

    renderTranslations([{ id: segments[0].id, text: "结构体 WakerRef" }]);
    const translation = document.querySelector(".wupage-translation");

    expect(translation?.textContent).toBe("结构体 WakerRef");
    expect(translation?.parentElement?.id).toBe("title");
    expect(translation?.getAttribute("data-wupage-container")).toBe("heading");
    expect(document.querySelector("#copy-path")?.textContent).toBe("Copy item path");
  });

  it("skips rustdoc breadcrumbs during page translation", () => {
    document.body.innerHTML = `
      <main>
        <section id="main-content">
          <div class="rustdoc-breadcrumbs"><a>futures</a>::<a>task</a></div>
          <h1>Struct <span>WakerRef</span></h1>
          <div class="docblock">
            <p>A Waker that is only valid for a given lifetime.</p>
          </div>
        </section>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "Struct WakerRef",
      "A Waker that is only valid for a given lifetime."
    ]);
  });

  it("skips standalone code syntax fragments", () => {
    document.body.innerHTML = `
      <main>
        <span>::</span>
        <span>for</span>
        <span>&lt;'a&gt;</span>
        <p>Readable sentence.</p>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual(["Readable sentence."]);
  });

  it("does not treat plain code blocks as paragraph targets", () => {
    document.body.innerHTML = `
      <main>
        <section>
          <pre><code>let value = ArcWake::wake_by_ref();</code></pre>
        </section>
      </main>
    `;
    stubLayout();

    const code = document.querySelector("code");

    expect(findTranslatableParagraph(code)).toBeNull();
  });

  it("finds GitHub code comment lines as paragraph targets", () => {
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr>
            <td class="blob-code">
              <span class="react-code-text"><span class="pl-c">// Read a frame from the socket.</span></span>
            </td>
          </tr>
        </tbody>
      </table>
    `;
    stubLayout();

    const comment = document.querySelector(".pl-c");
    const target = findTranslatableParagraph(comment);
    const segments = collectParagraphTextSegments(target!);

    expect(target?.classList.contains("react-code-text")).toBe(true);
    expect(segments.map((segment) => segment.text)).toEqual(["Read a frame from the socket."]);
  });

  it("does not select GitHub code lines without comments", () => {
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr>
            <td class="blob-code">
              <span class="react-code-text"><span>let frame = Frame::parse(&mut buf)?;</span></span>
            </td>
          </tr>
        </tbody>
      </table>
    `;
    stubLayout();

    const code = document.querySelector(".react-code-text span");

    expect(findTranslatableParagraph(code)).toBeNull();
  });

  it("finds rustdoc docblock paragraphs", () => {
    document.body.className = "rustdoc-page";
    document.body.innerHTML = `
      <main>
        <section id="main-content">
          <div class="docblock">
            <p id="doc">A way of waking up a specific task.</p>
          </div>
        </section>
      </main>
    `;
    stubLayout();

    const paragraph = document.querySelector("#doc");

    expect(findTranslatableParagraph(paragraph)?.id).toBe("doc");
  });

  it("translates readable document headings from their anchor links", () => {
    document.body.innerHTML = `
      <main id="main-content">
        <h2 id="blanket-implementations">
          Blanket Implementations<a href="#blanket-implementations" class="anchor">§</a>
        </h2>
      </main>
    `;
    stubLayout();

    const anchor = document.querySelector(".anchor");
    const heading = findTranslatableParagraph(anchor);
    const segments = collectParagraphTextSegments(heading!);

    expect(heading?.id).toBe("blanket-implementations");
    expect(segments.map((segment) => segment.text)).toEqual(["Blanket Implementations"]);
  });

  it("inserts heading translations before heading anchor links", () => {
    document.body.innerHTML = `
      <main id="main-content">
        <h2 id="implementations" class="section-header">
          Implementations<a href="#implementations" class="anchor">§</a>
        </h2>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    renderTranslations([{ id: segments[0].id, text: "实现" }]);

    const heading = document.querySelector("#implementations");
    const translation = heading?.querySelector(".wupage-translation");
    const anchor = heading?.querySelector(".anchor");

    expect(translation?.nextElementSibling).toBe(anchor);
    expect(anchor?.textContent).toBe("§");
  });

  it("translates readable headings inside summary toggles", () => {
    document.body.innerHTML = `
      <main id="main-content">
        <details open>
          <summary>
            <h2 id="deref-methods-Waker" class="section-header">
              <span>Methods from <a class="trait">Deref</a>&lt;Target = <a class="struct">Waker</a>&gt;</span>
              <a href="#deref-methods-Waker" class="anchor">§</a>
            </h2>
          </summary>
        </details>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "Methods from Deref<Target = Waker>"
    ]);
  });

  it("does not select headings inside navigation chrome", () => {
    document.body.innerHTML = `
      <nav>
        <h2 id="nav-title">Repository Navigation</h2>
      </nav>
      <main>
        <p>Readable content</p>
      </main>
    `;
    stubLayout();

    const navHeading = document.querySelector("#nav-title");

    expect(findTranslatableParagraph(navHeading)).toBeNull();
  });

  it("translates rustdoc sidebar navigation as compact inline text", () => {
    document.body.innerHTML = `
      <nav class="sidebar">
        <div class="sidebar-elems">
          <section id="rustdoc-toc">
            <h3><a href="#trait-implementations">Trait Implementations</a></h3>
            <ul>
              <li><a href="#impl-Debug">Debug</a></li>
              <li><a href="#impl-Any-for-T">Any</a></li>
            </ul>
          </section>
        </div>
      </nav>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "Trait Implementations",
      "Debug",
      "Any"
    ]);

    renderTranslations([
      { id: segments[0].id, text: "特性实现方式" },
      { id: segments[1].id, text: "调试" },
      { id: segments[2].id, text: "任何" }
    ]);

    const translations = [...document.querySelectorAll<HTMLElement>(".wupage-translation")];

    expect(translations.map((node) => node.dataset.wupageMode)).toEqual(["inline", "inline", "inline"]);
    expect(document.querySelector("h3 a")?.textContent).toBe("Trait Implementations特性实现方式");
  });

  it("translates semantic navigation without site-specific class names", () => {
    document.body.innerHTML = `
      <header>
        <nav role="navigation">
          <a href="/learn">Learn</a>
          <a href="/api">API Docs</a>
          <a href="/social"><svg></svg></a>
        </nav>
      </header>
      <aside>
        <p>Tokio</p>
        <ul>
          <li><a href="/tutorial">Tutorial</a></li>
          <li><a href="/overview">Overview</a></li>
          <li><a href="/async">Async in depth</a></li>
        </ul>
      </aside>
      <main><p>Readable content</p></main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "Learn",
      "API Docs",
      "Tokio",
      "Tutorial",
      "Overview",
      "Async in depth",
      "Readable content"
    ]);
    renderTranslations(segments.map((segment) => ({
      id: segment.id,
      text: `译：${segment.text}`
    })));
    expect(document.querySelector("aside a")?.textContent).toBe("Tutorial译：Tutorial");
    expect(document.querySelector("aside .wupage-translation")?.getAttribute("data-wupage-mode"))
      .toBe("inline");
  });

  it("translates icon navigation labels and compact controls inside their text hosts", () => {
    document.body.innerHTML = `
      <main>
        <nav aria-label="Secondary Nav">
          <a id="surface-link" href="/surface/deals">
            <svg aria-hidden="true"></svg>
            <span class="label">お得な Surface 特別モデル</span>
          </a>
        </nav>
        <header>
          <a id="accessory-link" href="/accessories">
            <svg aria-hidden="true"></svg>
            <span class="label">その他のアクセサリを見る</span>
          </a>
        </header>
        <section>
          <button id="hint-button" type="button">
            <svg aria-hidden="true"></svg>
            <span class="label">最適な PC を選ぶヒント</span>
          </button>
        </section>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "お得な Surface 特別モデル",
      "その他のアクセサリを見る",
      "最適な PC を選ぶヒント"
    ]);
    renderTranslations([
      { id: segments[0].id, text: "超值 Surface 特别版机型" },
      { id: segments[1].id, text: "查看其他配件" },
      { id: segments[2].id, text: "选择最佳 PC 的技巧" }
    ]);

    expect(document.querySelector("#surface-link > .wupage-translation")).toBeNull();
    expect(document.querySelector("#surface-link .label .wupage-translation")?.textContent)
      .toBe("超值 Surface 特别版机型");
    expect(document.querySelector("#accessory-link .label .wupage-translation")?.textContent)
      .toBe("查看其他配件");
    expect(document.querySelector("#hint-button > .wupage-translation")).toBeNull();
    expect(document.querySelector("#hint-button .label .wupage-translation")?.textContent)
      .toBe("选择最佳 PC 的技巧");
    expect([...document.querySelectorAll<HTMLElement>(".wupage-translation")]
      .map((node) => node.dataset.wupageMode)).toEqual(["inline", "inline", "inline"]);
  });

  it("translates custom-element navigation items exposed through listitem roles", () => {
    document.body.innerHTML = `
      <main>
        <store-ui-shell role="navigation" aria-label="产品类别">
          <store-secondary-nav>
            <store-secondary-nav-item role="listitem" enlabeltext="お得な Surface 特別モデル">
              お得な Surface 特別モデル
              <span slot="secondary-nav-item__description"></span>
              <store-icon slot="secondary-nav-item__asset" aria-hidden="true">
                <img alt="" src="icon.png">
              </store-icon>
            </store-secondary-nav-item>
            <store-secondary-nav-item role="listitem" enlabeltext="Surface を購入">
              Surface を購入
              <span slot="secondary-nav-item__description"></span>
              <store-icon slot="secondary-nav-item__asset" aria-hidden="true">
                <img alt="" src="icon.png">
              </store-icon>
            </store-secondary-nav-item>
          </store-secondary-nav>
        </store-ui-shell>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "お得な Surface 特別モデル",
      "Surface を購入"
    ]);
    renderTranslations([
      { id: segments[0].id, text: "超值 Surface 特别版机型" },
      { id: segments[1].id, text: "购买 Surface" }
    ]);

    const items = document.querySelectorAll("store-secondary-nav-item");
    expect(items[0].querySelector(".wupage-translation")?.textContent)
      .toBe("超值 Surface 特别版机型");
    expect(items[1].querySelector(".wupage-translation")?.textContent)
      .toBe("购买 Surface");
    expect([...document.querySelectorAll<HTMLElement>(".wupage-translation")]
      .map((node) => node.dataset.wupageMode)).toEqual(["inline", "inline"]);
  });

  it("translates visible animated hero text inside an aria-hidden wrapper", () => {
    document.body.innerHTML = `
      <main>
        <section>
          <p class="animated-heading">
            <span aria-hidden="true">
              <div class="animation-line">
                <div class="animation-word">パフォーマンスをお楽しみください</div>
              </div>
            </span>
            <span class="sr-only">パフォーマンスをお楽しみください</span>
          </p>
        </section>
      </main>
    `;
    stubLayout("rgb(255, 255, 255)");

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "パフォーマンスをお楽しみください"
    ]);
    renderTranslations([{
      id: segments[0].id,
      text: "尽享卓越性能"
    }]);

    const translation = document.querySelector<HTMLElement>(".animation-word .wupage-translation");
    expect(translation?.textContent).toBe("尽享卓越性能");
    expect(translation?.style.color).toBe("rgb(255, 255, 255)");
    expect(document.querySelector(".sr-only .wupage-translation")).toBeNull();
  });

  it("keeps decorative aria-hidden text excluded without an accessible duplicate", () => {
    document.body.innerHTML = `
      <main>
        <p>
          Readable content
          <span aria-hidden="true"><span>Decorative badge text</span></span>
        </p>
      </main>
    `;
    stubLayout();

    expect(collectTextSegments().map((segment) => segment.text)).toEqual([
      "Readable content"
    ]);
  });

  it("does not mistake a page-level breadcrumb state class for breadcrumb navigation", () => {
    document.documentElement.className = "layout show-table-of-contents show-breadcrumb";
    document.body.innerHTML = `
      <nav aria-label="Breadcrumb">
        <a href="/docs">Documentation</a>
      </nav>
      <main id="main" role="main" class="layout-body-main">
        <div class="content">
          <h1>Publish a Microsoft Edge extension</h1>
          <p>After you develop and test your extension, it is ready to be published.</p>
        </div>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "Publish a Microsoft Edge extension",
      "After you develop and test your extension, it is ready to be published."
    ]);
  });

  it("does not aggregate nested navigation items into duplicate translations", () => {
    document.body.innerHTML = `
      <aside>
        <ul>
          <li>
            <a href="/tutorial">Tutorial</a>
            <ul>
              <li><a href="/overview">Overview</a></li>
              <li><a href="/setup">Setup</a></li>
              <li><a href="/async"><span>Async in depth</span></a></li>
            </ul>
          </li>
        </ul>
      </aside>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "Tutorial",
      "Overview",
      "Setup",
      "Async in depth"
    ]);
    renderTranslations(segments.map((segment) => ({
      id: segment.id,
      text: `译：${segment.text}`
    })));

    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(4);
    expect(document.querySelector("li > .wupage-translation")).toBeNull();
    expect(document.querySelector("a[href='/async']")?.textContent)
      .toBe("Async in depth译：Async in depth");
  });

  it("does not render translations that are identical to their source text", () => {
    document.body.innerHTML = `
      <nav class="sidebar">
        <div class="sidebar-elems">
          <section id="rustdoc-toc">
            <ul><li><a href="#impl-Freeze">Freeze</a></li></ul>
          </section>
        </div>
      </nav>
    `;
    stubLayout();
    const segments = collectTextSegments();

    renderTranslationPlaceholders(segments);
    renderTranslations([{ id: segments[0].id, text: "  Freeze  " }]);

    expect(document.querySelector("a")?.textContent).toBe("Freeze");
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(hasPageTranslations()).toBe(false);
  });

  it("does not render identical target-level paragraph translations", () => {
    document.body.innerHTML = `<p id="target">WakerRef</p>`;
    stubLayout();
    const target = document.querySelector("#target")!;

    renderTargetPlaceholder(target);
    renderTargetTranslation(target, "WakerRef", "WakerRef");

    expect(target.textContent).toBe("WakerRef");
    expect(hasTranslationsIn(target)).toBe(false);
  });

  it("renders and clears target-level translations", () => {
    document.body.innerHTML = `<h3 id="impl">impl&lt;'a&gt; Freeze for WakerRef&lt;'a&gt;</h3>`;
    stubLayout();
    const target = document.querySelector("#impl")!;

    renderTargetTranslation(target, "实现 Freeze");
    expect(hasTranslationsIn(target)).toBe(true);

    clearTranslationsIn(target);
    expect(hasTranslationsIn(target)).toBe(false);

    renderTargetTranslation(target, "再次实现 Freeze");
    expect(target.querySelector(".wupage-translation")?.textContent).toBe("再次实现 Freeze");
  });

  it("replaces pending translation placeholders with translations", () => {
    document.body.innerHTML = `<p>Hello world</p>`;
    stubLayout();
    const segments = collectTextSegments();

    renderTranslationPlaceholders(segments);
    expect(document.querySelector(".wupage-translation-pending")).not.toBeNull();

    renderTranslations([{ id: segments[0].id, text: "你好世界" }]);
    expect(document.querySelector(".wupage-translation-pending")).toBeNull();
    expect(document.querySelector(".wupage-translation")?.textContent).toBe("你好世界");
  });

  it("translates a structured commit title without appending a second translation to its grid card", () => {
    document.body.innerHTML = `
      <main>
        <ul>
          <li id="commit-card">
            <div class="timeline-marker">●</div>
            <div class="commit-content">
              <h3 id="commit-title">
                <a href="/commit/812f0df">Recover malformed LLM translation batches</a>
              </h3>
              <div class="metadata"><a href="/mr-wuliu">mr-wuliu</a> committed on Jul 18</div>
            </div>
            <div class="commit-sha">812f0df</div>
          </li>
        </ul>
      </main>
    `;
    stubLayout();

    const segments = collectTextSegments();

    expect(segments.map((segment) => segment.text)).toEqual([
      "Recover malformed LLM translation batches"
    ]);

    renderTranslations([{ id: segments[0].id, text: "恢复损坏的 LLM 翻译批次" }]);

    const card = document.querySelector("#commit-card")!;
    expect(card.querySelector(":scope > .wupage-translation")).toBeNull();
    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
    expect(document.querySelector("#commit-title .wupage-translation")?.textContent)
      .toBe("恢复损坏的 LLM 翻译批次");
    expect(document.querySelector(".metadata .wupage-translation")).toBeNull();
  });

  it("removes translation state when pending placeholders are cleared", () => {
    document.body.innerHTML = `<p>Hello <em>world</em></p>`;
    stubLayout();
    const segments = collectTextSegments();

    renderTranslationPlaceholders(segments);
    clearTranslationPlaceholders(segments);

    expect(document.querySelector(".wupage-translation-pending")).toBeNull();
    expect(hasPageTranslations()).toBe(false);
  });

  it("renders target-level pending placeholders", () => {
    document.body.innerHTML = `<h2 id="title">Blanket Implementations</h2>`;
    stubLayout();
    const target = document.querySelector("#title")!;

    renderTargetPlaceholder(target);
    expect(target.querySelector(".wupage-translation-pending")).not.toBeNull();

    renderTargetTranslation(target, "覆盖实现");
    expect(target.querySelector(".wupage-translation-pending")).toBeNull();
    expect(target.querySelector(".wupage-translation")?.textContent).toBe("覆盖实现");
  });
});

function stubLayout(color = ""): void {
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    display: "block",
    visibility: "visible",
    opacity: "1",
    color
  } as CSSStyleDeclaration);

  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const visuallyHidden = this.matches(".sr-only");
    const width = visuallyHidden ? 1 : 600;
    const height = visuallyHidden ? 1 : 20;
    return {
      width,
      height,
      top: 0,
      right: width,
      bottom: height,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect;
  });
}
