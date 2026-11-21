// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.tiktok.com/@creator/video/1"}
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearTranslations, collectAdditionalTextSegmentsProgressive, collectParagraphTextSegments,
  collectTextSegmentsProgressive, findTranslatableParagraph, renderTranslationPlaceholders,
  renderTranslations, setTranslationDisplayMode
} from "../src/content/dom";
import { configureElementRules } from "../src/content/element-exclusions";
import { layoutDisplay } from "./helpers/layout-display";

beforeEach(() => {
  document.body.innerHTML = `<aside>
    <div style="display: flex; flex-direction: column">
      <a data-e2e="comment-username-1" href="/@viewer">Viewer</a>
      <div id="comment" data-e2e="comment-level-1"><span>Xinh điên dại quá chị 🥰</span><button>More</button></div>
      <button data-e2e="comment-reply-1">Reply</button>
    </div>
    <div id="replies"></div>
    <div contenteditable="true" data-e2e="comment-level-1">Unsent comment.</div>
    <span>Unrelated sidebar text.</span>
  </aside>`;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({
    display: element.hasAttribute("hidden") ? "none" : layoutDisplay(element),
    visibility: "visible", opacity: "1"
  }) as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 24));
});

afterEach(() => {
  clearTranslations();
  configureElementRules({});
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("collects the comment separately from its controls and renders beneath the expandable body", async () => {
  const comment = document.querySelector("#comment")!;
  const more = comment.querySelector("button")!;
  const original = comment.innerHTML;
  const segments = await collectTextSegmentsProgressive();
  const segment = segments.find(entry => entry.element === comment)!;
  expect(segment?.text).toBe("Xinh điên dại quá chị 🥰");
  expect(segments.map(entry => entry.text)).toContain("Reply");
  expect(segments.map(entry => entry.text)).not.toContain("Unsent comment.");

  renderTranslationPlaceholders([segment]);
  expect(comment.nextElementSibling?.classList.contains("wupage-translation-pending")).toBe(true);
  expect(renderTranslations([{ id: segment.id, text: "姐姐太漂亮了🥰" }])).toEqual([segment.id]);
  for (const mode of ["bilingual", "replace", "bilingual-accent"] as const) {
    setTranslationDisplayMode(mode);
    expect(comment.nextElementSibling?.textContent).toBe("姐姐太漂亮了🥰");
    expect(comment.nextElementSibling?.getAttribute("data-wupage-mode")).toBe("block");
    expect(comment.contains(more)).toBe(true);
  }
  clearTranslations();
  expect(comment.innerHTML).toBe(original);
  expect(comment.nextElementSibling?.textContent).toBe("Reply");
});

it("collects newly expanded replies once and supports translating a single reply", async () => {
  await collectTextSegmentsProgressive();
  const replies = document.querySelector("#replies")!;
  replies.innerHTML = `<span data-e2e="comment-level-2"><span>Mình cũng </span><em>thích video này.</em></span>`;
  const body = replies.firstElementChild!;
  const [reply] = await collectAdditionalTextSegmentsProgressive([replies]);
  expect(reply?.element).toBe(body);
  expect(reply.text).toBe("Mình cũng thích video này.");
  expect(await collectAdditionalTextSegmentsProgressive([replies])).toEqual([]);

  const target = findTranslatableParagraph(body.querySelector("em"));
  expect(target).toBe(body);
  const [paragraph] = collectParagraphTextSegments(target!);
  const translation = paragraph.requestText!.replace("Mình cũng ", "我也").replace("thích video này.", "喜欢这段视频。");
  expect(renderTranslations([{ id: paragraph.id, text: translation }])).toEqual([paragraph.id]);
  expect(body.nextElementSibling?.textContent).toBe("我也喜欢这段视频。");
});

it("respects hidden text, page opt-outs and user exclusions in the comment panel", async () => {
  document.querySelector("#replies")!.innerHTML = `
    <span data-e2e="comment-level-2" hidden>Hidden reply.</span>
    <span data-e2e="comment-level-2" translate="no">Opted-out reply.</span>
    <span data-e2e="comment-level-2" class="excluded">Excluded reply.</span>
    <span data-e2e="comment-level-2">Visible reply.</span>`;
  configureElementRules({ elementExclusions: [{
    id: "tiktok-exclusion", name: "TikTok exclusion", enabled: true, pattern: "www.tiktok.com", selectors: [".excluded"]
  }] });
  const texts = (await collectTextSegmentsProgressive()).map(entry => entry.text);
  expect(texts).toContain("Visible reply.");
  expect(texts.join(" ")).not.toMatch(/Hidden reply|Opted-out reply|Excluded reply|Unrelated sidebar/u);
});
