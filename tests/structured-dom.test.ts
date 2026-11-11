// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations, collectAdditionalTextSegmentsProgressive, collectTextSegmentsProgressive,
  invalidateStaleSegments, renderTranslationPlaceholders, renderTranslations, setTranslationDisplayMode
} from "../src/content/dom";
import { componentShadowRoot } from "../src/content/dom-roots";

beforeEach(() => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({
    display: computedStyle(element).display || "inline", visibility: "visible", opacity: "1", color: "rgb(0, 0, 0)"
  }) as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 300, height: 25, top: 0, right: 300, bottom: 25, left: 0
  } as DOMRect);
});
afterEach(() => { clearTranslations(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bound translation writes", () => {
  it.each(["x-action", "arbitrary-control", "renamed-widget"])("isolates unknown %s components without requiring button semantics", async tag => {
    document.body.innerHTML = `<main><div style="display:flex"><${tag} class="anything">Update</${tag}><${tag}>Cancel submission</${tag}></div></main>`;
    const hosts = [...document.querySelectorAll(tag)];
    const nodes = hosts.map(host => host.firstChild!);
    const original = document.querySelector("main")!.innerHTML;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.requestText)).toEqual(["Update", "Cancel submission"]);
    renderTranslations(segments.map(({ id }, index) => ({ id, text: ["更新", "取消提交"][index] })), "replace");
    expect(hosts.map(host => host.textContent)).toEqual(["更新", "取消提交"]);
    expect(hosts.map(host => host.firstChild)).toEqual(nodes);
    expect(document.querySelector(".wupage-translation")).toBeNull();
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("never absorbs an unknown component into surrounding paragraph prose", async () => {
    document.body.innerHTML = '<p>Before the action. <unknown-action>Update</unknown-action> After the action.</p>';
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(["Before the action.", "Update", "After the action."]);
    expect(segments.map(segment => segment.requestText)).toEqual(segments.map(segment => segment.text));
    renderTranslations(segments.map(({ id, text }) => ({ id, text: text === "Update" ? "更新" : "前后说明。" })), "replace");
    expect(document.querySelector("unknown-action")!.textContent).toBe("更新");
    expect(document.querySelectorAll("p > [data-wupage-prose-source] .wupage-translation")).toHaveLength(2);
    expect(document.querySelector("unknown-action")!.previousElementSibling?.textContent).toBe("前后说明。");
  });

  it("does not merge unknown component fields through an outer layout table", async () => {
    document.body.innerHTML = '<main><table><tr><td><unknown-card><span id="first">First action</span><p>Independent body text.</p><span id="second">Second action</span></unknown-card></td></tr></table></main>';
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text).sort()).toEqual(["First action", "Independent body text.", "Second action"].sort());
    segments.forEach(segment => { void segment.requestText; });
    renderTranslations(segments.map(({ id, text }) => ({ id, text: `译文：${text}` })), "replace");
    expect(document.querySelector("#first")!.textContent).toBe("译文：First action");
    expect(document.querySelector("#second")!.textContent).toBe("译文：Second action");
    expect(document.querySelector("unknown-card > .wupage-translation")).toBeNull();
  });

  it("discards a response when an intact component is moved to another owner", async () => {
    document.body.innerHTML = '<main><div id="old"><custom-action>Update</custom-action></div><div id="new"></div></main>';
    const [segment] = await collectTextSegmentsProgressive();
    expect(segment.requestText).toBe("Update");
    document.querySelector("#new")!.append(document.querySelector("custom-action")!);
    expect(renderTranslations([{ id: segment.id, text: "旧译文" }], "replace")).toEqual([]);
    expect(document.querySelector("custom-action")!.textContent).toBe("Update");
    expect(invalidateStaleSegments()).toContain(segment.id);
    const [updated] = await collectAdditionalTextSegmentsProgressive([document.querySelector("#new")!]);
    expect(updated.id).not.toBe(segment.id);
  });

  it("rejects missing, repeated and invented result bindings without hiding originals", async () => {
    document.body.innerHTML = '<p>Keep this paragraph visible.</p>';
    const [segment] = await collectTextSegmentsProgressive();
    renderTranslationPlaceholders([segment]);
    for (const rows of [[{ id: segment.id, text: "" }], [{ id: "unknown", text: "坏译文" }],
      [{ id: segment.id, text: "甲" }, { id: segment.id, text: "乙" }]]) {
      expect(renderTranslations(rows, "replace")).toEqual([]);
      expect(document.querySelector("p")!.textContent).toBe("Keep this paragraph visible.");
    }
    expect(renderTranslations([{ id: segment.id, text: "Invented ⟪WUPAGE90⟫" }], "replace")).toEqual([]);
  });
});

