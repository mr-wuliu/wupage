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
