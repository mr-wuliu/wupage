// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { translateShortcutParagraphs } from "../src/content/paragraph-shortcut";
import { clearPageTranslation, setPageTranslationDisplayMode } from "../src/content/page-translation";
import { sendRuntimeRequest } from "../src/content/runtime";
import { hasTranslationsIn } from "../src/content/dom";
import { structuredTranslation } from "./helpers/structured-translation";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));

beforeEach(() => {
  document.body.innerHTML = '<main><p id="first" tabindex="0">Read this <a href="#"><span>complete paragraph</span></a> before continuing.</p><p id="second">Read this other paragraph too.</p><p id="third">Leave this paragraph alone.</p></main><p id="editable" contenteditable="true">Private draft text.</p><div id="wupage-floating-menu"><p>Extension controls.</p></div>';
  const settings = { ...structuredClone(DEFAULT_SETTINGS), floatingBallEnabled: false, contextMenuTranslationEnabled: false,
    selectionTranslation: { enabled: false, provider: "bing", style: "underline" } };
  vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
    if (request.type === "GET_SETTINGS") return settings;
    if (request.type === "TRANSLATE_BATCH") return { translations: request.texts.map(text => structuredTranslation(text, "这是完整段落的译文。")), cached: 0 };
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 10, top: 10, right: 610, bottom: 40, width: 600, height: 30, x: 10, y: 10, toJSON: () => ({}) });
  window.getSelection()?.removeAllRanges();
  setPageTranslationDisplayMode("bilingual");
});
afterEach(() => {
  clearPageTranslation(); window.getSelection()?.removeAllRanges(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.mocked(sendRuntimeRequest).mockReset();
});

function select(range: Range): void { window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); }
const requests = () => vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request).filter(request => request.type === "TRANSLATE_BATCH");

describe("paragraph translation shortcut", () => {
  it("expands a partial text selection to the whole paragraph and restores it on the next press", async () => {
    const text = document.querySelector("#first span")!.firstChild!;
    const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 4); select(range);
    await translateShortcutParagraphs();
    expect(requests()).toHaveLength(1);
    expect(requests()[0].texts.join(" ")).toContain("Read this");
    expect(requests()[0].texts.join(" ")).toContain("before continuing.");
    expect(document.querySelector(".wupage-translation")?.textContent).toContain("完整段落");
    expect(document.querySelector("#first a")?.getAttribute("href")).toBe("#");
    expect(hasTranslationsIn(document.querySelector("#second")!)).toBe(false);
    expect(document.querySelector("#wupage-selection-tools")).toBeNull();
    await translateShortcutParagraphs();
    expect(hasTranslationsIn(document.querySelector("#first")!)).toBe(false);
    expect(requests()).toHaveLength(1);
  });

  it("translates each selected paragraph once without touching unselected paragraphs", async () => {
    const range = document.createRange();
    range.setStart(document.querySelector("#first")!.firstChild!, 2);
    const last = document.querySelector("#second")!.firstChild!;
    range.setEnd(last, last.textContent!.length); select(range);
    await translateShortcutParagraphs();
    expect(requests()).toHaveLength(2);
    expect(hasTranslationsIn(document.querySelector("#first")!)).toBe(true);
    expect(hasTranslationsIn(document.querySelector("#second")!)).toBe(true);
    expect(hasTranslationsIn(document.querySelector("#third")!)).toBe(false);
  });

  it("does not include a paragraph when the selection ends at its first character", async () => {
    const range = document.createRange(); range.setStart(document.querySelector("#first")!.firstChild!, 0);
    range.setEnd(document.querySelector("#second")!.firstChild!, 0); select(range);
    await translateShortcutParagraphs();
    expect(requests()).toHaveLength(1);
    expect(hasTranslationsIn(document.querySelector("#second")!)).toBe(false);
  });

  it("uses the hovered paragraph without requiring selection or reading feature switches", async () => {
    vi.spyOn(document, "querySelectorAll").mockReturnValueOnce(document.querySelectorAll("#first span"));
    await translateShortcutParagraphs();
    expect(requests()).toHaveLength(1);
    expect(hasTranslationsIn(document.querySelector("#first")!)).toBe(true);
  });

  it("restores the original paragraph when the pointer is over its translation", async () => {
    document.querySelector<HTMLElement>("#first")!.focus();
    await translateShortcutParagraphs();
    document.querySelector<HTMLElement>("#first")!.blur();
    const translated = document.querySelectorAll(".wupage-translation");
    vi.spyOn(document, "querySelectorAll").mockReturnValueOnce(translated);
    await translateShortcutParagraphs();
    expect(hasTranslationsIn(document.querySelector("#first")!)).toBe(false);
    expect(requests()).toHaveLength(1);
  });

  it.each(["#editable", "#wupage-floating-menu p"])("ignores private or extension-owned selections in %s", async selector => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector(selector)!); select(range);
    await expect(translateShortcutParagraphs()).rejects.toThrow("正文段落");
    expect(sendRuntimeRequest).not.toHaveBeenCalled();
  });

  it("asks for a paragraph when neither selection nor pointer supplies a target", async () => {
    await expect(translateShortcutParagraphs()).rejects.toThrow("正文段落");
    expect(sendRuntimeRequest).not.toHaveBeenCalled();
  });
});
