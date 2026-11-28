// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { findTranslatableParagraph, hasTranslationsIn } from "../src/content/dom";
import { clearPageTranslation, hidePageTranslation, setPageTranslationDisplayMode, startPageTranslation } from "../src/content/page-translation";
import { translateParagraph } from "../src/content/paragraph-translation";
import { sendRuntimeRequest } from "../src/content/runtime";
import { structuredTranslation, withoutMarkup } from "./helpers/structured-translation";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 600, bottom: 30, width: 600, height: 30, x: 0, y: 0, toJSON: () => ({})
  });
  setPageTranslationDisplayMode("bilingual");
  vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
    if (request.type === "GET_SETTINGS") return structuredClone(DEFAULT_SETTINGS);
    if (request.type === "TRANSLATE_BATCH") return { translations: request.texts.map(text => structuredTranslation(text, "这是完整段落的译文。")), cached: 0 };
  });
});

afterEach(() => {
  clearPageTranslation(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.mocked(sendRuntimeRequest).mockReset();
});

const requests = () => vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request)
  .filter(request => request.type === "TRANSLATE_BATCH");
const targetAt = (selector: string) => findTranslatableParagraph(document.querySelector(selector))!;

describe("paragraph translation clicks", () => {
  it.each(["replace", "bilingual", "bilingual-accent"] as const)(
    "keeps a restored paragraph in source view during %s page translation", async translationDisplayMode => {
      document.body.innerHTML = '<main><p id="paragraph">Read <em id="first">this complete guide</em> before continuing.</p><p id="other">This paragraph stays translated.</p></main>';
      const paragraph = document.querySelector("#paragraph")!;
      const other = document.querySelector("#other")!;
      const source = paragraph.textContent;
      const originalMarkup = paragraph.innerHTML;
      const options = { ...structuredClone(DEFAULT_SETTINGS), translationDisplayMode };
      await startPageTranslation(options);
      expect(hasTranslationsIn(paragraph)).toBe(true);
      expect(hasTranslationsIn(other)).toBe(true);

      await translateParagraph(targetAt("#first"));
      expect(paragraph.textContent).toBe(source);
      // A framework can rebuild a paragraph's text nodes without changing its source.
      paragraph.innerHTML = originalMarkup;
      const inserted = document.createElement("p");
      inserted.textContent = "This new paragraph still gets translated.";
      other.after(inserted);
      window.dispatchEvent(new Event("resize"));
      await vi.waitFor(() => expect(hasTranslationsIn(inserted)).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 240));
      expect(hasTranslationsIn(paragraph)).toBe(false);
      expect(paragraph.textContent).toBe(source);
      expect(hasTranslationsIn(other)).toBe(true);
      expect(requests().flatMap(request => request.texts).map(withoutMarkup).filter(text => text === source)).toHaveLength(1);

      setPageTranslationDisplayMode(translationDisplayMode === "replace" ? "bilingual" : "replace");
      expect(hasTranslationsIn(paragraph)).toBe(false);
      await hidePageTranslation();
      await startPageTranslation(options);
      expect(hasTranslationsIn(paragraph)).toBe(false);
      expect(hasTranslationsIn(other)).toBe(true);

      await translateParagraph(targetAt("#first"));
      expect(hasTranslationsIn(paragraph)).toBe(true);
    }
  );

  it("does not display an in-flight page result after restoring its paragraph", async () => {
    document.body.innerHTML = '<main><p id="paragraph">Source paragraph waiting for a translation.</p><p id="other">Another paragraph still wants a translation.</p></main>';
    const paragraph = document.querySelector("#paragraph")!;
    const other = document.querySelector("#other")!;
    const normal = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    let finish!: (response: { translations: string[]; cached: number }) => void;
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const page = startPageTranslation(structuredClone(DEFAULT_SETTINGS));
    await vi.waitFor(() => expect(hasTranslationsIn(paragraph)).toBe(true));
    await translateParagraph(targetAt("#paragraph"));
    expect(hasTranslationsIn(paragraph)).toBe(false);
    finish({ translations: requests()[0].texts.map(text => structuredTranslation(text, "这是完整段落的译文。")), cached: 0 });
    expect(await page).toMatchObject({ failed: 0 });
    expect(hasTranslationsIn(paragraph)).toBe(false);
    expect(hasTranslationsIn(other)).toBe(true);

    vi.mocked(sendRuntimeRequest).mockImplementation(normal);
    paragraph.textContent = "Different content in a reused paragraph.";
    await vi.waitFor(() => expect(paragraph.querySelector(".wupage-translation")?.textContent).toBe("这是完整段落的译文。"));
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)("renders the first %s result after the hover highlight moves away", async mode => {
    setPageTranslationDisplayMode(mode);
    document.body.innerHTML = '<main><p id="paragraph" data-wupage-paragraph-active="true">Read <em>this complete guide</em> before continuing.</p></main>';
    const paragraph = document.querySelector("#paragraph")!;
    let finish!: (response: { translations: string[]; cached: number }) => void;
    const normal = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(request => request.type === "TRANSLATE_BATCH"
      ? new Promise(resolve => { finish = resolve; }) : normal(request));
    const task = translateParagraph(paragraph);
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0].texts[0]).toContain("⟪WUPAGEOPEN");
    paragraph.removeAttribute("data-wupage-paragraph-active");
    finish({ translations: requests()[0].texts.map(text => structuredTranslation(text, "这是完整段落的译文。")), cached: 0 });
    await task;
    expect(document.body.textContent).toContain("这是完整段落的译文。");
    expect(document.querySelector(".wupage-translation-pending")).toBeNull();
    expect(requests()).toHaveLength(1);
    await translateParagraph(paragraph);
    expect(paragraph.textContent).toBe("Read this complete guide before continuing.");
  });

  it.each([
    '<div id="paragraph"><span id="first">Read <em id="second">this complete guide</em> before continuing.</span></div>',
    '<div><span id="paragraph">Read <em id="first">this complete guide</em><br><strong id="second">before continuing.</strong><br></span></div>',
    '<blockquote id="paragraph"><div><span id="first">Read <em id="second">this complete guide</em> before continuing.</span></div></blockquote>'
  ])("restores a rich paragraph on repeated clicks without accumulating sibling translations: %s", async markup => {
    document.body.innerHTML = `<main>${markup}<p id="untouched">Leave this paragraph alone.</p></main>`;
    const paragraph = document.querySelector("#paragraph")!;
    const original = paragraph.innerHTML;
    for (let index = 0; index < 3; index++) {
      await translateParagraph(targetAt("#first"));
      expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
      expect(requests().at(-1)!.texts.map(withoutMarkup)).toEqual(["Read this complete guide before continuing."]);
      await translateParagraph(targetAt("#second"));
      expect(document.querySelectorAll(".wupage-translation")).toHaveLength(0);
      expect(paragraph.innerHTML).toBe(original);
    }
    expect(requests()).toHaveLength(3);
    expect(document.querySelector("#untouched")!.textContent).toBe("Leave this paragraph alone.");
  });

  it("coalesces clicks on different inline children while settings are loading", async () => {
    document.body.innerHTML = '<main><div><span id="first">Read this complete guide carefully</span> <em id="second">before continuing to the next chapter.</em></div></main>';
    let finish!: (settings: typeof DEFAULT_SETTINGS) => void;
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = translateParagraph(targetAt("#first"));
    const second = translateParagraph(targetAt("#second"));
    finish(structuredClone(DEFAULT_SETTINGS));
    await Promise.all([first, second]);
    expect(requests()).toHaveLength(1);
    expect(requests()[0].texts.map(withoutMarkup)).toEqual(["Read this complete guide carefully before continuing to the next chapter."]);
    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
  });

  it("ignores an old response after restoring and translating the same paragraph again", async () => {
    document.body.innerHTML = '<main><div><span id="first">Read this complete guide carefully</span> <em id="second">before continuing to the next chapter.</em></div></main>';
    let finish!: (response: { translations: string[]; cached: number }) => void;
    const normal = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest).mockImplementation(request => request.type === "TRANSLATE_BATCH"
      ? new Promise(resolve => { finish = resolve; }) : normal(request));
    const old = translateParagraph(targetAt("#first"));
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    await translateParagraph(targetAt("#second"));
    expect(document.querySelector(".wupage-translation")).toBeNull();
    vi.mocked(sendRuntimeRequest).mockImplementation(normal);
    await translateParagraph(targetAt("#first"));
    finish({ translations: ["不应追加的旧译文"], cached: 0 });
    await old;
    expect(requests()).toHaveLength(2);
    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
    expect(document.querySelector(".wupage-translation")!.textContent).toContain("这是完整段落的译文。");
    expect(document.body.textContent).not.toContain("不应追加的旧译文");
  });
});
