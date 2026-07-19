import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "../shared/languages";
import { sendRuntimeMessage } from "../shared/messaging";
import type {
  ExtensionSettings,
  RuntimeRequest,
  TranslateBatchResponse
} from "../shared/types";
import {
  estimateForegroundColor,
  toCssRgb,
  type ForegroundColorSample,
  type RgbColor
} from "./colors";
import { createEditableTranslationBlock } from "./editor";
import {
  buildRasterPdf,
  canvasToJpegBytes,
  composeTranslatedPageCanvas,
  downloadPdfBytes,
  translatedPdfFileName,
  type RasterPdfPage
} from "./export";
import { findAvailableHorizontalRight, getTranslatedBlockLayout } from "./layout";
import { getPdfLaunchOptions, openPdfWorkspaceInNewTab } from "./launch";
import { extractTextBlocks, type PdfTextBlock } from "./model";
import { renderPageWithoutText } from "./rendering";
import "./styles.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PDF_DOWNLOAD_TIMEOUT_MS = 30_000;
const PDF_OPEN_TIMEOUT_MS = 45_000;
const TRANSLATION_PAGE_TIMEOUT_MS = 120_000;

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
  translationLayerObserver?: ResizeObserver;
  translations?: string[];
  renderViewport?: ReturnType<PDFPageProxy["getViewport"]>;
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

let settings: ExtensionSettings = structuredClone(DEFAULT_SETTINGS);
let pdfDocument: PDFDocumentProxy | undefined;
let pdfLoadingTask: ReturnType<typeof getDocument> | undefined;
let pageStates: PdfPageState[] = [];
let currentDocumentName = "";
let translationRun = 0;
let renderedPages = new Set<number>();
let pageRenderTasks = new Map<number, Promise<void>>();
let renderObserver: IntersectionObserver | undefined;

void init();

async function init(): Promise<void> {
  settings = await loadSettings();
  renderLanguageOptions(sourceLang, settings.sourceLang, SOURCE_LANGUAGES);
  renderLanguageOptions(targetLang, settings.targetLang, TARGET_LANGUAGES);
  renderProviders();
  bindEvents();

  const launchOptions = getPdfLaunchOptions(window.location.href);
  if (launchOptions.url) {
    pdfUrlInput.value = launchOptions.url;
    const opened = await openRemotePdf(launchOptions.url);
    if (opened && launchOptions.autoTranslate) await translateDocument();
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
      showStatus("请选择 PDF 文件。", "error");
      return;
    }
    void openLocalPdf(file);
  });
  urlForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = pdfUrlInput.value.trim();
    if (value) void openRemotePdf(value);
  });
  replaceButton.addEventListener("click", () => {
    void openPdfWorkspaceInNewTab(
      (properties) => chrome.tabs.create(properties),
      (path) => chrome.runtime.getURL(path)
    );
  });
  downloadButton.addEventListener("click", () => void downloadTranslatedDocument());
  translateButton.addEventListener("click", () => void translateDocument());
  sourceLang.addEventListener("change", () => void saveReaderSettings());
  targetLang.addEventListener("change", () => void saveReaderSettings());
  provider.addEventListener("change", () => void saveReaderSettings());
}

async function openLocalPdf(file: File): Promise<void> {
  if (!isPdfFile(file)) {
    showStatus("请选择 PDF 文件。", "error");
    return;
  }
  try {
    await loadPdf(await file.arrayBuffer(), file.name);
  } catch (error) {
    handleOpenError(error);
  }
}

async function openRemotePdf(value: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    showStatus("PDF 地址格式不正确。", "error");
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    showStatus("在线地址仅支持 HTTP 或 HTTPS；本地文件请使用“选择 PDF 文件”。", "error");
    return false;
  }

  showLoading("正在下载 PDF", "正在读取在线文档…");
  try {
    const response = await fetchWithTimeout(url.toString(), PDF_DOWNLOAD_TIMEOUT_MS);
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("pdf") && !url.pathname.toLowerCase().endsWith(".pdf")) {
      throw new Error("该地址返回的内容不是 PDF 文件。");
    }
    const name = decodeURIComponent(url.pathname.split("/").pop() || "在线文档.pdf");
    const data = await withTimeout(
      response.arrayBuffer(),
      PDF_DOWNLOAD_TIMEOUT_MS,
      "PDF 文件下载"
    );
    await loadPdf(data, name);
    return true;
  } catch (error) {
    handleOpenError(error);
    return false;
  }
}

