// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTranslations, collectAdditionalTextSegmentsProgressive, collectTextSegmentsProgressive, renderTranslations } from "../src/content/dom";

afterEach(() => { clearTranslations(); vi.restoreAllMocks(); document.body.replaceChildren(); });

function stubLayout(): void {
  vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ display: "block", visibility: "visible", opacity: "1", color: "" }) as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const hidden = this.matches(".hiddenVisually");
    const width = hidden ? 1 : 600, height = hidden ? 1 : 20;
    return { width, height, top: 0, right: width, bottom: height, left: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

const message = (id: number, user: string, text: string, header = true) => `<li class="messageListItem" id="chat-messages-1-${id}"><div class="message cozyMessage" role="article" tabindex="-1"><div class="contents">${
  header ? `<img class="avatar clickable" alt=""><h3 class="header"><span class="headerText" id="message-username-${id}"><span class="username clickable" role="button">${user}</span></span><span class="timestamp timestampInline"><span><time id="message-timestamp-${id}">9:57 PM</time></span><span class="hiddenVisually">Today at 9:57 PM</span></span></h3>` : ""
}<div class="markup messageContent" id="message-content-${id}"><span>${text}</span></div></div><div class="container" id="message-accessories-${id}"></div></div></li>`;

describe("Discord chat", () => {
  it("collects message bodies", async () => {
    document.documentElement.lang = "en-US";
    document.body.innerHTML = `<main aria-label="Game Design Final Project (channel)"><div role="group"><ol role="list" aria-label="Messages in Game Design Final Project" data-list-id="chat-messages">${
      message(1, "Pear", "Cool, I will take a look at the new build tonight.")}${message(2, "Steven", "I reworked the version so it now prioritizes the 3D scene.")}${message(3, "Steven", "Compact follow-up message without a header.", false)}</ol></div></main>`;
    stubLayout();
    const texts = (await collectTextSegmentsProgressive()).map(s => s.text);
    expect(texts).toEqual(expect.arrayContaining(["Cool, I will take a look at the new build tonight.", "I reworked the version so it now prioritizes the 3D scene.", "Compact follow-up message without a header."]));
  });

  it.each(["sr-only", "hiddenVisually_a1b2c3"])("excludes %s timestamps from all collected segments", async hiddenClass => {
    document.body.innerHTML = `<main><ol>${message(1, "Pear", `Visible message body.<span class="${hiddenClass}">Tuesday, August 31, 2021 at 8:43 AM</span>`, false)}</ol></main>`;
    stubLayout();
    expect((await collectTextSegmentsProgressive()).map(segment => segment.text)).toEqual(["Visible message body."]);
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)("renders and restores separate message paragraphs in %s mode", async mode => {
    document.body.innerHTML = `<main><ol>${message(1, "Pear", "First paragraph.\n\nSecond paragraph.", false)}</ol></main>`;
    stubLayout();
    const original = document.body.innerHTML;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.requestText)).toEqual(["First paragraph.", "Second paragraph."]);
    expect(renderTranslations(segments.map(({ id }, index) => ({ id, text: ["第一段。", "第二段。"][index] })), mode)).toEqual(segments.map(segment => segment.id));
    const body = document.querySelector("#message-content-1")!;
    expect([...body.querySelectorAll(".wupage-translation")].map(element => element.textContent)).toEqual(["第一段。", "第二段。"]);
    expect(await collectAdditionalTextSegmentsProgressive([body])).toEqual([]);
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
  });

  it("translates a multi-line message paragraph by paragraph, keeping each paragraph's own lines", async () => {
    document.documentElement.lang = "en-US";
    document.body.innerHTML = `<main><ol role="list"><li><div class="message" role="article"><div class="contents"><h3 class="header"><span class="username" role="button">Cobai</span></h3>
      <div class="markup messageContent" id="message-content-9"><strong><span>1. Be Civil People</span></strong><span>\nWe allow cursing, as long as it is not meant to insult someone.\n\n</span><strong><span>2. No NSFW</span></strong><span>\nWe do not allow any nsfw content of any kind in this server.\n\n</span><strong><span>3. Use Channels</span></strong><span>\nUse </span><span class="channelMention"><span class="name"><span>#self-promotion</span></span></span><span> to post your stream.</span><span class="timestamp"><time><span class="edited">(edited)</span></time><span class="hiddenVisually">Tuesday, August 31, 2021 at 8:43 AM</span></span></div></div></div></li></ol></main>`;
    stubLayout();
    const texts = (await collectTextSegmentsProgressive()).map(s => s.text).filter(text => text !== "Cobai");
    expect(texts).toEqual([
      "1. Be Civil People\nWe allow cursing, as long as it is not meant to insult someone.",
      "2. No NSFW\nWe do not allow any nsfw content of any kind in this server.",
      "3. Use Channels\nUse #self-promotion to post your stream. (edited)"
    ]);
  });
});
