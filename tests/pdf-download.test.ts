// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { RuntimeRequest, RuntimeResponse } from "../src/shared/types";

const { getDocument, buildRasterPdf, composeTranslatedPageCanvas, downloadPdfBytes } = vi.hoisted(() => ({
  getDocument: vi.fn(), buildRasterPdf: vi.fn(), composeTranslatedPageCanvas: vi.fn(), downloadPdfBytes: vi.fn()
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {}, OPS: {}, getDocument,
  TextLayer: class { async render() {} }
}));
vi.mock("../src/pdf/rendering", () => ({ renderPageWithoutText: vi.fn(async () => undefined) }));
vi.mock("../src/pdf/font-control", () => ({ setupPdfFontControl: () => ({
  prepareExport: async () => ({}), setExporting: vi.fn(), cancel: vi.fn()
}) }));
vi.mock("../src/pdf/export", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/pdf/export")>(),
  buildRasterPdf, composeTranslatedPageCanvas, downloadPdfBytes,
  canvasToJpegBytes: vi.fn(async () => new Uint8Array([1]))
}));

describe("PDF full document download", () => {
  let sendMessage: Mock<(request: RuntimeRequest) => Promise<RuntimeResponse>>;
  let stored: typeof DEFAULT_SETTINGS;

  beforeEach(() => {
    document.open();
    document.write(readFileSync(resolve(process.cwd(), "pdf.html"), "utf8"));
    document.close();
    window.history.replaceState({}, "", "/pdf.html?url=https%3A%2F%2Fexample.com%2Freport.pdf&translate=0");
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const page = Number(this.closest<HTMLElement>("article[data-page]")?.dataset.page);
      const top = page ? (page - 1) * 1000 : 0;
      return { top, bottom: page ? top + 980 : 75, left: 0, right: 600, width: 600,
        height: page ? 980 : 75, x: 0, y: top, toJSON() {} };
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal("IntersectionObserver", class {
      observe() {} unobserve() {} disconnect() {}
    });
    vi.stubGlobal("ResizeObserver", class {
      observe() {} disconnect() {}
    });
    getDocument.mockReset().mockImplementation(() => ({
      promise: Promise.resolve({ numPages: 4, getPage: async (number: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, scale }),
        getTextContent: async () => ({
          items: number === 4 ? [] : [{
            str: `Page ${number} contents.`, transform: [1, 0, 0, 12, 10, 100], width: 180, fontName: "font"
          }],
          styles: { font: { fontFamily: "Arial" } }
        }),
        render: () => ({ promise: Promise.resolve() })
      }) }), destroy: vi.fn(async () => undefined)
    }));
    stored = { ...structuredClone(DEFAULT_SETTINGS), pdfTranslationPageRadius: 0 };
    sendMessage = vi.fn(async (request: RuntimeRequest): Promise<RuntimeResponse> => {
      if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(stored) };
      if (request.type === "SAVE_SETTINGS") { stored = structuredClone(request.settings); return { ok: true }; }
      if (request.type === "TRANSLATE_BATCH") return {
        ok: true, data: { translations: request.texts.map((text) => `译文 ${text}`), cached: 0 }
      };
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { id: "test-extension", sendMessage } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-test")));
    buildRasterPdf.mockReset().mockResolvedValue(new Uint8Array([2]));
    composeTranslatedPageCanvas.mockReset().mockImplementation((canvas) => canvas);
    downloadPdfBytes.mockReset();
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    document.querySelectorAll<HTMLElement>("[data-timer]").forEach((element) => {
      window.clearTimeout(Number(element.dataset.timer));
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    document.documentElement.replaceChildren();
    window.history.replaceState({}, "", "/");
  });

  const download = () => document.querySelector<HTMLButtonElement>("#downloadDocument")!;
  const translate = () => document.querySelector<HTMLButtonElement>("#translateDocument")!;
  const requests = () => sendMessage.mock.calls.map(([request]) => request as RuntimeRequest)
    .filter((request) => request.type === "TRANSLATE_BATCH");
  const status = () => document.querySelector("#statusToast")?.textContent;
  async function launch(): Promise<void> {
    await import("../src/pdf/index");
    await vi.waitFor(() => expect(download().disabled).toBe(false));
  }

  it("translates every text page before exporting, even with current-page-only reading and scrolling", async () => {
    const original = sendMessage.getMockImplementation()!;
    const gates: Array<() => void> = [];
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      if (request.type === "TRANSLATE_BATCH" && gates.length < 2) {
        await new Promise<void>((resolve) => { gates.push(resolve); });
      }
      return original(request);
    });
    await launch();
    download().click();
    download().click();
    translate().click();
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    expect(downloadPdfBytes).not.toHaveBeenCalled();
    expect(download().textContent).toBe("正在翻译…");
    expect(document.querySelector<HTMLSelectElement>("#targetLang")!.disabled).toBe(true);
    window.dispatchEvent(new Event("scroll"));
    gates.forEach((release) => release());
    await vi.waitFor(() => expect(downloadPdfBytes).toHaveBeenCalledOnce());
    expect(requests().map((request) => request.texts[0]).sort()).toEqual([
      "Page 1 contents.", "Page 2 contents.", "Page 3 contents."
    ]);
    expect(buildRasterPdf.mock.calls[0][0]).toHaveLength(4); // Blank pages keep their place.
    expect(stored.pdfTranslationPageRadius).toBe(0);
    expect(download().disabled).toBe(false);
    expect(translate().disabled).toBe(false);
    expect(document.querySelector<HTMLSelectElement>("#targetLang")!.disabled).toBe(false);
  });

  it("reuses completed pages and their edits, and does not retranslate on repeated downloads", async () => {
    await launch();
    translate().click();
    await vi.waitFor(() => expect(translate().disabled).toBe(false));
    expect(requests()).toHaveLength(1);
    const layer = document.querySelector<HTMLElement>('article[data-page="1"] .translation-text-layer')!;
    layer.textContent = "手动校对的译文";
    download().click();
    await vi.waitFor(() => expect(downloadPdfBytes).toHaveBeenCalledOnce());
    expect(requests()).toHaveLength(3);
    expect(layer.textContent).toBe("手动校对的译文");
    expect(composeTranslatedPageCanvas.mock.calls[0][1]).toBe(layer);
    download().click();
    await vi.waitFor(() => expect(downloadPdfBytes).toHaveBeenCalledTimes(2));
    expect(requests()).toHaveLength(3);
    expect(layer.textContent).toBe("手动校对的译文");
  });

  it("translates all pages in the newly selected language instead of mixing contexts", async () => {
    await launch();
    translate().click();
    await vi.waitFor(() => expect(translate().disabled).toBe(false));
    const language = document.querySelector<HTMLSelectElement>("#targetLang")!;
    language.value = "ja";
    language.dispatchEvent(new Event("change"));
    download().click();
    await vi.waitFor(() => expect(downloadPdfBytes).toHaveBeenCalledOnce());
    expect(requests()).toHaveLength(4);
    expect(requests().slice(1).every((request) => request.targetLang === "ja")).toBe(true);
  });

  it.each(["service failure", "missing translation"])("blocks incomplete export after %s and retries only the failed page", async (failure) => {
    const original = sendMessage.getMockImplementation()!;
    let fail = true;
    sendMessage.mockImplementation((request: RuntimeRequest) => {
      if (fail && request.type === "TRANSLATE_BATCH" && request.texts[0].includes("Page 2")) {
        return Promise.resolve(failure === "service failure" ? { ok: false, error: "Service unavailable" }
          : { ok: true, data: { translations: [], cached: 0 } });
      }
      return original(request);
    });
    await launch();
    download().click();
    await vi.waitFor(() => expect(status()).toContain("1 页未完成翻译"));
    expect(downloadPdfBytes).not.toHaveBeenCalled();
    expect(buildRasterPdf).not.toHaveBeenCalled();
    expect(download().disabled).toBe(false);
    fail = false;
    download().click();
    await vi.waitFor(() => expect(downloadPdfBytes).toHaveBeenCalledOnce());
    expect(requests().map((request) => request.texts[0])).toEqual([
      "Page 1 contents.", "Page 2 contents.", "Page 3 contents.", "Page 2 contents."
    ]);
  });

  it("restores the controls when saving reader settings fails", async () => {
    await launch();
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation((request: RuntimeRequest) => request.type === "SAVE_SETTINGS"
      ? Promise.resolve({ ok: false, error: "Settings unavailable" }) : original(request));
    download().click();
    await vi.waitFor(() => expect(status()).toContain("Settings unavailable"));
    expect(requests()).toHaveLength(0);
    expect(downloadPdfBytes).not.toHaveBeenCalled();
    expect(download().disabled).toBe(false);
    expect(translate().disabled).toBe(false);
  });

  it("cancels the pending export when another document is opened", async () => {
    const original = sendMessage.getMockImplementation()!;
    const gates: Array<() => void> = [];
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      if (request.type === "TRANSLATE_BATCH") await new Promise<void>((resolve) => { gates.push(resolve); });
      return original(request);
    });
    await launch();
    download().click();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    document.querySelector<HTMLInputElement>("#pdfUrl")!.value = "https://example.com/second.pdf";
    document.querySelector("#urlForm")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector("#documentName")?.textContent).toBe("second.pdf"));
    gates.forEach((release) => release());
    await vi.waitFor(() => expect(download().disabled).toBe(false));
    expect(downloadPdfBytes).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(2);
  });
});
