import { initializeInterfaceLanguage, localizeDocument, t } from "../shared/i18n";
import { anySignal } from "../shared/abort";
import {
  GlobalWorkerOptions,
  OPS,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { renderUiIcons, uiIconUrl } from "../shared/ui-icons";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "../shared/languages";
import { enhanceProviderSelect } from "../shared/provider-picker";
import { sendRuntimeMessage } from "../shared/messaging";
import { requestPdfTranslation } from "../shared/pdf-translation";
import { getEffectiveProviderPerformance } from "../shared/performance";
import { ProviderError } from "../shared/errors";
import { doubaoProviderNotice, isDoubaoProviderUnavailable, syncDoubaoTargetControls } from "../shared/doubao-ui";
import type { ExtensionSettings } from "../shared/types";
import {
  estimateForegroundColor,
  toCssRgb,
  type ForegroundColorSample,
  type RgbColor
} from "./colors";
import { createEditableTranslationBlock, fitTranslationBlock } from "./editor";
import { setupPdfFontControl } from "./font-control";
import {
  buildRasterPdf,
  collectPdfExportScene,
  canvasToJpegBytes,
  composeTranslatedPageCanvas,
  downloadPdfBytes,
  translatedPdfFileName,
  type RasterPdfPage
} from "./export";
import { findAvailableHorizontalLeft, findAvailableHorizontalRight, findAvailableVerticalBottom, getTranslatedBlockLayout } from "./layout";
import { getExtensionDetailsUrl, getPdfLaunchOptions, openPdfWorkspaceInNewTab } from "./launch";
import { extractTextBlocks, normalizePdfTextItems, type PdfTextBlock } from "./model";
import { renderPageWithoutText } from "./rendering";
import { filterVisiblePdfText } from "./visibility";
import { readPdfPageGeometry } from "./math-structure";
import { validatePdfMathTranslation } from "./math";
import { preparePdfDocument, pdfPageTranslationContext, type PdfDocumentContext } from "./document";
import { preparePdfDocumentTranslations, type PdfDocumentParagraphInput, type PdfPageParagraphPlan } from "./paragraph-flow";
import { createFormulaImages, getFormulaViewportRect } from "./math-rendering";
import { findReadingPage, selectPdfTranslationPages } from "./scheduling";
import { PdfTranslationQueue, type PdfQueuePage, type PdfQueuePageStatus } from "./translation-queue";
import "./styles.css";

await initializeInterfaceLanguage();
localizeDocument(document);
renderUiIcons();
document.documentElement.style.setProperty("--wp-select-arrow", uiIconUrl("arrow-down-03", "#edf5f1"));

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PDF_DOWNLOAD_TIMEOUT_MS = 30_000;
const PDF_OPEN_TIMEOUT_MS = 45_000;
const TRANSLATION_SCROLL_DELAY_MS = 200;
let documentContext: PdfDocumentContext = { context: "", abbreviations: new Map() };
let documentParagraphs: PdfPageParagraphPlan[] = [];

interface PdfPageState {
  pageNumber: number;
  pdfWidth: number;
  pdfHeight: number;
  blocks: PdfTextBlock[];
  textContent: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
  canvas: HTMLCanvasElement;
  canvasShell: HTMLElement;
  originalTextLayer: HTMLElement;
  originalTextLayerObserver?: ResizeObserver;
  translatedCanvas: HTMLCanvasElement;
  translatedBaseCanvas: HTMLCanvasElement;
  translatedCanvasShell: HTMLElement;
  translationLayer: HTMLElement;
  translationPrompt: HTMLElement;
  translationRetryButton: HTMLButtonElement;
  translationLayerObserver?: ResizeObserver;
  translations?: string[];
  translationContext?: string;
  renderedTranslationContext?: string;
  translationPending?: boolean;
  translationProgress?: PdfQueuePageStatus;
  translationDraft?: { context: string; page: PdfQueuePage; inputs: Map<number, PdfDocumentParagraphInput> };
  renderViewport?: ReturnType<PDFPageProxy["getViewport"]>;
}

interface PdfTranslationSession {
  controller: AbortController;
  queue: PdfTranslationQueue;
  runId: number;
  forDownload: boolean;
  finished: Promise<void>;
  resolveFinished: () => void;
  radius: number | null;
  requestOptions: { sourceLang: string; targetLang: string; providerId: string };
  context: string;
  readingPage: number;
  scopePages: PdfPageState[];
  failed: Set<PdfPageState>;
  followReading: boolean;
  scrolling: boolean;
  busy: boolean;
  translated: number;
  cached: number;
  failedPages: number;
  pauseError?: ProviderError;
}

const sourceLang = query<HTMLSelectElement>("#sourceLang");
const targetLang = query<HTMLSelectElement>("#targetLang");
const provider = query<HTMLSelectElement>("#provider");
const translateButton = query<HTMLButtonElement>("#translateDocument");
const replaceButton = query<HTMLButtonElement>("#replaceDocument");
const downloadButton = query<HTMLButtonElement>("#downloadDocument");
const chooseFileButton = query<HTMLButtonElement>("#chooseFile");
const fileInput = query<HTMLInputElement>("#fileInput");
const dropZone = query<HTMLElement>("#dropZone");
const urlForm = query<HTMLFormElement>("#urlForm");
const pdfUrlInput = query<HTMLInputElement>("#pdfUrl");
const welcomeView = query<HTMLElement>("#welcomeView");
const readerView = query<HTMLElement>("#readerView");
const pagesElement = query<HTMLElement>("#pages");
const documentSummary = query<HTMLElement>("#documentSummary");
const documentName = query<HTMLElement>("#documentName");
const documentMeta = query<HTMLElement>("#documentMeta");
const loadingOverlay = query<HTMLElement>("#loadingOverlay");
const loadingTitle = query<HTMLElement>("#loadingTitle");
const loadingDetail = query<HTMLElement>("#loadingDetail");
const progressBar = query<HTMLElement>("#progressBar");
const statusToast = query<HTMLElement>("#statusToast");
const fileAccessNotice = query<HTMLElement>("#fileAccessNotice");
const fileAccessSettingsButton = query<HTMLButtonElement>("#openFileAccessSettings");
const retryLocalPdfButton = query<HTMLButtonElement>("#retryLocalPdf");
const fontControl = setupPdfFontControl();

let settings: ExtensionSettings = structuredClone(DEFAULT_SETTINGS);
let pdfDocument: PDFDocumentProxy | undefined;
let pdfLoadingTask: ReturnType<typeof getDocument> | undefined;
let pageStates: PdfPageState[] = [];
let currentDocumentName = "";
let translationRun = 0;
let renderedPages = new Set<number>();
let pageRenderTasks = new Map<number, Promise<void>>();
let renderObserver: IntersectionObserver | undefined;
let pendingSource: { url: string; autoTranslate: boolean } | undefined;
let translationSession: PdfTranslationSession | undefined;
let translationScrollTimer: number | undefined;
let opening: AbortController | undefined;

function beginOpen(): AbortController {
  opening?.abort();
  opening = new AbortController();
  cancelTranslationSession();
  translationRun++;
  return opening;
}

function assertCurrentOpen(operation: AbortController): void {
  operation.signal.throwIfAborted();
}

void init();

async function init(): Promise<void> {
  settings = await loadSettings();
  renderLanguageOptions(sourceLang, settings.sourceLang, SOURCE_LANGUAGES);
  renderLanguageOptions(targetLang, settings.targetLang, TARGET_LANGUAGES);
  renderProviders();
  updateDoubaoControls();
  updateTranslationScopeControl();
  bindEvents();

  const launchOptions = getPdfLaunchOptions(window.location.href);
  if (launchOptions.url) {
    pdfUrlInput.value = launchOptions.url;
    await openRequestedPdf(launchOptions.url, launchOptions.autoTranslate);
  }
}

function bindEvents(): void {
  chooseFileButton.addEventListener("click", (event) => {
    event.stopPropagation();
    fileInput.click();
  });
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void openLocalPdf(file);
  });
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    if (!isPdfFile(file)) {
      showStatus(t("chooseAPdfFile"), "error");
      return;
    }
    void openLocalPdf(file);
  });
  urlForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = pdfUrlInput.value.trim();
    if (value) void openRequestedPdf(value);
  });
  fileAccessSettingsButton.addEventListener("click", () => {
    void chrome.tabs.create({ url: getExtensionDetailsUrl(chrome.runtime.id, navigator.userAgent) })
      .catch((error: unknown) => handleOpenError(error));
  });
  retryLocalPdfButton.addEventListener("click", () => {
    if (pendingSource) void openRequestedPdf(pendingSource.url, pendingSource.autoTranslate);
  });
  replaceButton.addEventListener("click", () => {
    void openPdfWorkspaceInNewTab(
      (properties) => chrome.tabs.create(properties),
      (path) => chrome.runtime.getURL(path)
    );
  });
  downloadButton.addEventListener("click", () => void downloadTranslatedDocument());
  translateButton.addEventListener("click", () => void translateDocument());
  sourceLang.addEventListener("change", onReaderSettingsChange);
  targetLang.addEventListener("change", onReaderSettingsChange);
  provider.addEventListener("change", onReaderSettingsChange);
  window.addEventListener("scroll", scheduleReadingTranslation, { passive: true });
  window.addEventListener("resize", scheduleReadingTranslation);
  window.addEventListener("pagehide", () => {
    opening?.abort();
    cancelTranslationSession();
    translationRun += 1;
    window.removeEventListener("scroll", scheduleReadingTranslation);
    window.removeEventListener("resize", scheduleReadingTranslation);
  }, { once: true });
}

