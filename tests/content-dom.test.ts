// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslationsIn,
  clearTranslationPlaceholders,
  clearTranslations,
  collectParagraphTextSegments,
  collectAdditionalTextSegmentsProgressive,
  collectTextSegmentsProgressive,
  findTranslatableParagraph,
  hasPageTranslations,
  hasTranslationsIn,
  invalidateStaleSegments,
  mapTranslationTextColor,
  renderTranslationPlaceholders,
  renderTranslations,
  setTranslationDisplayMode,
  takeHiddenScanRoots
} from "../src/content/dom";
import { injectContentStyles } from "../src/content/styles";

describe("host content boundaries", () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])("restores temporarily detached rows before forgetting their source, pending=%s, fragment=%s", async (pending, fragment) => {
    document.body.innerHTML = '<main><section><p>Read <code>guide()</code> carefully.</p><input placeholder="Search rows"></section></main>';
    stubLayout();
    const row = document.querySelector("section")!;
    const original = row.innerHTML;
    const segments = (await collectTextSegmentsProgressive());
    if (pending) renderTranslationPlaceholders(segments);
    else renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), "replace");
    row.remove();
    if (fragment) document.createElement("template").content.append(row);
    clearTranslations();
    document.querySelector("main")!.append(row);
    expect(row.innerHTML).toBe(original);
    expect((await collectAdditionalTextSegmentsProgressive([row])).map(segment => segment.text)).toContain("Read ⟪WUPAGE0⟫ carefully.");
  });
  it("keeps source text when site CSS makes the generated replacement invisible", async () => {
    document.body.innerHTML = "<main><p>Original paragraph.</p></main>";
    stubLayout("", { style: element => element.classList.contains("wupage-translation") ? { display: "none" } : {} });
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: "译文段落。" }], "replace");
    expect(document.querySelector("p")!.textContent).toBe("Original paragraph.");
    expect(document.querySelector(".wupage-translation")).toBeNull();
  });
  it.each(["code", "math", "brand"])("invalidates active replacements when protected %s changes", async kind => {
    const inline = kind === "code" ? '<code id="protected">oldName()</code>'
      : kind === "math" ? '<math id="protected"><mi>alpha</mi></math>'
      : '<span id="protected" translate="no">OldBrand</span>';
    document.body.innerHTML = `<main><p>Read ${inline} before continuing.</p></main>`;
    stubLayout();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: "请先阅读 ⟪WUPAGE0⟫。" }], "replace");
    // Our own visibility class must not make every response invalidate itself.
    expect(invalidateStaleSegments()).toEqual([]);
    const source = document.querySelector("#protected")!;
    (source.querySelector("mi") ?? source).firstChild!.textContent = "UpdatedSource";
    expect(invalidateStaleSegments()).toContain(segment.id);
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(source.classList.contains("wupage-replaced-source")).toBe(false);
    expect(document.querySelector("p")!.textContent).toBe("Read UpdatedSource before continuing.");
  });
  it.each(["", "true", "plaintext-only"])("never collects code comments or controls inside contenteditable=%s", async value => {
    document.body.innerHTML = `<main><p>Published article.</p><div contenteditable="${value}">
      <pre><code>// Unsent private draft</code></pre><button><span>Draft action</span></button>
      </div><div role="textbox"><code># Another private draft</code></div></main>`;
    stubLayout();
    expect((await collectTextSegmentsProgressive()).map(segment => segment.text)).toEqual(["Published article."]);
    expect(collectParagraphTextSegments(document.querySelector("pre")!)).toEqual([]);
  });

  it("preserves opted-out inline content with protected markers across display modes", async () => {
    document.body.innerHTML = `<main><p>Install <span translate="NO">PrivateProduct</span> before proceeding.</p>
      <p class="notranslate">Do not translate this paragraph.</p><input translate="no" placeholder="Private placeholder"></main>`;
    stubLayout();
    const original = document.querySelector("main")!.innerHTML;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(segment => segment.text)).toEqual(["Install ⟪WUPAGE0⟫ before proceeding."]);
    renderTranslations([{ id: segments[0].id, text: "请先安装 ⟪WUPAGE0⟫。" }], "replace");
    expect(document.querySelector(".wupage-translation [translate]")?.textContent).toBe("PrivateProduct");
    for (const mode of ["bilingual", "bilingual-accent", "replace"] as const) {
      setTranslationDisplayMode(mode);
      expect(document.querySelector(".wupage-translation")?.textContent).toBe("请先安装 PrivateProduct。");
    }
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("honors explicit translate=yes within a translate=no region", async () => {
    document.body.innerHTML = `<main translate="NO"><p>Leave this paragraph alone.</p>
      <p translate="yes">Translate this paragraph.</p><p translate="invalid">Inherited exclusion.</p></main>`;
    stubLayout();
    expect((await collectTextSegmentsProgressive()).map(segment => segment.text)).toEqual(["Translate this paragraph."]);
  });

  it("preserves inline MathML while leaving standalone math and SVG graphics alone", async () => {
    document.body.innerHTML = `<main><p>Use <math><mi>alpha</mi><mo>+</mo><mi>beta</mi></math> to continue.</p>
      <math><mi>gamma</mi></math><svg><text>Diagram label</text></svg></main>`;
    stubLayout();
    const original = document.querySelector("main")!.innerHTML;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(segment => segment.text)).toEqual(["Use ⟪WUPAGE0⟫ to continue."]);
    renderTranslations([{ id: segments[0].id, text: "使用 ⟪WUPAGE0⟫ 继续。" }], "replace");
    expect(document.querySelector(".wupage-translation math")?.textContent).toBe("alpha+beta");
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("restores source text when a translated paragraph becomes an editor or opts out", async () => {
    document.body.innerHTML = "<main><p>Published paragraph.</p></main>";
    stubLayout();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: "已发布段落。" }], "replace");
    segment.element.setAttribute("contenteditable", "true");
    expect(invalidateStaleSegments()).toContain(segment.id);
    expect(segment.element.textContent).toBe("Published paragraph.");
    expect((await collectAdditionalTextSegmentsProgressive([segment.element]))).toEqual([]);
  });
});

