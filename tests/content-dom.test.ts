// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslationsIn,
  clearTranslations,
  collectParagraphTextSegments,
  collectTextSegments,
  findTranslatableParagraph,
  hasTranslationsIn,
  renderTargetPlaceholder,
  renderTargetTranslation,
  renderTranslationPlaceholders,
  renderTranslations
} from "../src/content/dom";

describe("content DOM translation extraction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

function stubLayout(): void {
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    display: "block",
    visibility: "visible",
    opacity: "1"
  } as CSSStyleDeclaration);

  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 600,
    height: 20,
    top: 0,
    right: 600,
    bottom: 20,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect);
}