function onReaderSettingsChange(): void {
  if (downloadButton.classList.contains("is-loading")) return;
  for (const page of pageStates) page.translationRetryButton.hidden = true;
  // A different language or service requires an explicit start with that config.
  const session = translationSession;
  if (session) {
    cancelTranslationSession();
    translateButton.classList.remove("is-loading");
    translateButton.disabled = false;
    updateDownloadButtonState();
    session.followReading = false;
    for (const number of session.queue.activePages) renderPageError(pageStates[number - 1], new Error(t("translationSettingsChangedChooseTranslateToStartAgain")));
    progressBar.style.width = "0%";
    showStatus(t("translationSettingsChangedChooseTranslateToStartAgain"), "info");
  }
  void saveReaderSettings();
}

async function openLocalPdf(file: File): Promise<void> {
  if (!isPdfFile(file)) {
    showStatus(t("chooseAPdfFile"), "error");
    return;
  }
  const operation = beginOpen();
  try {
    const autoTranslate = pendingSource?.autoTranslate ?? getPdfLaunchOptions(window.location.href).autoTranslate;
    const data = await file.arrayBuffer();
    assertCurrentOpen(operation);
    await loadPdf(data, file.name, autoTranslate, operation);
    if (opening === operation) pendingSource = undefined;
  } catch (error) {
    if (!operation.signal.aborted) handleOpenError(error);
  }
}

async function openRequestedPdf(value: string, autoTranslate = getPdfLaunchOptions(window.location.href).autoTranslate): Promise<void> {
  const operation = beginOpen();
  pendingSource = { url: value, autoTranslate };
  const opened = await openPdfUrl(value, autoTranslate, operation);
  if (opened && opening === operation) {
    pendingSource = undefined;
  }
}

async function openPdfUrl(value: string, autoTranslate: boolean, operation: AbortController): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    showStatus(t("invalidPdfAddress"), "error");
    return false;
  }
  const local = url.protocol === "file:";
  if (!local && url.protocol !== "http:" && url.protocol !== "https:") {
    showStatus(t("useAnHttpHttpsOrLocalFileUrl"), "error");
    return false;
  }

  fileAccessNotice.hidden = true;
  try {
    const fileAccess = !local || hasExtensionRuntime()
      && (!chrome.extension.isAllowedFileSchemeAccess || await chrome.extension.isAllowedFileSchemeAccess());
    assertCurrentOpen(operation);
    if (!fileAccess) {
      fileAccessNotice.hidden = false;
      fileAccessSettingsButton.hidden = !hasExtensionRuntime();
      showStatus(t("allowAccessToFileUrlsAndTryAgain"), "info", true);
      return false;
    }
    showLoading(local ? t("readingLocalPdf") : t("downloadingPdf"), local ? t("readingLocalDocument") : t("readingOnlineDocument"));
    assertCurrentOpen(operation);
    const response = await fetchWithTimeout(url.toString(), PDF_DOWNLOAD_TIMEOUT_MS, operation.signal);
    if (!response.ok) throw new Error(t("couldNotReadFileHttp", response.status));
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("pdf") && !url.pathname.toLowerCase().endsWith(".pdf")) {
      throw new Error(t("theAddressDidNotReturnAPdfFile"));
    }
    const rawName = url.pathname.split("/").pop() || (local ? t("localDocumentPdf") : t("onlineDocumentPdf"));
    let name = rawName;
    try { name = decodeURIComponent(rawName); } catch { /* Literal percent signs are valid in remote file names. */ }
    const data = await withTimeout(
      response.arrayBuffer(),
      PDF_DOWNLOAD_TIMEOUT_MS,
      t("readingThePdfFile")
    );
    assertCurrentOpen(operation);
    await loadPdf(data, name, autoTranslate, operation);
    return true;
  } catch (error) {
    if (!operation.signal.aborted) handleOpenError(error);
    return false;
  }
}

