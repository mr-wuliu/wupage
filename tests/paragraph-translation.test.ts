// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { findTranslatableParagraph } from "../src/content/dom";
import { clearPageTranslation, setPageTranslationDisplayMode } from "../src/content/page-translation";
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
