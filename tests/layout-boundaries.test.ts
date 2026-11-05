// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations,
  collectTextSegmentsProgressive,
  renderTranslationPlaceholders,
  renderTranslations,
  setTranslationDisplayMode
} from "../src/content/dom";

describe("translation layout boundaries", () => {
  beforeEach(() => {
    const inheritedWhiteSpace = (element: Element): string => {
      const value = (element as HTMLElement).style.whiteSpace;
      if (value && value !== "inherit") return value;
      return element.parentElement ? inheritedWhiteSpace(element.parentElement) : "normal";
    };
    vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({
      display: (element as HTMLElement).style.display || "block", visibility: "visible", opacity: "1", color: "rgb(0, 0, 0)",
      whiteSpace: inheritedWhiteSpace(element),
      overflow: (element as HTMLElement).style.overflow,
      overflowX: (element as HTMLElement).style.overflowX,
      textOverflow: (element as HTMLElement).style.textOverflow
    }) as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 600, height: 20, top: 0, right: 600, bottom: 20, left: 0, x: 0, y: 0, toJSON: () => ({})
    });
  });
  afterEach(() => { clearTranslations(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

  it.each(["td", "div"])("keeps inbox subject and preview inside their original clipped %s line", async tag => {
    const content = `<div class="slot"><div id="clip" style="overflow:hidden;white-space:nowrap"><div>
      <span id="subject">Release <strong>workflow failed</strong></span><span id="preview"> - <span>Review the publishing status.</span></span>
      </div></div></div>`;
    document.body.innerHTML = tag === "td" ? `<main><table><tbody><tr><td>${content}</td></tr></tbody></table></main>`
      : `<main><div role="row"><div role="gridcell">${content}</div></div></main>`;
    const original = document.querySelector("main")!.innerHTML;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(s => s.text)).toEqual(["Release workflow failed", "- Review the publishing status."]);
    renderTranslationPlaceholders(segments);
    expect(document.querySelector('.slot > .wupage-translation,td > .wupage-translation')).toBeNull();
    for (const pending of document.querySelectorAll('.wupage-translation-pending')) {
      expect(getComputedStyle(pending).whiteSpace).toBe("nowrap");
    }
    renderTranslations(segments.map(({id,text}) => ({id,text:`译文：${text}`})), "replace");
    for (const mode of ["replace", "bilingual", "bilingual-accent"] as const) {
      setTranslationDisplayMode(mode);
      expect(document.querySelector('#subject .wupage-translation')?.textContent).toBe("译文：Release workflow failed");
      expect(document.querySelector('#preview .wupage-translation')?.textContent).toBe("译文：- Review the publishing status.");
      expect(document.querySelector('.slot > .wupage-translation,td > .wupage-translation,tr > .wupage-translation')).toBeNull();
      for (const result of document.querySelectorAll('.wupage-translation')) {
        expect(getComputedStyle(result).whiteSpace).toBe("nowrap");
      }
    }
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("keeps a clipped rich sentence together when it has authored text around emphasis", async () => {
    document.body.innerHTML = `<main><div style="overflow:hidden;white-space:nowrap">A complete <em>rich sentence</em> in one line.</div></main>`;
    expect((await collectTextSegmentsProgressive()).map(s => s.text)).toEqual(["A complete rich sentence in one line."]);
  });

  it("keeps unclipped compact timestamps on one line across pending and display modes", async () => {
    document.body.innerHTML = `<main><table><tbody><tr><td style="white-space:nowrap"><span>3:08 AM</span></td></tr></tbody></table></main>`;
    const original = document.querySelector("main")!.innerHTML;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(["3:08 AM"]);
    renderTranslationPlaceholders(segments);
    expect(getComputedStyle(document.querySelector('.wupage-translation-pending')!).whiteSpace).toBe("nowrap");
    renderTranslations(segments.map(({ id }) => ({ id, text: "凌晨 3:08" })), "bilingual");
    for (const mode of ["bilingual", "bilingual-accent", "replace", "bilingual"] as const) {
      setTranslationDisplayMode(mode);
      const result = document.querySelector('.wupage-translation')!;
      expect(result.textContent).toBe("凌晨 3:08");
      expect(getComputedStyle(result).whiteSpace).toBe("nowrap");
    }
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("allows full paragraph translations to wrap even when their source inherits nowrap", async () => {
    document.body.innerHTML = `<article style="white-space:nowrap"><p>A complete email body paragraph that must remain fully readable.</p></article>`;
    const original = document.querySelector("article")!.innerHTML;
    const segments = await collectTextSegmentsProgressive();
    renderTranslationPlaceholders(segments);
    expect(getComputedStyle(document.querySelector('.wupage-translation-pending')!).whiteSpace).toBe("normal");
    renderTranslations(segments.map(({ id }) => ({ id, text: "邮件正文的长段落应该完整显示并正常换行。" })), "bilingual");
    for (const mode of ["bilingual", "bilingual-accent", "replace"] as const) {
      setTranslationDisplayMode(mode);
      expect(getComputedStyle(document.querySelector('.wupage-translation')!).whiteSpace).toBe("normal");
    }
    clearTranslations();
    expect(document.querySelector("article")!.innerHTML).toBe(original);
  });

  it("lets short flowing prose use a longer wrapping translation despite inline placement", async () => {
    document.body.innerHTML = `<main><div style="width:180px;white-space:nowrap"><span>Short source.</span></div></main>`;
    const original = document.querySelector("main")!.innerHTML;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(["Short source."]);
    renderTranslationPlaceholders(segments);
    const pending = document.querySelector('.wupage-translation-pending')!;
    expect(pending.getAttribute("data-wupage-mode")).toBe("inline");
    expect(getComputedStyle(pending).whiteSpace).toBe("normal");
    renderTranslations(segments.map(({ id }) => ({ id, text: "A longer translation that needs to wrap inside its narrow prose container." })), "bilingual");
    for (const mode of ["bilingual", "bilingual-accent", "replace"] as const) {
      setTranslationDisplayMode(mode);
      const result = document.querySelector('.wupage-translation')!;
      expect(result.getAttribute("data-wupage-mode")).toBe("inline");
      expect(getComputedStyle(result).whiteSpace).toBe("normal");
    }
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("does not mistake an unclipped grid timestamp's leaf div for flowing prose", async () => {
    document.body.innerHTML = `<main><div role="gridcell" style="white-space:nowrap"><div><span>3:08 AM</span></div></div></main>`;
    const segments = await collectTextSegmentsProgressive();
    renderTranslationPlaceholders(segments);
    expect(getComputedStyle(document.querySelector('.wupage-translation-pending')!).whiteSpace).toBe("nowrap");
    renderTranslations(segments.map(({ id }) => ({ id, text: "凌晨 3:08" })), "bilingual");
    for (const mode of ["bilingual", "bilingual-accent", "replace"] as const) {
      setTranslationDisplayMode(mode);
      expect(getComputedStyle(document.querySelector('.wupage-translation')!).whiteSpace).toBe("nowrap");
    }
  });

  it.each(["flex", "grid"])("keeps sidebar labels in their text cell beside font icons in %s links", async display => {
    document.body.innerHTML = `<aside><ul><li><a id="nav-item" href="/overview" style="display:${display}">
      <span id="nav-label">Extension <strong>overview</strong></span><i aria-hidden="true" class="status-icon">done</i>
    </a></li></ul></aside>`;
    const original = document.querySelector("aside")!.innerHTML;
    const link = document.querySelector("a")!, icon = document.querySelector("i")!;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(segment => segment.text)).toEqual(["Extension overview"]);
    renderTranslations(segments.map(({ id }) => ({ id, text: "扩展概述" })), "replace");
    for (const mode of ["replace", "bilingual", "bilingual-accent"] as const) {
      setTranslationDisplayMode(mode);
      expect(document.querySelector("a > .wupage-translation")).toBeNull();
      expect(document.querySelector("#nav-label .wupage-translation")?.textContent).toBe("扩展概述");
      expect(icon.textContent).toBe("done");
      expect(document.querySelector("a")).toBe(link);
      expect(link.getAttribute("href")).toBe("/overview");
    }
    clearTranslations();
    expect(document.querySelector("aside")!.innerHTML).toBe(original);
  });

  it.each(["flex", "grid"])("keeps card fields out of their ancestor %s list layout", async display => {
    document.body.innerHTML = `<main><ol><li id="slot" style="display:${display}"><div id="card" style="display:flex">
      <div id="fields" style="display:flex;flex-direction:column"><div style="display:flex">
        <span id="title"><a href="/project">An interesting <em>project title</em></a></span><span>Public</span></div>
        <p id="description">A complete <strong>project description</strong> with useful details.</p>
        <p id="metadata">A separate metadata field.</p>
      </div></div></li></ol></main>`;
    const original = document.querySelector("main")!.innerHTML;
    const nodes = [...document.querySelectorAll("#slot,#card,#fields,a,p")];
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.filter(s => s.text.includes("project description")).map(s => s.text)).toEqual([
      "A complete project description with useful details."
    ]);
    expect(segments.some(s => s.text.includes("project title") && s.text.includes("project description"))).toBe(false);
    expect(segments.find(s => s.text.includes("project title"))?.text).toBe("An interesting project title");
    renderTranslationPlaceholders(segments);
    expect(document.querySelector('#slot > .wupage-translation,#card > .wupage-translation,#fields > .wupage-translation')).toBeNull();
    renderTranslations(segments.map(({ id, text }) => ({ id, text: `译文：${text}` })));
    for (const mode of ["bilingual", "bilingual-accent", "replace"] as const) {
      setTranslationDisplayMode(mode);
      expect(document.querySelector('#slot > .wupage-translation,#card > .wupage-translation,#fields > .wupage-translation')).toBeNull();
      expect(document.querySelector('#title .wupage-translation')?.textContent).toBe("译文：An interesting project title");
      expect(document.querySelector('#description .wupage-translation')?.textContent).toBe("译文：A complete project description with useful details.");
    }
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
    expect(nodes.every(node => node.isConnected)).toBe(true);
  });

  it.each(["flex", "grid"])("separates rich text cells inside a semantic paragraph using %s", async display => {
    document.body.innerHTML = `<p style="display:${display}"><span id="first">First <em>independent field</em>.</span>
      <span id="second">Second <strong>independent field</strong>.</span></p>`;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(s => s.text)).toEqual(["First independent field.", "Second independent field."]);
    renderTranslations(segments.map(({ id, text }) => ({ id, text: `译文：${text}` })));
    expect(document.querySelector('p > .wupage-translation')).toBeNull();
    expect(document.querySelector('#first .wupage-translation')?.textContent).toBe("译文：First independent field.");
    expect(document.querySelector('#second .wupage-translation')?.textContent).toBe("译文：Second independent field.");
  });

  it("does not extract an independently owned compact control into its parent paragraph a second time", async () => {
    document.body.innerHTML = `<p>Useful community information. <a href="/stats"><svg></svg><span>Star count</span></a></p>`;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.filter(s => s.text.includes("Star count"))).toHaveLength(1);
    expect(segments.some(s => s.text.includes("Useful") && s.text.includes("Star count"))).toBe(false);
    expect(segments.map(s => s.text)).toEqual(["Useful community information.", "Star count"]);
  });

  it("does not aggregate a nested list or paragraphs into the outer list item", async () => {
    document.body.innerHTML = `<ul><li>Opening prose for the list.<p>A complete inner paragraph.</p>
      <ul><li>A nested list paragraph.</li></ul></li></ul>`;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.filter(s => s.text.includes("inner paragraph"))).toHaveLength(1);
    expect(segments.filter(s => s.text.includes("nested list"))).toHaveLength(1);
    expect(segments.some(s => s.text.includes("Opening") && s.text.includes("inner paragraph"))).toBe(false);
  });

  it("keeps ordinary rich list prose together", async () => {
    document.body.innerHTML = `<ul><li>One complete sentence with <em>inline emphasis</em> and a <a href="/ref">reference link</a>.</li></ul>`;
    expect((await collectTextSegmentsProgressive()).map(s => s.text)).toEqual(["One complete sentence with inline emphasis and a reference link."]);
  });

  it.each(["td", "blockquote"])("keeps lists inside their own items within a %s layout", async tag => {
    const content = `<p>Introduction before the feature list.</p><ul>
      <li id="feature-one">Open <em>archive architecture</em>
      <li id="feature-two">Strong encryption support for archive data
      </ul><p>Descriptions remain separate.</p>
      <table><tr><td id="method">Method label</td><td id="description">Compression method description</td></tr></table>
      <ul><li id="feature-three">Small memory requirements during archive extraction</li></ul><p>Concluding paragraph.</p>`;
    document.body.innerHTML = tag === "td" ? `<table><tr><td id="layout">${content}</td></tr></table>`
      : `<blockquote id="layout">${content}</blockquote>`;
    const original = document.body.innerHTML;
    const segments = await collectTextSegmentsProgressive();
    const items = [...document.querySelectorAll("li")];
    const sources = items.map(item => item.textContent!.trim());
    expect(segments.filter(segment => items.includes(segment.element as HTMLLIElement)).map(segment => segment.text)).toEqual(sources);
    expect(segments.some(segment => segment.element.id === "layout")).toBe(false);
    expect(segments.find(segment => segment.element.id === "description")?.text).toBe("Compression method description");

    for (const mode of ["replace", "bilingual", "bilingual-accent"] as const) {
      renderTranslationPlaceholders(segments);
      renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), mode);
      items.forEach((item, index) => expect(item.querySelector(".wupage-translation")?.textContent).toBe(`译文：${sources[index]}`));
      expect(document.querySelector("#layout > .wupage-translation")).toBeNull();
      expect(document.querySelector("#description .wupage-translation")?.textContent).toBe("译文：Compression method description");
      setTranslationDisplayMode(mode === "replace" ? "bilingual" : "replace");
      items.forEach(item => expect(item.textContent?.trim()).not.toBe(""));
    }
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it("keeps inner paragraphs, nested list items and table cells separate inside a table-layout list", async () => {
    document.body.innerHTML = `<table><tr><td id="layout"><ul><li>Opening list prose.
      <p id="inner-paragraph">An independent paragraph inside the list item.</p>
      <ul><li id="nested-item">A nested feature description.</li></ul>
      <table><tr><td id="inner-cell">A table cell inside the list item.</td></tr></table>
      </li></ul></td></tr></table>`;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.find(segment => segment.element.id === "inner-paragraph")?.text)
      .toBe("An independent paragraph inside the list item.");
    expect(segments.find(segment => segment.element.id === "nested-item")?.text).toBe("A nested feature description.");
    expect(segments.find(segment => segment.element.id === "inner-cell")?.text).toBe("A table cell inside the list item.");
    expect(segments.some(segment => segment.element.id === "layout")).toBe(false);
    expect(segments.some(segment => segment.text.includes("Opening") && segment.text.includes("independent"))).toBe(false);
  });

  it("keeps inline-block language and statistics fields in their original boxes", async () => {
    document.body.innerHTML = `<p><span id="language" style="display:inline-block"><i></i><span>Shell</span></span>
      <a id="stars" style="display:inline-block" href="/stars"><svg></svg>160</a>
      <a id="forks" style="display:inline-block" href="/forks"><svg></svg>7</a></p>`;
    const original = document.body.innerHTML;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(s => s.text)).toEqual(["Shell"]);
    renderTranslations(segments.map(({ id }) => ({ id, text: "译文标签" })), "replace");
    expect(document.querySelector('#language .wupage-translation')?.textContent).toBe("译文标签");
    expect(document.querySelector('#stars')?.textContent).toBe("160");
    expect(document.querySelector('#forks')?.textContent).toBe("7");
    expect(document.querySelector('p > .wupage-translation')).toBeNull();
    clearTranslations(); expect(document.body.innerHTML).toBe(original);
  });

  it("keeps numbers in prose while excluding standalone counts and dates", async () => {
    document.body.innerHTML = `<p>There are <strong>160</strong> stars and <em>7</em> forks.</p><p>160</p><p>2026-10-29</p>`;
    expect((await collectTextSegmentsProgressive()).map(s => s.text)).toEqual(["There are 160 stars and 7 forks."]);
  });

  it("continues protecting inline-block code as part of its surrounding sentence", async () => {
    document.body.innerHTML = `<p>Call <code style="display:inline-block">example()</code> to continue.</p>`;
    expect((await collectTextSegmentsProgressive()).map(s => s.text)).toEqual(["Call ⟪WUPAGE0⟫ to continue."]);
  });
});
