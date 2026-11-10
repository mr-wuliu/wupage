// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://x.com/home"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations,
  collectAdditionalTextSegmentsProgressive,
  collectParagraphTextSegments,
  collectTextSegmentsProgressive,
  findTranslatableParagraph,
  invalidateStaleSegments,
  renderTranslations
} from "../src/content/dom";
import { configureElementRules, isElementExcluded } from "../src/content/element-exclusions";
import { buildTranslationContext } from "../src/content/translation-context";

const rule = (selectors: string[], pattern = "x.com") => [{ id: "custom", name: "Custom", pattern, selectors, enabled: true }];
beforeEach(() => {
  history.replaceState(null, "", "/home"); configureElementRules({});
  document.body.innerHTML = `<header role="banner"><nav><a href="/home">Home</a><a href="/explore">Explore</a></nav>
    <button>Post</button></header><main><article><p id="post">Read this complete post before continuing.</p></article></main>
    <aside><p>Keep this unrelated sidebar readable.</p></aside>`;
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ display: "block", visibility: "visible", opacity: "1" } as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 30));
});

it("forces only visible text in a matching region and leaves inputs and exclusions untouched", async () => {
  const main = document.querySelector("main")!;
  main.innerHTML = `<aside role="dialog" translate="no" data-test="settings">
    <h2><span>Media Downloader Settings</span></h2>
    <label for="filename"><span>Filename Format</span></label>
    <input id="filename" value="{userId}-{postId}">
    <label>開</label><span>12345</span>
    <button type="button">Export</button>
    <p class="private notranslate">Private account name</p>
    <p hidden>Hidden dialog copy</p>
    <p contenteditable>Editable source value</p>
    <div role="textbox">Custom editor value</div>
    <pre>const internalValue = 2;</pre>
  </aside><p translate="no">Outside dialog</p>`;
  const dialog = main.querySelector("[role='dialog']")!;
  const elementInclusions = rule(["[data-test='settings']"], "x.com/settings/*");
  const elementExclusions = rule([".private", "header[role='banner']"]);
  configureElementRules({ elementInclusions, elementExclusions });
  expect(collectParagraphTextSegments(dialog)).toEqual([]);
  history.replaceState(null, "", "/settings/media");
  configureElementRules({ elementInclusions, elementExclusions });
  const segments = await collectTextSegmentsProgressive();
  expect(segments.map(segment => segment.requestText ?? segment.text).sort())
    .toEqual(["Export", "Filename Format", "Keep this unrelated sidebar readable.", "Media Downloader Settings", "開"]);
  renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), "replace");
  const input = main.querySelector("input")!;
  expect(input.value).toBe("{userId}-{postId}");
  expect(main.querySelector(".private")!.textContent).toBe("Private account name");
  expect(dialog.querySelector("label")!.textContent).toContain("译文：Filename Format");
  clearTranslations();
  expect(dialog.querySelector("label")!.textContent).toBe("Filename Format");
  expect(collectParagraphTextSegments(dialog.querySelector("label")!).map(segment => segment.text)).toEqual(["Filename Format"]);
});
afterEach(() => { clearTranslations(); configureElementRules({}); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("configured element exclusions", () => {
  it.each(["bilingual", "bilingual-accent", "replace"] as const)("keeps the X navigation intact while translating posts in %s mode", async mode => {
    const nav = document.querySelector("header")!, original = nav.outerHTML;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(segment => segment.text)).toEqual(["Read this complete post before continuing.", "Keep this unrelated sidebar readable."]);
    expect(findTranslatableParagraph(nav.querySelector("a"))).toBeNull();
    renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), mode);
    expect(nav.outerHTML).toBe(original); expect(document.querySelectorAll(".wupage-translation")).toHaveLength(2);
    expect(buildTranslationContext() ?? "").not.toContain("Explore");
  });

  it("allows deleting or disabling the preset without excluding other regions", async () => {
    configureElementRules({ elementExclusions: [] });
    expect((await collectTextSegmentsProgressive()).map(segment => segment.text)).toContain("Home");
  });

  it("scopes custom exclusions to the configured host and path", () => {
    configureElementRules({ elementExclusions: rule(["#post"], "x.com/settings/*") });
    expect(isElementExcluded(document.querySelector("#post")!)).toBe(false);
    history.replaceState(null, "", "/settings/privacy");
    expect(configureElementRules({ elementExclusions: rule(["#post"], "x.com/settings/*") })).toBe(true);
    expect(isElementExcluded(document.querySelector("#post")!)).toBe(true);
    configureElementRules({ elementExclusions: rule(["#post"], "example.com") });
    expect(isElementExcluded(document.querySelector("#post")!)).toBe(false);
  });

  it("preserves an excluded inline subtree and keeps it out of source and context", async () => {
    configureElementRules({ elementExclusions: rule([".private"]) });
    document.querySelector("main")!.innerHTML = '<p id="post">Read the article <span class="private" translate="yes"><b>Private account label</b></span> before continuing.</p>';
    const excluded = document.querySelector(".private")!, original = excluded.outerHTML;
    const segments = (await collectTextSegmentsProgressive());
    expect(segments.map(segment => segment.text).join(" ")).not.toContain("Private account label");
    expect(buildTranslationContext()).not.toContain("Private account label");
    renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), "replace");
    expect(excluded.outerHTML).toBe(original); expect(excluded.isConnected).toBe(true);
    expect(excluded.closest(".wupage-replaced-source")).toBeNull();
    expect(collectParagraphTextSegments(excluded)).toEqual([]);
  });

  it("applies to future nodes and restores a source that becomes excluded", async () => {
    configureElementRules({ elementExclusions: rule(["[data-region='ads']"]) });
    const segments = (await collectTextSegmentsProgressive());
    renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), "replace");
    const post = document.querySelector("#post")!; post.setAttribute("data-region", "ads");
    expect(invalidateStaleSegments().length).toBeGreaterThan(0);
    expect(post.textContent).toBe("Read this complete post before continuing.");
    const added = document.createElement("div"); added.innerHTML = '<p data-region="ads">New excluded recommendation.</p><p>New public article content.</p>';
    document.querySelector("main")!.append(added);
    const texts = (await collectAdditionalTextSegmentsProgressive([added])).map(segment => segment.text);
    expect(texts).toEqual(["New public article content."]);
  });

  it("crosses open component boundaries and ignores invalid imported selectors", async () => {
    configureElementRules({ elementExclusions: rule([".private", "[invalid"]) });
    const host = document.createElement("custom-card"); host.className = "private";
    const shadow = host.attachShadow({ mode: "open" }); shadow.innerHTML = '<p translate="yes">Excluded component text.</p>';
    document.querySelector("main")!.append(host);
    expect(isElementExcluded(shadow.querySelector("p")!)).toBe(true);
    expect((await collectAdditionalTextSegmentsProgressive([host]))).toEqual([]);
  });
});
