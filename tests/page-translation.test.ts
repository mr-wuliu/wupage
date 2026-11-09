// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionSettings, RuntimeRequest, TranslateBatchResponse } from "../src/shared/types";

vi.mock("../src/content/runtime", () => ({
  sendRuntimeRequest: vi.fn()
}));

import { clearPageTranslation, getPageTranslationState, hidePageTranslation, setPageTranslationDisplayMode, startPageTranslation, updatePageTranslationSettings } from "../src/content/page-translation";
import { sendRuntimeRequest } from "../src/content/runtime";
import { collectParagraphTextSegments, renderTranslations } from "../src/content/dom";
import { ProviderError } from "../src/shared/errors";
import { injectContentStyles } from "../src/content/styles";

const settings: ExtensionSettings = {
  targetLang: "zh-CN",
  sourceLang: "auto",
  activeProviderId: "zhipu-glm",
  chunkSize: 1200,
  concurrency: 8,
  pdfTranslationPageRadius: 5,
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
    vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      backgroundColor: element.id === "overlay" ? "rgb(255, 255, 255)" : "transparent"
    }) as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const positioned = this.closest("[data-top]") as HTMLElement | null;
      const top = this.id === "overlay" ? 0 : Number(positioned?.dataset.top ?? 0) - scrollOffset;
      const height = this.id === "overlay" ? 800 : 24;
      return {
        width: 600,
        height,
        top,
        right: 600,
        bottom: top + height,
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

  // The initial document scan yields to the browser, so a request is only in
  // flight on a later task; tests that hold a response open wait here first.
  async function waitForBatchRequests(count = 1): Promise<void> {
    await vi.waitFor(() => {
      const batches = vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "TRANSLATE_BATCH");
      expect(batches.length).toBeGreaterThanOrEqual(count);
    });
  }

  function mountImageText(top = 100): HTMLImageElement {
    document.body.innerHTML = `<div id="intro" data-top="${top}"><picture><img></picture></div>`;
    const image = document.querySelector("img")!;
    image.alt = "これは画像として表示される長い作品紹介文です。".repeat(5);
    return image;
  }

  it("continues translating after the host replaces document.body", async () => {
    document.body.innerHTML = "<main><p>Old document body.</p></main>";
    translateNormally();
    await startPageTranslation(settings);
    const next = document.createElement("body");
    next.innerHTML = "<main><p>Replacement document body.</p></main>";
    document.body.replaceWith(next);
    await vi.waitFor(() => expect(next.querySelector(".wupage-translation")?.textContent).toBe("译文：Replacement document body."));
    hidePageTranslation();
    expect(next.textContent).toBe("Replacement document body.");
  });

  it("tracks new and changed content inside nested open components", async () => {
    document.body.innerHTML = '<main><article-card></article-card></main>';
    const root = document.querySelector("article-card")!.attachShadow({ mode: "open" });
    root.innerHTML = '<p>Original component paragraph.</p>';
    translateNormally();
    await startPageTranslation(settings);
    expect(root.querySelector(".wupage-translation")?.textContent).toBe("译文：Original component paragraph.");
    root.querySelector("p")!.textContent = "Updated component paragraph.";
    await vi.waitFor(() => expect(root.querySelector(".wupage-translation")?.textContent).toBe("译文：Updated component paragraph."));
    const child = document.createElement("nested-card");
    const nested = child.attachShadow({ mode: "open" });
    nested.innerHTML = '<p>New nested component paragraph.</p>';
    root.append(child);
    await vi.waitFor(() => expect(nested.querySelector(".wupage-translation")?.textContent).toBe("译文：New nested component paragraph."));
    hidePageTranslation();
    expect(root.querySelector("p")!.textContent).toBe("Updated component paragraph.");
    expect(nested.querySelector("p")!.textContent).toBe("New nested component paragraph.");
  });

  it.each(["replace", "bilingual", "bilingual-accent"] as const)("restores saved %s translations without new requests", async (translationDisplayMode) => {
    document.body.innerHTML = `<main><p>Read <code>guide()</code> carefully.</p><input placeholder="Search documents"></main>`;
    const original = document.querySelector("main")!.textContent;
    translateNormally();
    const options = { ...settings, cacheEnabled: false, translationDisplayMode };
    const first = await startPageTranslation(options);
    const calls = vi.mocked(sendRuntimeRequest).mock.calls.length;
    for (let index = 0; index < 3; index++) {
      hidePageTranslation();
      expect(document.querySelector(".wupage-translation")).toBeNull();
      expect(document.querySelector("main")!.textContent).toBe(original);
      expect(document.querySelector("input")!.placeholder).toBe("Search documents");
      const result = await startPageTranslation(options);
      expect(result).toMatchObject({ translated: first.translated, cached: first.translated, failed: 0 });
      expect(document.querySelector(".wupage-translation code")?.textContent).toBe("guide()");
      expect(document.querySelector("input")!.placeholder).toBe("译文：Search documents");
      expect(sendRuntimeRequest).toHaveBeenCalledTimes(calls);
    }
  });

  it("translates only changed and new content when returning from the original view", async () => {
    document.body.innerHTML = `<main><p id="kept">Keep this paragraph.</p><p id="changed">Old paragraph.</p></main>`;
    translateNormally();
    await startPageTranslation(settings);
    hidePageTranslation();
    vi.mocked(sendRuntimeRequest).mockClear();
    document.querySelector("#changed")!.textContent = "New paragraph.";
    document.querySelector("main")!.insertAdjacentHTML("beforeend", "<p>Appended paragraph.</p>");
    const result = await startPageTranslation(settings);
    const requestedTexts = vi.mocked(sendRuntimeRequest).mock.calls.flatMap(([request]) => request.type === "TRANSLATE_BATCH" ? request.texts : []);
    expect(requestedTexts.sort()).toEqual(["Appended paragraph.", "New paragraph."]);
    expect(document.querySelector("#kept .wupage-translation")?.textContent).toBe("译文：Keep this paragraph.");
    expect(result).toMatchObject({ translated: 3, cached: 1, failed: 0 });
  });

  it("keeps original text visible when changing display mode while translations are hidden", async () => {
    document.body.innerHTML = "<main><p>Original paragraph.</p></main>";
    translateNormally();
    await startPageTranslation(settings);
    hidePageTranslation();
    setPageTranslationDisplayMode("replace");
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("Original paragraph.");
    await startPageTranslation({ ...settings, translationDisplayMode: "replace" });
    expect(document.querySelector<HTMLElement>(".wupage-translation")!.dataset.wupageDisplayMode).toBe("replace");
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
  });

  it("hides paragraph results added while the page translation is suspended", async () => {
    document.body.innerHTML = "<main><p>Original paragraph.</p></main>";
    translateNormally();
    await startPageTranslation(settings);
    hidePageTranslation();
    const paragraph = document.querySelector("p")!;
    const [segment] = collectParagraphTextSegments(paragraph);
    renderTranslations([{ id: segment.id, text: "单独翻译的段落。" }]);
    expect(document.querySelector(".wupage-translation")).not.toBeNull();
    hidePageTranslation();
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(paragraph.textContent).toBe("Original paragraph.");
  });

  it("invalidates saved rich text when protected code changes while showing the original", async () => {
    document.body.innerHTML = "<main><p>Read <code>oldGuide()</code> carefully.</p></main>";
    translateNormally();
    await startPageTranslation(settings);
    hidePageTranslation();
    hidePageTranslation();
    document.querySelector("code")!.firstChild!.textContent = "newGuide()";
    const result = await startPageTranslation(settings);
    expect(result.cached).toBe(0);
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".wupage-translation code")?.textContent).toBe("newGuide()");
  });

  it("keeps saved image paragraphs when switching back to the translated view", async () => {
    const image = mountImageText();
    translateNormally();
    await startPageTranslation({ ...settings, translationDisplayMode: "replace" });
    hidePageTranslation();
    expect(document.querySelector(".wupage-translation")).toBeNull();
    const result = await startPageTranslation({ ...settings, translationDisplayMode: "bilingual" });
    expect(result.cached).toBe(1);
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
    expect(image.closest("picture")!.nextElementSibling?.textContent).toBe(`译文：${image.alt}`);
  });

  it("does not reuse saved results after changing language or provider configuration", async () => {
    document.body.innerHTML = "<main><p>Original paragraph.</p></main>";
    translateNormally();
    let options: ExtensionSettings = { ...settings, providers: [{ type: "google-web-translate", id: settings.activeProviderId, label: "First provider" }] };
    await startPageTranslation(options);
    for (const patch of [{ targetLang: "ja" }, { sourceLang: "en" }, { providers: [{ type: "google-web-translate" as const, id: settings.activeProviderId, label: "Updated provider" }] }]) {
      hidePageTranslation();
      options = { ...options, ...patch };
      expect((await startPageTranslation(options)).cached).toBe(0);
    }
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(4);
  });

  it("reuses completed paragraphs but retries unfinished requests after stopping", async () => {
    document.body.innerHTML = `<main><p>${"First paragraph. ".repeat(10)}</p><p>${"Pending paragraph. ".repeat(10)}</p></main>`;
    let finishOld!: (value: TranslateBatchResponse) => void;
    const runtime = vi.fn(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      return { translations: request.texts.map((text) => `译文：${text}`), cached: 0 };
    });
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(runtime)
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const options = { ...settings, chunkSize: 200, concurrency: 1 };
    const first = startPageTranslation(options);
    await vi.waitFor(() => expect(finishOld).toBeTypeOf("function"));
    hidePageTranslation();
    await first;
    vi.mocked(sendRuntimeRequest).mockClear();
    vi.mocked(sendRuntimeRequest).mockImplementation(runtime);
    const result = await startPageTranslation(options);
    expect(result).toMatchObject({ translated: 2, cached: 1 });
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
    finishOld({ translations: ["Cancelled response"], cached: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).not.toContain("Cancelled response");
  });

  it("pauses the page queue on a login error and restores completed work when the user retries", async () => {
    const texts = ["First source paragraph. ", "Second source paragraph. ", "Third source paragraph. "]
      .map((text) => text.repeat(40).trim());
    document.body.innerHTML = `<main>${texts.map((text, index) => `<p id="p${index}" data-top="${100 + index * 100}">${text}</p>`).join("")}</main>`;
    const options: ExtensionSettings = {
      ...settings,
      activeProviderId: "doubao-web",
      translationDisplayMode: "replace",
      providers: [{ id: "doubao-web", type: "doubao-web", label: "豆包" }]
    };
    translateNormally();
    const translate = vi.mocked(sendRuntimeRequest).getMockImplementation()!;
    vi.mocked(sendRuntimeRequest)
      .mockImplementationOnce(translate)
      .mockRejectedValueOnce(new ProviderError("请登录豆包后重新检测。", "login-required"));

    const failed = await startPageTranslation(options);
    expect(failed).toMatchObject({ translated: 1, failed: 1, remaining: 1, errorCode: "login-required" });
    expect(failed.retryAt).toBeUndefined();
    expect(getPageTranslationState()).toMatchObject({ pending: 0, errorCode: "login-required" });
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(2);
    expect(document.querySelector("#p1")!.textContent).toBe(texts[1]);
    expect(document.querySelector("#p2")!.textContent).toBe(texts[2]);
    expect(document.querySelector(".wupage-translation-pending")).toBeNull();

    const addedText = "New source paragraph. ".repeat(40).trim();
    document.querySelector("main")!.insertAdjacentHTML("beforeend", `<p data-top="400">${addedText}</p>`);
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(2);
    expect(getPageTranslationState()).toMatchObject({ pending: 0, remaining: 2 });

    hidePageTranslation();
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(Array.from(document.querySelectorAll("main p"), (paragraph) => paragraph.textContent)).toEqual([...texts, addedText]);
    expect(getPageTranslationState().active).toBe(false);
    vi.mocked(sendRuntimeRequest).mockClear();
    translateNormally(); // The explicit login/check recovery is handled by the background provider.
    const recovered = await startPageTranslation(options);
    expect(recovered).toMatchObject({ translated: 4, cached: 1, failed: 0, remaining: 0 });
    expect(recovered.errorCode).toBeUndefined();
    expect(recovered.retryAt).toBeUndefined();
    const requested = vi.mocked(sendRuntimeRequest).mock.calls.flatMap(([request]) => request.type === "TRANSLATE_BATCH" ? request.texts : []);
    expect(requested).toEqual([texts[1], texts[2], addedText]);
    expect(document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)")).toHaveLength(4);
  });

  it("returns the rate-limit deadline, preserves originals, and requires an explicit retry after cooldown", async () => {
    const texts = ["First source paragraph. ", "Second source paragraph. ", "Third source paragraph. "]
      .map((text) => text.repeat(40).trim());
    document.body.innerHTML = `<main>${texts.map((text, index) => `<p data-top="${100 + index * 100}">${text}</p>`).join("")}</main>`;
    const options: ExtensionSettings = {
      ...settings,
      activeProviderId: "doubao-web",
      translationDisplayMode: "replace",
      providers: [{ id: "doubao-web", type: "doubao-web", label: "豆包" }]
    };
    const startedAt = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    vi.mocked(sendRuntimeRequest).mockRejectedValue(new ProviderError("豆包请求受限。", "rate-limited", 5000));
    const failed = await startPageTranslation(options);
    expect(failed).toMatchObject({ translated: 0, failed: 1, remaining: 2, errorCode: "rate-limited", retryAt: startedAt + 5000 });
    expect(getPageTranslationState()).toMatchObject({ pending: 0, errorCode: "rate-limited", retryAt: startedAt + 5000 });
    expect(Array.from(document.querySelectorAll("main p"), (paragraph) => paragraph.textContent)).toEqual(texts);
    expect(document.querySelector(".wupage-translation")).toBeNull();
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(startedAt + 6000);
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
    translateNormally();
    const recovered = await startPageTranslation(options, false);
    expect(recovered).toMatchObject({ translated: 3, failed: 0, remaining: 0 });
    expect(recovered.errorCode).toBeUndefined();
    expect(recovered.retryAt).toBeUndefined();
    expect(getPageTranslationState()).toMatchObject({ pending: 0, failed: 0, translated: 3 });
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(4);
    expect(document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)")).toHaveLength(3);
  });

  it("requests placeholder validation for rich text before replacing its source", async () => {
    document.body.innerHTML = `<main><p>Read <code>theGuide()</code> carefully.</p></main>`;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      expect(request).toMatchObject({ type: "TRANSLATE_BATCH", preservePlaceholders: true });
      return { translations: ["仔细阅读 ⟪WUPAGE0⟫。"], cached: 0 } as TranslateBatchResponse;
    });
    const result = await startPageTranslation({ ...settings, translationDisplayMode: "replace" });
    expect(result.translated).toBe(1);
    expect(document.querySelector(".wupage-translation code")?.textContent).toBe("theGuide()");
    clearPageTranslation();
    expect(document.querySelector("p")?.textContent).toBe("Read theGuide() carefully.");
  });

  describe("replacement mode with host-managed news teasers", () => {
    const prefix = "Reports and analysis from correspondents around the world";
    const translation = "世界各地の記者がお届けする最新のニュースと詳しい解説を紹介します。";
    const options = { ...settings, sourceLang: "en", targetLang: "ja", translationDisplayMode: "replace" as const };
    const hostObservers: MutationObserver[] = [];

    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(window.getComputedStyle).mockRestore();
      injectContentStyles();
      vi.mocked(sendRuntimeRequest).mockResolvedValue({ translations: [translation], cached: 1 });
    });

    afterEach(() => {
      hostObservers.splice(0).forEach((observer) => observer.disconnect());
      vi.useRealTimers();
      document.getElementById("wupage-translation-style")?.remove();
    });

    function readSource(source: Element): string {
      return Array.from(source.childNodes).filter((node) => node instanceof Text)
        .map((node) => node.textContent).join("");
    }

    function mountTeaser() {
      document.body.innerHTML = '<main><article><p class="teaser"><span style="display:block"></span></p></article></main>';
      const source = document.querySelector<HTMLElement>(".teaser > span")!;
      source.append(document.createTextNode(prefix), document.createTextNode("..."));
      const host = { source, writes: 0 };
      // BBC's resize-driven truncator rebuilds text and ellipsis nodes after
      // replacement clears its source. Cap rewrites so regressions cannot hang.
      const observer = new MutationObserver(() => {
        if (readSource(source).trim() || host.writes >= 8) return;
        host.writes += 1;
        source.replaceChildren(document.createTextNode(prefix), document.createTextNode("..."));
      });
      observer.observe(source, { subtree: true, characterData: true, childList: true });
      hostObservers.push(observer);
      return host;
    }

    function requestedTexts(): string[] {
      return vi.mocked(sendRuntimeRequest).mock.calls.flatMap(([request]) =>
        request.type === "TRANSLATE_BATCH" ? request.texts : []);
    }

    it("settles source rewrites and scrolling without new translations or growing counters", async () => {
      const host = mountTeaser();
      const { source } = host;
      await startPageTranslation(options);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(host.writes).toBe(1);
      expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
      expect(getPageTranslationState()).toMatchObject({ translated: 1, cached: 1, pending: 0, remaining: 0, failed: 0 });
      expect(readSource(source)).toBe(prefix + "...");
      const output = document.querySelector<HTMLElement>(".wupage-translation")!;
      expect(output.textContent).toBe(translation);
      expect(source.contains(output)).toBe(false);
      expect(window.getComputedStyle(source).visibility).toBe("hidden");
      expect(window.getComputedStyle(output).visibility).toBe("visible");

      for (let index = 0; index < 3; index++) {
        source.replaceChildren(document.createTextNode(prefix), document.createTextNode("..."));
        window.dispatchEvent(new Event("scroll"));
        await vi.advanceTimersByTimeAsync(250);
      }
      expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
      expect(getPageTranslationState()).toMatchObject({ translated: 1, cached: 1, pending: 0 });
      expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
      expect(requestedTexts().every((text) => !text.includes(translation))).toBe(true);
    });

    it("still translates real news updates and newly inserted cards after recovery", async () => {
      const host = mountTeaser();
      const { source } = host;
      await startPageTranslation(options);
      await vi.advanceTimersByTimeAsync(500);
      const updated = "A different report with new details and a new headline";
      source.replaceChildren(document.createTextNode(updated), document.createTextNode("..."));
      await vi.advanceTimersByTimeAsync(500);

      expect(requestedTexts()).toHaveLength(2);
      expect(requestedTexts()[1]).toContain(updated);
      expect(readSource(source)).toBe(updated + "...");
      expect(host.writes).toBe(1);
      document.querySelector("article")!.insertAdjacentHTML("beforeend", "<p>A newly published story.</p>");
      await vi.advanceTimersByTimeAsync(500);
      expect(requestedTexts()).toHaveLength(3);
      expect(requestedTexts()[2]).toBe("A newly published story.");
      expect(getPageTranslationState().pending).toBe(0);
    });

    it("preserves safe rendering across display modes, restoring originals and changing language", async () => {
      const host = mountTeaser();
      const { source } = host;
      const originalStyle = source.getAttribute("style");
      await startPageTranslation(options);
      await vi.advanceTimersByTimeAsync(500);

      for (const mode of ["bilingual", "bilingual-accent", "replace"] as const) {
        setPageTranslationDisplayMode(mode);
        await vi.advanceTimersByTimeAsync(300);
        expect(readSource(source)).toBe(prefix + "...");
        expect(window.getComputedStyle(source).visibility).toBe(mode === "replace" ? "hidden" : "visible");
      }
      hidePageTranslation();
      expect(source.getAttribute("style")).toBe(originalStyle);
      expect(window.getComputedStyle(source).visibility).toBe("visible");
      expect(document.querySelector(".wupage-translation")).toBeNull();
      await startPageTranslation(options);
      await vi.advanceTimersByTimeAsync(500);
      expect(host.writes).toBe(1);
      expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
      expect(getPageTranslationState()).toMatchObject({ translated: 1, cached: 1, pending: 0 });

      updatePageTranslationSettings({ ...options, targetLang: "fr" });
      await vi.advanceTimersByTimeAsync(500);
      expect(host.writes).toBe(1);
      expect(sendRuntimeRequest).toHaveBeenCalledTimes(2);
      expect(vi.mocked(sendRuntimeRequest).mock.calls[1][0]).toMatchObject({ targetLang: "fr" });
      expect(requestedTexts().at(-1)).toContain(prefix);
      expect(readSource(source)).toBe(prefix + "...");
      expect(window.getComputedStyle(source).visibility).toBe("hidden");
      expect(getPageTranslationState()).toMatchObject({ translated: 1, cached: 1, pending: 0 });
    });
  });

  it("does not rescan multiline post translations as source after unrelated mutations", async () => {
    document.body.innerHTML = `<main><div data-testid="tweetText">Original post text.\n\nSecond paragraph.</div></main>`;
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type !== "TRANSLATE_BATCH") throw new Error("Unexpected request");
      return { translations: request.texts.map(() => "第一行译文\n第二行译文"), cached: 0 } as TranslateBatchResponse;
    });
    await startPageTranslation(settings);
    const outputs = [...document.querySelectorAll(".wupage-translation")];
    const content = outputs.map((node) => node.textContent);
    const outputNodes = outputs.map((node) => [...node.childNodes]);
    document.querySelector("main")!.append(document.createElement("div"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(outputs.map((node) => node.textContent)).toEqual(content);
    expect(outputs.map((node) => [...node.childNodes])).toEqual(outputNodes);
    expect([...document.querySelectorAll(".wupage-translation")]).toEqual(outputs);
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
  });

  it("reuses completed translations when switching display modes without restarting requests", async () => {
    document.body.innerHTML = `<main><p>First sentence.</p><p>Second sentence.</p></main>`;
    translateNormally();
    await startPageTranslation(settings);
    const calls = vi.mocked(sendRuntimeRequest).mock.calls.length;
    for (const mode of ["replace", "bilingual-accent", "bilingual", "replace"] as const) {
      setPageTranslationDisplayMode(mode);
      expect([...document.querySelectorAll<HTMLElement>(".wupage-translation")]
        .every((element) => element.dataset.wupageDisplayMode === mode)).toBe(true);
      expect(document.querySelectorAll(".wupage-translation")).toHaveLength(2);
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      expect(sendRuntimeRequest).toHaveBeenCalledTimes(calls);
    }
    clearPageTranslation();
    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(0);
    expect(document.querySelector("main")?.textContent).toBe("First sentence.Second sentence.");
  });

  it("uses the latest mode for responses already in flight and newly loaded paragraphs", async () => {
    document.body.innerHTML = `<main><p>Still translating this sentence.</p></main>`;
    let release!: (result: TranslateBatchResponse) => void;
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const started = startPageTranslation(settings);
    await waitForBatchRequests();
    expect(document.querySelectorAll(".wupage-translation-pending")).toHaveLength(1);
    setPageTranslationDisplayMode("replace");
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".wupage-translation-pending")).toHaveLength(1);
    release({ translations: ["返回的译文"], cached: 0 });
    await started;
    expect(document.querySelector<HTMLElement>(".wupage-translation")?.dataset.wupageDisplayMode).toBe("replace");
    expect(document.querySelector("p")?.textContent).toBe("返回的译文");
    setPageTranslationDisplayMode("bilingual-accent");
    translateNormally();
    document.querySelector("main")!.insertAdjacentHTML("beforeend", "<p>New paragraph loaded later.</p>");
    await vi.waitFor(() => expect(document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)"))
      .toHaveLength(2));
    expect([...document.querySelectorAll<HTMLElement>(".wupage-translation")]
      .every((element) => element.dataset.wupageDisplayMode === "bilingual-accent")).toBe(true);
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(2);
  });

  it("translates image paragraphs on scroll without enabling OCR", async () => {
    const image = mountImageText(2500);
    translateNormally();
    await startPageTranslation(settings);
    expect(sendRuntimeRequest).not.toHaveBeenCalled();

    scrollOffset = 2100;
    window.dispatchEvent(new Event("scroll"));

    await vi.waitFor(() => expect(image.closest("picture")!.nextElementSibling?.textContent)
      .toBe(`译文：${image.alt}`));
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
  });

  it("retranslates changed image alt text without keeping the previous output", async () => {
    const image = mountImageText();
    translateNormally();
    await startPageTranslation(settings);
    image.alt = "更新後の画像には、新しい作品紹介文が表示されています。".repeat(5);

    await vi.waitFor(() => expect(image.closest("picture")!.nextElementSibling?.textContent)
      .toBe(`译文：${image.alt}`));
    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
  });

  it("discards an image translation response if its alt changes during the request", async () => {
    const image = mountImageText();
    let release!: (response: TranslateBatchResponse) => void;
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const completion = startPageTranslation(settings);
    await waitForBatchRequests();
    image.alt = "新しい画像の文章だけを翻訳し、古い画像の翻訳は表示しません。".repeat(5);
    translateNormally();
    release({ translations: ["过期的图片译文"], cached: 0 });
    await completion;

    await vi.waitFor(() => expect(image.closest("picture")!.nextElementSibling?.textContent)
      .toBe(`译文：${image.alt}`));
    expect(document.body.textContent).not.toContain("过期的图片译文");
    expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
  });

  it("discovers image text when loading creates its first rendered area", async () => {
    const image = mountImageText();
    let loaded = false;
    const originalRect = vi.mocked(Element.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this !== image || loaded ? originalRect.call(this) : { width: 0, height: 0 } as DOMRect;
    });
    translateNormally();
    await startPageTranslation(settings);
    expect(sendRuntimeRequest).not.toHaveBeenCalled();

    loaded = true;
    image.dispatchEvent(new Event("load"));

    await vi.waitFor(() => expect(image.closest("picture")!.nextElementSibling?.textContent)
      .toBe(`译文：${image.alt}`));
  });

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

  it("stops an initial scan that is still yielding", async () => {
    document.body.innerHTML = `<main>${Array.from({ length: 20 }, (_, index) =>
      `<p data-top="${index * 30}">Paragraph ${index} to translate.</p>`).join("")}</main>`;
    let yieldReached = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("scheduler", {
      yield: () => {
        yieldReached = true;
        return gate;
      }
    });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
    translateNormally();

    const starting = startPageTranslation({ ...settings, cacheEnabled: false });
    expect(yieldReached).toBe(true);
    hidePageTranslation();
    release();
    await starting;

    expect(getPageTranslationState().active).toBe(false);
    expect(sendRuntimeRequest).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps retrying hidden text until it becomes visible", async () => {
    document.body.innerHTML = `<div role="main"><div id="scroller"><p id="visible" data-top="100">Visible email.</p>
      <p id="covered" data-top="200">Previously covered email body.</p></div></div><div id="overlay"></div>`;
    let covered = true;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => (covered ? document.querySelector("#overlay") : document.body)
    });
    translateNormally();
    await startPageTranslation({ ...settings, cacheEnabled: false });
    expect(sendRuntimeRequest).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sendRuntimeRequest).not.toHaveBeenCalled();

    covered = false;
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(document.querySelector("#covered .wupage-translation")?.textContent)
      .toBe("译文：Previously covered email body."));
  });

  it("finishes covered paragraphs beyond one batch after a single scroll", async () => {
    const count = 401;
    document.body.innerHTML = `<main>${Array.from({ length: count }, (_, index) =>
      `<p data-top="0">Covered paragraph ${index}.</p>`).join("")}</main><div id="overlay"></div>`;
    let covered = true;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => (covered ? document.querySelector("#overlay") : document.body)
    });
    translateNormally();
    await startPageTranslation({ ...settings, cacheEnabled: false });
    expect(sendRuntimeRequest).not.toHaveBeenCalled();

    covered = false;
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(document.querySelectorAll(".wupage-translation:not(.wupage-translation-pending)")).toHaveLength(count), { timeout: 4000 });
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
    await waitForBatchRequests();
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
    await waitForBatchRequests();
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

  it("translates legacy BR-separated fiction near the viewport and discovers distant paragraphs on scroll", async () => {
    const passages = Array.from({ length: 70 }, (_, index) => `Passage ${index}: The traveler reached a village before sunset.`);
    document.body.innerHTML = `<main><div class="legacy-journal">${passages.join("<br><br>")}</div></main>`;
    const original = document.body.innerHTML;
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      const source = this.closest("[data-wupage-prose-source]");
      const index = Number(source?.textContent?.match(/Passage (\d+):/)?.[1] ?? 0);
      const top = index * 300 - scrollOffset;
      return { width: 600, height: source ? 240 : 21000, top, bottom: top + (source ? 240 : 21000),
        left: 0, right: 600, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    translateNormally();
    const requested = () => vi.mocked(sendRuntimeRequest).mock.calls.flatMap(([request]) =>
      request.type === "TRANSLATE_BATCH" ? request.texts : []);

    const result = await startPageTranslation(settings);
    expect(requested()).toEqual(passages.slice(0, 5));
    expect(result).toMatchObject({ translated: 5, remaining: 65, failed: 0 });
    const sources = [...document.querySelectorAll("[data-wupage-prose-source]")];
    expect(sources[0].nextElementSibling?.textContent).toBe(`译文：${passages[0]}`);
    expect(sources[69].nextElementSibling).toBeNull();
    await vi.waitFor(() => expect(getPageTranslationState().pending).toBe(0));

    scrollOffset = 69 * 300;
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(requested()).toContain(passages[69]));
    expect(requested().every(text => passages.includes(text))).toBe(true);
    expect(requested().filter(text => text === passages[0])).toHaveLength(1);
    clearPageTranslation();
    expect(document.body.innerHTML).toBe(original);
  });

  it("settles normalization of dynamically loaded legacy fiction without duplicate requests", async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = "<main><p>Initial paragraph.</p></main>";
      translateNormally();
      await startPageTranslation(settings);
      document.querySelector("main")!.insertAdjacentHTML("beforeend", "<div>First loaded passage.<br><br>Second loaded passage.</div>");
      await vi.advanceTimersByTimeAsync(2000);
      const requested = () => vi.mocked(sendRuntimeRequest).mock.calls.flatMap(([request]) =>
        request.type === "TRANSLATE_BATCH" ? request.texts : []);
      expect(requested()).toEqual(["Initial paragraph.", "First loaded passage.", "Second loaded passage."]);
      const source = document.querySelector("[data-wupage-prose-source]")!;
      source.append(" New ending.");
      await vi.advanceTimersByTimeAsync(1000);
      expect(requested().slice(3)).toEqual(["First loaded passage. New ending."]);
    } finally { vi.useRealTimers(); }
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

  it("restarts active translations when the ordinary source language changes", async () => {
    document.body.innerHTML = "<main><p>Original paragraph.</p></main>";
    translateNormally();
    await startPageTranslation(settings);
    updatePageTranslationSettings({ ...settings, sourceLang: "en" });
    await vi.waitFor(() => expect(getPageTranslationState().pending).toBe(0));

    expect(sendRuntimeRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendRuntimeRequest).mock.calls[1][0]).toMatchObject({
      sourceLang: "en", targetLang: settings.targetLang, texts: ["Original paragraph."]
    });
    expect(getPageTranslationState()).toMatchObject({ active: true, translated: 1, failed: 0 });
  });

  it("uses the new language for offscreen and dynamically added paragraphs", async () => {
    document.body.innerHTML = '<main><p data-top="100">First paragraph.</p><p data-top="5100">Later paragraph.</p></main>';
    translateNormally();
    await startPageTranslation({ ...settings, targetLang: "ja" });
    updatePageTranslationSettings(settings);
    await vi.waitFor(() => expect(getPageTranslationState().pending).toBe(0));
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(2);

    scrollOffset = 5000;
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(getPageTranslationState().translated).toBe(2));
    document.querySelector("main")!.insertAdjacentHTML("beforeend", '<p data-top="5200">New paragraph.</p>');
    await vi.waitFor(() => expect(getPageTranslationState().translated).toBe(3));
    const requests = vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(4);
    expect(requests.slice(1)).toEqual([
      expect.objectContaining({ targetLang: "zh-CN", texts: ["First paragraph."] }),
      expect.objectContaining({ targetLang: "zh-CN", texts: ["Later paragraph."] }),
      expect.objectContaining({ targetLang: "zh-CN", texts: ["New paragraph."] })
    ]);
  });

  it("preserves window and nested scroll positions while clearing the old language", async () => {
    document.body.innerHTML = '<main><section><p>Stable viewport paragraph.</p></section></main>';
    translateNormally();
    await startPageTranslation(settings);
    const container = document.querySelector("section")!;
    container.scrollTop = 700;
    container.scrollLeft = 15;
    let currentScrollY = 3400;
    vi.spyOn(window, "scrollX", "get").mockReturnValue(12);
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => currentScrollY);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation((_left, top) => { currentScrollY = Number(top); });
    const nativeRemove = Element.prototype.remove;
    vi.spyOn(Element.prototype, "remove").mockImplementation(function (this: Element) {
      if (this.classList.contains("wupage-translation")) {
        currentScrollY -= 100;
        container.scrollTop -= 40;
        container.scrollLeft = 0;
      }
      nativeRemove.call(this);
    });

    updatePageTranslationSettings({ ...settings, targetLang: "ja" });
    expect(currentScrollY).toBe(3400);
    expect(container.scrollTop).toBe(700);
    expect(container.scrollLeft).toBe(15);
    expect(scrollTo).toHaveBeenCalledWith(12, 3400);
    await vi.waitFor(() => expect(getPageTranslationState().pending).toBe(0));
    expect(getPageTranslationState().translated).toBe(1);
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

  it("settles structured writes without retranslating them and still discovers real edits", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(window.getComputedStyle).mockImplementation(element => ({
        display: element.matches("strong") ? "inline" : "block", visibility: "visible", opacity: "1"
      }) as CSSStyleDeclaration);
      document.body.innerHTML = '<main><p>Read <strong>the complete guide</strong> carefully.</p></main>';
      const strong = document.querySelector("strong")!;
      const source = strong.firstChild;
      translateNormally();
      await startPageTranslation({ ...settings, translationDisplayMode: "replace" });
      expect(vi.mocked(sendRuntimeRequest).mock.calls[0][0]).toMatchObject({ texts: [expect.stringContaining("WUPAGEOPEN0")] });
      await vi.advanceTimersByTimeAsync(2000);
      expect(sendRuntimeRequest).toHaveBeenCalledTimes(1);
      expect(getPageTranslationState()).toMatchObject({ translated: 1, failed: 0, pending: 0 });
      expect(document.querySelector("strong")).toBe(strong);
      expect(strong.firstChild).toBe(source);
      source!.textContent = "an updated guide";
      await vi.advanceTimersByTimeAsync(1000);
      expect(sendRuntimeRequest).toHaveBeenCalledTimes(2);
      expect(strong.textContent).toContain("an updated guide");
      clearPageTranslation();
      expect(strong.textContent).toBe("an updated guide");
    } finally { vi.useRealTimers(); }
  });
});