async function loadPdf(data: ArrayBuffer, name: string): Promise<void> {
  showLoading("正在打开 PDF", "正在读取文档结构…");
  translationRun += 1;
  pageStates.forEach((page) => {
    page.originalTextLayerObserver?.disconnect();
    page.translationLayerObserver?.disconnect();
  });
  await pdfLoadingTask?.destroy();
  pdfDocument = undefined;
  pdfLoadingTask = undefined;
  pageStates = [];
  renderedPages = new Set();
  pageRenderTasks = new Map();
  renderObserver?.disconnect();
  pagesElement.replaceChildren();

  const task = getDocument({ data: new Uint8Array(data) });
  pdfLoadingTask = task;
  let documentProxy: PDFDocumentProxy;
  try {
    documentProxy = await withTimeout(task.promise, PDF_OPEN_TIMEOUT_MS, "PDF 解析");
  } catch (error) {
    await task.destroy();
    pdfLoadingTask = undefined;
    throw error;
  }
  pdfDocument = documentProxy;
  currentDocumentName = cleanFileName(name);
  documentName.textContent = currentDocumentName;
  documentMeta.textContent = `${documentProxy.numPages} 页`;

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
      const pageNumber = parseCursor;
      parseCursor += 1;
      const page = await documentProxy.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const textItems = textContent.items.flatMap((item) => {
        if (!("str" in item)) return [];
        const fontFamily = textContent.styles[item.fontName]?.fontFamily || "Arial, sans-serif";
        return [{
          ...item,
          fontFamily,
          fontWeight: /bold|black|heavy|semibold|demi/iu.test(`${item.fontName} ${fontFamily}`)
            ? 700
            : 400
        }];
      });
      parsedPages[pageNumber - 1] = {
        page,
        blocks: extractTextBlocks(textItems, pageNumber),
        textContent
      };
      parsedCount += 1;
      loadingDetail.textContent = `正在解析第 ${parsedCount} / ${documentProxy.numPages} 页`;
    }
  }
  try {
    await withTimeout(
      Promise.all(Array.from({ length: Math.min(4, documentProxy.numPages) }, () => parseWorker())),
      Math.min(300_000, Math.max(60_000, documentProxy.numPages * 2_000)),
      "PDF 文本提取"
    );
  } catch (error) {
    await task.destroy();
    pdfDocument = undefined;
    pdfLoadingTask = undefined;
    throw error;
  }
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
  downloadButton.disabled = true;
  translateButton.disabled = pageStates.every((page) => !page.blocks.some((block) => block.translatable));
  hideLoading();
  showStatus(
    pageStates.some((page) => page.blocks.some((block) => block.translatable))
      ? "文档已打开，点击“翻译全文”开始翻译。"
      : "未检测到可翻译文字，这可能是一份扫描版 PDF。",
    pageStates.some((page) => page.blocks.some((block) => block.translatable)) ? "success" : "error"
  );
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  originalPanel.setAttribute("aria-label", `原文第 ${pageNumber} 页`);
  const canvasShell = document.createElement("div");
  canvasShell.className = "canvas-shell";
  canvasShell.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", `PDF 第 ${pageNumber} 页`);
  const originalTextLayer = document.createElement("div");
  originalTextLayer.className = "textLayer original-text-layer";
  originalTextLayer.setAttribute("aria-label", `第 ${pageNumber} 页原文文字层`);
  canvasShell.append(canvas, originalTextLayer);
  originalPanel.append(canvasShell);

  const translatedPanel = document.createElement("section");
  translatedPanel.className = "page-panel translated-panel";
  translatedPanel.setAttribute("aria-label", `译文第 ${pageNumber} 页`);
  const translatedCanvasShell = document.createElement("div");
  translatedCanvasShell.className = "canvas-shell translation-canvas-shell is-pending";
  translatedCanvasShell.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  const translatedCanvas = document.createElement("canvas");
  translatedCanvas.setAttribute("aria-label", `PDF 译文第 ${pageNumber} 页`);
  const translatedBaseCanvas = document.createElement("canvas");
  const translationLayer = document.createElement("div");
  translationLayer.className = "translation-text-layer";
  translationLayer.setAttribute("aria-label", `第 ${pageNumber} 页可编辑译文`);
  const prompt = document.createElement("p");
  prompt.className = "translation-prompt";
  prompt.textContent = blocks.length ? "等待翻译" : "此页未检测到可翻译文字";
  translatedCanvasShell.append(translatedCanvas, translationLayer, prompt);
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
    translationPrompt: prompt
  };
}

