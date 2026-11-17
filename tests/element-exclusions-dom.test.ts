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
import { configureElementRules, forcedTextRoot, isElementExcluded } from "../src/content/element-exclusions";
import { buildTranslationContext } from "../src/content/translation-context";
import { normalizeElementExclusions } from "../src/shared/element-exclusions";

const rule = (selectors: string[], pattern = "x.com") => [{ id: "custom", name: "Custom", pattern, selectors, enabled: true }];
const sidebar = `<aside data-testid="sidebarColumn">
  <div id="premium"><h2>Subscribe to Premium</h2><p>Enjoy more premium features.</p></div>
  <div id="news"><div data-testid="news_sidebar"></div><h2>Today’s News</h2>
    <a href="/news"><span>Technology news headline.</span></a><p>Three hours ago.</p></div>
  <section id="trends"><h2>What’s happening</h2><div data-testid="trend"><span>Trending topic.</span><p>Many posts.</p></div>
    <div><a href="/explore/tabs/for-you">Show more</a></div></section>
  <aside id="follow" aria-label="おすすめユーザー"><h2>Who to follow</h2>
    <ul><li data-testid="UserCell"><span>A recommended account.</span><button data-testid="123-follow">Follow</button></li></ul>
    <a href="/i/connect_people?user_id=123">Show more</a></aside>
  <nav id="footer" aria-label="フッター"><a href="https://x.com/tos">Terms</a><a href="https://x.com/privacy">Privacy</a>
    <a href="https://help.x.com/rules-and-policies/x-cookies">Cookies</a><span>Accessibility</span><span>Ads info</span>
    <button>More</button><span>© 2026 X Corp.</span></nav>
</aside>`;
beforeEach(() => {
  history.replaceState(null, "", "/home"); configureElementRules({});
  document.body.innerHTML = `<header role="banner"><nav><a href="/home">Home</a><a href="/explore">Explore</a></nav>
    <button>Post</button></header><main><article><p id="post">Read this complete post before continuing.</p></article></main>
    <aside><p>Keep this unrelated sidebar readable.</p></aside>`;
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ display: "block", visibility: "visible", opacity: "1" } as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 30));
});

it("applies global and wildcard rules per document, including cross-site frames and SPA path changes", () => {
  configureElementRules({ elementExclusions: rule([".sponsored"], "*"), elementInclusions: rule([".dialog"], "*://*.example.org/docs/*") });
  const frame = document.createElement("iframe"); frame.src = "https://news.example.org/docs/guide"; document.body.append(frame);
  const child = frame.contentDocument!;
  child.append(child.createElement("html")); child.documentElement.append(child.createElement("body"));
  child.body.innerHTML = '<div class="dialog"><p class="sponsored">Private label</p><p id="public">Public label</p></div>';
  expect(isElementExcluded(child.querySelector(".sponsored")!)).toBe(true);
  expect(forcedTextRoot(child.querySelector("#public")!)).toBe(child.querySelector(".dialog"));
  expect(forcedTextRoot(document.querySelector("#post")!)).toBeNull();
  configureElementRules({ elementExclusions: rule(["main"], String.raw`/^https?:\/\/x\.com\/docs\/[0-9]+$/`) });
  expect(isElementExcluded(document.querySelector("#post")!)).toBe(false);
  history.replaceState(null, "", "/docs/123");
  expect(isElementExcluded(document.querySelector("#post")!)).toBe(true);
  history.replaceState(null, "", "/docs/abc");
  expect(isElementExcluded(document.querySelector("#post")!)).toBe(false);
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
  it.each(["bilingual", "bilingual-accent", "replace"] as const)("preserves X sidebar cards, their controls and footer in %s mode", async mode => {
    document.body.insertAdjacentHTML("beforeend", sidebar);
    const news = document.querySelector("#news")!, trends = document.querySelector("#trends")!;
    const originalNews = news.outerHTML, originalTrends = trends.outerHTML;
    const follow = document.querySelector("#follow")!, footer = document.querySelector("#footer")!;
    const originalFollow = follow.outerHTML, originalFooter = footer.outerHTML;
    const segments = await collectTextSegmentsProgressive();
    const texts = segments.map(segment => segment.text).join(" ");
    expect(texts).toContain("Read this complete post");
    expect(texts).toContain("Enjoy more premium features.");
    for (const text of ["Today’s News", "Technology news headline.", "Three hours ago.", "What’s happening", "Trending topic.", "Many posts.",
      "Who to follow", "A recommended account.", "Follow", "Show more", "Terms", "Privacy", "Cookies", "Accessibility", "Ads info", "More", "© 2026 X Corp."]) {
      expect(texts).not.toContain(text);
      expect(buildTranslationContext() ?? "").not.toContain(text);
    }
    expect(findTranslatableParagraph(news.querySelector("span"))).toBeNull();
    expect(collectParagraphTextSegments(trends)).toEqual([]);
    renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), mode);
    expect(news.outerHTML).toBe(originalNews);
    expect(trends.outerHTML).toBe(originalTrends);
    expect(follow.outerHTML).toBe(originalFollow);
    expect(footer.outerHTML).toBe(originalFooter);
    expect(document.querySelector("#post .wupage-translation")).not.toBeNull();
  });

  it("applies X presets to late cards and lets each rule be disabled independently", async () => {
    const added = document.createElement("div"); added.innerHTML = sidebar;
    document.body.append(added);
    expect((await collectAdditionalTextSegmentsProgressive([added])).map(segment => segment.text).join(" "))
      .not.toMatch(/Technology news headline|Trending topic|Show more|Follow|Terms/);
    for (const [id, included, excluded] of [["x-news", "#news", "#trends"], ["x-trends", "#trends", "#news"],
      ["x-follow", "#follow", "#footer"], ["x-footer", "#footer", "#follow"]]) {
      const rules = normalizeElementExclusions(undefined);
      rules.find(rule => rule.id === id)!.enabled = false;
      configureElementRules({ elementExclusions: rules });
      expect(isElementExcluded(document.querySelector(included)!)).toBe(false);
      expect(isElementExcluded(document.querySelector(excluded)!)).toBe(true);
      expect(collectParagraphTextSegments(document.querySelector(included)!)).not.toEqual([]);
      configureElementRules({ elementExclusions: rules.filter(rule => rule.id !== id) });
      expect(isElementExcluded(document.querySelector(included)!)).toBe(false);
    }
    // The same marker outside X's sidebar must not suppress ordinary posts.
    const post = document.querySelector("#post")!;
    post.insertAdjacentHTML("afterend", '<section id="post-trend"><p data-testid="trend">A post discussing trends.</p></section>');
    post.insertAdjacentHTML("afterend", '<aside id="post-follow"><p data-testid="UserCell">An account mentioned in a post.</p></aside><nav id="post-footer"><a href="https://x.com/tos">Terms in a post.</a></nav>');
    configureElementRules({});
    expect(isElementExcluded(document.querySelector("#post-trend")!)).toBe(false);
    expect(isElementExcluded(document.querySelector("#post-follow")!)).toBe(false);
    expect(isElementExcluded(document.querySelector("#post-footer")!)).toBe(false);
  });

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
