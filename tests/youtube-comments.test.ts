// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations,
  collectAdditionalTextSegmentsProgressive,
  collectParagraphTextSegments,
  collectTextSegmentsProgressive,
  findTranslatableParagraph,
  invalidateStaleSegments,
  renderTranslationPlaceholders,
  renderTranslations,
  setTranslationDisplayMode
} from "../src/content/dom";

describe.each(["ytd-comment-view-model", "ytd-comment-renderer"])("%s comment layout", (renderer) => {
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      display: "inline", visibility: "visible", opacity: "1", whiteSpace: "pre-wrap"
    } as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 900, height: 20, top: 0, left: 0, right: 900, bottom: 20,
      x: 0, y: 0, toJSON: () => ({})
    } as DOMRect);
  });

  afterEach(() => {
    clearTranslations();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  const mount = (content: string): Element => {
    const hostTag = renderer === "ytd-comment-renderer" ? "yt-formatted-string" : "yt-attributed-string";
    document.body.innerHTML = `<${renderer}><div id="body"><${hostTag} id="content-text"><span class="yt-core-attributed-string">${content}</span></${hostTag}></div></${renderer}>`;
    return document.querySelector("#content-text")!;
  };

  it.each([
    "Wonderful video!",
    "Great video",
    "The footage and the information in these videos are so valuable that I could easily watch even more than an hour. Please make the videos longer!",
    'Please <b>keep</b> making these videos. See <a href="/watch?v=example">the previous episode</a> for more details.'
  ])("places one complete translation below the comment: %s", async (content) => {
    const host = mount(content);
    const original = document.body.innerHTML;
    const links = [...host.querySelectorAll("a")];
    const [segment, ...rest] = (await collectTextSegmentsProgressive());
    expect(rest).toEqual([]);
    expect(segment.element).toBe(host);
    expect(segment.text).toBe(host.textContent);
    renderTranslationPlaceholders([segment]);
    expect(host.lastElementChild?.getAttribute("data-wupage-mode")).toBe("block");
    renderTranslations([{ id: segment.id, text: "从新的一行开始显示完整评论译文。" }]);
    for (const mode of ["bilingual", "bilingual-accent", "replace", "bilingual"] as const) {
      setTranslationDisplayMode(mode);
      const output = host.querySelector<HTMLElement>(".wupage-translation")!;
      expect(output.parentElement).toBe(host);
      expect(output.dataset.wupageMode).toBe("block");
      expect(output.dataset.wupageDisplayMode).toBe(mode);
      expect(host.querySelectorAll(".wupage-translation")).toHaveLength(1);
      expect([...host.querySelectorAll("a")]).toEqual(links);
      expect(invalidateStaleSegments()).toEqual([]);
      expect((await collectAdditionalTextSegmentsProgressive([host]))).toEqual([]);
    }
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it("selects the whole comment for paragraph translation and recollects edited text", async () => {
    const host = mount('Please <b>keep</b> making these videos.');
    expect(findTranslatableParagraph(host.querySelector("b"))).toBe(host);
    const [segment] = collectParagraphTextSegments(host);
    renderTranslations([{ id: segment.id, text: "请继续制作这些视频。" }]);
    host.querySelector("b")!.textContent = "continue";
    expect(invalidateStaleSegments()).toContain(segment.id);
    const [updated] = (await collectAdditionalTextSegmentsProgressive([host]));
    expect(updated.element).toBe(host);
    expect(updated.text).toBe("Please continue making these videos.");
    renderTranslations([{ id: updated.id, text: "请继续制作这些视频。" }]);
    expect(host.querySelectorAll(".wupage-translation")).toHaveLength(1);
  });

  it("leaves unrelated attributed UI text in inline mode", async () => {
    mount("Wonderful video!");
    document.body.insertAdjacentHTML("beforeend", '<a href="/channel/example"><yt-attributed-string id="channel-name">example channel</yt-attributed-string></a>');
    const segments = (await collectTextSegmentsProgressive());
    renderTranslations(segments.map(({ id }) => ({ id, text: "译文" })));
    expect(document.querySelector("#channel-name .wupage-translation")?.getAttribute("data-wupage-mode")).toBe("inline");
  });
});