async function loadPdf(data: ArrayBuffer, name: string, autoTranslate: boolean, operation: AbortController): Promise<void> {
  assertCurrentOpen(operation);
  fontControl.cancel();
  fileAccessNotice.hidden = true;
  showLoading(t("openingPdf"), t("readingDocumentStructure"));
  translationRun += 1;
  cancelTranslationSession();
  translateButton.classList.remove("is-loading");
  translateButton.disabled = true;
  pageStates.forEach((page) => {
    page.originalTextLayerObserver?.disconnect();
    page.translationLayerObserver?.disconnect();
  });
  const previousTask = pdfLoadingTask;
  pdfDocument = undefined;
  pdfLoadingTask = undefined;
  await previousTask?.destroy();
  assertCurrentOpen(operation);
  pageStates = [];
  documentContext = { context: "", abbreviations: new Map() };
  documentParagraphs = [];
  renderedPages = new Set();
  pageRenderTasks = new Map();
  renderObserver?.disconnect();
  pagesElement.replaceChildren();

  const task = getDocument({ data: new Uint8Array(data) });
  pdfLoadingTask = task;
  let documentProxy: PDFDocumentProxy;
  try {
    documentProxy = await withTimeout(task.promise, PDF_OPEN_TIMEOUT_MS, t("pdfParsing"));
    assertCurrentOpen(operation);
  } catch (error) {
    await task.destroy();
    if (pdfLoadingTask === task) pdfLoadingTask = undefined;
    throw error;
  }
  pdfDocument = documentProxy;
  const optionalContent = await documentProxy.getOptionalContentConfig?.({ intent: "display" });
  assertCurrentOpen(operation);
  currentDocumentName = cleanFileName(name);
  documentName.textContent = currentDocumentName;
  updateTranslationScopeControl();

  setupRenderObserver();
  const parsedPages = Array<{
    page: PDFPageProxy;
    blocks: PdfTextBlock[];
    textContent: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
  }>(documentProxy.numPages);
  let parseCursor = 1;
  let parsedCount = 0;
  async function parseWorker(): Promise<void> {
    while (parseCursor <= documentProxy.numPages) {
      assertCurrentOpen(operation);
      const pageNumber = parseCursor;
      parseCursor += 1;
      const page = await documentProxy.getPage(pageNumber);
      const textContent = await page.getTextContent();
      assertCurrentOpen(operation);
      // The fallback CSS family hides the distinction between prose and math
      // fonts. Load the real font metadata before identifying formula runs.
      const operators = await page.getOperatorList?.();
      assertCurrentOpen(operation);
      const fonts = new Map(Object.keys(textContent.styles).flatMap((name) =>
        page.commonObjs?.has(name) ? [[name, page.commonObjs.get(name)] as const] : []
      ));
      const visibleItems = filterVisiblePdfText(textContent.items, operators, OPS, optionalContent, fonts);
      const measureContext = fonts.size ? document.createElement("canvas").getContext("2d") : null;
      const textItems = visibleItems.flatMap((item) => {
        if (!("str" in item)) return [];
        const fontFamily = textContent.styles[item.fontName]?.fontFamily || "Arial, sans-serif";
        return [{
          ...item,
          fontFamily,
          fontName: fonts.get(item.fontName)?.name ?? item.fontName,
          fontFace: item.fontName,
          fontAscent: textContent.styles[item.fontName]?.ascent,
          fontDescent: textContent.styles[item.fontName]?.descent,
          fontWeight: /bold|black|heavy|semibold|demi|CMBX|(?:NimbusRomNo9L|TimesNewRomanPS)-Medi/iu.test(`${fonts.get(item.fontName)?.name ?? item.fontName} ${fontFamily}`)
            ? 700
            : 400
        }];
      });
      const viewport = page.getViewport({ scale: 1 });
      const geometry = readPdfPageGeometry(operators, OPS, viewport, optionalContent);
      parsedPages[pageNumber - 1] = {
        page,
        blocks: extractTextBlocks(normalizePdfTextItems(textItems, viewport), pageNumber, measureContext ? (item, text) => {
          measureContext.font = `${item.height || Math.abs(Number(item.transform[3])) || 10}px "${item.fontFace}"`;
          return measureContext.measureText(text);
        } : undefined, geometry.rules, geometry.cells, geometry.tableCells),
        textContent: { ...textContent, items: visibleItems }
      };
      parsedCount += 1;
      loadingDetail.textContent = t("parsingPageOf", parsedCount, documentProxy.numPages);
    }
  }
  try {
    await withTimeout(
      Promise.all(Array.from({ length: Math.min(4, documentProxy.numPages) }, () => parseWorker())),
      Math.min(300_000, Math.max(60_000, documentProxy.numPages * 2_000)),
      t("pdfTextExtraction")
    );
    assertCurrentOpen(operation);
  } catch (error) {
    await task.destroy();
    if (pdfLoadingTask === task) { pdfDocument = undefined; pdfLoadingTask = undefined; }
    throw error;
  }
  const documentPages = parsedPages.map(({ page, blocks, textContent }) => {
    const viewport = page.getViewport({ scale: 1 });
    return { blocks, width: viewport.width, height: viewport.height,
      sourceText: textContent.items.flatMap((item) => "str" in item ? [item.str] : []).join(" ") };
  });
  documentContext = preparePdfDocument(documentPages, currentDocumentName);
  documentParagraphs = preparePdfDocumentTranslations(documentPages, documentContext.abbreviations);
  parsedPages.forEach(({ page, blocks, textContent }, index) => {
    const pageState = createPageState(page, index + 1, blocks, textContent);
    pageStates.push(pageState);
    renderObserver?.observe(pageState.canvasShell);
  });

  welcomeView.hidden = true;
  readerView.hidden = false;
  documentSummary.hidden = false;
  replaceButton.hidden = false;
  downloadButton.hidden = false;
  query<HTMLButtonElement>("#pdfFontAction").hidden = false;
  const hasTranslatableText = pageStates.some((page) => page.blocks.some((block) => block.translatable));
  translateButton.disabled = !hasTranslatableText;
  updateDownloadButtonState();
  hideLoading();
  window.scrollTo({ top: 0, behavior: "instant" });
  if (hasTranslatableText && autoTranslate) {
    await translateDocument();
  } else {
    showStatus(
      hasTranslatableText
        ? t("documentOpenChooseToStartTranslating", translateButton.textContent?.trim())
        : t("noTranslatableTextFoundThisMayBeA"),
      hasTranslatableText ? "success" : "error"
    );
  }
}

function createPageState(
  page: PDFPageProxy,
  pageNumber: number,
  blocks: PdfTextBlock[],
  textContent: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>
): PdfPageState {
  const viewport = page.getViewport({ scale: 1 });
  const row = document.createElement("article");
  row.className = "page-row";
  row.dataset.page = String(pageNumber);

  const originalPanel = document.createElement("section");
  originalPanel.className = "page-panel original-panel";
  originalPanel.setAttribute("aria-label", t("originalPage", pageNumber));
  const canvasShell = document.createElement("div");
  canvasShell.className = "canvas-shell";
  canvasShell.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", t("pdfPage", pageNumber));
  const originalTextLayer = document.createElement("div");
  originalTextLayer.className = "textLayer original-text-layer";
  originalTextLayer.setAttribute("aria-label", t("originalTextLayerForPage", pageNumber));
  canvasShell.append(canvas, originalTextLayer);
  originalPanel.append(canvasShell);

  const translatedPanel = document.createElement("section");
  translatedPanel.className = "page-panel translated-panel";
  translatedPanel.setAttribute("aria-label", t("translatedPage", pageNumber));
  const translatedCanvasShell = document.createElement("div");
  translatedCanvasShell.className = "canvas-shell translation-canvas-shell is-pending";
  translatedCanvasShell.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  const translatedCanvas = document.createElement("canvas");
  translatedCanvas.setAttribute("aria-label", t("pdfTranslationPage", pageNumber));
  const translatedBaseCanvas = document.createElement("canvas");
  const translationLayer = document.createElement("div");
  translationLayer.className = "translation-text-layer";
  translationLayer.setAttribute("aria-label", t("editableTranslationForPage", pageNumber));
  const translationViewport = document.createElement("div");
  translationViewport.className = "translation-layer-viewport";
  translationViewport.append(translationLayer);
  const prompt = document.createElement("p");
  prompt.className = "translation-prompt";
  prompt.textContent = blocks.length ? t("thisPageHasNotBeenTranslatedStartTranslation") : t("noTranslatableTextFoundOnThisPage");
  const retryButton = document.createElement("button");
  retryButton.className = "translation-retry";
  retryButton.textContent = t("retryUnfinishedParagraphs");
  retryButton.setAttribute("aria-label", t("retryUnfinishedParagraphsOnPage", pageNumber));
  retryButton.hidden = true;
  retryButton.addEventListener("click", () => {
    const session = translationSession;
    if (!session || session.pauseError) return;
    window.clearTimeout(translationScrollTimer);
    session.scrolling = false;
    session.readingPage = pageNumber;
    refreshTranslationRange(session);
    session.queue.retryPage(pageNumber);
  });
  translatedCanvasShell.append(translatedCanvas, translationViewport, prompt, retryButton);
  translatedPanel.append(translatedCanvasShell);

  row.append(originalPanel, translatedPanel);
  pagesElement.append(row);
  return {
    pageNumber,
    pdfWidth: viewport.width,
    pdfHeight: viewport.height,
    blocks,
    textContent,
    canvas,
    canvasShell,
    originalTextLayer,
    translatedCanvas,
    translatedBaseCanvas,
    translatedCanvasShell,
    translationLayer,
    translationPrompt: prompt,
    translationRetryButton: retryButton
  };
}