function setupRenderObserver(): void {
  renderObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pageState = pageStates.find((state) => state.canvasShell === entry.target);
      if (!pageState) continue;
      renderObserver?.unobserve(entry.target);
      void renderPdfPage(pageState);
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
  if (pageState.translations) renderTranslatedPdfPage(pageState);
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
  const viewport = pageState.renderViewport;
  const translations = pageState.translations;
  if (!viewport || !translations) return;

  const target = pageState.translatedCanvas;
  target.width = pageState.canvas.width;
  target.height = pageState.canvas.height;
  target.style.width = pageState.canvas.style.width;
  target.style.height = pageState.canvas.style.height;
  const context = target.getContext("2d", { alpha: false });
  if (!context) return;
  context.drawImage(pageState.translatedBaseCanvas, 0, 0);

  const originalContext = pageState.canvas.getContext("2d", { alpha: false });

  const layouts = pageState.blocks.map((block) => ({
    block,
    lineRects: block.lines.map((line) => getViewportLineRect(line, viewport))
  }));
  const rectangleGroups = layouts.map((layout) => layout.lineRects);
  const backgrounds = layouts.map((layout) => layout.lineRects.map((rectangle) =>
    originalContext ? sampleBackgroundColor(originalContext, rectangle) : [255, 255, 255] as RgbColor
  ));
  const colors = layouts.map((layout, index) => originalContext
    ? sampleTextColor(originalContext, layout.lineRects, backgrounds[index])
    : "#202826"
  );
  pageState.translationLayer.replaceChildren();
  layouts.forEach((layout, index) => {
    const text = translations[index] ?? layout.block.text;
    const blockLayout = getTranslatedBlockLayout(
      context,
      text,
      layout.block,
      layout.lineRects,
      viewport.scale,
      findAvailableHorizontalRight(rectangleGroups, index, target.width)
    );
    if (!blockLayout || !text.trim()) return;
    const editableBlock = createEditableTranslationBlock(pageState.translationLayer, {
      id: layout.block.id,
      text,
      color: colors[index],
      fontFamily: blockLayout.fontFamily,
      fontSize: blockLayout.fontSize,
      fontWeight: layout.block.fontWeight,
      lineHeight: blockLayout.lineHeight,
      left: blockLayout.left,
      top: blockLayout.top,
      width: blockLayout.width,
      height: blockLayout.height,
      onTextChange: (value) => {
        translations[index] = value;
        updateDownloadButtonState();
      },
      onDelete: () => {
        translations[index] = "";
        updateDownloadButtonState();
      }
    });
    pageState.translationLayer.append(editableBlock);
  });
  syncTranslationLayer(pageState);
  if (!pageState.translationLayerObserver) {
    pageState.translationLayerObserver = new ResizeObserver(() => syncTranslationLayer(pageState));
    pageState.translationLayerObserver.observe(pageState.translatedCanvasShell);
  }

  pageState.translationPrompt.hidden = true;
  pageState.translatedCanvasShell.className = "canvas-shell translation-canvas-shell is-rendered";
}