describe("inline structure plans", () => {
  it("keeps protected code inside its original format scope and reuses the code node", async () => {
    document.body.innerHTML = '<p>Read <strong>the <code id="code">guide()</code> carefully</strong> now.</p>';
    const code = document.querySelector("code")!, original = document.body.innerHTML;
    const [segment] = await collectTextSegmentsProgressive();
    expect(segment.requestText).toBe("Read ⟪WUPAGEOPEN0⟫the ⟪WUPAGE0⟫ carefully⟪WUPAGECLOSE0⟫ now.");
    const text = "阅读⟪WUPAGEOPEN0⟫⟪WUPAGE0⟫指南⟪WUPAGECLOSE0⟫。";
    expect(renderTranslations([{ id: segment.id, text }], "replace")).toEqual([segment.id]);
    expect(document.querySelector("code")).toBe(code);
    expect(code.textContent).toBe("guide()");
    expect(document.querySelector("p")!.textContent).toBe("阅读guide()指南。");
    expect(renderTranslations([{ id: segment.id, text: "⟪WUPAGE0⟫阅读⟪WUPAGEOPEN0⟫指南⟪WUPAGECLOSE0⟫。" }], "replace")).toEqual([]);
    setTranslationDisplayMode("bilingual");
    expect(document.querySelectorAll("#code")).toHaveLength(1);
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it("preserves original links, formatting, Text identities and exact restoration across reordered translations", async () => {
    document.body.innerHTML = '<main><p>Read <strong id="bold">the complete guide</strong> and <a id="link" href="/details">the details</a> now.</p></main>';
    const paragraph = document.querySelector("p")!;
    const original = paragraph.outerHTML;
    const allNodes = [...paragraph.childNodes], bold = document.querySelector("strong")!, link = document.querySelector("a")!;
    const click = vi.fn(); link.addEventListener("click", event => { event.preventDefault(); click(); });
    const [segment] = await collectTextSegmentsProgressive();
    expect(segment.text).toBe("Read the complete guide and the details now.");
    expect(segment.requestText).toBe("Read ⟪WUPAGEOPEN0⟫the complete guide⟪WUPAGECLOSE0⟫ and ⟪WUPAGEOPEN1⟫the details⟪WUPAGECLOSE1⟫ now.");
    const translated = "先读⟪WUPAGEOPEN1⟫详情⟪WUPAGECLOSE1⟫，再读⟪WUPAGEOPEN0⟫完整指南⟪WUPAGECLOSE0⟫。";
    renderTranslationPlaceholders([segment]);
    expect(renderTranslations([{ id: segment.id, text: translated }], "replace")).toEqual([segment.id]);
    expect(paragraph.textContent).toBe("先读详情，再读完整指南。");
    expect(paragraph.querySelector("a")).toBe(link);
    expect(paragraph.querySelector("strong")).toBe(bold);
    expect(allNodes.every(node => node.isConnected)).toBe(true);
    (link as HTMLElement).click(); expect(click).toHaveBeenCalledOnce();
    for (const mode of ["bilingual", "bilingual-accent", "replace"] as const) {
      setTranslationDisplayMode(mode);
      expect(invalidateStaleSegments()).toEqual([]);
      expect(document.querySelectorAll("#link")).toHaveLength(1);
      expect(document.querySelectorAll("#bold")).toHaveLength(1);
      expect(paragraph.textContent).not.toContain("WUPAGE");
    }
    clearTranslations();
    expect(paragraph.outerHTML).toBe(original);
    expect([...paragraph.childNodes]).toEqual(allNodes);
  });

  it("rejects missing, duplicated, empty and incorrectly nested format scopes", async () => {
    document.body.innerHTML = '<p>Read <strong>the <em>complete</em> guide</strong> now.</p>';
    const [segment] = await collectTextSegmentsProgressive();
    const source = document.querySelector("p")!.textContent;
    expect(segment.requestText).toContain("WUPAGEOPEN1");
    for (const text of ["格式丢失", "⟪WUPAGEOPEN0⟫⟪WUPAGEOPEN1⟫⟪WUPAGECLOSE1⟫⟪WUPAGECLOSE0⟫",
      "⟪WUPAGEOPEN0⟫译⟪WUPAGEOPEN1⟫文⟪WUPAGECLOSE0⟫⟪WUPAGECLOSE1⟫",
      "⟪WUPAGEOPEN1⟫译文⟪WUPAGECLOSE1⟫⟪WUPAGEOPEN0⟫正文⟪WUPAGECLOSE0⟫"]) {
      expect(renderTranslations([{ id: segment.id, text }], "replace")).toEqual([]);
      expect(document.querySelector("p")!.textContent).toBe(source);
    }
  });

  it("keeps neutral span fields in order and refuses new prose outside their original scopes", async () => {
    document.body.innerHTML = '<p><span>Update</span><span>Cancel submission</span></p>';
    const [segment] = await collectTextSegmentsProgressive();
    expect(segment.requestText).toContain("WUPAGEOPEN1");
    for (const text of ["更新⟪WUPAGEOPEN0⟫按钮⟪WUPAGECLOSE0⟫⟪WUPAGEOPEN1⟫取消提交⟪WUPAGECLOSE1⟫",
      "⟪WUPAGEOPEN1⟫取消提交⟪WUPAGECLOSE1⟫⟪WUPAGEOPEN0⟫更新⟪WUPAGECLOSE0⟫"]) {
      expect(renderTranslations([{ id: segment.id, text }], "replace")).toEqual([]);
      expect(document.querySelector("p")!.textContent).toBe("UpdateCancel submission");
    }
    expect(renderTranslations([{ id: segment.id, text: "⟪WUPAGEOPEN0⟫更新⟪WUPAGECLOSE0⟫⟪WUPAGEOPEN1⟫取消提交⟪WUPAGECLOSE1⟫" }], "replace")).toEqual([segment.id]);
    expect([...document.querySelectorAll("p > span")].map(node => node.textContent)).toEqual(["更新", "取消提交"]);
  });

  it.each(["class", "title", "href"])("still rejects a page-owned %s change while a structured response is pending", async attribute => {
    document.body.innerHTML = '<p class="article-copy">Read <a href="/guide" title="Guide">the guide</a> carefully.</p>';
    const [segment] = await collectTextSegmentsProgressive();
    const request = segment.requestText!;
    const target = document.querySelector(attribute === "class" ? "p" : "a")!;
    target.setAttribute(attribute, "updated-by-page");
    expect(renderTranslations([{ id: segment.id, text: request.replace("Read", "阅读") }], "replace")).toEqual([]);
    expect(invalidateStaleSegments()).toContain(segment.id);
    expect(target.getAttribute(attribute)).toBe("updated-by-page");
    expect(document.querySelector("p")!.textContent).toBe("Read the guide carefully.");
  });

  it("keeps a host update made while the structured response is pending", async () => {
    document.body.innerHTML = '<p>Read <strong>the guide</strong> carefully.</p>';
    const [segment] = await collectTextSegmentsProgressive();
    const request = segment.requestText!;
    document.querySelector("strong")!.textContent = "the new article";
    expect(renderTranslations([{ id: segment.id, text: request.replace("Read", "阅读") }], "replace")).toEqual([]);
    clearTranslations();
    expect(document.querySelector("strong")!.textContent).toBe("the new article");
  });

  it("restores its own node order while preserving later host text and attribute changes", async () => {
    document.body.innerHTML = '<p>Read <strong>the guide</strong> and <a href="/old">details</a>.</p>';
    const paragraph = document.querySelector("p")!, strong = document.querySelector("strong")!, link = document.querySelector("a")!;
    const [segment] = await collectTextSegmentsProgressive();
    void segment.requestText;
    renderTranslations([{ id: segment.id, text: "阅读⟪WUPAGEOPEN1⟫详情⟪WUPAGECLOSE1⟫和⟪WUPAGEOPEN0⟫指南⟪WUPAGECLOSE0⟫。" }], "replace");
    link.setAttribute("href", "/updated");
    strong.firstChild!.textContent = "updated source";
    clearTranslations();
    expect([...paragraph.children]).toEqual([strong, link]);
    expect(link.getAttribute("href")).toBe("/updated");
    expect(strong.textContent).toBe("updated source");
  });
});

describe("closed component roots", () => {
  it("skips Chromium's closed-root API after the extension is reloaded", () => {
    const readRoot = vi.fn(() => { throw new Error("Extension context invalidated."); });
    vi.stubGlobal("chrome", { runtime: {}, dom: { openOrClosedShadowRoot: readRoot } });
    const host = document.createElement("div");
    const open = document.createElement("div");
    const openRoot = open.attachShadow({ mode: "open" });

    expect(componentShadowRoot(host)).toBeNull();
    expect(componentShadowRoot(open)).toBe(openRoot);
    expect(readRoot).not.toHaveBeenCalled();
  });

  it.each(["chromium", "firefox"])("discovers and restores closed roots using the %s extension API", async api => {
    document.body.innerHTML = '<main><closed-card></closed-card></main>';
    const host = document.querySelector("closed-card")!;
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = '<p>Read the closed component content.</p>';
    if (api === "chromium") vi.stubGlobal("chrome", {
      runtime: { id: "test-extension" }, dom: { openOrClosedShadowRoot: (element: Element) => element === host ? root : null }
    });
    else Object.defineProperty(host, "openOrClosedShadowRoot", { value: root, configurable: true });
    expect(host.shadowRoot).toBeNull();
    expect(componentShadowRoot(host)).toBe(root);
    const [segment] = await collectTextSegmentsProgressive();
    expect(segment.text).toBe("Read the closed component content.");
    renderTranslations([{ id: segment.id, text: "封闭组件的译文。" }], "replace");
    expect(root.querySelector("p")!.textContent).toBe("封闭组件的译文。");
    clearTranslations();
    expect(root.querySelector("p")!.textContent).toBe("Read the closed component content.");
  });
});
