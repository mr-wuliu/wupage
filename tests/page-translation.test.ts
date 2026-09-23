// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionSettings, RuntimeRequest, TranslateBatchResponse } from "../src/shared/types";

vi.mock("../src/content/runtime", () => ({
  sendRuntimeRequest: vi.fn()
}));

import { clearPageTranslation, startPageTranslation } from "../src/content/page-translation";
import { sendRuntimeRequest } from "../src/content/runtime";

const settings: ExtensionSettings = {
  targetLang: "zh-CN",
  sourceLang: "auto",
  activeProviderId: "zhipu-glm",
  chunkSize: 1200,
  concurrency: 8,
  cacheEnabled: true,
  floatingBallEnabled: true,
  translateCodeComments: true,
  translationDisplayMode: "bilingual",
  providers: []
};

describe("viewport page translation", () => {
  let scrollOffset = 0;

  beforeEach(() => {
    scrollOffset = 0;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      display: "block",
      visibility: "visible",
      opacity: "1"
    } as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const positioned = this.closest("[data-top]") as HTMLElement | null;
      const top = Number(positioned?.dataset.top ?? 0) - scrollOffset;
      return {
        width: 600,
        height: 24,
        top,
        right: 600,
        bottom: top + 24,
        left: 0,
        x: 0,
        y: top,
        toJSON: () => ({})
      } as DOMRect;
    });
  });

  afterEach(() => {
    clearPageTranslation();
    vi.restoreAllMocks();
    vi.mocked(sendRuntimeRequest).mockReset();
    document.body.innerHTML = "";
    document.title = "";
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  function translateNormally(): void {
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      return { translations: request.texts.map((text) => `译文：${text}`), cached: 0 } as TranslateBatchResponse;
    });
  }

  it("discovers previously occluded email text after a non-bubbling inner scroll", async () => {
    document.body.innerHTML = `<div role="main"><div id="scroller"><p>Visible email.</p>
      <p id="covered">Previously covered email body.</p></div></div><div id="overlay"></div>`;
    let covered = true;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () =>
      covered ? document.querySelector("#overlay") : document.body });
    translateNormally();
    await startPageTranslation(settings);
    expect(sendRuntimeRequest).not.toHaveBeenCalled();

    covered = false;
    document.querySelector("#scroller")!.dispatchEvent(new Event("scroll", { bubbles: false }));
    await vi.waitFor(() => expect(document.querySelector("#covered .wupage-translation")?.textContent)
      .toBe("译文：Previously covered email body."));
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("keeps watching when the initial email view is empty", async () => {
    document.body.innerHTML = `<div role="main"></div>`;
    translateNormally();
    await startPageTranslation(settings);
    document.querySelector("[role='main']")!.innerHTML = `<div>New message body.</div>`;
    await vi.waitFor(() => expect(document.querySelector(".wupage-translation")?.textContent)
      .toBe("译文：New message body."));
  });

  it("retranslates a reused email text node without leaving the old translation", async () => {
    document.body.innerHTML = `<div role="main"><div id="body">Original email body.</div></div>`;
    translateNormally();
    await startPageTranslation(settings);
    document.querySelector("#body")!.firstChild!.textContent = "Updated email body.";
    await vi.waitFor(() => expect(document.querySelector("#body .wupage-translation")?.textContent)
      .toBe("译文：Updated email body."));
    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
  });

  it("discards an old response when the source changes during the request", async () => {
    document.body.innerHTML = `<div role="main"><div id="body">Original email body.</div></div>`;
    let release!: (response: TranslateBatchResponse) => void;
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const completion = startPageTranslation(settings);
    document.querySelector("#body")!.firstChild!.textContent = "Updated email body.";
    translateNormally();
    release({ translations: ["过期译文"], cached: 0 });
    await completion;
    await vi.waitFor(() => expect(document.querySelector("#body .wupage-translation")?.textContent)
      .toBe("译文：Updated email body."));
    expect(document.body.textContent).not.toContain("过期译文");
  });

  it("restores a translation removed by the host when scrolling back", async () => {
    document.body.innerHTML = `<main><p>Persistent source paragraph.</p></main>`;
    translateNormally();
    await startPageTranslation(settings);
    document.querySelector(".wupage-translation")!.remove();
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(document.querySelector(".wupage-translation")?.textContent)
      .toBe("译文：Persistent source paragraph."));
  });

  it("returns queued paragraphs to the queue after rapid scrolling away and back", async () => {
    document.body.innerHTML = `<main>${[100, 200, 300, 2600].map((top) =>
      `<p data-top="${top}">Paragraph ${top} ${"body ".repeat(50)}</p>`).join("")}</main>`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      await gate;
      return { translations: request.texts.map((text) => `译文：${text}`), cached: 0 } as TranslateBatchResponse;
    });
    const completion = startPageTranslation({ ...settings, chunkSize: 200, concurrency: 1 });
    scrollOffset = 2200;
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 130));
    scrollOffset = 0;
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 130));
    release();
    await completion;
    await vi.waitFor(() => expect(document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)"))
      .toHaveLength(3));
    expect(vi.mocked(sendRuntimeRequest).mock.calls.flatMap(([request]) =>
      request.type === "TRANSLATE_BATCH" ? request.texts : []).some((text) => text.includes("2600"))).toBe(false);
  });

  it("rebuilds a formatted email paragraph when inline content is added", async () => {
    document.body.innerHTML = `<div role="main"><div id="body">Please <b>review</b> this message.</div></div>`;
    translateNormally();
    await startPageTranslation(settings);
    const extra = document.createElement("em");
    extra.textContent = " Today.";
    document.querySelector("#body")!.append(extra);
    await vi.waitFor(() => expect(document.querySelector(".wupage-translation")?.textContent).toContain("Today."));
    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
  });

  it("preserves the email pane scroll position when rendering translations", async () => {
    document.body.innerHTML = `<div id="pane" role="main"><p>Email body paragraph.</p></div>`;
    const pane = document.querySelector("#pane")!;
    pane.scrollTop = 500;
    const nativeAfter = CharacterData.prototype.after;
    vi.spyOn(CharacterData.prototype, "after").mockImplementation(function (this: CharacterData, ...nodes: Array<Node | string>) {
      nativeAfter.apply(this, nodes);
      pane.scrollTop += 40;
    });
    translateNormally();
    await startPageTranslation(settings);
    expect(pane.scrollTop).toBe(500);
  });

  it("updates replacement-mode email text and does not restore the previous message", async () => {
    document.body.innerHTML = `<div role="main"><div id="body">Original message.</div></div>`;
    translateNormally();
    await startPageTranslation({ ...settings, translationDisplayMode: "replace" });
    document.querySelector("#body")!.firstChild!.textContent = "New message.";
    await vi.waitFor(() => expect(document.querySelector(".wupage-translation")?.textContent).toBe("译文：New message."));
    clearPageTranslation();
    expect(document.querySelector("#body")!.textContent).toBe("New message.");
  });

  it("sends page topic context with every translation batch", async () => {
    document.title = "Why variance matters";
    document.body.innerHTML = `
      <main>
        <h1 data-top="50">Why variance matters</h1>
        <p data-top="100">Variance is about our ability to substitute types for other types.</p>
        <p data-top="200">Covariant behavior means subtypes are acceptable.</p>
      </main>
    `;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      expect(request.context).toContain("Page title: Why variance matters");
      expect(request.context).toContain("substitute types for other types");
      expect(request.context).toContain("Covariant behavior");
      return {
        translations: request.texts.map((text) => `译文：${text}`),
        cached: 0
      } as TranslateBatchResponse;
    });

    await startPageTranslation(settings);

    expect(vi.mocked(sendRuntimeRequest)).toHaveBeenCalled();
  });

  it("translates an x.com long post as blank-line paragraphs instead of one flattened item", async () => {
    document.body.innerHTML = `
      <main><article><div data-testid="tweetText" data-top="100">
        <span>Opening paragraph.</span><span>\n\nSecond paragraph.\n\nFlow:\nAI watches\n↓\nAI adjusts.</span>
      </div></article></main>
    `;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      return {
        translations: request.texts.map((text) => `译文：${text}`),
        cached: 0
      } as TranslateBatchResponse;
    });

    await startPageTranslation(settings);

    const request = vi.mocked(sendRuntimeRequest).mock.calls[0][0];
    expect(request.type).toBe("TRANSLATE_BATCH");
    if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
    expect(request.texts).toEqual([
      "Opening paragraph.",
      "Second paragraph.",
      "Flow:\nAI watches\n↓\nAI adjusts."
    ]);
    const post = document.querySelector("[data-testid='tweetText']")!;
    const translations = [...document.querySelectorAll(".wupage-translation")];
    expect(translations).toHaveLength(3);
    expect(post.contains(translations[0])).toBe(true);
    expect(post.contains(translations[1])).toBe(true);
    expect(translations[2].previousElementSibling).toBe(post);
  });

  it("only requests text in and near the viewport", async () => {
    document.body.innerHTML = `
      <main>
        <p data-top="100">Visible paragraph</p>
        <p data-top="1100">Nearby paragraph</p>
        <p data-top="2400">Far paragraph</p>
      </main>
    `;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      return {
        translations: request.texts.map((text) => `译文：${text}`),
        cached: 0
      } as TranslateBatchResponse;
    });

    const result = await startPageTranslation(settings);

    const requests = vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request);
    const requestedTexts = requests.flatMap((request) =>
      request.type === "TRANSLATE_BATCH" ? request.texts : []
    );
    expect(requestedTexts).toEqual(["Visible paragraph", "Nearby paragraph"]);
    expect(result.translated).toBe(2);
    expect(result.remaining).toBe(1);
    expect(document.querySelector('[data-top="2400"] .wupage-translation')).toBeNull();
  });

  it("caps page concurrency and renders each completed batch immediately", async () => {
    const longText = (label: string) => `${label} ${"translation content ".repeat(36)}`;
    document.body.innerHTML = `
      <main>
        <p data-top="100">${longText("First")}</p>
        <p data-top="200">${longText("Second")}</p>
        <p data-top="300">${longText("Third")}</p>
      </main>
    `;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let callCount = 0;
    let releaseRemaining!: () => void;
    const remainingGate = new Promise<void>((resolve) => {
      releaseRemaining = resolve;
    });
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      callCount += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      if (callCount > 1) await remainingGate;
      activeRequests -= 1;
      return {
        translations: request.texts.map((text) => `译文：${text.slice(0, 10)}`),
        cached: 0
      } as TranslateBatchResponse;
    });

    const completion = startPageTranslation(settings);
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)")).toHaveLength(1);
    });

    expect(maxActiveRequests).toBe(2);
    expect(document.querySelectorAll(".wupage-translation-pending")).toHaveLength(2);
    releaseRemaining();
    const result = await completion;

    expect(result.translated).toBe(3);
    expect(document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)")).toHaveLength(3);
  });

  it("uses the active provider concurrency override", async () => {
    const longText = (label: string) => `${label} ${"translation content ".repeat(36)}`;
    document.body.innerHTML = `
      <main>
        <p data-top="100">${longText("First")}</p>
        <p data-top="200">${longText("Second")}</p>
      </main>
    `;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      return {
        translations: request.texts.map((text) => `译文：${text.slice(0, 10)}`),
        cached: 0
      } as TranslateBatchResponse;
    });
    const providerSettings: ExtensionSettings = {
      ...settings,
      providers: [
        {
          type: "zhipu-glm",
          id: "zhipu-glm",
          label: "Zhipu GLM",
          performanceMode: "custom",
          chunkSize: 700,
          concurrency: 1,
          baseURL: "https://open.bigmodel.cn/api/paas/v4",
          apiKey: "",
          model: "glm-4-flash-250414",
          systemPrompt: "Translate"
        }
      ]
    };

    await startPageTranslation(providerSettings);

    expect(vi.mocked(sendRuntimeRequest)).toHaveBeenCalledTimes(2);
    expect(maxActiveRequests).toBe(1);
  });

  it("limits LLM page batches by item count", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 35 },
      (_, index) => `<p data-top="${100 + index * 10}">Short paragraph ${index + 1}</p>`
    ).join("")}</main>`;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      return {
        translations: request.texts.map((text) => `译文：${text}`),
        cached: 0
      } as TranslateBatchResponse;
    });
    const providerSettings: ExtensionSettings = {
      ...settings,
      providers: [
        {
          type: "zhipu-glm",
          id: "zhipu-glm",
          label: "Zhipu GLM",
          performanceMode: "custom",
          chunkSize: 3200,
          concurrency: 3,
          baseURL: "https://open.bigmodel.cn/api/paas/v4",
          apiKey: "",
          model: "glm-4-flash-250414",
          systemPrompt: "Translate"
        }
      ]
    };

    await startPageTranslation(providerSettings);

    const requests = vi.mocked(sendRuntimeRequest).mock.calls
      .map(([request]) => request)
      .filter((request): request is Extract<RuntimeRequest, { type: "TRANSLATE_BATCH" }> =>
        request.type === "TRANSLATE_BATCH"
      );
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.texts.length <= 16)).toBe(true);
    expect(requests.flatMap((request) => request.texts)).toHaveLength(35);
  });

  it("continues lazily when a distant segment is scrolled into view", async () => {
    document.body.innerHTML = `
      <main>
        <p data-top="100">Initial paragraph</p>
        <p data-top="2500">Scrolled paragraph</p>
      </main>
    `;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      return {
        translations: request.texts.map((text) => `译文：${text}`),
        cached: 0
      } as TranslateBatchResponse;
    });

    await startPageTranslation(settings);
    expect(vi.mocked(sendRuntimeRequest)).toHaveBeenCalledTimes(1);

    scrollOffset = 2100;
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => {
      expect(vi.mocked(sendRuntimeRequest)).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[data-top="2500"] .wupage-translation')?.textContent)
        .toContain("Scrolled paragraph");
    });
  });

  it("translates interactive content added after the initial page scan", async () => {
    document.body.innerHTML = `<main><p data-top="100">Initial paragraph</p></main>`;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      return {
        translations: request.texts.map((text) => `译文：${text}`),
        cached: 0
      } as TranslateBatchResponse;
    });

    await startPageTranslation(settings);
    const button = document.createElement("button");
    button.dataset.top = "200";
    button.innerHTML = `<svg aria-hidden="true"></svg><span>Microsoft 365 のヒント</span>`;
    document.querySelector("main")?.append(button);

    await vi.waitFor(() => {
      expect(vi.mocked(sendRuntimeRequest)).toHaveBeenCalledTimes(2);
      expect(button.querySelector(".wupage-translation")?.textContent)
        .toBe("译文：Microsoft 365 のヒント");
    });
  });

  it("translates carousel content when it becomes visible through an attribute change", async () => {
    document.body.innerHTML = `
      <main>
        <p data-top="100">Visible slide</p>
        <section class="is-hidden" aria-hidden="true">
          <p data-top="200">後から表示されるスライド</p>
        </section>
      </main>
    `;
    vi.mocked(window.getComputedStyle).mockImplementation((element: Element) => ({
      display: element.closest(".is-hidden") ? "none" : "block",
      visibility: "visible",
      opacity: "1"
    } as CSSStyleDeclaration));
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      return {
        translations: request.texts.map((text) => `译文：${text}`),
        cached: 0
      } as TranslateBatchResponse;
    });

    await startPageTranslation(settings);
    const slide = document.querySelector<HTMLElement>(".is-hidden")!;
    expect(slide.querySelector(".wupage-translation")).toBeNull();
    slide.classList.remove("is-hidden");
    slide.removeAttribute("aria-hidden");

    await vi.waitFor(() => {
      expect(vi.mocked(sendRuntimeRequest)).toHaveBeenCalledTimes(2);
      expect(slide.querySelector(".wupage-translation")?.textContent)
        .toBe("译文：後から表示されるスライド");
    });
  });

  it("restores the viewport after translation nodes change page layout", async () => {
    document.body.innerHTML = `<main><p data-top="100">Stable viewport paragraph</p></main>`;
    let currentScrollY = 3400;
    vi.spyOn(window, "scrollX", "get").mockReturnValue(0);
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => currentScrollY);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation((_left, top) => {
      currentScrollY = Number(top);
    });
    const nativeAfter = CharacterData.prototype.after;
    vi.spyOn(CharacterData.prototype, "after").mockImplementation(function (
      this: CharacterData,
      ...nodes: Array<Node | string>
    ) {
      nativeAfter.apply(this, nodes);
      currentScrollY += 33;
    });
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      return { translations: ["稳定的视口译文"], cached: 0 } as TranslateBatchResponse;
    });

    await startPageTranslation(settings);

    expect(currentScrollY).toBe(3400);
    expect(scrollTo).toHaveBeenCalledWith(0, 3400);
  });

  it("does not render a late response after translations are cleared", async () => {
    document.body.innerHTML = `<main><p data-top="100">Pending paragraph</p></main>`;
    let resolveRequest!: (response: TranslateBatchResponse) => void;
    vi.mocked(sendRuntimeRequest).mockImplementation(() =>
      new Promise<TranslateBatchResponse>((resolve) => {
        resolveRequest = resolve;
      })
    );

    const completion = startPageTranslation(settings);
    await vi.waitFor(() => expect(vi.mocked(sendRuntimeRequest)).toHaveBeenCalledTimes(1));
    clearPageTranslation();
    resolveRequest({ translations: ["迟到的译文"], cached: 0 });
    await completion;
    await Promise.resolve();

    expect(document.querySelector(".wupage-translation")).toBeNull();
  });
});