function getViewportLineRect(
  line: PdfTextBlock["lines"][number],
  viewport: ReturnType<PDFPageProxy["getViewport"]>
): { x: number; y: number; width: number; height: number } {
  const start = viewport.convertToViewportPoint(
    line.x,
    line.baselineY - line.height * 0.24
  );
  const end = viewport.convertToViewportPoint(
    line.x + line.width,
    line.baselineY + line.height * 0.9
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
  rectangle: { x: number; y: number; width: number; height: number }
): RgbColor {
  const left = Math.max(0, Math.floor(rectangle.x - 3));
  const top = Math.max(0, Math.floor(rectangle.y - 3));
  const right = Math.min(context.canvas.width - 1, Math.ceil(rectangle.x + rectangle.width + 3));
  const bottom = Math.min(context.canvas.height - 1, Math.ceil(rectangle.y + rectangle.height + 3));
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
  const internalWidth = pageState.translatedCanvas.width;
  const internalHeight = pageState.translatedCanvas.height;
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

async function translateDocument(): Promise<void> {
  if (!pdfDocument || !pageStates.length) return;
  await saveReaderSettings();
  const runId = ++translationRun;
  translateButton.disabled = true;
  downloadButton.disabled = true;
  translateButton.classList.add("is-loading");
  progressBar.style.width = "0%";
  let completed = 0;
  let translated = 0;
  let cached = 0;
  let failedPages = 0;
  const runnablePages = pageStates.filter((page) => page.blocks.some((block) => block.translatable));

  for (const page of runnablePages) renderTranslationSkeleton(page);
  showStatus(`正在翻译 0 / ${runnablePages.length} 页…`, "info", true);

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < runnablePages.length && runId === translationRun) {
      const index = cursor;
      cursor += 1;
      const page = runnablePages[index];
      try {
        const translatableBlocks = page.blocks.filter((block) => block.translatable);
        const result = await withTimeout(
          sendRuntimeMessage<TranslateBatchResponse>({
            type: "TRANSLATE_BATCH",
            texts: translatableBlocks.map((block) => block.text),
            sourceLang: sourceLang.value,
            targetLang: targetLang.value,
            providerId: provider.value
          } satisfies RuntimeRequest),
          TRANSLATION_PAGE_TIMEOUT_MS,
          `第 ${page.pageNumber} 页翻译`
        );
        if (runId !== translationRun) return;
        let translationIndex = 0;
        const translations = page.blocks.map((block) => {
          if (!block.translatable) return block.text;
          const translation = result.translations[translationIndex] ?? block.text;
          translationIndex += 1;
          return translation;
        });
        renderPageTranslations(page, translations);
        translated += result.translations.length;
        cached += result.cached;
      } catch (error) {
        if (runId !== translationRun) return;
        failedPages += 1;
        renderPageError(page, error);
      } finally {
        if (runId !== translationRun) return;
        completed += 1;
        const percentage = Math.round((completed / runnablePages.length) * 100);
        progressBar.style.width = `${percentage}%`;
        showStatus(`正在翻译 ${completed} / ${runnablePages.length} 页…`, "info", true);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, runnablePages.length) }, () => worker()));
  if (runId !== translationRun) return;
  translateButton.disabled = false;
  translateButton.classList.remove("is-loading");
  updateDownloadButtonState();
  if (failedPages) {
    showStatus(`翻译完成：${translated} 段成功，${failedPages} 页失败。`, "error");
  } else {
    showStatus(`翻译完成：${translated} 段译文，缓存命中 ${cached} 段。`, "success");
  }
  window.setTimeout(() => { progressBar.style.width = "0%"; }, 1200);
}

function renderTranslationSkeleton(page: PdfPageState): void {
  page.translatedCanvasShell.className = "canvas-shell translation-canvas-shell is-loading";
  page.translationLayer.replaceChildren();
  page.translationPrompt.hidden = false;
  page.translationPrompt.textContent = "正在生成版式译文…";
}

function renderPageTranslations(page: PdfPageState, translations: string[]): void {
  page.translations = translations;
  if (renderedPages.has(page.pageNumber)) renderTranslatedPdfPage(page);
}

