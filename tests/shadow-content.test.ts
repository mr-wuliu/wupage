// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations,
  collectTextSegmentsProgressive,
  hasPageTranslations,
  hideTranslations,
  invalidateStaleSegments,
  renderTranslations,
  restoreTranslations,
  setTranslationDisplayMode
} from "../src/content/dom";
import { buildTranslationContext } from "../src/content/translation-context";
import { injectContentStyles } from "../src/content/styles";

beforeEach(() => {
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({ display: "block", visibility: "visible", opacity: "1",
    ...(element.hasAttribute("hidden") ? { display: "none" } : {}) }) as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 600, height: 20, top: 0, right: 600, bottom: 20, left: 0 } as DOMRect);
});
afterEach(() => { clearTranslations(); document.body.replaceChildren(); vi.restoreAllMocks(); });

function mount() {
  document.body.innerHTML = '<main><p>Light DOM prose.</p><article-card></article-card></main>';
  const host = document.querySelector("article-card")!;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<article><p id="text">Read <code>guide()</code> before continuing.</p><input placeholder="Search documents"><nested-card></nested-card></article>';
  const nested = root.querySelector("nested-card")!.attachShadow({ mode: "open" });
  nested.innerHTML = '<p>Nested component prose.</p><p class="notranslate">Private component text.</p>';
  return { host, root, nested };
}

describe("open component prose", () => {
  it.each([false, true])("collects nested roots and restores every display mode, progressive=%s", async progressive => {
    const { root, nested } = mount();
    injectContentStyles();
    const segments = progressive ? await collectTextSegmentsProgressive() : (await collectTextSegmentsProgressive());
    expect(segments.map(segment => segment.text).sort()).toEqual([
      "Light DOM prose.", "Read ⟪WUPAGE0⟫ before continuing.", "Search documents", "Nested component prose."
    ].sort());
    const translations = segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` }));
    renderTranslations(translations, "replace");
    expect(root.querySelector(".wupage-translation code")?.textContent).toBe("guide()");
    expect(nested.querySelector(".wupage-translation")?.textContent).toBe("译文：Nested component prose.");
    expect(root.querySelector("#wupage-translation-style")).not.toBeNull();
    for (const mode of ["bilingual", "replace", "bilingual-accent"] as const) {
      setTranslationDisplayMode(mode);
      expect(root.querySelectorAll(".wupage-translation")).toHaveLength(1);
      expect(nested.querySelectorAll(".wupage-translation")).toHaveLength(1);
    }
    hideTranslations();
    expect(hasPageTranslations()).toBe(false);
    expect(root.querySelector("p")?.textContent).toBe("Read guide() before continuing.");
    expect(root.querySelector("input")?.placeholder).toBe("Search documents");
    expect(nested.querySelector("p")?.textContent).toBe("Nested component prose.");
    restoreTranslations("replace");
    expect(hasPageTranslations()).toBe(true);
    expect(nested.querySelector(".wupage-translation")).not.toBeNull();
  });

  it.each(["hidden", "contenteditable", "translate", "class"])("respects host %s across nested roots", async attribute => {
    const { host, nested } = mount();
    host.setAttribute(attribute, attribute === "translate" ? "no" : attribute === "class" ? "notranslate" : "");
    expect((await collectTextSegmentsProgressive()).some(segment => segment.text.includes("Nested component"))).toBe(false);
    expect(buildTranslationContext([nested.querySelector("p")!]) ?? "").not.toContain("Nested component");
  });

  it("withdraws translated prose and placeholders when a host opts out", async () => {
    const { host, root } = mount();
    const segments = (await collectTextSegmentsProgressive());
    renderTranslations(segments.map(segment => ({ id: segment.id, text: `译文：${segment.text}` })), "replace");
    host.setAttribute("translate", "no");
    expect(invalidateStaleSegments().length).toBeGreaterThan(0);
    expect(root.querySelector(".wupage-translation")).toBeNull();
    expect(root.querySelector("p")?.textContent).toBe("Read guide() before continuing.");
    expect(root.querySelector("input")?.placeholder).toBe("Search documents");
  });
});