function setupRenderObserver(): void {
  renderObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pageState = pageStates.find((state) => state.canvasShell === entry.target);
      if (!pageState) continue;
      renderObserver?.unobserve(entry.target);
      void renderPdfPage(pageState).catch(error => renderPageError(pageState, error));
    }
  }, { rootMargin: "900px 0px" });
}

async function renderPdfPage(pageState: PdfPageState): Promise<void> {
  if (!pdfDocument || renderedPages.has(pageState.pageNumber)) return;
  const activeTask = pageRenderTasks.get(pageState.pageNumber);
  if (activeTask) return activeTask;
  const task = renderPdfPageOnce(pageState);
  pageRenderTasks.set(pageState.pageNumber, task);
  try {
    await task;
  } finally {
    pageRenderTasks.delete(pageState.pageNumber);
  }
}

async function renderPdfPageOnce(pageState: PdfPageState): Promise<void> {
  if (!pdfDocument) return;
  const page = await pdfDocument.getPage(pageState.pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const cssWidth = Math.max(320, Math.min(900, pageState.canvasShell.clientWidth || 720));
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  const cssViewport = page.getViewport({ scale: cssWidth / baseViewport.width });
  const viewport = page.getViewport({ scale: cssViewport.scale * outputScale });
  pageState.renderViewport = viewport;
  pageState.canvas.width = Math.floor(viewport.width);
  pageState.canvas.height = Math.floor(viewport.height);
  pageState.canvas.style.width = `${Math.floor(viewport.width / outputScale)}px`;
  pageState.canvas.style.height = `${Math.floor(viewport.height / outputScale)}px`;
  await page.render({ canvas: pageState.canvas, viewport }).promise;
  await renderOriginalTextLayer(pageState, cssViewport);
  await renderPageWithoutText(page, pageState.translatedBaseCanvas, viewport);
  renderedPages.add(pageState.pageNumber);
  pageState.canvasShell.classList.add("is-rendered");
  if (pageState.translations || pageState.translationDraft?.page.values.some((value, index) => pageState.blocks[index].translatable && value !== undefined)) renderTranslatedPdfPage(pageState);
}

async function renderOriginalTextLayer(
  pageState: PdfPageState,
  viewport: ReturnType<PDFPageProxy["getViewport"]>
): Promise<void> {
  const layer = pageState.originalTextLayer;
  layer.replaceChildren();
  layer.style.setProperty("--total-scale-factor", String(viewport.scale));
  layer.style.setProperty("--scale-round-x", "1px");
  layer.style.setProperty("--scale-round-y", "1px");
  const textLayer = new TextLayer({
    textContentSource: pageState.textContent,
    container: layer,
    viewport
  });
  await textLayer.render();
  syncOriginalTextLayer(pageState, viewport.width);
  if (!pageState.originalTextLayerObserver) {
    pageState.originalTextLayerObserver = new ResizeObserver(() => {
      syncOriginalTextLayer(pageState, viewport.width);
    });
    pageState.originalTextLayerObserver.observe(pageState.canvasShell);
  }
}

function syncOriginalTextLayer(pageState: PdfPageState, internalWidth: number): void {
  if (!internalWidth) return;
  const displayedWidth = pageState.canvasShell.clientWidth || internalWidth;
  pageState.originalTextLayer.style.transform = `scale(${displayedWidth / internalWidth})`;
}

function renderTranslatedPdfPage(pageState: PdfPageState): void {
  const renderViewport = pageState.renderViewport;
  const translations = pageState.translations ?? pageState.translationDraft?.page.values;
  if (!renderViewport || !translations) return;
  const scale = renderViewport.width / pageState.pdfWidth;
  const viewport = {
    scale,
    convertToViewportPoint: (x: number, y: number): number[] => [x * scale, (pageState.pdfHeight - y) * scale]
  };

  const target = pageState.translatedCanvas;
  target.width = pageState.canvas.width;
  target.height = pageState.canvas.height;
  target.style.width = pageState.canvas.style.width;
  target.style.height = pageState.canvas.style.height;
  const context = target.getContext("2d", { alpha: false });
  if (!context) return;
  context.drawImage(pageState.translatedBaseCanvas, 0, 0);

  const originalContext = pageState.canvas.getContext("2d", { alpha: false });
  // PDF.js already measures the browser's enforced minimum font size. Use
  // enlarged text coordinates and an inverse layer transform, as its original
  // text layer does, so small PDF text remains editable at its intended size.
  // Firefox's CJK fallback fonts quantize tiny glyph metrics even when its
  // Latin minimum-font probe reports 1px. Keep fractional PDF text in a larger
  // coordinate space, then scale the whole layer back to the page geometry.
  const coordinateScale = Math.max(4, Number.parseFloat(pageState.originalTextLayer.style.getPropertyValue("--min-font-size")) || 1);
  pageState.translationLayer.dataset.coordinateScale = String(coordinateScale);
  pageState.translatedCanvasShell.className = "canvas-shell translation-canvas-shell is-rendered";
  syncTranslationLayer(pageState);

  const layouts = pageState.blocks.map((block) => ({
    block,
    cellRect: block.tableCell ? { x: block.tableCell.x * scale,
      y: (pageState.pdfHeight - block.tableCell.y - block.tableCell.height) * scale,
      width: block.tableCell.width * scale, height: block.tableCell.height * scale } : undefined,
    lineRects: [
      ...block.lines.map((line) => getViewportLineRect(line, viewport)),
      ...(block.formulas ?? []).map((formula) => getFormulaViewportRect(formula, viewport))
    ]
  }));
  const rectangleGroups = layouts.map((layout) => layout.lineRects);
  const backgrounds = layouts.map((layout) => layout.lineRects.map((rectangle) =>
    originalContext ? sampleBackgroundColor(originalContext, rectangle, layout.cellRect) : [255, 255, 255] as RgbColor
  ));
  const colors = layouts.map((layout, index) => originalContext
    ? sampleTextColor(originalContext, layout.lineRects, backgrounds[index])
    : "#202826"
  );
  const titleBackgrounds: Array<{ x: number; y: number; width: number; height: number; color: RgbColor }> = [];
  // Fraction bars and some symbol outlines are vector paths, so suppressing
  // fillText alone leaves them behind at the formula's old inline position.
  for (const { block, cellRect } of layouts) for (const formula of block.formulas ?? []) {
    const rect = getFormulaViewportRect(formula, viewport);
    context.fillStyle = toCssRgb(originalContext ? sampleBackgroundColor(originalContext, rect, cellRect) : [255, 255, 255]);
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
  const previousBlocks = new Map(pageState.renderedTranslationContext === pageState.translationDraft?.context
    ? [...pageState.translationLayer.querySelectorAll<HTMLElement>(".translation-block")].map(block => [block.dataset.blockId!, block] as const) : []);
  pageState.renderedTranslationContext = pageState.translationDraft?.context ?? pageState.translationContext;
  for (const child of [...pageState.translationLayer.children]) {
    if (!previousBlocks.has((child as HTMLElement).dataset.blockId ?? "")) child.remove();
  }
  layouts.forEach((layout, index) => {
    if (!layout.block.translatable || translations[index] === undefined) {
      // Copy original glyphs, including scripts and equation numbers. Replacing
      // them with ordinary canvas text would lose the PDF's math typography.
      // Italic references can paint beyond the extracted horizontal advance.
      const glyphPadding = layout.block.role === "reference" ? layout.block.fontSize * viewport.scale * 0.15 : 0;
      for (const rect of layout.lineRects) {
        const x = Math.max(0, Math.floor(rect.x - glyphPadding));
        const y = Math.max(0, Math.floor(rect.y));
        const width = Math.min(target.width - x, Math.ceil(rect.x + rect.width + glyphPadding) - x);
        const height = Math.min(target.height - y, Math.ceil(rect.y + rect.height) - y);
        if (width > 0 && height > 0) context.drawImage(pageState.canvas, x, y, width, height, x, y, width, height);
      }
      return;
    }
    const text = translations[index] ?? layout.block.text;
    const previousBlock = previousBlocks.get(layout.block.id);
    if (previousBlock?.dataset.translationValue === text) {
      return;
    }
    previousBlock?.remove();
    const { cellRect } = layout;
    const blockLayout = getTranslatedBlockLayout(
      context,
      text,
      layout.block,
      layout.lineRects,
      viewport.scale,
      findAvailableHorizontalRight(layout.block.tocPart === "title"
        ? rectangleGroups.map((rects, position) => layouts[position].block.tocPart === "leader" ? [] : rects)
        : rectangleGroups, index, target.width),
      target.width,
      findAvailableHorizontalLeft(rectangleGroups, index),
      cellRect
    );
    if (!blockLayout || !text.trim()) return;
    if (layout.block.tocPart === "title") {
      // A longer translated title can use the beginning of the dotted run.
      // Clear that part after copying preserved glyphs, keeping the locator
      // at its original right edge and preventing dots behind the title.
      titleBackgrounds.push({ x: blockLayout.left, y: blockLayout.top, width: blockLayout.width,
        height: blockLayout.height, color: backgrounds[index][0] ?? [255, 255, 255] });
    }
    const editableBlock = createEditableTranslationBlock(pageState.translationLayer, {
      id: layout.block.id,
      text,
      color: colors[index],
      fontFamily: blockLayout.fontFamily,
      fontSize: blockLayout.fontSize * coordinateScale,
      fontWeight: layout.block.fontWeight,
      lineHeight: blockLayout.lineHeight * coordinateScale,
      textAlign: blockLayout.textAlign,
      hangingIndent: blockLayout.hangingIndent * coordinateScale,
      fontSizeStep: viewport.scale * coordinateScale,
      maximumAutoHeight: (Math.min(findAvailableVerticalBottom(rectangleGroups, index, target.height),
        cellRect ? cellRect.y + cellRect.height - scale * 0.75 : Infinity) - blockLayout.top) * coordinateScale,
      formulaImages: createFormulaImages(layout.block.formulas ?? [], pageState.canvas, viewport),
      left: blockLayout.left * coordinateScale,
      top: blockLayout.top * coordinateScale,
      width: blockLayout.width * coordinateScale,
      height: blockLayout.height * coordinateScale,
      onTextChange: (value) => {
        translations[index] = value;
        editableBlock.dataset.translationValue = value;
        updateDownloadButtonState();
      },
      onDelete: () => {
        translations[index] = "";
        updateDownloadButtonState();
      }
    });
    editableBlock.dataset.translationValue = text;
    const nextBlock = [...pageState.translationLayer.children].find(child =>
      layouts.findIndex(entry => entry.block.id === (child as HTMLElement).dataset.blockId) > index);
    pageState.translationLayer.insertBefore(editableBlock, nextBlock ?? null);
    fitTranslationBlock(editableBlock);
  });
  for (const rect of titleBackgrounds) {
    context.fillStyle = toCssRgb(rect.color);
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
  syncTranslationLayer(pageState);
  if (!pageState.translationLayerObserver) {
    pageState.translationLayerObserver = new ResizeObserver(() => syncTranslationLayer(pageState));
    pageState.translationLayerObserver.observe(pageState.translatedCanvasShell);
  }

  pageState.translationPrompt.hidden = true;
  pageState.translatedCanvasShell.className = "canvas-shell translation-canvas-shell is-rendered";
  if (!pageState.translations) updatePartialPageStatus(pageState);
}

function getViewportLineRect(
  line: PdfTextBlock["lines"][number],
  viewport: Pick<ReturnType<PDFPageProxy["getViewport"]>, "convertToViewportPoint">
): { x: number; y: number; width: number; height: number } {
  const start = viewport.convertToViewportPoint(
    line.sourceBounds?.x ?? line.x,
    line.sourceBounds?.y ?? line.baselineY - line.height * 0.24
  );
  const end = viewport.convertToViewportPoint(
    line.sourceBounds ? line.sourceBounds.x + line.sourceBounds.width : line.x + line.width,
    line.sourceBounds ? line.sourceBounds.y + line.sourceBounds.height : line.baselineY + line.height * 0.9
  );
  const rectangle = [start[0], start[1], end[0], end[1]];
  const left = Math.min(rectangle[0], rectangle[2]);
  const top = Math.min(rectangle[1], rectangle[3]);
  return {
    x: left,
    y: top,
    width: Math.max(2, Math.abs(rectangle[2] - rectangle[0])),
    height: Math.max(2, Math.abs(rectangle[3] - rectangle[1]))
  };
}

function sampleTextColor(
  context: CanvasRenderingContext2D,
  rectangles: Array<{ x: number; y: number; width: number; height: number }>,
  backgrounds: RgbColor[]
): string {
  const samples: ForegroundColorSample[] = [];
  rectangles.forEach((rectangle, rectangleIndex) => {
    const x = Math.max(0, Math.floor(rectangle.x));
    const y = Math.max(0, Math.floor(rectangle.y));
    const width = Math.min(context.canvas.width - x, Math.max(1, Math.ceil(rectangle.width)));
    const height = Math.min(context.canvas.height - y, Math.max(1, Math.ceil(rectangle.height)));
    if (width <= 0 || height <= 0) return;
    const pixels = context.getImageData(x, y, width, height).data;
    const stride = Math.max(4, Math.floor((width * height) / 500) * 4);
    const background = backgrounds[rectangleIndex] ?? [255, 255, 255];
    for (let index = 0; index < pixels.length; index += stride) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const alpha = pixels[index + 3];
      if (alpha < 100) continue;
      samples.push({ color: [r, g, b], background });
    }
  });
  const foreground = estimateForegroundColor(samples);
  return foreground ? toCssRgb(foreground) : "#202826";
}

function sampleBackgroundColor(
  context: CanvasRenderingContext2D,
  rectangle: { x: number; y: number; width: number; height: number },
  cell?: { x: number; y: number; width: number; height: number }
): RgbColor {
  // Keep the sample off the grid lines and out of a differently shaded row.
  const left = Math.max(0, Math.floor(rectangle.x - 3), cell ? Math.ceil(cell.x + 1) : 0);
  const top = Math.max(0, Math.floor(rectangle.y - 3), cell ? Math.ceil(cell.y + 1) : 0);
  const right = Math.min(context.canvas.width - 1, Math.ceil(rectangle.x + rectangle.width + 3),
    cell ? Math.floor(cell.x + cell.width - 1) : Infinity);
  const bottom = Math.min(context.canvas.height - 1, Math.ceil(rectangle.y + rectangle.height + 3),
    cell ? Math.floor(cell.y + cell.height - 1) : Infinity);
  if (right < left || bottom < top) return [255, 255, 255];
  const counts = new Map<string, { color: RgbColor; count: number }>();
  const regionWidth = Math.max(1, right - left + 1);
  const regionHeight = Math.max(1, bottom - top + 1);
  const pixels = context.getImageData(left, top, regionWidth, regionHeight).data;
  const sample = (x: number, y: number): void => {
    const index = ((y - top) * regionWidth + (x - left)) * 4;
    if (pixels[index + 3] < 100) return;
    const color: RgbColor = [pixels[index], pixels[index + 1], pixels[index + 2]];
    const key = color.map((channel) => Math.round(channel / 16)).join("-");
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { color, count: 1 });
  };
  const horizontalStep = Math.max(1, Math.floor((right - left) / 24));
  const verticalStep = Math.max(1, Math.floor((bottom - top) / 12));
  for (let x = left; x <= right; x += horizontalStep) {
    sample(x, top);
    sample(x, bottom);
  }
  for (let y = top; y <= bottom; y += verticalStep) {
    sample(left, y);
    sample(right, y);
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return best?.color ?? [255, 255, 255];
}

function syncTranslationLayer(pageState: PdfPageState): void {
  const coordinateScale = Number(pageState.translationLayer.dataset.coordinateScale) || 1;
  const internalWidth = pageState.translatedCanvas.width * coordinateScale;
  const internalHeight = pageState.translatedCanvas.height * coordinateScale;
  if (!internalWidth || !internalHeight) return;
  const displayedWidth = pageState.translatedCanvasShell.clientWidth
    || Number.parseFloat(pageState.translatedCanvas.style.width)
    || internalWidth;
  pageState.translationLayer.style.width = `${internalWidth}px`;
  pageState.translationLayer.style.height = `${internalHeight}px`;
  const layerScale = displayedWidth / internalWidth;
  pageState.translationLayer.style.transform = `scale(${layerScale})`;
  pageState.translationLayer.style.setProperty("--translation-ui-scale", String(1 / layerScale));
}

function getReadingPageNumber(): number {
  const toolbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 75;
  const readingY = toolbarBottom + Math.max(0, window.innerHeight - toolbarBottom) * 0.25;
  return findReadingPage(pageStates, (page) => page.canvasShell.getBoundingClientRect(), readingY)?.pageNumber ?? 1;
}

function updateTranslationScopeControl(): void {
  const radius = settings.pdfTranslationPageRadius;
  translateButton.querySelector("span")!.textContent = radius === null ? t("translatePage") : t("translateNearbyPages");
  translateButton.title = radius === null ? t("translateEntirePdf") : radius === 0
    ? t("translateThisPageAndContinueAsYouScroll")
    : t("translateThisPageAndPagesOnEachSide", radius);
  if (pdfDocument) documentMeta.textContent = t("documentPageCount", pdfDocument.numPages, radius === null ? t("entireDocument") : t("pagesOnEachSide", radius));
}

function cancelTranslationSession(): void {
  translationSession?.queue.cancel();
  translationSession?.controller.abort();
  translationSession?.resolveFinished();
  translationSession = undefined;
  window.clearTimeout(translationScrollTimer);
}

async function translateDocument(forDownload = false): Promise<PdfTranslationSession | undefined> {
  if (!pdfDocument || !pageStates.length || translateButton.classList.contains("is-loading")
    || (!forDownload && downloadButton.classList.contains("is-loading"))) return;
  const startingPage = getReadingPageNumber();
  const runId = ++translationRun;
  cancelTranslationSession();
  translateButton.disabled = true;
  downloadButton.disabled = true;
  translateButton.classList.add("is-loading");
  progressBar.style.width = "0%";
  try {
    await saveReaderSettings();
  } catch (error) {
    if (runId !== translationRun) return;
    translateButton.disabled = false;
    translateButton.classList.remove("is-loading");
    updateDownloadButtonState();
    if (forDownload) throw error;
    showStatus(t("couldNotStartTranslation", formatTranslationError(error)), "error");
    return;
  }
  if (runId !== translationRun) return;
  const requestOptions = { sourceLang: sourceLang.value, targetLang: targetLang.value, providerId: provider.value };
  const context = JSON.stringify([requestOptions, settings.providers.find((entry) => entry.id === requestOptions.providerId)]);
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  let session!: PdfTranslationSession;
  const performance = getEffectiveProviderPerformance(settings, requestOptions.providerId);
  const queue = new PdfTranslationQueue({
    concurrency: Math.max(1, Math.min(2, performance.concurrency)), maxChars: Math.min(1600, performance.chunkSize),
    translate: (entry, indexes, signal) => {
      const page = pageStates[entry.pageNumber - 1], draft = page.translationDraft!;
      return requestPdfTranslation({
        texts: indexes.map(index => draft.inputs.get(index)!.text),
        context: pdfPageTranslationContext(documentContext, page.blocks, [
          ...(pageStates[entry.pageNumber - 2]?.blocks.filter(block => block.translatable).slice(-2) ?? []),
          ...(pageStates[entry.pageNumber]?.blocks.filter(block => block.translatable).slice(0, 2) ?? [])
        ]), preservePlaceholders: true,
        translationStyle: "academic", ...session.requestOptions
      }, page.pageNumber, anySignal([signal, session.controller.signal]));
    },
    restore: (entry, index, raw) => {
      const page = pageStates[entry.pageNumber - 1];
      const values = page.translationDraft!.inputs.get(index)!.restore(raw);
      for (const [region, value] of values) validatePdfMathTranslation(value, pageStates[region.pageNumber - 1].blocks[region.index].formulas);
      for (const [region, value] of values) pageStates[region.pageNumber - 1].translationDraft!.page.values[region.index] = value;
      session.translated += values.size;
      return entry.values[index]!;
    },
    onChange: (entry, status) => {
      if (translationSession !== session) return;
      const page = pageStates[entry.pageNumber - 1];
      page.translationProgress = status;
      page.translationPending = status.running || status.pending;
      try {
        if (status.completed === status.total) {
          session.failed.delete(page);
          renderPageTranslations(page, entry.values as string[], session.context);
        } else {
          if (status.error) session.failed.add(page);
          else session.failed.delete(page);
          if (status.completed && renderedPages.has(page.pageNumber)) renderTranslatedPdfPage(page);
          updatePartialPageStatus(page);
        }
      } catch (error) {
        // A page display failure must not strand the remaining network queue.
        session.failed.add(page);
        renderPageError(page, error);
      }
      session.cached = queue.cached;
      if (queue.pauseError) {
        session.pauseError = queue.pauseError; session.followReading = false; session.scrolling = false;
        window.clearTimeout(translationScrollTimer);
      }
      pumpTranslationQueue(session);
    },
    onIdle: () => { if (translationSession === session && session.busy) finishTranslationBatch(session); }
  });
  session = {
    controller: new AbortController(),
    queue,
    runId, forDownload, finished, resolveFinished,
    radius: forDownload ? null : settings.pdfTranslationPageRadius, requestOptions, context,
    readingPage: startingPage, scopePages: [], failed: new Set(),
    followReading: !forDownload, scrolling: false, busy: true, translated: 0, cached: 0, failedPages: 0
  };
  translationSession = session;
  refreshTranslationRange(session);
  pumpTranslationQueue(session);
  return session;
}

function scheduleReadingTranslation(): void {
  const session = translationSession;
  if (!session?.followReading) return;
  // Stop dispatching while the viewport is moving; keep at most the two
  // requests already in flight, then replace the waiting range after it settles.
  session.scrolling = true;
  session.queue.suspend();
  window.clearTimeout(translationScrollTimer);
  translationScrollTimer = window.setTimeout(() => {
    if (translationSession !== session || !session.followReading) return;
    session.scrolling = false;
    session.readingPage = getReadingPageNumber();
    refreshTranslationRange(session);
    pumpTranslationQueue(session);
  }, TRANSLATION_SCROLL_DELAY_MS);
}

function refreshTranslationRange(session: PdfTranslationSession): void {
  session.scopePages = selectPdfTranslationPages(pageStates, session.readingPage, session.radius);
  for (const page of session.scopePages) {
    if (page.translations && page.translationContext === session.context) {
      if (page.translatedCanvasShell.classList.contains("has-error")) {
        renderPageTranslations(page, page.translations, session.context);
      }
    } else if (!page.blocks.some(block => block.translatable)) {
      // Bibliography-only and image-only pages still need a visible right
      // panel, even though they require no translation request.
      renderPageTranslations(page, page.blocks.map(block => block.text), session.context);
    }
  }
  const ensureDraft = (page: PdfPageState): PdfQueuePage => {
    if (page.translationDraft?.context !== session.context) {
      const { inputs, incoming } = documentParagraphs[page.pageNumber - 1];
      page.translationDraft = { context: session.context, inputs, page: {
        pageNumber: page.pageNumber, items: [...inputs].map(([index, input]) => ({
          index, text: input.text, targetPages: [...new Set(input.regions.map(region => region.pageNumber))]
        })), incoming,
        values: page.translationContext === session.context && page.translations ? page.translations
          : page.blocks.map(block => block.translatable ? undefined : block.text)
      } };
      if (page.translationContext !== session.context) page.translations = undefined;
    }
    return page.translationDraft.page;
  };
  const selected = session.scopePages.filter(page => page.blocks.some(block => block.translatable));
  const scope = new Set(selected.map(page => page.pageNumber));
  const owners = new Set(selected.map(page => page.pageNumber));
  for (const page of selected) for (const incoming of documentParagraphs[page.pageNumber - 1].incoming) owners.add(incoming.pageNumber);
  const dependencies = new Set(owners);
  for (const owner of owners) for (const input of documentParagraphs[owner - 1].inputs.values()) {
    if (input.regions.some(region => scope.has(region.pageNumber))) {
      for (const region of input.regions) dependencies.add(region.pageNumber);
    }
  }
  // Register related pages without expanding the requested translation range:
  // only shared paragraphs touching that range are eligible to run.
  const registered = [...dependencies].map(number => ensureDraft(pageStates[number - 1]));
  session.queue.setScope(selected.map(ensureDraft), session.readingPage, registered);
}

function pumpTranslationQueue(session: PdfTranslationSession): void {
  if (translationSession !== session || session.runId !== translationRun || session.scrolling
    || (downloadButton.classList.contains("is-loading") && !session.forDownload)) return;
  if (session.queue.busy && !session.busy) {
    session.busy = true;
    session.translated = session.cached = session.failedPages = 0;
  }
  session.failedPages = session.scopePages.filter(page => session.failed.has(page)).length;
  if (session.queue.busy) {
    translateButton.disabled = true;
    translateButton.classList.add("is-loading");
    updateDownloadButtonState();
    const scope = session.scopePages.map(page => page.translationProgress).filter((status): status is PdfQueuePageStatus => Boolean(status));
    const total = scope.reduce((sum, status) => sum + status.total, 0);
    const completed = scope.reduce((sum, status) => sum + status.completed, 0);
    progressBar.style.width = `${Math.round(completed / Math.max(1, total) * 100)}%`;
    const label = session.radius === null ? t("entireDocument")
      : t("documentPageRange", session.scopePages[0].pageNumber, session.scopePages.at(-1)!.pageNumber);
    if (session.pauseError) {
      showStatus(t("translationPausedWaitingForPendingRequestsToFinish", formatTranslationError(session.pauseError), session.queue.activeCount), "error", true);
    } else {
      const action = session.forDownload ? t("finishingTranslationBeforeDownload") : t("pdfTranslating");
      showStatus(t("paragraphs", action, label, completed, total), "info", true);
    }
  } else if (session.busy) {
    finishTranslationBatch(session);
  }
}

function finishTranslationBatch(session: PdfTranslationSession): void {
  session.busy = false;
  translateButton.disabled = downloadButton.classList.contains("is-loading");
  translateButton.classList.remove("is-loading");
  updateDownloadButtonState();
  session.resolveFinished();
  if (session.forDownload) return;
  if (session.pauseError) {
    showStatus(t("translationPausedCompletedParagraphsResolveTheIssueAnd", formatTranslationError(session.pauseError), session.translated), "error", true);
  } else if (session.failedPages) {
    const remaining = session.scopePages.reduce((sum, page) => sum + (page.translationProgress
      ? page.translationProgress.total - page.translationProgress.completed : 0), 0);
    showStatus(t("translationFinishedSuccessfulParagraphsFailedAcrossPagesCompleted", session.translated, remaining, session.failedPages), "error");
  } else {
    const detail = session.radius === null || !session.followReading ? "" : t("scrollToTranslateNearbyPagesAutomatically");
    showStatus(t("translationCompleteParagraphsCacheHits", session.translated, session.cached, detail), "success");
  }
  window.setTimeout(() => {
    if (translationSession === session && !session.busy) progressBar.style.width = "0%";
  }, 1200);
}

function updatePartialPageStatus(page: PdfPageState): void {
  const status = page.translationProgress;
  if (!status || page.translations) return;
  const partial = status.completed > 0;
  page.translationRetryButton.hidden = !status.error || Boolean(translationSession?.queue.pauseError);
  const visible = partial && renderedPages.has(page.pageNumber);
  page.translatedCanvasShell.className = `canvas-shell translation-canvas-shell ${visible ? "is-rendered is-partial" : "is-pending"}`
    + (status.running ? " is-loading" : "") + (status.error ? " has-error" : "");
  if (!partial) page.translationLayer.replaceChildren();
  const progress = t("translatedParagraphs", status.completed, status.total);
  page.translationPrompt.hidden = false;
  page.translationPrompt.textContent = status.error
    ? t("remainingParagraphsFailed", progress, formatTranslationError(status.error), partial ? t("completedTranslationsWereKept") : "")
    : status.retrying ? t("connectionInterruptedRetryingUnfinishedParagraphs", progress)
    : status.running ? t("translatingThisPage", progress)
    : t("pageQueuedVisiblePagesAreTranslatedFirst", progress);
}

function renderPageTranslations(page: PdfPageState, translations: string[], context: string): void {
  page.translations = translations;
  page.translationContext = context;
  page.translationPending = false;
  page.translationRetryButton.hidden = true;
  if (renderedPages.has(page.pageNumber)) renderTranslatedPdfPage(page);
  else {
    // Translation can finish before lazy canvas rendering. Do not leave a
    // completed offscreen page displaying the old spinner or failure state.
    page.translatedCanvasShell.className = "canvas-shell translation-canvas-shell is-pending";
    page.translationPrompt.hidden = false;
    page.translationPrompt.textContent = t("translationReadyScrollToThisPageToView");
  }
}

async function downloadTranslatedDocument(): Promise<void> {
  if (downloadButton.disabled || !pdfDocument || !pageStates.length) return;

  const documentProxy = pdfDocument;
  downloadButton.disabled = true;
  downloadButton.classList.add("is-loading");
  fontControl.setExporting(true);
  downloadButton.textContent = t("chooseExportFormat");
  sourceLang.disabled = targetLang.disabled = provider.disabled = true;
  enhanceProviderSelect(provider, settings.providers);
  progressBar.style.width = "0%";
  const rasterPages: RasterPdfPage[] = [];

  try {
    const choice = await fontControl.prepareExport();
    if (!choice || pdfDocument !== documentProxy) return;
    downloadButton.textContent = t("translationInProgress");
    const session = await translateDocument(true);
    if (!session || pdfDocument !== documentProxy) return;
    await session.finished;
    if (translationSession !== session || pdfDocument !== documentProxy) return;
    if (session.pauseError) throw session.pauseError;
    const incompletePages = pageStates.filter((page) => page.blocks.some((block) => block.translatable)
      && (!page.translations || page.translationContext !== session.context || session.failed.has(page)));
    if (incompletePages.length) {
      throw new Error(t("untranslatedPagesChooseDownloadTranslationAgainToRetry", incompletePages.length));
    }
    downloadButton.textContent = t("generating");
    for (let index = 0; index < pageStates.length; index += 1) {
      const page = pageStates[index];
      if (!renderedPages.has(page.pageNumber)) await renderPdfPage(page);
      if (translationSession !== session || pdfDocument !== documentProxy) return;
      const canvas = page.translations
        ? composeTranslatedPageCanvas(page.translatedCanvas, page.translationLayer)
        : page.canvas;
      const imageBytes = await canvasToJpegBytes(canvas);
      if (translationSession !== session || pdfDocument !== documentProxy) return;
      rasterPages.push({
        width: page.pdfWidth,
        height: page.pdfHeight,
        imageBytes,
        format: "jpeg",
        scene: choice.fontBytes ? await collectPdfExportScene(page.canvas, page.translationLayer, page.blocks, page.pdfWidth, page.pdfHeight,
          Array.from((await documentProxy.getPage(page.pageNumber)).getViewport({ scale: 1 }).transform ?? [])) : undefined
      });
      const percentage = Math.round(((index + 1) / pageStates.length) * 85);
      progressBar.style.width = `${percentage}%`;
      showStatus(t("generatingTranslatedPdfPageOf", index + 1, pageStates.length), "info", true);
    }

    const fileName = translatedPdfFileName(currentDocumentName);
    const bytes = await buildRasterPdf(rasterPages, fileName.replace(/\.pdf$/iu, ""),
      choice.fontBytes ? await documentProxy.getData?.() : undefined, choice.fontBytes);
    if (translationSession !== session || pdfDocument !== documentProxy) return;
    progressBar.style.width = "100%";
    downloadPdfBytes(bytes, fileName);
    showStatus(t("translatedPdfReady", fileName), "success");
  } catch (error) {
    showStatus(t("downloadFailed", error instanceof Error ? error.message : String(error)), "error");
  } finally {
    fontControl.setExporting(false);
    downloadButton.classList.remove("is-loading");
    downloadButton.textContent = t("downloadTranslation");
    sourceLang.disabled = targetLang.disabled = provider.disabled = false;
    enhanceProviderSelect(provider, settings.providers);
    translateButton.disabled = Boolean(translationSession?.busy)
      || !pageStates.some((page) => page.blocks.some((block) => block.translatable));
    updateDownloadButtonState();
    if (translationSession?.forDownload) {
      translationSession.forDownload = false;
      translationSession.radius = settings.pdfTranslationPageRadius;
      translationSession.followReading = !translationSession.pauseError;
      translationSession.readingPage = getReadingPageNumber();
      if (!translationSession.pauseError) refreshTranslationRange(translationSession);
    }
    if (translationSession) pumpTranslationQueue(translationSession);
    window.setTimeout(() => {
      if (!translateButton.classList.contains("is-loading") && !downloadButton.classList.contains("is-loading")) {
        progressBar.style.width = "0%";
      }
    }, 1200);
  }
}

function updateDownloadButtonState(): void {
  downloadButton.disabled = downloadButton.classList.contains("is-loading")
    || translateButton.classList.contains("is-loading")
    || !pdfDocument || !pageStates.some((page) => page.blocks.some((block) => block.translatable));
}

function renderPageError(page: PdfPageState, error: unknown): void {
  page.translationPending = false;
  if (!page.translations && page.translationDraft && page.translationProgress?.completed) {
    page.translationProgress = { ...page.translationProgress, running: false, pending: false, error };
    updatePartialPageStatus(page); return;
  }
  page.translatedCanvasShell.className = "canvas-shell translation-canvas-shell has-error";
  page.translationLayer.replaceChildren();
  page.translationPrompt.hidden = false;
  page.translationPrompt.textContent = t("pageTranslationFailed", formatTranslationError(error));
}

function formatTranslationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/translation response was interrupted|translation request timed out|cannot connect to the translation service/iu.test(message)) {
    return t("translationServiceDisconnectedOrTimedOutTryAgain");
  }
  if (provider.value === "google-web-translate" && /timed out|timeout|超时/iu.test(message)) {
    return t("googleWebTranslateTimedOutThisFreeService");
  }
  return message;
}

