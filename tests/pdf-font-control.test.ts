// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupPdfFontControl } from "../src/pdf/font-control";
import { importPdfFont, installPdfFont, readPdfFont, removePdfFont } from "../src/pdf/font-store";
vi.mock("../src/pdf/font-store", () => ({
  PDF_FONT: { bytes: 16437364, source: "https://fonts.example/pinned/font.otf", file: "font.otf" }, importPdfFont: vi.fn(), installPdfFont: vi.fn(), readPdfFont: vi.fn(), removePdfFont: vi.fn()
}));
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
const dialog = () => document.querySelector<HTMLDialogElement>("#pdfFontDialog")!;
const status = () => document.querySelector("#pdfFontStatus")!.textContent;
beforeEach(() => {
  document.body.innerHTML = readFileSync("pdf.html", "utf8");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) {
    this.open = false; this.dispatchEvent(new Event("close"));
  } });
  vi.mocked(readPdfFont).mockReset().mockResolvedValue(undefined);
  vi.mocked(installPdfFont).mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.mocked(importPdfFont).mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.mocked(removePdfFont).mockReset().mockResolvedValue(undefined);
});
afterEach(() => { window.dispatchEvent(new Event("pagehide")); vi.restoreAllMocks(); });

describe("PDF optional font installation", () => {
  it("provides a pinned download link and exports after an offline file installation", async () => {
    const control = setupPdfFontControl(), choice = control.prepareExport();
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    expect(document.querySelector<HTMLAnchorElement>("#pdfFontDownload")!.href).toBe("https://fonts.example/pinned/font.otf");
    const input = document.querySelector<HTMLInputElement>("#pdfFontFile")!;
    const file = new File(["abc"], "font.otf");
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    expect(await choice).toEqual({ fontBytes: new Uint8Array([1, 2, 3]) });
    expect(importPdfFont).toHaveBeenCalledWith(file, expect.any(AbortSignal));
    expect(installPdfFont).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });
  it("keeps the export choice open after a rejected import and allows basic export", async () => {
    vi.mocked(importPdfFont).mockRejectedValue(new Error("字体包完整性校验失败"));
    const control = setupPdfFontControl(), choice = control.prepareExport();
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    const input = document.querySelector<HTMLInputElement>("#pdfFontFile")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["bad"], "font.otf")] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(status()).toContain("完整性校验失败"));
    expect(button("pdfFontImport").disabled).toBe(false);
    button("pdfFontBasic").click();
    expect(await choice).toEqual({});
  });
  it("cancels an offline installation and ignores its late completion", async () => {
    let complete!: (bytes: Uint8Array) => void;
    vi.mocked(importPdfFont).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const control = setupPdfFontControl(), choice = control.prepareExport();
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    const input = document.querySelector<HTMLInputElement>("#pdfFontFile")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["abc"], "font.otf")] });
    input.dispatchEvent(new Event("change"));
    const signal = vi.mocked(importPdfFont).mock.calls[0][1];
    expect(button("pdfFontClose").textContent).toBe("取消安装");
    expect(button("pdfFontImport").disabled).toBe(true);
    button("pdfFontClose").click();
    expect(await choice).toBeUndefined();
    expect(signal.aborted).toBe(true);
    complete(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    expect(dialog().open).toBe(false);
    expect(button("pdfFontAction").dataset.state).toBe("missing");
  });
  it("prompts only on export and lets users continue without downloading", async () => {
    const control = setupPdfFontControl();
    expect(dialog().open).toBe(false);
    expect(installPdfFont).not.toHaveBeenCalled();
    const choice = control.prepareExport();
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    expect(dialog().textContent).toContain("搜索、复制");
    button("pdfFontBasic").click();
    expect(await choice).toEqual({});
    expect(installPdfFont).not.toHaveBeenCalled();
    expect(await control.prepareExport()).toEqual({});
    expect(dialog().open).toBe(false);
    button("pdfFontAction").click();
    expect(dialog().open).toBe(true);
    expect(button("pdfFontBasic").hidden).toBe(true);
  });
  it("installs after explicit consent, then exports with cached fonts without a prompt", async () => {
    const control = setupPdfFontControl(); const choice = control.prepareExport();
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    button("pdfFontInstall").click();
    expect(await choice).toEqual({ fontBytes: new Uint8Array([1, 2, 3]) });
    expect(dialog().open).toBe(false);
    vi.mocked(readPdfFont).mockResolvedValue(new Uint8Array([1, 2, 3]));
    expect(await control.prepareExport()).toEqual({ fontBytes: new Uint8Array([1, 2, 3]) });
    expect(installPdfFont).toHaveBeenCalledTimes(1);
  });
  it("retains basic export after installation fails, and allows retry", async () => {
    vi.mocked(installPdfFont).mockRejectedValue(new Error("下载失败"));
    const control = setupPdfFontControl(); const choice = control.prepareExport();
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    button("pdfFontInstall").click();
    await vi.waitFor(() => expect(status()).toContain("下载失败"));
    expect(button("pdfFontInstall").disabled).toBe(false);
    button("pdfFontBasic").click(); expect(await choice).toEqual({});
  });
  it("cancels without starting a download or an export", async () => {
    const control = setupPdfFontControl(); const choice = control.prepareExport();
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    button("pdfFontClose").click(); expect(await choice).toBeUndefined();
    expect(installPdfFont).not.toHaveBeenCalled();
  });
  it("aborts an in-progress font installation when choosing basic export", async () => {
    let signal: AbortSignal;
    vi.mocked(installPdfFont).mockImplementation((value) => { signal = value; return new Promise(() => {}); });
    const control = setupPdfFontControl(); const choice = control.prepareExport();
    await vi.waitFor(() => expect(dialog().open).toBe(true));
    button("pdfFontInstall").click(); button("pdfFontBasic").click();
    expect(await choice).toEqual({}); expect(signal!.aborted).toBe(true);
  });
  it("removes installed fonts through the adjacent control", async () => {
    vi.mocked(readPdfFont).mockResolvedValue(new Uint8Array([1]));
    setupPdfFontControl();
    await vi.waitFor(() => expect(button("pdfFontAction").dataset.state).toBe("installed"));
    button("pdfFontAction").click();
    await vi.waitFor(() => expect(removePdfFont).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(button("pdfFontAction").getAttribute("aria-label")).toContain("安装"));
  });
});
