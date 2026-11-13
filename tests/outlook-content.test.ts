// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://partner.outlook.cn/mail/"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations, collectAdditionalTextSegmentsProgressive, collectParagraphTextSegments,
  collectTextSegmentsProgressive, findTranslatableParagraph, invalidateStaleSegments,
  renderTranslations, setTranslationDisplayMode
} from "../src/content/dom";
import { isTranslationOptedOut } from "../src/content/content-policy";
import { configureElementRules } from "../src/content/element-exclusions";
import { sampleDocumentText } from "../src/content/frame-sample";
import { layoutDisplay } from "./helpers/layout-display";

beforeEach(() => {
  document.documentElement.setAttribute("translate", "no");
  document.body.innerHTML = `<main role="main"><div role="document" tabindex="0" aria-label="Message body">
    <p id="body">Please review the attached report.</p>
    <p translate="no">Locally excluded paragraph.</p><p class="notranslate">Protected paragraph.</p>
    <div contenteditable="true" role="textbox"><p>Unsent reply draft.</p></div>
    <p hidden>Hidden message.</p>
  </div></main>`;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({
    display: element.hasAttribute("hidden") ? "none" : layoutDisplay(element),
    visibility: "visible", opacity: "1"
  }) as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 24));
});
afterEach(() => {
  clearTranslations(); configureElementRules({}); vi.restoreAllMocks();
  document.documentElement.removeAttribute("translate");
  document.documentElement.classList.remove("notranslate");
  document.body.replaceChildren();
});

describe("Outlook document translation", () => {
  it("collects mail prose despite the app root opt-out while retaining local exclusions", async () => {
    expect((await collectTextSegmentsProgressive()).map(segment => segment.text))
      .toEqual(["Please review the attached report."]);
    expect(document.documentElement.getAttribute("translate")).toBe("no");
    expect(sampleDocumentText(true)).toBe("Please review the attached report.");
  });

  it("supports paragraph translation and newly opened messages", async () => {
    const body = document.querySelector("#body")!;
    expect(findTranslatableParagraph(body)).toBe(body);
    expect(collectParagraphTextSegments(body).map(segment => segment.text))
      .toEqual(["Please review the attached report."]);
    await collectTextSegmentsProgressive();
    const pane = document.querySelector('[role="document"]')!;
    pane.insertAdjacentHTML("beforeend", "<p>A newly opened message.</p>");
    expect((await collectAdditionalTextSegmentsProgressive([pane])).map(segment => segment.text))
      .toEqual(["A newly opened message."]);
  });

  it.each(["bilingual", "bilingual-accent", "replace"] as const)("renders and restores email prose in %s mode", async mode => {
    const original = document.body.innerHTML;
    const [segment] = await collectTextSegmentsProgressive();
    expect(segment).toBeDefined();
    expect(renderTranslations([{ id: segment.id, text: "请查看附件中的报告。" }], mode)).toEqual([segment.id]);
    expect(invalidateStaleSegments()).toEqual([]);
    for (const next of ["replace", "bilingual", "bilingual-accent"] as const) {
      setTranslationDisplayMode(next);
      expect(document.querySelector("#body .wupage-translation")?.textContent).toBe("请查看附件中的报告。");
      expect(document.querySelector("[contenteditable]")?.textContent).toBe("Unsent reply draft.");
    }
    clearTranslations();
    expect(document.body.innerHTML).toBe(original);
    expect(document.documentElement.getAttribute("translate")).toBe("no");
  });

  it("still applies user exclusions on the root element", async () => {
    configureElementRules({ elementExclusions: [{ id: "exclude-mail", name: "Exclude mail", pattern: "partner.outlook.cn", selectors: ["html"], enabled: true }] });
    expect(await collectTextSegmentsProgressive()).toEqual([]);
    expect(sampleDocumentText(true)).toBe("");
  });

  it("retains a notranslate class on the root and a translate=no on the body", async () => {
    document.documentElement.classList.add("notranslate");
    expect(await collectTextSegmentsProgressive()).toEqual([]);
    document.documentElement.classList.remove("notranslate");
    document.body.setAttribute("translate", "no");
    try { expect(await collectTextSegmentsProgressive()).toEqual([]); }
    finally { document.body.removeAttribute("translate"); }
  });

  it.each([
    ["partner.outlook.cn", false], ["outlook.live.com", false], ["outlook.office.com", false],
    ["outlook.office365.com", false], ["outlook.cloud.microsoft", false],
    ["example.com", true], ["partner.outlook.cn.example.com", true], ["fakeoutlook.office.com", true]
  ])("scopes the app-root exception to the document hostname %s", (hostname, optedOut) => {
    const frame = document.createElement("iframe");
    frame.src = `https://${hostname}/mail/`;
    document.body.append(frame);
    const other = frame.contentDocument!;
    other.appendChild(other.createElement("html"));
    other.documentElement.setAttribute("translate", "no");
    other.documentElement.innerHTML = "<body><p>Mail prose.</p></body>";
    expect(isTranslationOptedOut(other.querySelector("p")!)).toBe(optedOut);
  });

  it("does not exempt documents without an Outlook location", () => {
    const other = new DOMParser().parseFromString('<html translate="no"><body><p>Other document.</p></body></html>', "text/html");
    expect(isTranslationOptedOut(other.querySelector("p")!)).toBe(true);
  });
});
