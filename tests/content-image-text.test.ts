// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as imageTextLayout from "../src/content/image-text-layout";
import {
  clearTranslationPlaceholders,
  clearTranslations,
  clearTranslationsIn,
  collectAdditionalTextSegmentsProgressive,
  collectParagraphTextSegments,
  collectTextSegmentsProgressive,
  hasPageTranslations,
  hasTranslationsIn,
  invalidateStaleSegments,
  renderTranslationPlaceholders,
  renderTranslations,
  setTranslationDisplayMode
} from "../src/content/dom";

const paragraphs = [
  "今こそ、『魔法少女まどか☆マギカ』の世界が、新たな局面を迎える。",
  "これは本文を画像として掲載するページの紹介文です。画像の代替テキストには、作品の背景や登場人物についての長い文章が複数の段落に分けて用意されています。"
];
const sourceAlt = `${paragraphs[0]} \n              ${paragraphs[1]} `;
const translation = "现在，魔法少女的世界迎来全新局面。\n\n这是一段以图片形式呈现的作品介绍。";

describe("long-form image text translation", () => {
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      display: element.closest("[hidden]") ? "none" : "block",
      visibility: "visible",
      opacity: "1",
      color: "rgb(240, 240, 240)"
    }) as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 600, height: 240, top: 0, right: 600, bottom: 240, left: 0
    } as DOMRect);
  });

  afterEach(() => {
    clearTranslations();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function mountPicture(): HTMLImageElement {
    document.body.innerHTML = `<div id="intro"><div class="p-intro__lead"><picture>
      <source srcset="txt_intro_sp.png" media="(max-width: 767px)">
      <img src="txt_intro_pc.png">
    </picture></div></div>`;
    const image = document.querySelector("img")!;
    image.alt = sourceAlt;
    return image;
  }

  it("extracts paragraph text from responsive images without visible text nodes", async () => {
    const image = mountPicture();
    const segments = (await collectTextSegmentsProgressive());

    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe(paragraphs.join("\n\n"));
    expect(segments[0].element).toBe(image);
    expect((await collectAdditionalTextSegmentsProgressive([document.body]))).toEqual([]);
  });

  it("ignores empty or short labels, numeric alt text and hidden images", async () => {
    const image = mountPicture();
    image.hidden = true;
    document.body.insertAdjacentHTML("beforeend", `<img alt=""><img alt="INTRODUCTION">
      <img alt="${"12345".repeat(30)}">`);

    expect((await collectTextSegmentsProgressive())).toEqual([]);
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)(
    "renders readable text outside picture and restores the page in %s mode",
    async (mode) => {
      const image = mountPicture();
      const picture = image.closest("picture")!;
      const segments = (await collectTextSegmentsProgressive());
      renderTranslationPlaceholders(segments);

      expect(picture.nextElementSibling?.matches(".wupage-translation-pending")).toBe(true);
      expect(picture.querySelector(".wupage-translation")).toBeNull();
      expect(hasTranslationsIn(image)).toBe(true);

      renderTranslations([{ id: segments[0].id, text: translation }], mode);
      const output = picture.nextElementSibling as HTMLElement;
      expect(output.textContent).toBe(translation);
      expect(output.dataset.wupageContainer).toBe("image-text");
      expect(output.dataset.wupageDisplayMode).toBe(mode);
      expect(output.getAttribute("aria-hidden")).toBe(mode === "replace" ? null : "true");
      expect(document.querySelector(".wupage-translation-pending")).toBeNull();
      expect(image.alt).toBe(sourceAlt);
      expect(image.hidden).toBe(false);
      expect(image.classList.contains("wupage-replaced-source")).toBe(false);

      clearTranslations();
      expect(document.querySelector(".wupage-translation")).toBeNull();
      expect(image.alt).toBe(sourceAlt);
      expect(hasPageTranslations()).toBe(false);
    }
  );

  it("clears image placeholders on failure and leaves no translation state", async () => {
    mountPicture();
    const segments = (await collectTextSegmentsProgressive());
    renderTranslationPlaceholders(segments);
    clearTranslationPlaceholders(segments);

    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(hasPageTranslations()).toBe(false);
  });

  it.each(["rgb(0, 0, 0)", "rgb(240, 240, 240)"])(
    "uses the document's text color for image descriptions on a %s text page",
    async (color) => {
      vi.mocked(window.getComputedStyle).mockReturnValue({
        display: "block", visibility: "visible", opacity: "1", color,
        backgroundColor: color === "rgb(0, 0, 0)" ? "rgb(255, 255, 255)" : "rgb(23, 32, 38)"
      } as CSSStyleDeclaration);
      document.body.innerHTML = '<p><img src="trpl04-06.svg"></p>';
      const image = document.querySelector("img")!;
      image.alt = "Three tables: the table for s contains only a pointer to the table for s1. The table for s1 contains the stack data for s1 and points to the string data on the heap.";
      const [segment] = (await collectTextSegmentsProgressive());
      renderTranslations([{ id: segment.id, text: "三张表及它们之间的指针关系。" }]);
      const output = image.nextElementSibling as HTMLElement;
      expect(output.style.color).toBe(color);
      expect(output.textContent).toBe("三张表及它们之间的指针关系。");
      setTranslationDisplayMode("bilingual-accent");
      expect((image.nextElementSibling as HTMLElement).style.color).not.toBe(color);
      setTranslationDisplayMode("replace");
      expect((image.nextElementSibling as HTMLElement).style.color).toBe(color);
      expect(image.classList.contains("wupage-replaced-source")).toBe(false);
    }
  );

  it("leaves no output when the translation matches the source", async () => {
    mountPicture();
    const segments = (await collectTextSegmentsProgressive());
    renderTranslationPlaceholders(segments);
    renderTranslations(segments);

    expect(hasPageTranslations()).toBe(false);
  });

  it.each(["img", "picture"])("clears a sibling translation when clearing %s", async (selector) => {
    mountPicture();
    const segments = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segments[0].id, text: translation }]);

    clearTranslationsIn(document.querySelector(selector)!);

    expect(hasPageTranslations()).toBe(false);
    expect((await collectAdditionalTextSegmentsProgressive([document.body]))).toHaveLength(1);
  });

  it("releases outdated alt text and removes the old translation", async () => {
    const image = mountPicture();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: translation }]);
    image.alt = paragraphs.slice().reverse().join(" ");

    expect(invalidateStaleSegments()).toContain(segment.id);
    expect(document.querySelector(".wupage-translation")).toBeNull();
    const [updated] = (await collectAdditionalTextSegmentsProgressive([document.body]));
    expect(updated.id).not.toBe(segment.id);
    expect(updated.text).toBe(image.alt);
  });

  it("removes translation state when an image loses its paragraph text", async () => {
    const image = mountPicture();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: translation }]);
    image.alt = "";

    invalidateStaleSegments();

    expect(hasPageTranslations()).toBe(false);
    expect((await collectAdditionalTextSegmentsProgressive([document.body]))).toEqual([]);
  });

  it("follows a picture moved into a different container", async () => {
    const image = mountPicture();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: translation }]);
    const container = document.body.appendChild(document.createElement("section"));
    container.append(image.closest("picture")!);

    invalidateStaleSegments();
    const [updated] = (await collectAdditionalTextSegmentsProgressive([container]));
    renderTranslations([{ id: updated.id, text: translation }]);

    expect(container.querySelector(".wupage-translation")?.textContent).toBe(translation);
    expect(document.querySelector(".p-intro__lead .wupage-translation")).toBeNull();
  });

  it("keeps the translation in the same named slot as a standalone image", () => {
    document.body.innerHTML = `<custom-card><img slot="body"></custom-card>`;
    const image = document.querySelector("img")!;
    image.alt = sourceAlt;
    const [segment] = collectParagraphTextSegments(image);
    renderTranslations([{ id: segment.id, text: translation }]);

    expect(image.nextElementSibling?.getAttribute("slot")).toBe("body");
    expect(image.nextElementSibling?.textContent).toBe(translation);
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)(
    "pairs original image paragraphs with translations in %s mode",
    async (mode) => {
      vi.spyOn(imageTextLayout, "readImageTextLayout").mockReturnValue({
        width: 600, height: 240, foreground: "rgb(240, 240, 240)", fontRatio: 0.04,
        slices: [{ top: 0, bottom: 80 }, { top: 80, bottom: 240 }]
      });
      const image = mountPicture();
      const [segment] = (await collectTextSegmentsProgressive());
      renderTranslations([{ id: segment.id, text: translation }], mode);

      const output = image.closest("picture")!.nextElementSibling as HTMLElement;
      expect(output.dataset.wupageImageLayout).toBe("interleaved");
      expect(output.querySelectorAll(".wupage-image-text-row")).toHaveLength(2);
      expect([...output.querySelectorAll(".wupage-image-text-result")].map((result) => result.textContent))
        .toEqual(translation.split("\n\n"));
      const originals = [...output.querySelectorAll<HTMLImageElement>(".wupage-image-text-original img")];
      expect(originals.map((original) => original.alt)).toEqual(mode === "replace" ? [] : paragraphs);
      expect(image.classList.contains("wupage-replaced-source")).toBe(true);
      expect(output.getAttribute("aria-hidden")).toBeNull();
      expect(output.style.color).toBe("rgb(240, 240, 240)");
      expect((await collectAdditionalTextSegmentsProgressive([document.body]))).toEqual([]);

      clearTranslations();
      expect(image.classList.contains("wupage-replaced-source")).toBe(false);
      expect(image.alt).toBe(sourceAlt);
      expect(hasPageTranslations()).toBe(false);
    }
  );

  it("restores the original before rescanning a removed interleaved translation", async () => {
    vi.spyOn(imageTextLayout, "readImageTextLayout").mockReturnValue({
      width: 600, height: 240, foreground: "rgb(240, 240, 240)", fontRatio: 0.04,
      slices: [{ top: 0, bottom: 80 }, { top: 80, bottom: 240 }]
    });
    const image = mountPicture();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: translation }]);
    document.querySelector(".wupage-translation")!.remove();

    expect(invalidateStaleSegments()).toContain(segment.id);
    expect(image.classList.contains("wupage-replaced-source")).toBe(false);
    expect((await collectAdditionalTextSegmentsProgressive([document.body]))).toHaveLength(1);
  });

  it("reuses translated image paragraphs while switching between replacement and bilingual display", async () => {
    vi.spyOn(imageTextLayout, "readImageTextLayout").mockReturnValue({
      width: 600, height: 240, foreground: "rgb(240, 240, 240)", fontRatio: 0.04,
      slices: [{ top: 0, bottom: 80 }, { top: 80, bottom: 240 }]
    });
    const image = mountPicture();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: translation }]);
    for (const mode of ["replace", "bilingual-accent", "bilingual"] as const) {
      setTranslationDisplayMode(mode);
      const output = image.closest("picture")!.nextElementSibling as HTMLElement;
      expect(output.dataset.wupageDisplayMode).toBe(mode);
      expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
      expect(output.querySelectorAll(".wupage-image-text-original")).toHaveLength(mode === "replace" ? 0 : 2);
      expect([...output.querySelectorAll(".wupage-image-text-result")].map((node) => node.textContent))
        .toEqual(translation.split("\n\n"));
      expect(invalidateStaleSegments()).toEqual([]);
    }
    clearTranslations();
    expect(image.classList.contains("wupage-replaced-source")).toBe(false);
  });

  it("keeps the whole translation if the provider drops paragraph boundaries", async () => {
    const image = mountPicture();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: translation.replace(/\n/g, " ") }]);

    expect(image.classList.contains("wupage-replaced-source")).toBe(false);
    expect(image.closest("picture")!.nextElementSibling?.textContent).toBe(translation.replace(/\n/g, " "));
  });

  it("restores a split original when a later response cannot be paired", async () => {
    vi.spyOn(imageTextLayout, "readImageTextLayout").mockReturnValue({
      width: 600, height: 240, foreground: "rgb(240, 240, 240)", fontRatio: 0.04,
      slices: [{ top: 0, bottom: 80 }, { top: 80, bottom: 240 }]
    });
    const image = mountPicture();
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: translation }]);
    renderTranslations([{ id: segment.id, text: "没有段落边界的译文" }]);

    expect(image.classList.contains("wupage-replaced-source")).toBe(false);
    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
    expect(image.closest("picture")!.nextElementSibling?.textContent).toBe("没有段落边界的译文");
  });

  it("revisits a caption when its text image finishes loading", async () => {
    const image = mountPicture();
    Object.defineProperty(image, "complete", { configurable: true, value: false });
    const [segment] = (await collectTextSegmentsProgressive());
    renderTranslations([{ id: segment.id, text: translation }]);
    Object.defineProperty(image, "complete", { configurable: true, value: true });
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 600 });

    expect(invalidateStaleSegments()).toContain(segment.id);
    expect((await collectAdditionalTextSegmentsProgressive([document.body]))).toHaveLength(1);
  });
});