async function saveReaderSettings(): Promise<void> {
  const readerSettings = {
    sourceLang: sourceLang.value || "auto",
    targetLang: targetLang.value || "zh-CN",
    activeProviderId: provider.value || settings.activeProviderId
  };
  // Update provider controls immediately while the latest stored settings are loading.
  settings = { ...settings, ...readerSettings };
  updateDoubaoControls();
  const previousSettings = await loadSettings();
  settings = {
    ...previousSettings,
    ...readerSettings
  };
  updateTranslationScopeControl();
  if (hasExtensionRuntime()) {
    await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings, previousSettings });
  }
}

async function loadSettings(): Promise<ExtensionSettings> {
  if (!hasExtensionRuntime()) return structuredClone(DEFAULT_SETTINGS);
  return sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" });
}

function renderProviders(): void {
  provider.replaceChildren();
  for (const item of settings.providers.filter((entry) => entry.enabled !== false)) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    option.disabled = isDoubaoProviderUnavailable(item);
    provider.append(option);
  }
  provider.value = settings.activeProviderId;
  enhanceProviderSelect(provider, settings.providers);
}

function updateDoubaoControls(): void {
  syncDoubaoTargetControls(settings, targetLang);
  const message = doubaoProviderNotice(settings);
  let notice = document.getElementById("doubaoProviderNotice");
  if (!notice && message) {
    notice = document.createElement("p");
    notice.id = "doubaoProviderNotice";
    notice.setAttribute("role", "status");
    const description = document.createElement("span");
    description.dataset.role = "doubao-description";
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.textContent = t("signInAndCheck");
    settingsButton.addEventListener("click", () => {
      void sendRuntimeMessage({ type: "OPEN_OPTIONS_PAGE" }).catch((error: unknown) => showStatus(error instanceof Error ? error.message : String(error), "error"));
    });
    notice.append(description, settingsButton);
    provider.closest("header")?.after(notice);
  }
  if (notice) {
    notice.hidden = !message;
    const description = notice.querySelector("[data-role='doubao-description']");
    if (description) description.textContent = message ?? "";
  }
}