async function downloadTranslatedDocument(): Promise<void> {
  if (!pdfDocument || !pageStates.length || !hasTranslatedContent()) {
    showStatus("请先完成文档翻译，再下载译文 PDF。", "error");
    return;
  }

  downloadButton.disabled = true;
  downloadButton.classList.add("is-loading");
  downloadButton.textContent = "正在生成…";
  progressBar.style.width = "0%";
  const rasterPages: RasterPdfPage[] = [];

  try {
    for (let index = 0; index < pageStates.length; index += 1) {
      const page = pageStates[index];
      if (!renderedPages.has(page.pageNumber)) await renderPdfPage(page);
      const canvas = page.translations
        ? composeTranslatedPageCanvas(page.translatedCanvas, page.translationLayer)
        : page.canvas;
      rasterPages.push({
        width: page.pdfWidth,
        height: page.pdfHeight,
        imageBytes: await canvasToJpegBytes(canvas),
        format: "jpeg"
      });
      const percentage = Math.round(((index + 1) / pageStates.length) * 85);
      progressBar.style.width = `${percentage}%`;
      showStatus(`正在生成译文 PDF：${index + 1} / ${pageStates.length} 页…`, "info", true);
    }

    const fileName = translatedPdfFileName(currentDocumentName);
    const bytes = await buildRasterPdf(rasterPages, fileName.replace(/\.pdf$/iu, ""));
    progressBar.style.width = "100%";
    downloadPdfBytes(bytes, fileName);
    showStatus(`译文 PDF 已生成：${fileName}`, "success");
  } catch (error) {
    showStatus(`下载失败：${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    downloadButton.classList.remove("is-loading");
    downloadButton.textContent = "下载译文";
    updateDownloadButtonState();
    window.setTimeout(() => { progressBar.style.width = "0%"; }, 1200);
  }
}

function hasTranslatedContent(): boolean {
  return pageStates.some((page) => page.translations?.some((text, index) =>
    Boolean(page.blocks[index]?.translatable && text.trim())
  ));
}

function updateDownloadButtonState(): void {
  downloadButton.disabled = downloadButton.classList.contains("is-loading")
    || translateButton.classList.contains("is-loading")
    || !hasTranslatedContent();
}

function renderPageError(page: PdfPageState, error: unknown): void {
  page.translatedCanvasShell.className = "canvas-shell translation-canvas-shell has-error";
  page.translationLayer.replaceChildren();
  page.translationPrompt.hidden = false;
  page.translationPrompt.textContent = `本页翻译失败：${formatTranslationError(error)}`;
}

function formatTranslationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (provider.value === "google-web-translate" && /timed out|timeout|超时/iu.test(message)) {
    return "Google Web Translate 连接超时。该免密服务在部分网络中不稳定，请重试或在顶部切换其他翻译服务。";
  }
  return message;
}

async function saveReaderSettings(): Promise<void> {
  settings = {
    ...settings,
    sourceLang: sourceLang.value || "auto",
    targetLang: targetLang.value || "zh-CN",
    activeProviderId: provider.value || settings.activeProviderId
  };
  if (hasExtensionRuntime()) {
    await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings });
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
    provider.append(option);
  }
  provider.value = settings.activeProviderId;
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
  showStatus(`无法打开 PDF：${message}`, "error");
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
  const normalized = name.trim() || "未命名文档.pdf";
  return normalized.length > 64 ? `${normalized.slice(0, 61)}…` : normalized;
}

function hasExtensionRuntime(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(new DOMException("PDF download timed out.", "TimeoutError")),
    timeoutMs
  );
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.reason instanceof DOMException
      && controller.signal.reason.name === "TimeoutError") {
      throw new Error(`PDF 下载超过 ${Math.round(timeoutMs / 1000)} 秒，请检查网络或改用本地文件。`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () => reject(new Error(`${label}超过 ${Math.round(timeoutMs / 1000)} 秒，任务已停止。`)),
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
