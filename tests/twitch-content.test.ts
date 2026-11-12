// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.twitch.tv/meltonff"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations, collectAdditionalTextSegmentsProgressive, collectParagraphTextSegments,
  collectTextSegmentsProgressive, findTranslatableParagraph, invalidateStaleSegments,
  renderTranslations, setTranslationDisplayMode
} from "../src/content/dom";
import { layoutDisplay } from "./helpers/layout-display";
import { structuredTranslation } from "./helpers/structured-translation";
import { isTwitchChatIdentity, twitchMessageBody } from "../src/content/twitch-content";

const message = (id: number, text: string) => `<div class="chat-line__message" role="group" tabindex="0" data-a-target="chat-line-message">
  <div class="chat-line__message-container"><div class="chat-line__no-background"><div>
    <div class="chat-line__username-container"><span class="chat-line__username" role="button" tabindex="0"><span
      class="chat-author__display-name" data-a-target="chat-message-username">Viewer${id}</span></span></div><span aria-hidden="true">: </span>
    <span id="message-${id}" data-a-target="chat-line-message-body" dir="auto">${text}</span>
  </div></div></div></div>`;
const fragment = (text: string) => `<span class="text-fragment" data-a-target="chat-message-text">${text}</span>`;

beforeEach(() => {
  document.body.innerHTML = `<main><p>Stream description.</p></main><aside class="right-column">
    <section data-a-target="chat-room-component-layout"><div role="log" data-test-selector="chat-scrollable-area__message-container">
      ${message(1, fragment("自分の感想やめて"))}${message(2, fragment("見方から話しかけてたよ"))}
    </div><div contenteditable="true" role="textbox">Unsent chat draft.</div></section>
    <span>Unrelated sidebar text.</span></aside>`;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({
    display: element.hasAttribute("hidden") ? "none" : layoutDisplay(element),
    visibility: "visible", opacity: "1"
  }) as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 312, 24));
});
afterEach(() => { clearTranslations(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("Twitch chat content", () => {
  it("collects sidebar message bodies without translating identities or editor drafts", async () => {
    expect((await collectTextSegmentsProgressive()).map(segment => segment.text)).toEqual([
      "Stream description.", "自分の感想やめて", "見方から話しかけてたよ"
    ]);
  });

  it("keeps text fragments and links in one message, separately from its author and neighboring messages", async () => {
    document.querySelector("#message-1")!.innerHTML = `${fragment("Please read ")}<a href="https://example.com/guide">this guide</a>${fragment(" before playing.")}`;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual([
      "Stream description.", "Please read this guide before playing.", "見方から話しかけてたよ"
    ]);
    expect(segments[1].element).toBe(document.querySelector("#message-1"));
  });

  it("collects newly appended messages only once", async () => {
    await collectTextSegmentsProgressive();
    const log = document.querySelector('[role="log"]')!;
    log.insertAdjacentHTML("beforeend", message(3, fragment("もっとゆっくり話してください")));
    expect((await collectAdditionalTextSegmentsProgressive([log])).map(segment => segment.text)).toEqual(["もっとゆっくり話してください"]);
    expect(await collectAdditionalTextSegmentsProgressive([log])).toEqual([]);
  });

  it("also collects message bodies in standalone popout chat", async () => {
    const aside = document.querySelector("aside")!;
    aside.replaceWith(...aside.childNodes);
    const segments = (await collectTextSegmentsProgressive()).filter(segment => segment.element.closest(".chat-line__message"));
    expect(segments.map(segment => segment.text)).toEqual(["自分の感想やめて", "見方から話しかけてたよ"]);
  });

  it("does not apply the Twitch policy to markup in another document", () => {
    const other = new DOMParser().parseFromString(message(1, fragment("Ordinary site content.")), "text/html");
    expect(twitchMessageBody(other.querySelector(".text-fragment")!)).toBeNull();
    expect(isTwitchChatIdentity(other.querySelector("[data-a-target='chat-message-username']")!)).toBe(false);
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)("preserves original links and emotes with structured translation in %s mode", async mode => {
    const body = document.querySelector("#message-1")!;
    body.innerHTML = `${fragment("Please read ")}<a href="https://example.com/guide">this guide</a>${fragment(" before playing.")}<button data-a-target="emote-button"><img alt="Kappa"></button>`;
    const original = body.innerHTML, link = body.querySelector("a")!, image = body.querySelector("img")!;
    const segment = (await collectTextSegmentsProgressive()).find(segment => segment.element === body)!;
    const source = segment.requestText!;
    expect(renderTranslations([{ id: segment.id, text: structuredTranslation(source, "聊天译文。") }], mode)).toEqual([segment.id]);
    expect(body.contains(link)).toBe(true);
    expect(body.contains(image)).toBe(true);
    clearTranslations();
    expect(body.innerHTML).toBe(original);
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)("renders, switches and restores message text in %s mode", async mode => {
    const original = document.body.innerHTML;
    const segments = (await collectTextSegmentsProgressive()).filter(segment => segment.element.closest('[data-a-target="chat-line-message-body"]'));
    expect(segments).toHaveLength(2);
    expect(renderTranslations(segments.map(({ id }) => ({ id, text: "聊天消息译文。" })), mode)).toEqual(segments.map(segment => segment.id));
    for (const next of ["replace", "bilingual", "bilingual-accent"] as const) {
      setTranslationDisplayMode(next);
      expect(document.querySelectorAll('[data-a-target="chat-line-message-body"] .wupage-translation')).toHaveLength(2);
      expect([...document.querySelectorAll('[data-a-target="chat-message-username"]')].map(element => element.textContent)).toEqual(["Viewer1", "Viewer2"]);
    }
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it("supports paragraph selection in the chat sidebar", () => {
    const body = document.querySelector("#message-1")!;
    const paragraph = findTranslatableParagraph(body.firstElementChild);
    expect(paragraph).toBe(body);
    expect(collectParagraphTextSegments(paragraph!).map(segment => segment.text)).toEqual(["自分の感想やめて"]);
  });

  it.each(['hidden', 'aria-hidden="true"', 'translate="no"', 'class="notranslate"', 'contenteditable="true"'])
  ("retains the %s exclusion inside chat", async attribute => {
    document.querySelector("#message-1")!.outerHTML = `<span id="message-1" data-a-target="chat-line-message-body" ${attribute}>${fragment("Protected message.")}</span>`;
    const texts = (await collectTextSegmentsProgressive()).map(segment => segment.text);
    expect(texts).not.toContain("Protected message.");
    expect(texts).toContain("見方から話しかけてたよ");
  });

  it.each(['hidden', 'aria-hidden', 'translate', 'contenteditable'])("retains the %s exclusion on chat ancestors", async attribute => {
    document.querySelector("section")!.setAttribute(attribute, attribute === "translate" ? "no" : "true");
    expect((await collectTextSegmentsProgressive()).map(segment => segment.text)).toEqual(["Stream description."]);
  });

  it("invalidates changed message text before accepting an old response", async () => {
    const segment = (await collectTextSegmentsProgressive()).find(segment => segment.text === "自分の感想やめて")!;
    expect(segment).toBeDefined();
    document.querySelector("#message-1 .text-fragment")!.firstChild!.textContent = "Updated chat message.";
    expect(invalidateStaleSegments()).toContain(segment.id);
    expect(renderTranslations([{ id: segment.id, text: "过期译文。" }])).toEqual([]);
    expect((await collectAdditionalTextSegmentsProgressive([document.querySelector("#message-1")!])).map(segment => segment.text)).toEqual(["Updated chat message."]);
  });
});
