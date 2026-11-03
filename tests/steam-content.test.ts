// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://steamcommunity.com/app/1281930/"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations,
  collectAdditionalTextSegmentsProgressive,
  collectParagraphTextSegments,
  collectTextSegmentsProgressive,
  findTranslatableParagraph,
  hasTranslationsIn,
  renderTranslations,
  clearTranslationsIn
} from "../src/content/dom";
import { steamItemTitle } from "../src/content/steam-content";

const intro = "Dig, Fight, and Build your way through the world of player-created mods on Terraria with tModLoader.";
const announcement = "Hello everyone! It is time for the monthly stable update and other news.";
const progress = "Progress on the development branch is going smoothly, with new features contributed by the community.";
const fixture = `<div role="main">
  <div class="apphub_StoreInfoHeader" role="button" tabindex="0">
    <img src="/header.jpg"><div id="intro" class="apphub_StoreAppText">${intro}</div>
    <div class="apphub_StoreAppData"><a href="https://store.steampowered.com/app/1281930/"><span>Visit the Store Page</span></a></div>
  </div>
  <div id="card" class="apphub_Card Announcement_Card" role="button" tabindex="0">
    <div class="apphub_CardContentMain">
      <div id="title" class="apphub_CardContentNewsTitle">Monthly Stable Update</div>
      <div class="apphub_CardContentNewsDesc"><div id="body" class="apphub_CardTextContent">${announcement}<br><br>
        <div id="heading" class="bb_h1">Development Progress</div><br>${progress}<br><br>
        <span hidden>Hidden announcement content.</span><span translate="no">PrivateBrand</span>
      </div></div>
    </div>
    <div class="apphub_CardContentAuthorName"><a href="/profiles/123">ExampleAuthor</a></div>
  </div>
</div>
<div id="workshop"><div><a id="mod" href="https://steamcommunity.com/sharedfiles/filedetails/?id=123">Cheat Sheet</a></div>
  <div><a id="rich-mod" href="/sharedfiles/filedetails/?id=456"><span>Magic</span> <b>Storage</b></a></div>
  <a id="external" href="https://example.com/sharedfiles/filedetails/?id=789">External Library</a>
</div>`;

beforeEach(() => {
  document.body.innerHTML = fixture;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({ display: element.hasAttribute("hidden") ? "none" : "block",
    visibility: "visible", opacity: "1" } as CSSStyleDeclaration));
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 30));
});
afterEach(() => { clearTranslations(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("Steam community content", () => {
  it("includes game descriptions and announcement prose inside navigable cards", async () => {
    const texts = (await collectTextSegmentsProgressive()).map(segment => segment.text);
    for (const source of [intro, announcement, progress, "Monthly Stable Update", "Development Progress"])
      expect(texts.filter(text => text === source)).toHaveLength(1);
    expect(texts.join(" ")).not.toContain("Hidden announcement content.");
  });

  it("recognizes short workshop titles from stable item links without relying on generated CSS classes", async () => {
    const texts = (await collectTextSegmentsProgressive()).map(segment => segment.text);
    expect(texts).toContain("Cheat Sheet"); expect(texts).toContain("Magic Storage");
    expect(steamItemTitle(document.querySelector("#external")!)).toBeNull();
  });

  it("keeps short navigation, section and filter labels in the generated workshop UI", async () => {
    document.querySelector("#workshop")!.insertAdjacentHTML("beforeend", `<a href="/app/1281930/">All</a>
      <a href="https://store.steampowered.com/app/1281930/">Store Page</a><div>Mods</div><div>Mod Features</div>
      <a href="https://example.com/guide">Learn More</a><div>In the past week</div>`);
    const texts = (await collectTextSegmentsProgressive()).map(segment => segment.text);
    for (const text of ["All", "Store Page", "Mods", "Mod Features", "Learn More", "In the past week"])
      expect(texts).toContain(text);
  });

  it.each(["hidden", "aria-hidden", "contenteditable", "translate", "sr-only"])("keeps the %s exclusion on a navigable card", async exclusion => {
    const card = document.querySelector("#card")!;
    if (exclusion === "sr-only") card.classList.add("sr-only");
    else card.setAttribute(exclusion, exclusion === "translate" ? "no" : "true");
    const texts = (await collectTextSegmentsProgressive()).map(segment => segment.text);
    expect(texts).not.toContain(announcement); expect(texts).not.toContain("Monthly Stable Update");
    expect(texts).toContain(intro);
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)("renders and restores Steam cards and links in %s mode", async mode => {
    const original = document.body.innerHTML;
    const segments = (await collectTextSegmentsProgressive());
    renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), mode);
    for (const selector of ["#intro", "#title", "#body", "#mod", "#rich-mod"])
      expect(hasTranslationsIn(document.querySelector(selector)!)).toBe(true);
    expect(document.querySelector("#card")!.getAttribute("role")).toBe("button");
    expect(document.querySelector("#mod")!.getAttribute("href")).toBe("https://steamcommunity.com/sharedfiles/filedetails/?id=123");
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it.each(["#intro", "#title", "#heading", "#mod", "#rich-mod span"])("supports paragraph translation and restoration for %s", selector => {
    const target = findTranslatableParagraph(document.querySelector(selector));
    expect(target).not.toBeNull();
    const original = document.body.innerHTML;
    const segments = collectParagraphTextSegments(target!);
    expect(segments.length).toBeGreaterThan(0);
    renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })));
    expect(hasTranslationsIn(target!)).toBe(true);
    clearTranslationsIn(target!);
    expect(hasTranslationsIn(target!)).toBe(false);
    expect(document.body.innerHTML).toBe(original);
  });

  it("collects newly loaded cards and workshop titles without requesting existing text twice", async () => {
    (await collectTextSegmentsProgressive());
    const added = document.createElement("div");
    added.innerHTML = `<div class="apphub_Card" role="button"><div class="apphub_CardContentMain">
      <div class="apphub_CardContentNewsTitle">New Release</div><div class="apphub_CardTextContent">${progress}</div></div></div>
      <a href="/sharedfiles/filedetails/?id=999">Recipe Browser</a>`;
    document.querySelector("[role='main']")!.append(added);
    const texts = (await collectAdditionalTextSegmentsProgressive([document.body])).map(segment => segment.text);
    expect(texts).toContain("New Release"); expect(texts).toContain("Recipe Browser"); expect(texts).not.toContain(intro);
  });
});
