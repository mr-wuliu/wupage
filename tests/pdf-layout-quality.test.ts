// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateTranslationLayout } from "../src/pdf/layout-quality";
import { paintTranslationLayer } from "../src/pdf/export";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("PDF layout quality gate", () => {
  it("blocks overlapping text and clears the error after the user moves a block", () => {
    const layer = document.createElement("div");
    layer.style.width = "200px";
    for (const [id, top] of [["first", 0], ["second", 8]] as const) {
      const block = document.createElement("div"); block.className = "translation-block"; block.dataset.blockId = id;
      block.style.top = `${top}px`;
      const text = document.createElement("div"); text.className = "translation-block-text"; text.textContent = "完整译文";
      const bounds = () => new DOMRect(0, Number.parseFloat(block.style.top), 80, 12);
      vi.spyOn(block, "getBoundingClientRect").mockImplementation(bounds);
      vi.spyOn(text, "getBoundingClientRect").mockImplementation(bounds);
      block.append(text); layer.append(block);
    }
    document.body.append(layer);
    let selected: HTMLElement;
    vi.spyOn(document, "createRange").mockImplementation(() => ({
      selectNodeContents: (node: HTMLElement) => { selected = node; },
      getClientRects: () => [selected.getBoundingClientRect()]
    }) as unknown as Range);
    expect(validateTranslationLayout(layer)).toEqual({ collisions: [["first", "second"]], unsafe: 2 });
    expect(layer.querySelectorAll("[data-layout-collision]")).toHaveLength(2);
    expect(() => paintTranslationLayer({} as CanvasRenderingContext2D, layer)).toThrow("超出可读排版范围");
    (layer.lastElementChild as HTMLElement).style.top = "20px";
    expect(validateTranslationLayout(layer)).toEqual({ collisions: [], unsafe: 0 });
    expect(layer.querySelectorAll("[data-layout-collision]")).toHaveLength(0);
  });
});
