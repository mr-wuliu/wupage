// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTranslations, collectParagraphTextSegments, refreshTranslationColors, renderTranslations } from "../src/content/dom";
import { mapTranslationTextColor } from "../src/shared/translation-colors";

afterEach(() => {
  clearTranslations();
  document.body.replaceChildren();
  refreshTranslationColors();
  vi.restoreAllMocks();
});

describe("paragraph typography", () => {
  const translate = () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 600, height: 80, top: 0, left: 0,
      bottom: 80, right: 600, x: 0, y: 0, toJSON: () => ({}) });
    const source = document.querySelector<HTMLElement>("#source")!;
    const segments = collectParagraphTextSegments(source);
    renderTranslations(segments.map(({ id }) => ({ id, text: "完整的段落译文应保留原文的字号。" })));
    return { source, output: document.querySelector<HTMLElement>(".wupage-translation")! };
  };

  it("keeps a rich paragraph's typography when its translation is outside the source", () => {
    document.body.innerHTML = '<main style="font:16px Arial"><p id="source" style="font:italic 500 28px/1.4 Georgia;letter-spacing:.4px">A complete <em>paragraph with emphasis</em> retains its typography.</p></main>';
    const { source, output } = translate();
    expect(output).not.toBeNull();
    expect(source.contains(output)).toBe(false);
    expect(output.style.fontSize).toBe("28px");
    expect(output.style.fontFamily).toBe("Georgia");
    expect(output.style.fontWeight).toBe("500");
    expect(output.style.fontStyle).toBe("italic");
    expect(output.style.letterSpacing).toBe("0.4px");
    expect(output.style.getPropertyPriority("font-size")).toBe("important");
  });

  it("updates an existing sibling after the host changes typography without replacing the result", async () => {
    document.body.innerHTML = '<div><span id="source" style="font-family:Georgia;font-size:24px;font-weight:600">First authored sentence with enough text.<br>Second sentence on its own line.<br></span></div>';
    const { source, output } = translate();
    expect(source.contains(output)).toBe(false);
    expect(output.style.fontSize).toBe("24px");
    source.style.fontSize = "31px";
    source.style.fontWeight = "700";
    await vi.waitFor(() => {
      expect(output.style.fontSize).toBe("31px");
      expect(output.style.fontWeight).toBe("700");
    });
    expect(document.querySelector(".wupage-translation")).toBe(output);
    clearTranslations();
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(source.style.fontSize).toBe("31px");
    expect(source.querySelectorAll("br")).toHaveLength(2);
  });

  it("leaves a descendant translation free to inherit responsive source styles", () => {
    document.body.innerHTML = '<h2 id="source" style="font:400 42px Georgia">A language empowering everyone<br>to build reliable software.</h2>';
    const { source, output } = translate();
    expect(source.contains(output)).toBe(true);
    expect(output.dataset.wupageContainer).toBe("heading");
    expect(output.style.fontSize).toBe("");
    expect(output.style.fontWeight).toBe("");
  });
});

describe("custom bilingual colors", () => {
  const colors = { light: "#aa3344", dark: "#f3c97a" };
  it("selects colors using the webpage background, independently of interface mode", () => {
    expect(mapTranslationTextColor("rgb(30, 30, 30)", "rgb(255, 255, 255)", colors)).toBe("rgb(170, 51, 68)");
    expect(mapTranslationTextColor("rgb(240, 240, 240)", "rgb(23, 32, 38)", colors)).toBe("rgb(243, 201, 122)");
  });

  it("adjusts unreadable choices to preserve contrast", () => {
    const color = mapTranslationTextColor("rgb(30, 30, 30)", "rgb(255, 255, 255)", { light: "#ffffff", dark: "#000000" })!;
    const channel = Number(color.match(/\d+/)![0]) / 255;
    const luminance = channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    expect(1.05 / (luminance + .05)).toBeGreaterThanOrEqual(4.55);
    expect(mapTranslationTextColor("rgb(240, 240, 240)", "rgb(0, 0, 0)", { light: "#fffefe", dark: "#000000" })).not.toBe("rgb(0, 0, 0)");
  });

  it("preserves configured transparency on both light and dark pages, including zero opacity", () => {
    const transparent = { light: "rgba(170, 51, 68, 0.3)", dark: "rgba(243, 201, 122, 0.25)" };
    expect(mapTranslationTextColor("rgb(30, 30, 30)", "rgb(255, 255, 255)", transparent)).toBe(transparent.light);
    expect(mapTranslationTextColor("rgb(240, 240, 240)", "rgb(23, 32, 38)", transparent)).toBe(transparent.dark);
    expect(mapTranslationTextColor("rgb(30, 30, 30)", "rgb(255, 255, 255)", { ...transparent, light: "rgba(170, 51, 68, 0)" })).toBe("rgba(170, 51, 68, 0)");
  });

  it("keeps the chosen hue distinguishable when the source already uses it", () => {
    const result = mapTranslationTextColor("rgb(15, 118, 110)", "rgb(255, 255, 255)", { light: "#0f766e", dark: "#5eead4" });
    expect(result).not.toBe("rgb(15, 118, 110)");
  });

  it("recolors completed paragraph translations in place while preserving original-color mode", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 80));
    document.body.innerHTML = '<p id="light" style="color:rgb(30,30,30);background:rgb(255,255,255)">Original text.</p><p id="dark" style="color:rgb(240,240,240);background:rgb(23,32,38)">Other original.</p><p id="original" style="color:rgb(30,30,30);background:rgb(255,255,255)">Keep original color.</p>';
    const light = document.querySelector<HTMLElement>("#light")!, dark = document.querySelector<HTMLElement>("#dark")!;
    const translate = (element: Element, text: string, mode: "bilingual" | "bilingual-accent") =>
      renderTranslations(collectParagraphTextSegments(element).map(segment => ({ id: segment.id, text })), mode);
    translate(light, "浅色译文", "bilingual-accent");
    translate(dark, "深色译文", "bilingual-accent");
    translate(document.querySelector("#original")!, "原色译文", "bilingual");
    const rendered = light.querySelector<HTMLElement>(".wupage-translation")!;
    refreshTranslationColors(colors);
    expect(light.querySelector(".wupage-translation")).toBe(rendered);
    expect(rendered.style.color).toBe("rgb(170, 51, 68)");
    expect(rendered.textContent).toBe("浅色译文");
    expect(dark.querySelector<HTMLElement>(".wupage-translation")!.style.color).toBe("rgb(243, 201, 122)");
    expect(document.querySelector<HTMLElement>("#original .wupage-translation")!.style.color).toBe("rgb(30, 30, 30)");
    expect(light.style.color).toBe("rgb(30, 30, 30)");
  });
});
