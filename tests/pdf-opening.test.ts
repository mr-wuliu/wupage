// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
vi.mock("../src/pdf/font-control", () => ({ setupPdfFontControl: () => ({
  prepareExport: async () => ({}), setExporting: vi.fn(), cancel: vi.fn()
}) }));
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { RuntimeRequest, RuntimeResponse } from "../src/shared/types";
import { pdfPortFixture } from "./helpers/pdf-port";

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, OPS: {}, TextLayer: vi.fn(), getDocument }));

describe("PDF source opening", () => {
  let fileAccess: Mock<() => Promise<boolean>>;
  let fetchPdf: Mock<typeof fetch>;
  let sendMessage: Mock<(request: RuntimeRequest) => Promise<RuntimeResponse>>;
  const fileUrl = "file:///C:/Reports/Annual%20report.pdf#page=2";

  beforeEach(() => {
    document.open();
    document.write(readFileSync(resolve(process.cwd(), "pdf.html"), "utf8"));
    document.close();
    window.history.replaceState({}, "", "/pdf.html");
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    vi.stubGlobal("IntersectionObserver", class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
    const page = {
      getViewport: () => ({ width: 612, height: 792 }),
      getTextContent: async () => ({
        items: [{ str: "A paragraph for translation.", transform: [1, 0, 0, 12, 10, 100], width: 180, fontName: "font" }],
        styles: { font: { fontFamily: "Arial" } }
      })
    };
    getDocument.mockReset().mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage: async () => page }),
      destroy: vi.fn(async () => undefined)
    });
    fileAccess = vi.fn(async () => true);
    sendMessage = vi.fn(async (request: RuntimeRequest): Promise<RuntimeResponse> => {
      if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(DEFAULT_SETTINGS) };
      if (request.type === "TRANSLATE_BATCH") return { ok: true, data: { translations: ["一段用于翻译的文字。"], cached: 0 } };
      return { ok: true };
    });
    vi.stubGlobal("chrome", {
      runtime: { id: "test-extension", sendMessage, connect: pdfPortFixture(sendMessage) },
      extension: { isAllowedFileSchemeAccess: fileAccess },
      tabs: { create: vi.fn(async () => undefined) }
    });
    fetchPdf = vi.fn(async () => new Response("%PDF-test", { headers: { "content-type": "application/pdf" } }));
    vi.stubGlobal("fetch", fetchPdf);
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

  async function launch(url: string, autoTranslate = true): Promise<void> {
    window.history.replaceState({}, "", `/pdf.html?url=${encodeURIComponent(url)}&translate=${autoTranslate ? 1 : 0}`);
    await import("../src/pdf/index");
  }

  function translated(): boolean {
    return sendMessage.mock.calls.some(([request]) => (request as RuntimeRequest).type === "TRANSLATE_BATCH");
  }

  function submitUrl(url: string): void {
    document.querySelector<HTMLInputElement>("#pdfUrl")!.value = url;
    document.querySelector("#urlForm")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it("does not let an older download replace the document opened afterward", async () => {
    let finish!: (response: Response) => void;
    let oldSignal: AbortSignal | undefined;
    fetchPdf.mockImplementationOnce((_url, init) => {
      oldSignal = init!.signal!;
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    await launch("https://example.com/slow.pdf", false);
    await vi.waitFor(() => expect(fetchPdf).toHaveBeenCalledOnce());
    submitUrl("https://example.com/new.pdf");
    await vi.waitFor(() => expect(document.querySelector("#documentName")?.textContent).toBe("new.pdf"));
    expect(oldSignal!.aborted).toBe(true);
    finish(new Response("%PDF-old", { headers: { "content-type": "application/pdf" } }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(document.querySelector("#documentName")?.textContent).toBe("new.pdf");
    expect(getDocument).toHaveBeenCalledOnce();
  });

  it("ignores a late parser result without clearing the newer document", async () => {
    const normal = getDocument.getMockImplementation()!();
    const proxy = await normal.promise;
    let finish!: (value: typeof proxy) => void;
    const old = { promise: new Promise<typeof proxy>(resolve => { finish = resolve; }), destroy: vi.fn(async () => undefined) };
    getDocument.mockReturnValueOnce(old);
    await launch("https://example.com/old.pdf", false);
    await vi.waitFor(() => expect(getDocument).toHaveBeenCalledOnce());
    submitUrl("https://example.com/latest.pdf");
    await vi.waitFor(() => expect(document.querySelector("#documentName")?.textContent).toBe("latest.pdf"));
    finish(proxy);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(document.querySelector("#documentName")?.textContent).toBe("latest.pdf");
    expect(document.querySelector("#pages")?.children.length).toBe(1);
  });

  it("opens valid PDF URLs whose file names contain a literal percent sign", async () => {
    await launch("https://example.com/report%complete.pdf", false);
    await vi.waitFor(() => expect(document.querySelector("#documentName")?.textContent).toBe("report%complete.pdf"));
    expect(getDocument).toHaveBeenCalledOnce();
  });

  async function mockDocumentPages(count: number): Promise<void> {
    const documentProxy = await getDocument.getMockImplementation()!().promise;
    const sample = await documentProxy.getPage(1);
    getDocument.mockReturnValue({ promise: Promise.resolve({
      numPages: count,
      getPage: async (number: number) => ({ ...sample, getTextContent: async () => ({
        items: [{ str: `Page ${number} contents.`, transform: [1, 0, 0, 12, 10, 100], width: 180, fontName: "font" }],
        styles: { font: { fontFamily: "Arial" } }
      }) })
    }), destroy: vi.fn() });
  }

  it("translates a shared page-break paragraph from either reading page without translating the rest of its dependency page", async () => {
    let readingPage = 2;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const number = Number(this.closest<HTMLElement>("article[data-page]")?.dataset.page);
      const top = number ? (number - readingPage) * 1000 : 0;
      return { top, bottom: top + 980, left: 0, right: 600, width: 600, height: 980, x: 0, y: top, toJSON() {} };
    });
    const item = (str: string, y: number) => ({ str, transform: [12, 0, 0, 12, 40, y], width: 240, height: 12, hasEOL: true, fontName: "font" });
    const contents = [
      [item("A separate earlier paragraph on the previous page.", 600),
        item("We introduce an encoder that maps", 100), item("the incoming observations to the hidden", 86), item("representation of the robot", 72)],
      [item("state and predicts the next action from these", 730), item("measurements.", 716),
        item("An independent paragraph on the current page.", 500)]
    ];
    getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage: async (number: number) => ({
      getViewport: () => ({ width: 612, height: 792 }),
      getTextContent: async () => ({ items: contents[number - 1], styles: { font: { fontFamily: "Arial" } } })
    }) }), destroy: vi.fn(async () => undefined) });
    const stored = { ...structuredClone(DEFAULT_SETTINGS), pdfTranslationPageRadius: 0, cacheEnabled: false };
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async request => {
      if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(stored) };
      if (request.type === "TRANSLATE_BATCH") return { ok: true, data: { translations: request.texts, cached: 0 } };
      return original(request);
    });
    await launch(fileUrl);
    const requests = () => sendMessage.mock.calls.flatMap(([request]) => request.type === "TRANSLATE_BATCH" ? request.texts : []);
    const shared = () => requests().filter(text => text.includes("representation of the robot") && text.includes("state and predicts"));
    await vi.waitFor(() => expect(document.querySelector('article[data-page="2"] .translation-prompt')?.textContent).toContain("译文已就绪"));
    expect(shared()).toHaveLength(1);
    expect(requests().some(text => text.includes("separate earlier"))).toBe(false);
    expect(document.querySelector('article[data-page="1"] .translation-prompt')?.textContent).toContain("1 / 2");
    readingPage = 1;
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(requests().some(text => text.includes("separate earlier"))).toBe(true));
    await vi.waitFor(() => expect(document.querySelector('article[data-page="1"] .translation-prompt')?.textContent).toContain("译文已就绪"));
    expect(shared()).toHaveLength(1);
  });

  it("reads and automatically translates a permitted local PDF", async () => {
    await launch(fileUrl);
    await vi.waitFor(() => expect(translated()).toBe(true));
    expect(fileAccess).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "TRANSLATE_BATCH", preservePlaceholders: true, translationStyle: "academic" }));
    expect(fetchPdf).toHaveBeenCalledWith(fileUrl, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(getDocument).toHaveBeenCalledWith({ data: expect.any(Uint8Array) });
    expect(document.querySelector("#documentName")?.textContent).toBe("Annual report.pdf");
    expect(document.querySelector<HTMLElement>("#readerView")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#fileAccessNotice")?.hidden).toBe(true);
  });

  it("blocks repeated translation clicks while reader settings are still being saved", async () => {
    await launch(fileUrl, false);
    const button = document.querySelector<HTMLButtonElement>("#translateDocument")!;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    let finishSave: (response: RuntimeResponse) => void = () => undefined;
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation((request: RuntimeRequest) => request.type === "SAVE_SETTINGS"
      ? new Promise<RuntimeResponse>((resolve) => { finishSave = resolve; }) : original(request));
    button.click();
    expect(button.disabled).toBe(true);
    button.click();
    await vi.waitFor(() => expect(sendMessage.mock.calls.filter(([request]) => request.type === "SAVE_SETTINGS")).toHaveLength(1));
    finishSave({ ok: true });
    await vi.waitFor(() => expect(translated()).toBe(true));
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "TRANSLATE_BATCH")).toHaveLength(1);
  });

  it("stops loading immediately when the language changes and ignores the old page result", async () => {
    let finish!: (response: RuntimeResponse) => void;
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(request => request.type === "TRANSLATE_BATCH"
      ? new Promise(resolve => { finish = resolve; }) : original(request));
    await launch(fileUrl);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const language = document.querySelector<HTMLSelectElement>("#targetLang")!;
    language.value = "ja"; language.dispatchEvent(new Event("change"));
    expect(document.querySelector<HTMLButtonElement>("#translateDocument")!.disabled).toBe(false);
    expect(document.querySelector(".translation-canvas-shell.is-loading")).toBeNull();
    expect(document.querySelector(".translation-prompt")!.textContent).toContain("翻译设置已更改");
    finish({ ok: true, data: { translations: ["旧译文"], cached: 0 } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector(".translation-prompt")!.textContent).toContain("翻译设置已更改");
    sendMessage.mockImplementation(original);
    document.querySelector<HTMLButtonElement>("#translateDocument")!.click();
    await vi.waitFor(() => expect(document.querySelector("#statusToast")?.textContent).toContain("翻译完成"));
    expect(document.querySelector(".translation-canvas-shell.is-loading")).toBeNull();
    expect(document.querySelector(".translation-prompt")!.textContent).toContain("译文已就绪");
  });

  it("starts at the reading position, debounces scrolling, and replaces waiting pages while requests are in flight", async () => {
    let readingPage = 10;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const page = Number(this.closest<HTMLElement>("article[data-page]")?.dataset.page);
      const top = page ? (page - readingPage) * 1000 : 0;
      return { top, bottom: page ? top + 980 : 75, left: 0, right: 600, width: 600, height: page ? 980 : 75, x: 0, y: top, toJSON() {} };
    });
    const documentProxy = await getDocument.getMockImplementation()!().promise;
    const sample = await documentProxy.getPage(1);
    getDocument.mockReturnValue({ promise: Promise.resolve({
      numPages: 40,
      getPage: async (number: number) => ({ ...sample, getTextContent: async () => ({
        items: [{ str: `Page ${number} contents.`, transform: [1, 0, 0, 12, 10, 100], width: 180, fontName: "font" }],
        styles: { font: { fontFamily: "Arial" } }
      }) })
    }), destroy: vi.fn() });
    const gates: Array<(response: RuntimeResponse) => void> = [];
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation((request: RuntimeRequest) => request.type === "TRANSLATE_BATCH" && gates.length < 2
      ? new Promise<RuntimeResponse>((resolve) => gates.push(resolve)) : original(request));
    const requests = () => sendMessage.mock.calls.flatMap(([request]) => request.type === "TRANSLATE_BATCH" ? [request.texts[0]] : []);
    await launch(fileUrl);
    await vi.waitFor(() => expect(requests()).toEqual(["Page 10 contents.", "Page 11 contents."]));
    readingPage = 20;
    window.dispatchEvent(new Event("scroll"));
    readingPage = 30;
    window.dispatchEvent(new Event("scroll"));
    gates[0]({ ok: true, data: { translations: ["译文"], cached: 0 } });
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(requests()).toHaveLength(2); // No intermediate range or old queued page is dispatched.
    await vi.waitFor(() => expect(requests()[2]).toBe("Page 30 contents."));
    gates[1]({ ok: true, data: { translations: ["译文"], cached: 0 } });
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#translateDocument")!.disabled).toBe(false));
    expect(requests().slice(2).sort()).toEqual(Array.from({ length: 11 }, (_, index) => `Page ${index + 25} contents.`).sort());
    expect(new Set(requests()).size).toBe(13);
    expect(document.querySelector('article[data-page="8"] .translation-canvas-shell')?.classList.contains("is-loading")).toBe(false);
  });

  it("automatically follows the nearby range after activation, reuses overlap, and reads updated settings without reopening", async () => {
    let readingPage = 15;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const page = Number(this.closest<HTMLElement>("article[data-page]")?.dataset.page);
      const top = page ? (page - readingPage) * 1000 : 0;
      return { top, bottom: page ? top + 980 : 75, left: 0, right: 600, width: 600, height: page ? 980 : 75, x: 0, y: top, toJSON() {} };
    });
    const documentProxy = await getDocument.getMockImplementation()!().promise;
    const sample = await documentProxy.getPage(1);
    getDocument.mockReturnValue({ promise: Promise.resolve({
      numPages: 30,
      getPage: async (number: number) => ({ ...sample, getTextContent: async () => ({
        items: [{ str: `Page ${number} contents.`, transform: [1, 0, 0, 12, 10, 100], width: 180, fontName: "font" }],
        styles: { font: { fontFamily: "Arial" } }
      }) })
    }), destroy: vi.fn() });
    const stored = { ...structuredClone(DEFAULT_SETTINGS), cacheEnabled: false };
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation((request: RuntimeRequest) => {
      if (request.type === "GET_SETTINGS") return Promise.resolve({ ok: true, data: structuredClone(stored) });
      return original(request);
    });
    const requests = () => sendMessage.mock.calls.flatMap(([request]) => request.type === "TRANSLATE_BATCH"
      ? [Number(/Page (\d+)/u.exec(request.texts[0])![1])] : []);
    await launch(fileUrl, false);
    const button = document.querySelector<HTMLButtonElement>("#translateDocument")!;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toContain("翻译附近页面");
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(requests()).toHaveLength(0); // Scrolling alone cannot start paid translation before activation.
    const run = async () => {
      button.click();
      await vi.waitFor(() => expect(button.disabled).toBe(false));
    };
    await run();
    expect(requests()[0]).toBe(15);
    expect([...requests()].sort((a, b) => a - b)).toEqual(Array.from({ length: 11 }, (_, index) => index + 10));
    expect(document.querySelector('article[data-page="9"] .translation-canvas-shell')?.classList.contains("is-pending")).toBe(true);
    expect(document.querySelector("#statusToast")?.textContent).toContain("滚动后自动补译");
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(requests()).toHaveLength(11);
    await run();
    expect(requests()).toHaveLength(11); // No duplicate requests, even with the service cache disabled.
    readingPage = 20;
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(requests()).toHaveLength(16));
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(new Set(requests()).size).toBe(16); // Overlapping windows reuse their translations.
    stored.pdfTranslationPageRadius = 0;
    readingPage = 28;
    await run();
    expect(requests()).toHaveLength(17);
    expect(requests().at(-1)).toBe(28);
    readingPage = 30;
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(requests()).toHaveLength(18));
    expect(requests().at(-1)).toBe(30);
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    stored.pdfTranslationPageRadius = null;
    await run();
    expect(button.textContent).toContain("翻译全文");
    expect(new Set(requests()).size).toBe(30);
    expect(requests()).toHaveLength(30);
    const language = document.querySelector<HTMLSelectElement>("#targetLang")!;
    language.value = "ja";
    stored.pdfTranslationPageRadius = 0;
    readingPage = 28;
    await run();
    expect(requests()).toHaveLength(31); // A changed target language needs a new translation.
  });

  it("does not automatically retry failures on scroll, and allows an explicit retry", async () => {
    const original = sendMessage.getMockImplementation()!;
    let failed = true;
    sendMessage.mockImplementation((request: RuntimeRequest) => request.type === "TRANSLATE_BATCH" && failed
      ? Promise.resolve({ ok: false, error: "Service unavailable" }) : original(request));
    await launch(fileUrl);
    const button = document.querySelector<HTMLButtonElement>("#translateDocument")!;
    await vi.waitFor(() => expect(document.querySelector("#statusToast")?.textContent).toContain("1 段失败"));
    for (let index = 0; index < 3; index++) window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "TRANSLATE_BATCH")).toHaveLength(1);
    failed = false;
    button.click();
    await vi.waitFor(() => expect(document.querySelector("#statusToast")?.textContent).toContain("1 段译文"));
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "TRANSLATE_BATCH")).toHaveLength(2);
  });

  it.each([["login-required", false], ["service-rejected", false], ["rate-limited", false], ["rate-limited", true]] as const)("pauses all waiting pages after %s (download=%s) and resumes only on an explicit translation", async (errorCode, forDownload) => {
    await mockDocumentPages(6);
    let readingPage = 1;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const page = Number(this.closest<HTMLElement>("article[data-page]")?.dataset.page);
      const top = page ? (page - readingPage) * 1000 : 0;
      return { top, bottom: page ? top + 980 : 75, left: 0, right: 600, width: 600, height: page ? 980 : 75, x: 0, y: top, toJSON() {} };
    });
    Object.assign(chrome.runtime, { getURL: (path: string) => `chrome-extension://test-extension/${path}` });
    const stored = { ...structuredClone(DEFAULT_SETTINGS), activeProviderId: "doubao-web" };
    const gates: Array<(response: RuntimeResponse) => void> = [];
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation((request: RuntimeRequest) => {
      if (request.type === "GET_SETTINGS") return Promise.resolve({ ok: true, data: structuredClone(stored) });
      if (request.type === "TRANSLATE_BATCH" && gates.length < 1) {
        return new Promise<RuntimeResponse>((resolve) => gates.push(resolve));
      }
      return original(request);
    });
    const requests = () => sendMessage.mock.calls.flatMap(([request]) => request.type === "TRANSLATE_BATCH" ? [request.texts[0]] : []);
    await launch(fileUrl, !forDownload);
    if (forDownload) {
      const download = document.querySelector<HTMLButtonElement>("#downloadDocument")!;
      await vi.waitFor(() => expect(download.disabled).toBe(false));
      download.click();
    }
    await vi.waitFor(() => expect(requests()).toEqual(["Page 1 contents."]));
    const originals = [...document.querySelectorAll(".original-panel canvas")];
    const button = document.querySelector<HTMLButtonElement>("#translateDocument")!;
    readingPage = 6;
    window.dispatchEvent(new Event("scroll")); // A previously scheduled range change must also stop.
    gates[0]({ ok: false, error: "请处理连接后重试。", errorCode, ...(errorCode === "rate-limited" ? { retryAfterMs: 100 } : {}) });
    await vi.waitFor(() => expect(document.querySelector("#statusToast")?.textContent).toContain(forDownload ? "下载失败" : "翻译已暂停"));
    // Doubao's configured single-request limit is respected by the PDF queue.
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(requests()).toHaveLength(1);
    expect(document.querySelector("#statusToast")?.textContent).toContain(forDownload ? "下载失败：请处理连接后重试" : "可直接点击翻译按钮重试");
    expect(document.querySelector<HTMLElement>("#statusToast")?.hidden).toBe(false);
    expect(document.querySelector('article[data-page="1"] .translation-canvas-shell')?.classList.contains("has-error")).toBe(true);
    expect(document.querySelector('article[data-page="3"] .translation-canvas-shell')?.classList.contains("is-pending")).toBe(true);
    expect([...document.querySelectorAll(".original-panel canvas")]).toEqual(originals);

    button.click();
    await vi.waitFor(() => expect(requests()).toHaveLength(7));
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(requests().filter((text) => text === "Page 2 contents.")).toHaveLength(1);
    expect(document.querySelector("#statusToast")?.textContent).toContain("翻译完成");
    expect(sendMessage.mock.calls.some(([request]) => request.type === "CHECK_DOUBAO")).toBe(false);
  });

  it("keeps completed paragraphs after a partial-page failure and retries only the missing paragraphs", async () => {
    const normal = await getDocument.getMockImplementation()!().promise;
    const sample = await normal.getPage(1);
    getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({ ...sample,
      getTextContent: async () => ({ items: Array.from({ length: 6 }, (_, index) => ({
        str: `Paragraph ${String.fromCharCode(65 + index)} contents.`, transform: [1, 0, 0, 12, 20, 700 - index * 85],
        width: 180, fontName: "font" })), styles: { font: { fontFamily: "Arial" } } })
    }) }), destroy: vi.fn() });
    const original = sendMessage.getMockImplementation()!;
    let fail = true;
    sendMessage.mockImplementation(request => {
      if (request.type !== "TRANSLATE_BATCH") return original(request);
      if (fail && request.texts.some(text => text.includes("Paragraph E"))) return Promise.resolve({ ok: false, error: "Only this group failed" });
      return Promise.resolve({ ok: true, data: { translations: request.texts.map(text => `译文：${text}`), cached: 0 } });
    });
    await launch(fileUrl);
    await vi.waitFor(() => expect(document.querySelector("#statusToast")?.textContent).toContain("2 段失败"));
    expect(document.querySelector(".translation-prompt")!.textContent).toContain("已翻译 4 / 6 段");
    const requests = () => sendMessage.mock.calls.flatMap(([request]) => request.type === "TRANSLATE_BATCH" ? [request.texts] : []);
    expect(requests().map(texts => texts.length)).toEqual([4, 2]);
    fail = false;
    document.querySelector<HTMLButtonElement>("#translateDocument")!.click();
    await vi.waitFor(() => expect(requests()).toHaveLength(3));
    await vi.waitFor(() => expect(document.querySelector("#statusToast")?.textContent).toContain("翻译完成"));
    expect(requests()).toHaveLength(3);
    expect(requests()[2]).toEqual(["Paragraph E contents.", "Paragraph F contents."]);
    expect(document.querySelector(".has-error,.is-partial")).toBeNull();
  });

  it("continues other waiting pages after an ordinary provider error", async () => {
    await mockDocumentPages(6);
    const original = sendMessage.getMockImplementation()!;
    let failed = false;
    sendMessage.mockImplementation((request: RuntimeRequest) => {
      if (request.type === "TRANSLATE_BATCH" && !failed) {
        failed = true;
        return Promise.resolve({ ok: false, error: "This page could not be translated." });
      }
      return original(request);
    });
    await launch(fileUrl);
    await vi.waitFor(() => expect(document.querySelector("#statusToast")?.textContent).toContain("1 段失败"));
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "TRANSLATE_BATCH")).toHaveLength(6);
    expect(document.querySelector<HTMLButtonElement>("#translateDocument")!.disabled).toBe(false);
    expect(document.querySelector("#statusToast")?.textContent).not.toContain("翻译已暂停");
  });

  it("resets the old session and automatically translates a different document once", async () => {
    await launch(fileUrl);
    await vi.waitFor(() => expect(translated()).toBe(true));
    const button = document.querySelector<HTMLButtonElement>("#translateDocument")!;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    window.dispatchEvent(new Event("scroll")); // Also cancel the old document's scheduled callback.
    const form = document.querySelector<HTMLFormElement>("#urlForm")!;
    document.querySelector<HTMLInputElement>("#pdfUrl")!.value = "https://example.com/second.pdf";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector("#documentName")?.textContent).toBe("second.pdf"));
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "TRANSLATE_BATCH")).toHaveLength(2);
  });

  it("does not read a file before permission, then retries the same PDF and translation", async () => {
    fileAccess.mockResolvedValue(false);
    await launch(fileUrl);
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#fileAccessNotice")?.hidden).toBe(false));
    expect(fetchPdf).not.toHaveBeenCalled();
    expect(getDocument).not.toHaveBeenCalled();
    expect(translated()).toBe(false);

    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Chrome/130 Edg/130");
    document.querySelector<HTMLButtonElement>("#openFileAccessSettings")!.click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "edge://extensions/?id=test-extension" });
    fileAccess.mockResolvedValue(true);
    document.querySelector<HTMLButtonElement>("#retryLocalPdf")!.click();
    await vi.waitFor(() => expect(translated()).toBe(true));
    expect(fetchPdf).toHaveBeenCalledWith(fileUrl, expect.anything());
    expect(document.querySelector<HTMLElement>("#fileAccessNotice")?.hidden).toBe(true);
  });

  it("lets the user select the local file without granting file URL access", async () => {
    fileAccess.mockResolvedValue(false);
    await launch(fileUrl);
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#fileAccessNotice")?.hidden).toBe(false));
    const file = new File(["%PDF-test"], "selected.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("%PDF-test").buffer });
    const input = document.querySelector<HTMLInputElement>("#fileInput")!;
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(translated()).toBe(true));
    expect(fetchPdf).not.toHaveBeenCalled();
    expect(document.querySelector("#documentName")?.textContent).toBe("selected.pdf");
    expect(document.querySelector<HTMLElement>("#fileAccessNotice")?.hidden).toBe(true);
  });

  it("still opens online PDFs without checking local file permission", async () => {
    fileAccess.mockResolvedValue(false);
    await launch("https://example.com/report.pdf");
    await vi.waitFor(() => expect(translated()).toBe(true));
    expect(fileAccess).not.toHaveBeenCalled();
  });

  it("honors an explicit opt-out of automatic translation", async () => {
    await launch(fileUrl, false);
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#readerView")?.hidden).toBe(false));
    expect(translated()).toBe(false);
    document.querySelector<HTMLButtonElement>("#translateDocument")!.click();
    await vi.waitFor(() => expect(translated()).toBe(true));
  });

  it.each(["file selection", "drop"])("automatically translates after %s in a blank workspace", async (entry) => {
    await import("../src/pdf/index");
    await vi.waitFor(() => expect(document.querySelector("#provider option")).not.toBeNull());
    expect(translated()).toBe(false);
    const file = new File(["%PDF-test"], "selected.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("%PDF-test").buffer });
    if (entry === "file selection") {
      const input = document.querySelector<HTMLInputElement>("#fileInput")!;
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
      document.querySelector("#dropZone")!.dispatchEvent(event);
    }
    await vi.waitFor(() => expect(translated()).toBe(true));
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "TRANSLATE_BATCH")).toHaveLength(1);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
    expect(fetchPdf).not.toHaveBeenCalled();
  });

  it("automatically translates a URL without an explicit translation flag", async () => {
    window.history.replaceState({}, "", "/pdf.html?url=https%3A%2F%2Fexample.com%2Freport.pdf");
    await import("../src/pdf/index");
    await vi.waitFor(() => expect(translated()).toBe(true));
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "TRANSLATE_BATCH")).toHaveLength(1);
  });

  it("automatically translates an address submitted in a blank workspace", async () => {
    await import("../src/pdf/index");
    await vi.waitFor(() => expect(document.querySelector("#provider option")).not.toBeNull());
    document.querySelector<HTMLInputElement>("#pdfUrl")!.value = "https://example.com/report.pdf";
    document.querySelector("#urlForm")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(translated()).toBe(true));
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "TRANSLATE_BATCH")).toHaveLength(1);
  });

  it("keeps the scanned-document warning when there is no translatable text", async () => {
    const documentProxy = await getDocument.getMockImplementation()!().promise;
    const page = await documentProxy.getPage(1);
    page.getTextContent = async () => ({ items: [], styles: {} });
    await launch("https://example.com/scanned.pdf");
    await vi.waitFor(() => expect(document.querySelector("#statusToast")?.textContent).toContain("未检测到可翻译文字"));
    expect(translated()).toBe(false);
    expect(document.querySelector<HTMLButtonElement>("#translateDocument")!.disabled).toBe(true);
  });

  it("reports a missing local file without attempting translation", async () => {
    fetchPdf.mockRejectedValue(new Error("File not found"));
    await launch(fileUrl);
    await vi.waitFor(() => expect(document.querySelector("#statusToast")?.textContent).toContain("File not found"));
    expect(getDocument).not.toHaveBeenCalled();
    expect(translated()).toBe(false);
    expect(document.querySelector<HTMLElement>("#loadingOverlay")?.hidden).toBe(true);
  });

  it("rejects unsupported URL schemes before making a request", async () => {
    await launch("data:application/pdf;base64,JVBERg==");
    await vi.waitFor(() => expect(document.querySelector("#statusToast")?.textContent).toContain("仅支持"));
    expect(fetchPdf).not.toHaveBeenCalled();
  });
});
