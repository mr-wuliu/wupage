import { t } from "../shared/i18n";
import { uiIconMarkup } from "../shared/ui-icons";
import { PDF_FONT, importPdfFont, installPdfFont, readPdfFont, removePdfFont } from "./font-store";

export interface PdfExportChoice { fontBytes?: Uint8Array }

export function setupPdfFontControl(): {
  prepareExport: () => Promise<PdfExportChoice | undefined>;
  setExporting: (active: boolean) => void;
  cancel: () => void;
} {
  const action = document.querySelector<HTMLButtonElement>("#pdfFontAction")!;
  const dialog = document.querySelector<HTMLDialogElement>("#pdfFontDialog")!;
  const title = document.querySelector<HTMLElement>("#pdfFontTitle")!;
  const status = document.querySelector<HTMLElement>("#pdfFontStatus")!;
  const progress = document.querySelector<HTMLProgressElement>("#pdfFontProgress")!;
  const install = document.querySelector<HTMLButtonElement>("#pdfFontInstall")!;
  const basic = document.querySelector<HTMLButtonElement>("#pdfFontBasic")!;
  const close = document.querySelector<HTMLButtonElement>("#pdfFontClose")!;
  const importButton = document.querySelector<HTMLButtonElement>("#pdfFontImport")!;
  const fileInput = document.querySelector<HTMLInputElement>("#pdfFontFile")!;
  const download = document.querySelector<HTMLAnchorElement>("#pdfFontDownload")!;
  download.href = PDF_FONT.source;
  download.title = PDF_FONT.file;
  document.querySelector<HTMLElement>("#pdfFontSize")!.textContent = t("fullFontPackMbOneTimeDownload", (PDF_FONT.bytes / 1_000_000).toFixed(1));
  let installed = false, exporting = false, skipPrompt = false, disposed = false;
  let choiceRun = 0;
  let mode: "export" | "install" = "install";
  let controller: AbortController | undefined;
  let importing = false;
  let resolveChoice: ((choice: PdfExportChoice | undefined) => void) | undefined;

  function render(): void {
    action.innerHTML = uiIconMarkup(installed ? "trash" : "wrench");
    action.dataset.state = controller ? "installing" : installed ? "installed" : "missing";
    action.title = installed ? t("removePdfExportFont") : t("installFullPdfExportFontMb", (PDF_FONT.bytes / 1_000_000).toFixed(1));
    action.setAttribute("aria-label", action.title);
    action.disabled = exporting || Boolean(controller);
    install.disabled = Boolean(controller);
    importButton.disabled = Boolean(controller);
    install.textContent = controller ? t("installing") : mode === "export" ? t("installAndExport") : t("installFontPack");
    basic.hidden = mode !== "export";
    close.textContent = controller ? importing ? t("cancelInstallation") : t("cancelDownload") : t("cancel");
    progress.hidden = !controller || importing;
    title.textContent = mode === "export" ? t("installFontsForHigherQualityExports") : t("installPdfExportFont");
  }

  async function refresh(): Promise<Uint8Array | undefined> {
    try {
      const bytes = await readPdfFont();
      installed = Boolean(bytes);
      return bytes;
    } catch {
      installed = false;
      status.textContent = t("couldNotReadTheFontCacheYouCan");
      return undefined;
    } finally { if (!disposed) render(); }
  }

  function finish(choice?: PdfExportChoice): void {
    choiceRun++;
    const resolve = resolveChoice;
    resolveChoice = undefined;
    controller?.abort();
    controller = undefined;
    if (dialog.open) dialog.close();
    render();
    resolve?.(choice);
  }

  function show(nextMode: "export" | "install"): void {
    mode = nextMode;
    status.textContent = t("fontsAreProvidedByNotoOnlyFontData");
    status.dataset.state = "missing";
    progress.max = PDF_FONT.bytes; progress.value = 0;
    render();
    if (!dialog.open) dialog.showModal();
  }

  async function prepareExport(): Promise<PdfExportChoice | undefined> {
    const run = ++choiceRun;
    const fontBytes = await refresh();
    if (disposed || run !== choiceRun) return undefined;
    if (fontBytes) return { fontBytes };
    if (skipPrompt) return {};
    return new Promise((resolve) => { resolveChoice = resolve; show("export"); });
  }

  async function installFont(file?: File): Promise<void> {
    if (controller) return;
    const operation = new AbortController(); controller = operation;
    importing = Boolean(file);
    status.dataset.state = "installing"; status.textContent = file ? t("verifyingFontFile") : t("downloadingFontPack0");
    progress.value = 0;
    render();
    try {
      const fontBytes = file ? await importPdfFont(file, operation.signal) : await installPdfFont(operation.signal, (bytes) => {
        if (controller !== operation) return;
        progress.value = bytes;
        status.textContent = bytes === PDF_FONT.bytes ? t("downloadCompleteVerifying") : t("downloadingFontPack", Math.floor(bytes / PDF_FONT.bytes * 100));
      });
      if (controller !== operation || disposed) return;
      installed = true; skipPrompt = false;
      status.textContent = t("fullFontInstalledYouCanExportSearchableSelectable");
      finish(mode === "export" ? { fontBytes } : undefined);
    } catch (error) {
      if (controller !== operation || disposed) return;
      status.dataset.state = "error";
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (controller === operation) { controller = undefined; render(); }
    }
  }
  install.addEventListener("click", () => { void installFont(); });
  importButton.addEventListener("click", () => { if (!controller) fileInput.click(); });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0]; fileInput.value = "";
    if (file && dialog.open && !disposed) void installFont(file);
  });
  basic.addEventListener("click", () => { skipPrompt = true; finish({}); });
  close.addEventListener("click", () => finish());
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(); });
  dialog.addEventListener("close", () => { if (resolveChoice || controller) finish(); });
  action.addEventListener("click", async () => {
    if (exporting || controller) return;
    if (installed) {
      action.disabled = true;
      try { await removePdfFont(); installed = false; skipPrompt = false; render(); }
      catch (error) { show("install"); status.textContent = t("removalFailed", error instanceof Error ? error.message : String(error)); }
    } else show("install");
  });
  const onFocus = () => { if (!controller && !exporting) void refresh(); };
  window.addEventListener("focus", onFocus);
  window.addEventListener("pagehide", () => {
    disposed = true; finish(); window.removeEventListener("focus", onFocus);
  }, { once: true });
  void refresh();
  return { prepareExport, cancel: () => finish(), setExporting: (active) => { exporting = active; render(); } };
}