function renderLanguageOptions(
  select: HTMLSelectElement,
  value: string,
  languages: ReadonlyArray<{ code: string; label: string }>
): void {
  select.replaceChildren();
  const options = languages.some((entry) => entry.code === value)
    ? languages
    : [{ code: value, label: value }, ...languages];
  for (const language of options) {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    select.append(option);
  }
  select.value = value;
}

function showLoading(title: string, detail: string): void {
  loadingTitle.textContent = title;
  loadingDetail.textContent = detail;
  loadingOverlay.hidden = false;
}

function hideLoading(): void {
  loadingOverlay.hidden = true;
}

function handleOpenError(error: unknown): void {
  hideLoading();
  const message = error instanceof Error ? error.message : String(error);
  showStatus(t("couldNotOpenPdf", message), "error");
}

function showStatus(
  message: string,
  tone: "info" | "success" | "error",
  persistent = false
): void {
  statusToast.textContent = message;
  statusToast.dataset.tone = tone;
  statusToast.hidden = false;
  window.clearTimeout(Number(statusToast.dataset.timer) || 0);
  if (persistent) return;
  const timer = window.setTimeout(() => { statusToast.hidden = true; }, 4200);
  statusToast.dataset.timer = String(timer);
}

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function cleanFileName(name: string): string {
  const normalized = name.trim() || t("untitledDocumentPdf");
  return normalized.length > 64 ? `${normalized.slice(0, 61)}…` : normalized;
}

function hasExtensionRuntime(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

async function fetchWithTimeout(url: string, timeoutMs: number, source: AbortSignal): Promise<Response> {
  const signal = anySignal([source, AbortSignal.timeout(timeoutMs)]);
  try {
    return await fetch(url, { signal });
  } catch (error) {
    if (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
      throw new Error(t("pdfDownloadExceededSecondsCheckYourConnectionOr", Math.round(timeoutMs / 1000)));
    }
    throw error;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () => reject(new Error(t("exceededSecondsTheTaskWasStopped", label, Math.round(timeoutMs / 1000)))),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