describe("content DOM translation extraction", () => {
  it("skips protected tags when the document exposes lowercase tag names", async () => {
    document.body.innerHTML = '<p>Readable article paragraph.</p><kbd>Skipped keyboard contents</kbd><samp>Skipped sample output</samp>';
    // XHTML uses lowercase tagName values; retain the test document's browsing context for layout.
    for (const element of document.querySelectorAll("kbd,samp")) Object.defineProperty(element, "tagName", { value: element.localName });
    stubLayout();
    expect((await collectTextSegmentsProgressive(false)).map(segment => segment.text)).toEqual(["Readable article paragraph."]);
  });
  it.each(["videoPlayer", "videoComponent"])("keeps X %s controls out of page and paragraph translation", async (testId) => {
    document.body.innerHTML = `<main><article>
      <div data-testid="tweetText">Watch this portrait video.</div>
      <div data-testid="${testId}"><video>Video playback is unavailable.</video>
        <div role="slider"><span>Seek to a different time</span></div>
        <div role="button"><span>Playback speed</span></div>
        <button><span>Picture in picture</span></button>
        <div><span>Video settings</span></div>
      </div>
    </article></main>`;
    stubLayout();
    const player = document.querySelector(`[data-testid="${testId}"]`)!;
    const original = player.innerHTML;
    expect(collectParagraphTextSegments(player).map(segment => segment.text)).toEqual([]);
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(segment => segment.text)).toEqual(["Watch this portrait video."]);
    renderTranslations(segments.map(({ id }) => ({ id, text: "看看这段竖屏视频。" })));
    expect(player.innerHTML).toBe(original);
  });

  it.each(["ytp-chrome-bottom", "ytp-chrome-top", "vjs-control-bar", "plyr__controls", "jw-controlbar"])
    ("leaves %s playback controls unchanged while translating surrounding prose", async (className) => {
      document.body.innerHTML = `<main><p>A description of the video.</p><div class="${className}">
        <button><span>Playback speed</span></button><span>Video settings</span>
      </div></main>`;
      stubLayout();
      expect((await collectTextSegmentsProgressive()).map(segment => segment.text)).toEqual(["A description of the video."]);
    });

  it('keeps Udemy native captions out of page translation before subtitle translation starts', async () => {
    vi.stubGlobal('location', new URL('https://www.udemy.com/course/fixture/'));
    try {
      document.body.innerHTML = '<main><p>Ordinary course description.</p></main><div data-purpose="media-player-container"><video></video><div class="_caption-container_nnobv_16"><div class="_cue-text_nnobv_32">The native video subtitle should stay unchanged.</div></div></div>';
      stubLayout();
      expect((await collectTextSegmentsProgressive()).map(segment => segment.text)).toEqual(['Ordinary course description.']);
      vi.stubGlobal('location', new URL('https://example.com/article'));
      expect((await collectTextSegmentsProgressive()).map(segment => segment.text)).toContain('The native video subtitle should stay unchanged.');
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["Label", "State", "Counter", "layout-with-breadcrumbs", "withBreadcrumbs"])
    ("does not exclude ordinary prose because of a generic %s class", async (className) => {
      document.body.innerHTML = `<article class="${className}"><p>Ordinary readable article text.</p></article>`;
      stubLayout();
      expect((await collectTextSegmentsProgressive()).map(({ text }) => text)).toEqual(["Ordinary readable article text."]);
    });

  it("keeps semantic headings separate inside a div-based reading region", async () => {
    document.body.innerHTML = `<div role="main"><div><h2>Review <em>request</em></h2><span>Please respond tomorrow.</span></div></div>`;
    stubLayout();
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(({ text }) => text)).toEqual(["Review request", "Please respond tomorrow."]);
    renderTranslations(segments.map(({ id, text }) => ({ id, text: `译文：${text}` })));
    expect(document.querySelector("h2 .wupage-translation")?.textContent).toBe("译文：Review request");
  });

  it.each(["main", "article", "div role='main'"])("groups div-based prose consistently inside %s", async (rootTag) => {
    const closingTag = rootTag.split(" ")[0];
    document.body.innerHTML = `<${rootTag}><div>Please <strong>review</strong> the attached contract.</div></${closingTag}>`;
    stubLayout();
    expect((await collectTextSegmentsProgressive()).map(({ text }) => text)).toEqual(["Please review the attached contract."]);
  });

  it.each(["flex", "inline-flex", "grid", "inline-grid"])("keeps card fields separate in a %s layout", async (display) => {
    document.body.innerHTML = `<article><div id="fields"><span id="title">A modular library for game extensions</span>
      <span id="author">by <a href="/user/developer">developer</a></span></div>
      <div id="summary">Lightweight tools for creating and sharing extensions.</div></article>`;
    stubLayout("", { style: element => ({ display: element.id === "fields" ? display : "block" }) });
    const original = document.querySelector("article")!.innerHTML;
    const authorLink = document.querySelector("#author a");
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(({ text }) => text)).toEqual([
      "A modular library for game extensions", "by", "developer", "Lightweight tools for creating and sharing extensions."
    ]);
    renderTranslations(segments.map(({ id, text }) => ({ id, text: `译文：${text}` })), "replace");
    expect(document.querySelector("#fields > .wupage-translation")).toBeNull();
    expect(document.querySelector("#title .wupage-translation")?.textContent).toBe("译文：A modular library for game extensions");
    expect(document.querySelector("#author > .wupage-translation")?.textContent).toBe("译文：by");
    expect(authorLink?.querySelector(".wupage-translation")?.textContent).toBe("译文：developer");
    expect(authorLink?.getAttribute("href")).toBe("/user/developer");
    for (const mode of ["bilingual", "bilingual-accent", "replace"] as const) {
      setTranslationDisplayMode(mode);
      expect(document.querySelector("#fields > .wupage-translation")).toBeNull();
      expect(document.querySelector("#author a")).toBe(authorLink);
    }
    clearTranslations();
    expect(document.querySelector("article")!.innerHTML).toBe(original);
  });

  it.each(["inline-block", "inline-flex", "block", "grid"])("keeps a self-contained %s list link inside its layout box", async (display) => {
    document.body.innerHTML = `<div id="sidebar"><ul><li><div class="favicon" title="Site"></div><a href="/question">Lower your <em>expectations</em> for this puzzle</a></li></ul>
      <ul><li><a href="/tag/stream" rel="tag">stream</a></li></ul></div>`;
    stubLayout("rgb(0, 102, 204)", { style: element => ({
      display: element.matches("a") ? display : element.matches("li") ? "list-item" : "block"
    }) });
    const original = document.querySelector("#sidebar")!.innerHTML;
    const links = [...document.querySelectorAll("a")];
    const icon = document.querySelector(".favicon");
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(({ text }) => text)).toEqual(["Lower your expectations for this puzzle", "stream"]);
    renderTranslationPlaceholders(segments);
    expect(document.querySelector("li > .wupage-translation")).toBeNull();
    renderTranslations(segments.map(({ id, text }) => ({ id, text: text === "stream" ? "流" : "降低你对这个谜题的期望" })), "replace");
    for (const mode of ["replace", "bilingual", "bilingual-accent", "replace"] as const) {
      setTranslationDisplayMode(mode);
      expect([...document.querySelectorAll("a")]).toEqual(links);
      expect(document.querySelector(".favicon")).toBe(icon);
      expect(document.querySelector("li > .wupage-translation")).toBeNull();
      expect(links.map(link => link.querySelector(".wupage-translation")?.textContent))
        .toEqual(["降低你对这个谜题的期望", "流"]);
      expect(links.map(link => link.getAttribute("href"))).toEqual(["/question", "/tag/stream"]);
      expect(invalidateStaleSegments()).toEqual([]);
    }
    clearTranslations();
    expect(document.querySelector("#sidebar")!.innerHTML).toBe(original);
  });

  it("protects inline code inside div-based prose", async () => {
    document.body.innerHTML = `<article><div>Call <code>fetch()</code> before continuing.</div></article>`;
    stubLayout();
    const [segment] = (await collectTextSegmentsProgressive());
    expect(segment.text).toBe("Call ⟪WUPAGE0⟫ before continuing.");
    renderTranslations([{ id: segment.id, text: "继续之前调用 ⟪WUPAGE0⟫。" }]);
    expect(document.querySelector(".wupage-translation code")?.textContent).toBe("fetch()");
  });

  it("replaces every source fragment in a grouped paragraph, including short words and punctuation", async () => {
    document.body.innerHTML = `<main><div id="prose">Please <strong>review</strong> the attached contract.</div>
      <p id="code">A <strong>small</strong> <code>example()</code>.</p></main>`;
    stubLayout();
    const original = document.querySelector("main")!.textContent;
    const segments = (await collectTextSegmentsProgressive());
    renderTranslations(segments.map(({ id, text }) => ({ id, text: text.includes("WUPAGE") ? "代码 ⟪WUPAGE0⟫。" : "请审阅合同。" })), "replace");
    expect(document.querySelector("#prose")?.textContent).toBe("请审阅合同。");
    expect(document.querySelector("#code .wupage-translation")?.textContent).toBe("代码 example()。");
    expect([...document.querySelector("#code")!.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent).join("")).toBe("");
    // Protected original code remains in the DOM, hidden by its replacement class.
    expect(document.querySelector("#code > code")?.classList.contains("wupage-replaced-source")).toBe(true);
    clearTranslations();
    expect(document.querySelector("main")!.textContent).toBe(original);
  });

  it.each(["", "true", "plaintext-only"])("excludes contenteditable=%s from both standalone and grouped text", async (value) => {
    document.body.innerHTML = `<main><div contenteditable="${value}">Unsent standalone draft.</div>
      <p>Published <em>message</em>.<span contenteditable="${value}">Unsent inline draft.</span></p></main>`;
    stubLayout();
    const texts = (await collectTextSegmentsProgressive()).map(({ text }) => text);
    expect(texts).toEqual(["Published message."]);
  });

  it("switches existing rich text, authored lines, comments and placeholders without losing originals", async () => {
    document.body.innerHTML = `<main>
      <p id="prose">Read the <a href="/guide"><code>guide</code></a> today.</p>
      <div><span id="authored">First authored sentence.<br>Second authored sentence.<br></span></div>
      <div class="react-code-text"><span class="pl-c">// Explain the next line</span></div>
      <input placeholder="Search this site">
    </main>`;
    stubLayout("rgb(34, 34, 34)");
    const original = document.body.textContent;
    const code = document.querySelector("code")!;
    const protectedSource = code.closest("a")!;
    const authored = document.querySelector("#authored")!;
    const breaks = [...authored.querySelectorAll("br")];
    const segments = (await collectTextSegmentsProgressive());
    expect(segments).toHaveLength(4);
    renderTranslations(segments.map((segment) => ({ id: segment.id, text: segment.text.includes("WUPAGE")
      ? "今天阅读 ⟪WUPAGE0⟫。" : "保留的译文" })));
    for (const mode of ["replace", "bilingual-accent", "bilingual", "replace", "bilingual"] as const) {
      setTranslationDisplayMode(mode);
      const outputs = [...document.querySelectorAll<HTMLElement>(".wupage-translation")];
      expect(outputs).toHaveLength(3);
      expect(outputs.every((output) => output.dataset.wupageDisplayMode === mode)).toBe(true);
      expect(outputs.every((output) => output.hasAttribute("aria-hidden") === (mode !== "replace"))).toBe(true);
      expect(protectedSource.classList.contains("wupage-replaced-source")).toBe(mode === "replace");
      expect(authored.classList.contains("wupage-replaced-source")).toBe(mode === "replace");
      expect([...authored.querySelectorAll("br")]).toEqual(breaks);
      expect(document.querySelector(".wupage-translation code")?.textContent).toBe("guide");
      expect(document.querySelector("input")?.placeholder).toBe("保留的译文");
      expect(document.querySelector(".pl-c .wupage-translation")?.textContent).toBe("// 保留的译文");
      expect(invalidateStaleSegments()).toEqual([]);
      if (mode === "bilingual") expect(outputs[0].style.color).toBe("rgb(34, 34, 34)");
    }
    clearTranslations();
    expect(document.body.textContent).toBe(original);
    expect(code.isConnected).toBe(true);
    setTranslationDisplayMode("replace");
    expect(document.querySelector(".wupage-translation")).toBeNull();
  });

  it("does not revive cleared paragraphs or overwrite source updates when switching modes", async () => {
    document.body.innerHTML = `<main><p id="first">First sentence.</p><p id="second">Second sentence.</p></main>`;
    stubLayout();
    const segments = (await collectTextSegmentsProgressive());
    renderTranslations(segments.map((segment) => ({ id: segment.id, text: "已有译文" })), "replace");
    clearTranslationsIn(document.querySelector("#first")!);
    document.querySelector("#second")!.firstChild!.textContent = "New source text supplied by the website.";
    setTranslationDisplayMode("bilingual");
    expect(document.querySelector("#first")?.textContent).toBe("First sentence.");
    expect(document.querySelector("#second")?.textContent).toBe("New source text supplied by the website.");
    expect(document.querySelector(".wupage-translation")).toBeNull();
  });
  it.each(["bilingual", "bilingual-accent"] as const)("keeps authored multiline text inside its column in %s mode", async (mode) => {
    document.body.innerHTML = `<div id="profile"><span id="source">すべての魔法少女たちを救うことを願い<br>「円環の理」と呼ばれる神にも等しい<br>存在となった少女。<br></span></div>`;
    stubLayout("rgb(34, 34, 34)", { style: (element) => element.id === "source"
      ? { display: "inline-block", whiteSpace: "nowrap" } : {} });
    const source = document.querySelector<HTMLElement>("#source")!;
    const original = source.innerHTML;
    const breaks = [...source.querySelectorAll("br")];
    const segments = (await collectTextSegmentsProgressive());
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toContain("願い 「円環の理」");
    renderTranslationPlaceholders(segments);
    expect(source.nextElementSibling?.getAttribute("data-wupage-container")).toBe("authored-lines");
    renderTranslations([{ id: segments[0].id, text: "她希望拯救所有魔法少女，成为被称作圆环之理的存在。" }], mode);
    const output = source.nextElementSibling!;
    expect(output.getAttribute("data-wupage-mode")).toBe("block");
    expect(output.getAttribute("data-wupage-display-mode")).toBe(mode);
    expect(output.parentElement?.id).toBe("profile");
    expect(source.querySelector(".wupage-translation")).toBeNull();
    expect(source.innerHTML).toBe(original);
    clearTranslations();
    expect(source.innerHTML).toBe(original);
    expect([...source.querySelectorAll("br")]).toEqual(breaks);
    expect(document.querySelector(".wupage-translation")).toBeNull();
  });

  it("restores authored line breaks when returning from replacement mode", async () => {
    document.body.innerHTML = `<div><span id="source">First authored sentence with enough text.<br>Second authored sentence on its own line.<br></span></div>`;
    stubLayout();
    const source = document.querySelector<HTMLElement>("#source")!;
    const original = source.innerHTML;
    const originalElement = source.outerHTML;
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: "合并为完整段落的译文。" }], "replace");
    expect(source.classList.contains("wupage-replaced-source")).toBe(true);
    expect(source.nextElementSibling?.textContent).toBe("合并为完整段落的译文。");
    clearTranslations();
    expect(source.classList.contains("wupage-replaced-source")).toBe(false);
    expect(source.innerHTML).toBe(original);
    expect(source.outerHTML).toBe(originalElement);
  });

  it("does not combine separate card fields just because their wrapper contains a line break", async () => {
    document.body.innerHTML = `<div><span>First independent field with enough text.</span><br><p>Another complete paragraph in the same card.</p></div>`;
    stubLayout();
    expect((await collectTextSegmentsProgressive()).map((segment) => segment.text)).toEqual([
      "First independent field with enough text.", "Another complete paragraph in the same card."
    ]);
  });

  it("reveals updated authored text without overwriting the host page's changes", async () => {
    document.body.innerHTML = `<div><span id="source">First authored sentence with enough text.<br>Second authored sentence on its own line.</span></div>`;
    stubLayout();
    const source = document.querySelector<HTMLElement>("#source")!;
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: "旧译文。" }], "replace");
    source.firstChild!.textContent = "The page supplied an updated opening sentence.";
    source.classList.add("host-updated");
    expect(invalidateStaleSegments()).toContain(segment.id);
    expect(source.className).toBe("host-updated");
    expect(source.textContent).toBe("The page supplied an updated opening sentence.Second authored sentence on its own line.");
    expect(source.querySelectorAll("br")).toHaveLength(1);
    expect(document.querySelector(".wupage-translation")).toBeNull();
  });

  describe("host-managed replacement recovery", () => {
    const original = "News and analysis from around the world.";
    const translated = "世界各地のニュースと解説をお届けします。";

    afterEach(() => {
      clearTranslations();
      document.getElementById("wupage-translation-style")?.remove();
    });

    function mount(style = ""): HTMLElement {
      stubLayout();
      vi.mocked(window.getComputedStyle).mockRestore();
      injectContentStyles();
      document.body.innerHTML = `<main><p class="host-wrapper" style="${style}"><span class="host-source" style="display:block">${original}</span></p></main>`;
      return document.querySelector<HTMLElement>(".host-source")!;
    }

    async function recover(source: HTMLElement) {
      const [segment] = (await collectTextSegmentsProgressive());
      expect(segment.text).toBe(original);
      renderTranslations([{ id: segment.id, text: translated }], "replace");
      source.replaceChildren(document.createTextNode(original));
      expect(invalidateStaleSegments([source])).not.toContain(segment.id);
      return segment;
    }

    it("preserves standalone identity without repeated mutations when the host rebuilds its text", async () => {
      const source = mount();
      const segment = await recover(source);
      const output = document.querySelector<HTMLElement>(".wupage-translation")!;
      expect(source.textContent).toBe(original);
      expect(source.contains(output)).toBe(false);
      expect(output.parentElement).toBe(source.parentElement);
      expect(output.textContent).toBe(translated);
      expect(window.getComputedStyle(source).visibility).toBe("hidden");
      expect(window.getComputedStyle(source).alignSelf).toBe("start");
      expect(window.getComputedStyle(output).visibility).toBe("visible");
      source.replaceChildren(document.createTextNode(original.slice(0, 8)), document.createTextNode(original.slice(8)));
      expect(invalidateStaleSegments([source])).not.toContain(segment.id);
      expect((await collectAdditionalTextSegmentsProgressive([document.body]))).toEqual([]);
      expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
      const observer = new MutationObserver(() => {});
      observer.observe(source.parentElement!, { attributes: true, characterData: true, childList: true, subtree: true });
      for (let index = 0; index < 5; index++) expect(invalidateStaleSegments([source])).toEqual([]);
      expect(observer.takeRecords()).toEqual([]);
      observer.disconnect();
    });


    it("restores host classes and inline styles exactly and remembers safe rendering after clearing results", async () => {
      const source = mount("margin: 3px 0");
      const originalHtml = document.querySelector("main")!.innerHTML;
      await recover(source);
      source.classList.add("host-updated");
      setTranslationDisplayMode("bilingual");
      expect(window.getComputedStyle(source).visibility).toBe("visible");
      expect(source.className).toBe("host-source host-updated");
      setTranslationDisplayMode("replace");
      expect(source.textContent).toBe(original);
      expect(window.getComputedStyle(source).visibility).toBe("hidden");
      source.classList.remove("host-updated");
      clearTranslations();
      expect(document.querySelector("main")!.innerHTML).toBe(originalHtml);

      const [fresh] = (await collectTextSegmentsProgressive());
      renderTranslations([{ id: fresh.id, text: "新的目标语言译文。" }], "replace");
      expect(source.textContent).toBe(original);
      expect(window.getComputedStyle(source).visibility).toBe("hidden");
      expect(source.contains(document.querySelector(".wupage-translation"))).toBe(false);
    });


    it("releases a recovered source moved into an unsafe wrapper even when its text nodes are unchanged", async () => {
      const source = mount();
      const oldContainer = source.parentElement!;
      const segment = await recover(source);
      const destination = document.createElement("div");
      destination.innerHTML = "<button>Another control</button>";
      document.querySelector("main")!.append(destination);
      destination.append(source);

      expect(invalidateStaleSegments()).toContain(segment.id);
      expect(document.querySelector(".wupage-translation")).toBeNull();
      expect(source.className).toBe("host-source");
      expect(oldContainer.className).toBe("host-wrapper");
      expect(window.getComputedStyle(source).visibility).toBe("visible");
      expect(destination.querySelector("button")!.textContent).toBe("Another control");
    });

    it("restores the host wrapper when unrelated content or a new layout makes isolation unsafe", async () => {
      const source = mount();
      const segment = await recover(source);
      const container = source.parentElement!;
      container.style.display = "flex";
      container.insertAdjacentHTML("beforeend", "<img alt='' src='new-image.png'>");

      expect(invalidateStaleSegments()).toContain(segment.id);
      expect(container.className).toBe("host-wrapper");
      expect(container.style.display).toBe("flex");
      expect(source.className).toBe("host-source");
      expect(container.querySelector("img")).not.toBeNull();
      expect(document.querySelector(".wupage-translation")).toBeNull();
    });

    it("does not retain a grouped segment's old viewport anchor after moving its source", async () => {
      const source = mount();
      source.replaceChildren(document.createTextNode(original), document.createTextNode("..."));
      const [segment] = (await collectTextSegmentsProgressive());
      expect(segment.element).toBe(source.parentElement);
      renderTranslations([{ id: segment.id, text: translated }], "replace");
      source.replaceChildren(document.createTextNode(original), document.createTextNode("..."));
      expect(invalidateStaleSegments([source])).not.toContain(segment.id);
      const destination = document.createElement("p");
      document.querySelector("main")!.append(destination);
      destination.append(source);

      expect(invalidateStaleSegments()).toContain(segment.id);
      expect(window.getComputedStyle(source).visibility).toBe("visible");
      const [fresh] = (await collectAdditionalTextSegmentsProgressive([document.body]));
      expect(fresh.id).not.toBe(segment.id);
      expect(fresh.element).toBe(destination);
      expect(fresh.text).toBe(original + "...");
    });

    it.each([false, true])("does not expose text hidden by the host after recovery=%s", async (alreadyRecovered) => {
      const source = mount();
      const [segment] = (await collectTextSegmentsProgressive());
      renderTranslations([{ id: segment.id, text: translated }], "replace");
      if (alreadyRecovered) {
        source.replaceChildren(document.createTextNode(original));
        expect(invalidateStaleSegments([source])).not.toContain(segment.id);
      }
      source.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)";
      const hiddenStyle = source.getAttribute("style");
      source.replaceChildren(document.createTextNode(original));
      expect(invalidateStaleSegments([source])).toContain(segment.id);
      expect(document.querySelector(".wupage-translation")).toBeNull();
      expect(source.parentElement!.className).toBe("host-wrapper");
      expect(source.className).toBe("host-source");
      expect(source.getAttribute("style")).toBe(hiddenStyle);
      expect(source.textContent).toBe(original);
    });

    it("does not replace a host's existing grid layout", async () => {
      const display = "grid";
      const source = mount(`display:${display}`);
      const [segment] = (await collectTextSegmentsProgressive());
      renderTranslations([{ id: segment.id, text: translated }], "replace");
      source.replaceChildren(document.createTextNode(original));
      expect(invalidateStaleSegments([source])).toContain(segment.id);
      expect(source.parentElement!.className).toBe("host-wrapper");
      expect(source.className).toBe("host-source");
      expect(source.parentElement!.style.display).toBe(display);
    });

    it.each([
      '<button>Open story</button>',
      ' Other unrelated text.'
    ])("does not cover unrelated wrapper content: %s", async (sibling) => {
      const source = mount();
      source.parentElement!.insertAdjacentHTML("beforeend", sibling);
      const segments = (await collectTextSegmentsProgressive());
      renderTranslations(segments.map(({ id }) => ({ id, text: translated })), "replace");
      source.replaceChildren(document.createTextNode(original));
      invalidateStaleSegments([source]);
      expect(source.parentElement!.classList.contains("wupage-stable-replacement")).toBe(false);
      expect(source.classList.contains("wupage-stable-source")).toBe(false);
      clearTranslations();
      expect(source.parentElement!.querySelector("button")?.outerHTML ?? source.parentElement!.textContent)
        .toContain(sibling.includes("<button") ? "Open story" : "Other unrelated text.");
    });
  });

  it.each(["span", "div"])("keeps translations inside a %s that owns a flex layout column", async (tag) => {
    document.body.innerHTML = `<div id="layout"><${tag} id="column">First sentence in the text column.<br>Second sentence in the text column.</${tag}><img alt="" src="character.png"></div>`;
    stubLayout("rgb(34, 34, 34)", { style: (element) => element.id === "layout" ? { display: "flex" } : {} });
    const column = document.querySelector("#column")!;
    const segments = (await collectTextSegmentsProgressive());
    renderTranslations(segments.map(segment => ({ id: segment.id, text: "文字栏内的译文。" })));
    const outputs = [...document.querySelectorAll(".wupage-translation")];
    expect(outputs).toHaveLength(2);
    expect(outputs.every(output => column.contains(output))).toBe(true);
    expect(document.querySelector("#layout")!.children).toHaveLength(2);
  });

  it("keeps Reddit comment metadata untouched and translations in the body slot", async () => {
    document.body.innerHTML = `
      <main role="main">
        <shreddit-comment>
          <div slot="commentMeta"><a>Narthesia</a><span>8h ago</span><span>P1S + AMS</span></div>
          <div slot="comment"><p>Scroll down for <em>30 seconds</em> and you will find someone like you.</p></div>
        </shreddit-comment>
      </main>`;
    stubLayout();
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map((segment) => segment.text)).toEqual([
      "Scroll down for 30 seconds and you will find someone like you."
    ]);
    renderTranslationPlaceholders(segments);
    expect(document.querySelector("[slot='commentMeta'] .wupage-translation")).toBeNull();
    renderTranslations([{ id: segments[0].id, text: "往下滑动30秒，你会找到和你一样的人。" }]);
    expect(document.querySelector("[slot='comment'] .wupage-translation")?.textContent)
      .toBe("往下滑动30秒，你会找到和你一样的人。");
    expect(document.querySelector("shreddit-comment > .wupage-translation")).toBeNull();
  });

  it("keeps grouped translations and placeholders inside a named slot", async () => {
    document.body.innerHTML = `<custom-card><p slot="body">Hello <em>world</em></p></custom-card>`;
    stubLayout();
    const segments = (await collectTextSegmentsProgressive());
    renderTranslationPlaceholders(segments);
    expect(document.querySelector("p[slot='body'] .wupage-translation-pending")).not.toBeNull();
    renderTranslations([{ id: segments[0].id, text: "你好世界" }]);
    expect(document.querySelector("p[slot='body'] .wupage-translation")?.textContent).toBe("你好世界");
    expect(document.querySelector("custom-card > .wupage-translation")).toBeNull();
    clearTranslations();
    expect(document.querySelector("p")?.textContent).toBe("Hello world");
  });

  afterEach(() => {
    clearTranslations();
    vi.restoreAllMocks();
    document.documentElement.className = "";
    document.body.innerHTML = "";
  });

  it("translates code comments without translating code", async () => {
    document.body.innerHTML = `
      <main>
        <p>Hello world</p>
        <pre><code>// Explain the next line</code></pre>
        <pre><code>const value = 1;</code></pre>
      </main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());

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

  it("matches block translation color to the translated source element", async () => {
    document.body.innerHTML = `
      <main>
        <p id="source">Readable text on a dark card.</p>
      </main>
    `;
    stubLayout("rgb(224, 232, 240)");
    const [segment] = (await collectTextSegmentsProgressive());

    renderTranslations([{ id: segment.id, text: "深色卡片上的可读文本。" }]);

    expect(document.querySelector<HTMLElement>(".wupage-translation")?.style.color)
      .toBe("rgb(224, 232, 240)");
  });

  it("replaces source text visually and restores it when translations are cleared", async () => {
    document.body.innerHTML = `<main><p id="source">Read the <code>guide</code> today.</p></main>`;
    stubLayout("rgb(34, 34, 34)");
    const [segment] = (await collectTextSegmentsProgressive());

    renderTranslations([{ id: segment.id, text: "今天阅读 ⟪WUPAGE0⟫。" }], "replace");

    const source = document.querySelector("#source")!;
    const translation = source.querySelector<HTMLElement>(".wupage-translation")!;
    expect(translation.dataset.wupageDisplayMode).toBe("replace");
    expect(translation.textContent).toBe("今天阅读 guide。");
    expect(source.querySelector("code:not(.wupage-translation code)")?.classList)
      .toContain("wupage-replaced-source");

    clearTranslations();
    expect(source.textContent).toBe("Read the guide today.");
    expect(source.querySelector(".wupage-replaced-source")).toBeNull();
  });

  it("visibly distinguishes accent colors while maintaining light and dark contrast", () => {
    const lightMapped = mapTranslationTextColor("rgb(32, 38, 42)", "rgb(255, 255, 255)");
    const darkMapped = mapTranslationTextColor("rgb(232, 238, 240)", "rgb(12, 18, 22)");

    expect(lightMapped).toMatch(/^rgb\(/);
    expect(darkMapped).toMatch(/^rgb\(/);
    expect(lightMapped).not.toBe("rgb(32, 38, 42)");
    expect(darkMapped).not.toBe("rgb(232, 238, 240)");
    expect(cssContrast(lightMapped!, "rgb(255, 255, 255)")).toBeGreaterThanOrEqual(4.49);
    expect(cssContrast(darkMapped!, "rgb(12, 18, 22)")).toBeGreaterThanOrEqual(4.49);
    expect(mapTranslationTextColor("rgb(15, 118, 110)", "rgb(255, 255, 255)"))
      .not.toBe("rgb(15, 118, 110)");
    expect(mapTranslationTextColor("rgb(94, 234, 212)", "rgb(0, 0, 0)"))
      .not.toBe("rgb(94, 234, 212)");
  });

  it.each([
    ["rgb(0, 0, 0)", "rgb(255, 255, 255)"],
    ["rgb(32, 38, 42)", "rgb(255, 255, 255)"],
    ["rgb(15, 118, 110)", "rgb(255, 255, 255)"],
    ["rgb(255, 255, 255)", "rgb(12, 18, 22)"],
    ["rgb(94, 234, 212)", "rgb(12, 18, 22)"]
  ])("keeps a visible color difference from %s against %s", (source, background) => {
    const mapped = mapTranslationTextColor(source, background)!;
    const channels = (color: string) => color.match(/\d+/g)!.map(Number);
    const sourceChannels = channels(source);
    const difference = Math.hypot(...channels(mapped).map((value, index) => value - sourceChannels[index]));
    expect(difference).toBeGreaterThanOrEqual(48);
    expect(cssContrast(mapped, background)).toBeGreaterThanOrEqual(4.5);
  });

  it("protects translation colors from host color and inherited text-fill rules", async () => {
    document.body.innerHTML = "<main><p>Readable text with a fixed website color.</p></main>";
    stubLayout("rgb(32, 38, 42)");
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: "使用不同颜色显示的译文。" }], "bilingual-accent");
    const output = document.querySelector<HTMLElement>(".wupage-translation")!;
    expect(output.style.getPropertyPriority("color")).toBe("important");
    expect(output.style.getPropertyValue("-webkit-text-fill-color")).toBe("currentcolor");
    expect(output.style.getPropertyPriority("-webkit-text-fill-color")).toBe("important");
    setTranslationDisplayMode("bilingual");
    expect(document.querySelector<HTMLElement>(".wupage-translation")!.style.color).toBe("rgb(32, 38, 42)");
  });

  it("translates x.com post paragraphs at blank lines and preserves single line breaks", async () => {
    document.body.innerHTML = `
      <main>
        <article>
          <div id="post-text" data-testid="tweetText" lang="en">
            <span>Operation Cheespeek: Phase 1 Complete </span><img alt="😂"><span>\n\nOpenCode Go subscribers now get $30 of usage for $10\n\nPhase 2:\nAI watches\n↓\nAI adjusts.</span>
          </div>
        </article>
      </main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());

    expect(segments.map((segment) => segment.text)).toEqual([
      "Operation Cheespeek: Phase 1 Complete",
      "OpenCode Go subscribers now get $30 of usage for $10",
      "Phase 2:\nAI watches\n↓\nAI adjusts."
    ]);

    renderTranslations([
      { id: segments[0].id, text: "奶酪行动：第一阶段完成" },
      { id: segments[1].id, text: "订阅用户现在能以 10 美元获得 30 美元用量" },
      { id: segments[2].id, text: "第二阶段：\nAI 观察\n↓\nAI 调整。" }
    ]);

    const postText = document.querySelector("#post-text")!;
    const emoji = document.querySelector("img")!;
    const translations = [...document.querySelectorAll<HTMLElement>(".wupage-translation")];
    expect(translations).toHaveLength(3);
    expect(postText.contains(translations[0])).toBe(true);
    expect(postText.contains(translations[1])).toBe(true);
    expect(emoji.compareDocumentPosition(translations[0]) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(translations[2].previousElementSibling).toBe(postText);
    expect(translations.map((translation) => translation.dataset.wupageMode))
      .toEqual(["block", "block", "block"]);
    expect(translations[2].dataset.wupagePreserveWhitespace).toBe("true");
    expect(translations[2].textContent).toBe("第二阶段：\nAI 观察\n↓\nAI 调整。");
  });

  it("uses consecutive br elements as x.com post paragraph boundaries", async () => {
    document.body.innerHTML = `
      <main><article><div id="post-text" data-testid="tweetText">
        <span>First paragraph.</span><br><br><span>Second paragraph.</span>
      </div></article></main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map((segment) => segment.text)).toEqual([
      "First paragraph.",
      "Second paragraph."
    ]);

    renderTranslations([
      { id: segments[0].id, text: "第一段。" },
      { id: segments[1].id, text: "第二段。" }
    ]);

    const postText = document.querySelector("#post-text")!;
    const translations = [...document.querySelectorAll<HTMLElement>(".wupage-translation")];
    expect(postText.contains(translations[0])).toBe(true);
    expect(translations[0].nextElementSibling?.tagName).toBe("BR");
    expect(translations[1].previousElementSibling).toBe(postText);
  });

  it("keeps a single-node x.com post translation outside its text container", async () => {
    document.body.innerHTML = `
      <main><article><div id="post-text" data-testid="tweetText">A short standalone post.</div></article></main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segments[0].id, text: "一条简短的独立推文。" }]);

    const postText = document.querySelector("#post-text")!;
    const translation = document.querySelector<HTMLElement>(".wupage-translation")!;
    expect(segments).toHaveLength(1);
    expect(postText.contains(translation)).toBe(false);
    expect(translation.previousElementSibling).toBe(postText);
    expect(translation.dataset.wupageMode).toBe("block");
  });

  it("translates Partner Center form labels, choices, and placeholders", async () => {
    document.body.innerHTML = `
      <aside>
        <nav><a href="#overview">Extension overview</a><a href="#packages">Packages</a></nav>
      </aside>
      <main>
        <h1>Submit your extension</h1>
        <div class="field">
          <label id="credentials-label">
            Does a tester need credentials, accounts, or any other info to test your extension?
            <a href="#learn">Learn More</a>
          </label>
          <input id="no-credentials" type="radio" name="credentials">
          <label for="no-credentials">No, testers can access and test all functionality without any additional info</label>
          <input id="yes-credentials" type="radio" name="credentials">
          <label for="yes-credentials">Yes, I need to provide credentials, accounts, or other info for testers</label>
        </div>
        <label for="certification-notes">Notes for certification (less than 2,000 characters)</label>
        <div role="status">Certification notes must be provided with every submission.</div>
        <textarea id="certification-notes"
          placeholder="e.g. Username: demo@example.com / Password: Test1234"></textarea>
      </main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());
    const translationBySource = new Map([
      ["Extension overview", "扩展概览"],
      ["Packages", "程序包"],
      ["Submit your extension", "提交扩展"],
      ["Does a tester need credentials, accounts, or any other info to test your extension? Learn More", "测试扩展是否需要凭据或其他信息？了解更多"],
      ["No, testers can access and test all functionality without any additional info", "否，测试人员无需额外信息"],
      ["Yes, I need to provide credentials, accounts, or other info for testers", "是，我需要提供测试信息"],
      ["Notes for certification (less than 2,000 characters)", "认证说明（少于 2,000 个字符）"],
      ["Certification notes must be provided with every submission.", "每次提交都必须提供认证说明。"],
      ["e.g. Username: demo@example.com / Password: Test1234", "例如：用户名 demo@example.com / 密码 Test1234"]
    ]);

    expect(segments.map((segment) => segment.text)).toEqual(
      expect.arrayContaining([...translationBySource.keys()])
    );
    renderTranslations(segments.map((segment) => ({
      id: segment.id,
      text: translationBySource.get(segment.text) ?? `译：${segment.text}`
    })));

    const question = document.querySelector<HTMLElement>("#credentials-label")!;
    const noChoice = document.querySelector<HTMLElement>("label[for='no-credentials']")!;
    const notes = document.querySelector<HTMLTextAreaElement>("#certification-notes")!;
    expect(question.nextElementSibling?.classList.contains("wupage-translation")).toBe(true);
    expect(question.nextElementSibling?.textContent).toBe("测试扩展是否需要凭据或其他信息？了解更多");
    expect(noChoice.querySelector(".wupage-translation")?.textContent).toBe("否，测试人员无需额外信息");
    expect(notes.placeholder).toBe("例如：用户名 demo@example.com / 密码 Test1234");

    clearTranslations();
    expect(notes.placeholder).toBe("e.g. Username: demo@example.com / Password: Test1234");
  });

  it("skips code comments when comment translation is disabled", async () => {
    document.body.innerHTML = `
      <main>
        <p>Hello world</p>
        <pre id="code"><code>// Explain the next line</code></pre>
      </main>
    `;
    stubLayout();

    expect((await collectTextSegmentsProgressive(false)).map((segment) => segment.text)).toEqual(["Hello world"]);
    expect(collectParagraphTextSegments(document.querySelector("#code")!, false)).toEqual([]);
  });

  it("clears translated comments", async () => {
    document.body.innerHTML = `<pre><code># A comment</code></pre>`;
    stubLayout();
    const [segment] = (await collectTextSegmentsProgressive());

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

  it("groups inline text nodes in the same paragraph", async () => {
    document.body.innerHTML = `
      <p>If this mentions <em>any</em> specific language, keep it together.</p>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());

    expect(segments.map((segment) => segment.text)).toEqual([
      "If this mentions any specific language, keep it together."
    ]);
  });

  it("renders ordinary list prose consistently with and without paragraph wrappers", async () => {
    document.body.innerHTML = `<main><ul id="updates">
      <li>New version <a href="/release">released</a> with improved training.</li>
      <li><p>Previous version <a href="/previous">released</a> with improved training.</p></li>
      <li>Support for older versions has been retired.</li>
      <li><a href="/install">Download and install the latest version</a></li>
    </ul><nav><ul><li><a href="/guide">User guide</a></li></ul></nav>
    <table><tbody><tr><td>Training status</td></tr></tbody></table></main>`;
    stubLayout("", { style: (element) => ({
      display: element.matches("li") ? "list-item" : element.matches("a") ? "inline"
        : element.matches("td") ? "table-cell" : "block"
    }) });
    const original = document.querySelector("main")!.innerHTML;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments).toHaveLength(6);
    renderTranslationPlaceholders(segments);
    expect([...document.querySelectorAll<HTMLElement>("#updates .wupage-translation-pending")]
      .map((output) => output.dataset.wupageMode)).toEqual(["block", "block", "block", "block"]);
    renderTranslations(segments.map(({ id, text }) => ({ id, text: `译文：${text}` })));
    for (const mode of ["replace", "bilingual-accent", "bilingual"] as const) {
      setTranslationDisplayMode(mode);
      const outputs = [...document.querySelectorAll<HTMLElement>("#updates .wupage-translation")];
      expect(outputs).toHaveLength(4);
      expect(outputs.map((output) => output.dataset.wupageMode)).toEqual(["block", "block", "block", "block"]);
      expect(outputs.every((output) => output.closest("li")?.parentElement?.id === "updates")).toBe(true);
      if (mode !== "replace") expect(outputs.every((output) => output.parentElement?.matches("li"))).toBe(true);
      expect(document.querySelector("#updates a .wupage-translation")).toBeNull();
      expect(document.querySelector<HTMLElement>("nav .wupage-translation")?.dataset.wupageMode).toBe("inline");
      expect(document.querySelector<HTMLElement>("td .wupage-translation")?.dataset.wupageMode).toBe("inline");
    }
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("excludes unrendered descendants from a grouped paragraph", async () => {
    document.body.innerHTML = `
      <p>Visible beginning <span id="hidden">invisible middle</span><em>visible ending.</em></p>
    `;
    stubLayout("", {
      style: (element) => element.id === "hidden" ? { display: "none" } : {}
    });

    expect((await collectTextSegmentsProgressive()).map((segment) => segment.text)).toEqual([
      "Visible beginning visible ending."
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

  it("protects inline code terms and restores them in translated text", async () => {
    document.body.innerHTML = `
      <main>
        <p id="doc">
          A <a href="struct.Waker.html"><code>Waker</code></a>
          that is only valid for a given lifetime.
        </p>
      </main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());

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

  it.each(["bilingual", "bilingual-accent", "replace"] as const)("keeps source code visible instead of guessing duplicated IDs in %s mode", async (mode) => {
    document.body.innerHTML = `
      <main>
        <p id="doc">
          Both <code>tokio::spawn</code> and <code>select!</code> enable running
          concurrent asynchronous operations.
        </p>
      </main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());

    expect(segments.map((segment) => segment.text)).toEqual([
      "Both ⟪WUPAGE0⟫ and ⟪WUPAGE1⟫ enable running concurrent asynchronous operations."
    ]);
    const original = document.querySelector("#doc")!.textContent;
    renderTranslationPlaceholders(segments);
    renderTranslations([{
      id: segments[0].id,
      text: "⟪WUPAGE0⟫ 和 ⟪WUPAGE0⟫ 都能启用并发异步操作。"
    }], mode);

    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(document.querySelector("#doc")!.textContent).toBe(original);
    setTranslationDisplayMode("replace");
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(document.querySelector("#doc")!.textContent).toBe(original);
  });

  it("restores distinct inline-code nodes without shifting their source paths", async () => {
    document.body.innerHTML = `
      <main>
        <p id="doc">
          Both <code>tokio::spawn</code> and <code>select!</code> enable running
          concurrent asynchronous operations.
        </p>
      </main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());
    renderTranslations([{
      id: segments[0].id,
      text: "⟪WUPAGE0⟫ 和 ⟪WUPAGE1⟫ 都能启用并发异步操作。"
    }]);

    expect([...document.querySelectorAll(".wupage-translation code")]
      .map((node) => node.textContent)).toEqual(["tokio::spawn", "select!"]);
  });

  it("preserves reordered code identities and normalizes nested token brackets", async () => {
    document.body.innerHTML = `<main><p>Compare <code>first()</code> with <code>second()</code>.</p></main>`;
    stubLayout();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: "{{wupage 1}} 与 《WUPAGE0》 相比。" }], "replace");
    expect([...document.querySelectorAll(".wupage-translation code")].map((node) => node.textContent))
      .toEqual(["second()", "first()"]);
    expect(document.body.textContent).not.toContain("WUPAGE");
    clearTranslations();
    expect(document.querySelector("p")?.textContent).toBe("Compare first() with second().");
  });

  it.each([undefined, "", "syntax-symbol"])("restores the original protected node class attribute %s", async (className) => {
    document.body.innerHTML = `<main><p>Call <code>example()</code> today.</p></main>`;
    const code = document.querySelector("code")!;
    if (className !== undefined) code.setAttribute("class", className);
    const original = document.querySelector("main")!.innerHTML;
    stubLayout();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: "今天调用 ⟪WUPAGE0⟫。" }], "replace");
    setTranslationDisplayMode("bilingual");
    expect(code.getAttribute("class")).toBe(className ?? null);
    setTranslationDisplayMode("replace");
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("groups readable headings with inline code into one segment", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

    expect(segments.map((segment) => segment.text)).toEqual([
      "impl<'a> Freeze for WakerRef <'a>"
    ]);
  });

  it("does not include heading action buttons in grouped heading text", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

    expect(segments.map((segment) => segment.text)).toEqual(["Struct WakerRef"]);

    renderTranslations([{ id: segments[0].id, text: "结构体 WakerRef" }]);
    const translation = document.querySelector(".wupage-translation");

    expect(translation?.textContent).toBe("结构体 WakerRef");
    expect(translation?.parentElement?.id).toBe("title");
    expect(translation?.getAttribute("data-wupage-container")).toBe("heading");
    expect(document.querySelector("#copy-path")?.textContent).toBe("Copy item path");
  });

  it("skips rustdoc breadcrumbs during page translation", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

    expect(segments.map((segment) => segment.text)).toEqual([
      "Struct WakerRef",
      "A Waker that is only valid for a given lifetime."
    ]);
  });

  it("skips standalone code syntax fragments", async () => {
    document.body.innerHTML = `
      <main>
        <span>::</span>
        <span>for</span>
        <span>&lt;'a&gt;</span>
        <p>Readable sentence.</p>
      </main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());

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

  it("keeps heading anchor links before the translated title row", async () => {
    document.body.innerHTML = `
      <main id="main-content">
        <h2 id="implementations" class="section-header">
          Implementations<a href="#implementations" class="anchor">§</a>
        </h2>
      </main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());

    renderTranslations([{ id: segments[0].id, text: "实现" }]);

    const heading = document.querySelector("#implementations");
    const translation = heading?.querySelector(".wupage-translation");
    const anchor = heading?.querySelector(".anchor");

    expect(anchor?.nextElementSibling).toBe(translation);
    expect(anchor?.textContent).toBe("§");
  });

  it("translates readable headings inside summary toggles", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

    expect(segments.map((segment) => segment.text)).toEqual([
      "Methods from Deref<Target = Waker>"
    ]);
  });

  it("translates plain FAQ questions inside readable summary toggles", async () => {
    document.body.innerHTML = `
      <main>
        <details>
          <summary><strong>🖼️ Do you support slicer projects with multiple build plates?</strong></summary>
          No. Only single build plate setups are supported.
        </details>
      </main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());

    expect(segments.map((segment) => segment.text)).toEqual([
      "🖼️ Do you support slicer projects with multiple build plates?",
      "No. Only single build plate setups are supported."
    ]);

    const summarySegment = segments.find((segment) => segment.element.matches("summary"));
    renderTranslations([{ id: summarySegment!.id, text: "🖼️ 是否支持包含多个构建板的切片项目？" }]);

    const summary = document.querySelector("summary");
    const translation = summary?.querySelector(":scope > .wupage-translation");
    expect(translation?.textContent).toBe("🖼️ 是否支持包含多个构建板的切片项目？");
    expect(translation?.getAttribute("data-wupage-mode")).toBe("inline");
  });

  it("keeps summary controls outside readable content untranslated", async () => {
    document.body.innerHTML = `
      <details>
        <summary>Application menu</summary>
        <nav>Menu contents</nav>
      </details>
      <main><p>Readable content</p></main>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());

    expect(segments.map((segment) => segment.text)).toEqual(["Readable content"]);
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

  it("translates rustdoc sidebar navigation as compact inline text", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

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

  it("translates semantic navigation without site-specific class names", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

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

  it("translates document text in article headers, asides, captions, tables, and footers", async () => {
    document.body.innerHTML = `
      <header>
        <h1>How Symmetric Are the Insides of a Go Network?</h1>
        <p>A study of KataGo's neural networks · July 2026</p>
        <nav><a href="#findings">Findings</a></nav>
      </header>
      <div class="strip">
        <aside class="remark">
          <p>The experiments and research in this article were performed almost entirely by Claude Code.</p>
        </aside>
        <h2>The networks</h2>
        <figure>
          <figcaption>Figure 1. The same position in <em>eight orientations</em>.</figcaption>
        </figure>
        <table>
          <caption>Networks in this study</caption>
          <tbody><tr><th>architecture</th><td>convolutional network</td></tr></tbody>
        </table>
        <footer><p>All reports and analysis scripts live alongside this article.</p></footer>
      </div>
    `;
    stubLayout();

    const segments = (await collectTextSegmentsProgressive());
    const texts = segments.map((segment) => segment.text);

    expect(texts).toEqual(expect.arrayContaining([
      "How Symmetric Are the Insides of a Go Network?",
      "A study of KataGo's neural networks · July 2026",
      "The experiments and research in this article were performed almost entirely by Claude Code.",
      "The networks",
      "Figure 1. The same position in eight orientations.",
      "Networks in this study",
      "architecture",
      "convolutional network",
      "All reports and analysis scripts live alongside this article."
    ]));
  });

  it("translates icon navigation labels and compact controls inside their text hosts", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

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

  it.each(["grid", "flex", "inline-grid", "inline-flex"])("keeps split control labels inside their %s layout cell", async (display) => {
    document.body.innerHTML = `<main><button aria-label="Optimized for: Balance" aria-expanded="false">
      <span class="content"><span class="label"></span></span>
      <span class="action"><svg aria-hidden="true"></svg></span>
    </button></main>`;
    const label = document.querySelector(".label")!;
    const nodes = [document.createTextNode("Optimized for: "), document.createTextNode("Balance")];
    label.append(...nodes);
    stubLayout("", { style: element => ({ display: element.matches(".content") ? display : "inline" }) });
    const original = document.querySelector("main")!.innerHTML;
    const [segment, ...other] = (await collectTextSegmentsProgressive());
    expect(other).toHaveLength(0);
    expect(segment.text).toBe("Optimized for: Balance");
    expect(segment.element).toBe(label);
    renderTranslations([{ id: segment.id, text: "针对：平衡进行了优化" }], "replace");
    for (const mode of ["replace", "bilingual", "bilingual-accent"] as const) {
      setTranslationDisplayMode(mode);
      expect(document.querySelector(".content > .wupage-translation")).toBeNull();
      expect(label.querySelector(".wupage-translation")?.textContent).toBe("针对：平衡进行了优化");
      expect(document.querySelector("button")?.getAttribute("aria-label")).toBe("Optimized for: Balance");
    }
    clearTranslations();
    expect([...label.childNodes]).toEqual(nodes);
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it.each(["menuitemradio", "menuitemcheckbox", "option"])("keeps %s labels and descriptions in separate layout fields", async (role) => {
    document.body.innerHTML = `<main role="main"><ul><li role="${role}" aria-describedby="description" tabindex="0">
      <div class="layout"><svg aria-hidden="true"></svg><div class="fields">
        <span id="label"><span>Auto</span></span>
        <span id="description"><span>Optimized for Balance</span></span>
      </div></div></li></ul></main>`;
    stubLayout("", { style: element => ({ display: element.matches(".layout") ? "grid" : element.matches(".fields") ? "flex" : "block" }) });
    const original = document.querySelector("main")!.innerHTML;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(({ text }) => text)).toEqual(["Auto", "Optimized for Balance"]);
    renderTranslations(segments.map(({ id }, index) => ({ id, text: ["自动", "针对平衡进行了优化"][index] })), "replace");
    for (const mode of ["replace", "bilingual", "bilingual-accent"] as const) {
      setTranslationDisplayMode(mode);
      expect(document.querySelector("li > .wupage-translation, .layout > .wupage-translation, .fields > .wupage-translation")).toBeNull();
      expect(document.querySelector("#label .wupage-translation")?.textContent).toBe("自动");
      expect(document.querySelector("#description .wupage-translation")?.textContent).toBe("针对平衡进行了优化");
    }
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it.each(["/", "Ctrl K"])("preserves the %s shortcut when replacing a control label", async (shortcut) => {
    document.body.innerHTML = `<header><button><svg aria-hidden="true"></svg>
      <span id="search-label">Type <kbd>${shortcut}</kbd> to search</span></button></header>`;
    stubLayout();
    const original = document.querySelector("header")!.innerHTML;
    const key = document.querySelector("kbd")!;
    const [segment, ...other] = (await collectTextSegmentsProgressive());
    expect(other).toHaveLength(0);
    expect(segment.text).toBe("Type ⟪WUPAGE0⟫ to search");
    renderTranslations([{ id: segment.id, text: "输入 ⟪WUPAGE0⟫ 进行搜索" }], "replace");
    expect(key.classList.contains("wupage-replaced-source")).toBe(true);
    expect(document.querySelector("#search-label .wupage-translation kbd")?.textContent).toBe(shortcut);
    expect(document.querySelector("button > .wupage-translation")).toBeNull();
    setTranslationDisplayMode("bilingual");
    expect(key.classList.contains("wupage-replaced-source")).toBe(false);
    setTranslationDisplayMode("replace");
    expect(key.classList.contains("wupage-replaced-source")).toBe(true);
    clearTranslations();
    expect(document.querySelector("kbd")).toBe(key);
    expect(document.querySelector("header")!.innerHTML).toBe(original);
  });

  it("translates custom-element navigation items exposed through listitem roles", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

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

  it("translates visible animated hero text inside an aria-hidden wrapper", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

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

  it("keeps decorative aria-hidden text excluded without an accessible duplicate", async () => {
    document.body.innerHTML = `
      <main>
        <p>
          Readable content
          <span aria-hidden="true"><span>Decorative badge text</span></span>
        </p>
      </main>
    `;
    stubLayout();

    expect((await collectTextSegmentsProgressive()).map((segment) => segment.text)).toEqual([
      "Readable content"
    ]);
  });

  it("does not mistake a page-level breadcrumb state class for breadcrumb navigation", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

    expect(segments.map((segment) => segment.text)).toEqual([
      "Publish a Microsoft Edge extension",
      "After you develop and test your extension, it is ready to be published."
    ]);
  });

  it("does not aggregate nested navigation items into duplicate translations", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

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

  it("does not render translations that are identical to their source text", async () => {
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
    const segments = (await collectTextSegmentsProgressive());

    renderTranslationPlaceholders(segments);
    renderTranslations([{ id: segments[0].id, text: "  Freeze  " }]);

    expect(document.querySelector("a")?.textContent).toBe("Freeze");
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(hasPageTranslations()).toBe(false);
  });

  it("does not render identical paragraph translations", () => {
    document.body.innerHTML = `<p id="target">WakerRef</p>`;
    stubLayout();
    const target = document.querySelector("#target")!;

    const segments = collectParagraphTextSegments(target);
    renderTranslationPlaceholders(segments);
    renderTranslations(segments.map(segment => ({ id: segment.id, text: segment.text })));

    expect(target.textContent).toBe("WakerRef");
    expect(hasTranslationsIn(target)).toBe(false);
  });

  it("renders, clears and retranslates paragraphs", () => {
    document.body.innerHTML = `<h3 id="impl">impl&lt;'a&gt; Freeze for WakerRef&lt;'a&gt;</h3>`;
    stubLayout();
    const target = document.querySelector("#impl")!;

    renderTranslations(collectParagraphTextSegments(target).map(segment => ({ id: segment.id, text: "实现 Freeze" })));
    expect(hasTranslationsIn(target)).toBe(true);

    clearTranslationsIn(target);
    expect(hasTranslationsIn(target)).toBe(false);

    renderTranslations(collectParagraphTextSegments(target).map(segment => ({ id: segment.id, text: "再次实现 Freeze" })));
    expect(target.querySelector(".wupage-translation")?.textContent).toBe("再次实现 Freeze");
  });

  it("replaces pending translation placeholders with translations", async () => {
    document.body.innerHTML = `<p>Hello world</p>`;
    stubLayout();
    const segments = (await collectTextSegmentsProgressive());

    renderTranslationPlaceholders(segments);
    expect(document.querySelector(".wupage-translation-pending")).not.toBeNull();

    renderTranslations([{ id: segments[0].id, text: "你好世界" }]);
    expect(document.querySelector(".wupage-translation-pending")).toBeNull();
    expect(document.querySelector(".wupage-translation")?.textContent).toBe("你好世界");
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)("replaces repeated segment results without appending translations in %s mode", async mode => {
    document.body.innerHTML = `<main><p>Standalone sentence.</p><p>Read <em>this guide</em> carefully.</p>
      <div><span>First authored sentence.<br>Second authored sentence.<br></span></div></main>`;
    stubLayout();
    const original = document.querySelector("main")!.innerHTML;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments).toHaveLength(3);
    renderTranslationPlaceholders(segments);
    for (const text of ["初次译文", "更新后的译文", "更新后的译文"]) {
      renderTranslations(segments.map(segment => ({ id: segment.id, text })), mode);
      const outputs = [...document.querySelectorAll(".wupage-translation")];
      expect(outputs).toHaveLength(3);
      expect(outputs.every(output => output.textContent === text)).toBe(true);
      expect(document.querySelector(".wupage-translation-pending")).toBeNull();
    }
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("translates a structured commit title without appending a second translation to its grid card", async () => {
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

    const segments = (await collectTextSegmentsProgressive());

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

  it("removes translation state when pending placeholders are cleared", async () => {
    document.body.innerHTML = `<p>Hello <em>world</em></p>`;
    stubLayout();
    const segments = (await collectTextSegmentsProgressive());

    renderTranslationPlaceholders(segments);
    clearTranslationPlaceholders(segments);

    expect(document.querySelector(".wupage-translation-pending")).toBeNull();
    expect(hasPageTranslations()).toBe(false);
  });

  it("renders paragraph pending placeholders", () => {
    document.body.innerHTML = `<h2 id="title">Blanket Implementations</h2>`;
    stubLayout();
    const target = document.querySelector("#title")!;

    const segments = collectParagraphTextSegments(target);
    renderTranslationPlaceholders(segments);
    expect(target.querySelector(".wupage-translation-pending")).not.toBeNull();

    renderTranslations(segments.map(segment => ({ id: segment.id, text: "覆盖实现" })));
    expect(target.querySelector(".wupage-translation-pending")).toBeNull();
    expect(target.querySelector(".wupage-translation")?.textContent).toBe("覆盖实现");
  });

  it("drops every hidden inline run from a grouped block", async () => {
    document.body.innerHTML = `<main><p id="prose">Visible prose <span class="hidden">HIDDEN_ONE</span> continues with <em>readable words</em><span class="hidden">HIDDEN_TWO</span> at the end.</p></main>`;
    stubLayout("", { style: (element) => ({ display: element.closest(".hidden") ? "none" : "block" }) });

    const [segment] = (await collectTextSegmentsProgressive());

    expect(segment.text).toContain("Visible prose");
    expect(segment.text).toContain("readable words");
    expect(segment.text).toContain("at the end.");
    expect(segment.text).not.toContain("HIDDEN_ONE");
    expect(segment.text).not.toContain("HIDDEN_TWO");
  });

  it.each([399, 400, 401, 1000])("keeps every one of %i covered paragraphs reachable", async (count) => {
    document.body.innerHTML = `<main>${Array.from({ length: count }, (_, index) =>
      `<p>Covered paragraph ${index}.</p>`).join("")}</main>`;
    stubLayout("", { style: element => ({ backgroundColor: element.id === "overlay" ? "rgb(255, 255, 255)" : "transparent" }) });
    const overlay = document.createElement("div");
    overlay.id = "overlay";
    document.body.append(overlay);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => overlay });
    try {
      expect((await collectAdditionalTextSegmentsProgressive([document.body]))).toEqual([]);

      const seen = new Set<Element>();
      let rounds = 0;
      let firstBatch = 0;
      while (seen.size < count && rounds < count) {
        const roots = takeHiddenScanRoots();
        if (!roots.length) break;
        if (!rounds) firstBatch = roots.length;
        rounds += 1;
        for (const root of roots) {
          seen.add(root);
          // The overlay still covers the text, so this rescan re-queues the root.
          (await collectAdditionalTextSegmentsProgressive([root]));
        }
      }

      expect(firstBatch).toBe(Math.min(count, 400));
      expect(seen.size).toBe(count);
      expect(rounds).toBeLessThanOrEqual(Math.ceil(count / 400) + 1);
    } finally {
      delete (document as unknown as { elementFromPoint?: Document["elementFromPoint"] }).elementFromPoint;
    }
  });

  it.each([400, 128])("reaches overflow while earlier candidates keep re-queuing with a batch of %i", async (batchSize) => {
    document.body.innerHTML = `<main>${Array.from({ length: 4097 }, (_, index) =>
      `<p id="pending-${index}">Hidden paragraph number ${index}.</p>`).join("")}</main><div id="overlay"></div>`;
    stubLayout("", { style: (element) => ({
      display: element.matches("p") && element.id !== "pending-4096" ? "none" : "block",
      backgroundColor: element.id === "overlay" ? "rgb(255, 255, 255)" : "transparent"
    }) });
    const overlay = document.querySelector("#overlay")!;
    let covered = true;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true, value: () => covered ? overlay : document.body
    });
    try {
      expect((await collectAdditionalTextSegmentsProgressive([document.body]))).toEqual([]);
      const tail = document.querySelector("#pending-4096")!;
      let retriedTail = false;
      const roundLimit = Math.ceil(4096 / batchSize) + 1;
      // A retry of the ordinary candidates puts them back in the queue. The
      // overflow must still get a turn, including when it also stays hidden.
      for (let round = 0; round < roundLimit && !retriedTail; round++) {
        const roots = takeHiddenScanRoots(batchSize);
        expect(roots.length).toBeLessThanOrEqual(batchSize);
        for (const root of roots) {
          if (root.contains(tail)) retriedTail = true;
          expect((await collectAdditionalTextSegmentsProgressive([root]))).toEqual([]);
        }
      }
      expect(retriedTail).toBe(true);

      covered = false;
      const texts: string[] = [];
      for (let round = 0; round < roundLimit && !texts.length; round++) {
        const roots = takeHiddenScanRoots(batchSize);
        expect(roots.length).toBeLessThanOrEqual(batchSize);
        for (const root of roots) texts.push(...(await collectAdditionalTextSegmentsProgressive([root])).map(segment => segment.text));
      }
      expect(texts).toEqual(["Hidden paragraph number 4096."]);
    } finally {
      delete (document as unknown as { elementFromPoint?: Document["elementFromPoint"] }).elementFromPoint;
    }
  }, 20000);

  it("keeps container text that a split progressive scan would skip", async () => {
    const sections = Array.from({ length: 61 }, (_, index) =>
      `<section><p>Readable section number ${index}.</p></section>`).join("");
    document.body.innerHTML = `<article>Introduction before the sections.${sections}</article>`;
    stubLayout();

    const texts = (await collectTextSegmentsProgressive()).map((segment) => segment.text);

    expect(texts).toContain("Introduction before the sections.");
    expect(texts).toContain("Readable section number 60.");
    expect(texts).toHaveLength(62);
  });
});

function stubLayout(
  color = "",
  options: {
    style?: (element: Element) => Partial<CSSStyleDeclaration>;
  } = {}
): void {
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
    display: "block",
    visibility: "visible",
    opacity: "1",
    color,
    ...options.style?.(element)
  }) as CSSStyleDeclaration);

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

function cssContrast(left: string, right: string): number {
  const luminance = (value: string): number => {
    const channels = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
