// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://x.com/home"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTranslations, collectAdditionalTextSegments, collectParagraphTextSegments, collectTextSegments,
  findTranslatableParagraph, invalidateStaleSegments, renderTranslations } from "../src/content/dom";
import { configureElementExclusions, isElementExcluded } from "../src/content/element-exclusions";
import { buildTranslationContext } from "../src/content/translation-context";

const rule = (selectors: string[], pattern = "x.com") => [{ id: "custom", name: "Custom", pattern, selectors, enabled: true }];
beforeEach(() => {
  history.replaceState(null, "", "/home"); configureElementExclusions(undefined);
  document.body.innerHTML = `<header role="banner"><nav><a href="/home">Home</a><a href="/explore">Explore</a></nav>
    <button>Post</button></header><main><article><p id="post">Read this complete post before continuing.</p></article></main>
    <aside><p>Keep this unrelated sidebar readable.</p></aside>`;
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ display: "block", visibility: "visible", opacity: "1" } as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 30));
});
afterEach(() => { clearTranslations(); configureElementExclusions(undefined); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("configured element exclusions", () => {
  it.each(["bilingual", "bilingual-accent", "replace"] as const)("keeps the X navigation intact while translating posts in %s mode", mode => {
    const nav = document.querySelector("header")!, original = nav.outerHTML;
    const segments = collectTextSegments();
    expect(segments.map(segment => segment.text)).toEqual(["Read this complete post before continuing.", "Keep this unrelated sidebar readable."]);
    expect(findTranslatableParagraph(nav.querySelector("a"))).toBeNull();
    renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), mode);
    expect(nav.outerHTML).toBe(original); expect(document.querySelectorAll(".wupage-translation")).toHaveLength(2);
    expect(buildTranslationContext() ?? "").not.toContain("Explore");
  });

  it("allows deleting or disabling the preset without excluding other regions", () => {
    configureElementExclusions([]);
    expect(collectTextSegments().map(segment => segment.text)).toContain("Home");
  });

  it("scopes custom exclusions to the configured host and path", () => {
    configureElementExclusions(rule(["#post"], "x.com/settings/*"));
    expect(isElementExcluded(document.querySelector("#post")!)).toBe(false);
    history.replaceState(null, "", "/settings/privacy");
    expect(configureElementExclusions(rule(["#post"], "x.com/settings/*"))).toBe(true);
    expect(isElementExcluded(document.querySelector("#post")!)).toBe(true);
    configureElementExclusions(rule(["#post"], "example.com"));
    expect(isElementExcluded(document.querySelector("#post")!)).toBe(false);
  });

  it("preserves an excluded inline subtree and keeps it out of source and context", () => {
    configureElementExclusions(rule([".private"]));
    document.querySelector("main")!.innerHTML = '<p id="post">Read the article <span class="private" translate="yes"><b>Private account label</b></span> before continuing.</p>';
    const excluded = document.querySelector(".private")!, original = excluded.outerHTML;
    const segments = collectTextSegments();
    expect(segments.map(segment => segment.text).join(" ")).not.toContain("Private account label");
    expect(buildTranslationContext()).not.toContain("Private account label");
    renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), "replace");
    expect(excluded.outerHTML).toBe(original); expect(excluded.isConnected).toBe(true);
    expect(excluded.closest(".wupage-replaced-source")).toBeNull();
    expect(collectParagraphTextSegments(excluded)).toEqual([]);
  });

  it("applies to future nodes and restores a source that becomes excluded", () => {
    configureElementExclusions(rule(["[data-region='ads']"]));
    const segments = collectTextSegments();
    renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), "replace");
    const post = document.querySelector("#post")!; post.setAttribute("data-region", "ads");
    expect(invalidateStaleSegments().length).toBeGreaterThan(0);
    expect(post.textContent).toBe("Read this complete post before continuing.");
    const added = document.createElement("div"); added.innerHTML = '<p data-region="ads">New excluded recommendation.</p><p>New public article content.</p>';
    document.querySelector("main")!.append(added);
    const texts = collectAdditionalTextSegments(added).map(segment => segment.text);
    expect(texts).toEqual(["New public article content."]);
  });

  it("crosses open component boundaries and ignores invalid imported selectors", () => {
    configureElementExclusions(rule([".private", "[invalid"]));
    const host = document.createElement("custom-card"); host.className = "private";
    const shadow = host.attachShadow({ mode: "open" }); shadow.innerHTML = '<p translate="yes">Excluded component text.</p>';
    document.querySelector("main")!.append(host);
    expect(isElementExcluded(shadow.querySelector("p")!)).toBe(true);
    expect(collectAdditionalTextSegments(host)).toEqual([]);
  });
});
