import { initializeInterfaceLanguage, resolveBridgeMessage, t, watchInterfaceLanguage } from "../shared/i18n";
import { OCR_CACHE, OCR_DOWNLOAD_BYTES, type OcrLine, type OcrStatus } from "../shared/ocr";
import { commitModels, downloadModels, installedRevision, readModelBuffers } from "./model-store";
import "../local/offscreen";
import "../dictionary/runtime";
import { withInferenceLifetime } from "../shared/inference-lifetime";

void initializeInterfaceLanguage();
watchInterfaceLanguage();

let state: OcrStatus = { state: "missing", downloaded: 0, total: OCR_DOWNLOAD_BYTES };
let installing: Promise<void> | undefined;
let frame: HTMLIFrameElement | undefined;
let initialized: Promise<void> | undefined;
let busy = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

window.addEventListener("message", (event) => {
  if (event.source !== frame?.contentWindow || event.data?.target !== "wupage-ocr-result") return;
  const task = pending.get(event.data.id);
  if (!task) return;
  clearTimeout(task.timer);
  pending.delete(event.data.id);
  if (event.data.error) task.reject(new Error(resolveBridgeMessage(String(event.data.error))));
  else task.resolve(event.data.result);
});

function releaseEngine(): void {
  clearTimeout(idleTimer);
  frame?.remove(); frame = undefined; initialized = undefined;
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(t("ocrTaskCanceled"))); }
  pending.clear();
}

function scheduleRelease(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(releaseEngine, 60_000);
}

function callEngine(action: string, data?: unknown, transfer: Transferable[] = []): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(t("ocrProcessingTimedOutTryAgain"))); releaseEngine(); }, 120_000);
    pending.set(id, { resolve, reject, timer });
    frame!.contentWindow!.postMessage({ target: "wupage-ocr-engine", id, action, data }, "*", transfer);
  });
}

async function ensureEngine(): Promise<void> {
  clearTimeout(idleTimer);
  if (initialized) return initialized;
  initialized = (async () => {
    frame = document.createElement("iframe");
    frame.sandbox.add("allow-scripts");
    frame.src = chrome.runtime.getURL("ocr-sandbox.html");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(t("ocrInitializationTimedOut"))), 30_000);
      frame!.onload = () => { clearTimeout(timeout); resolve(); };
      document.body.append(frame!);
    });
    const models = await readModelBuffers();
    await callEngine("init", { models, wasmPath: chrome.runtime.getURL("ocr-runtime/") }, models);
  })();
  try { await initialized; } catch (error) { releaseEngine(); throw error; }
}

async function status(): Promise<OcrStatus> {
  if (installing) return state;
  const revision = await installedRevision();
  if (revision) state = { state: "installed", total: OCR_DOWNLOAD_BYTES, downloaded: OCR_DOWNLOAD_BYTES, revision };
  else if (state.state !== "error") state = { state: "missing", total: OCR_DOWNLOAD_BYTES, downloaded: 0 };
  return state;
}

async function handle(action: string, dataUrl?: string): Promise<unknown> {
  await initializeInterfaceLanguage();
  if (action === "status") return status();
  if (action === "install") {
    if (installing || (await status()).state === "installed") return state;
    if (installing) return state;
    state = { state: "installing", total: OCR_DOWNLOAD_BYTES, downloaded: 0 };
    installing = withInferenceLifetime(async () => {
      try {
        await downloadModels((downloaded) => { state = { ...state, downloaded }; });
        // A downloaded file is not an installed model until the runtime can load it.
        await ensureEngine();
        const revision = await commitModels();
        state = { ...state, state: "installed", revision };
      } catch (error) {
        releaseEngine();
        await caches.delete(OCR_CACHE);
        state = { state: "error", downloaded: 0, total: OCR_DOWNLOAD_BYTES, error: error instanceof Error ? error.message : String(error) };
      } finally { installing = undefined; scheduleRelease(); }
    });
    return state;
  }
  if (action === "remove") {
    if (installing) throw new Error(t("waitForOcrModelInstallationToFinishBefore"));
    if (busy) throw new Error(t("waitForImageRecognitionToFinishBeforeRemoving"));
    releaseEngine();
    await caches.delete(OCR_CACHE);
    state = { state: "missing", downloaded: 0, total: OCR_DOWNLOAD_BYTES };
    return state;
  }
  if (action === "recognize") {
    const revision = await installedRevision();
    if (!revision) throw new Error(t("useTheWrenchBesideImageTranslationToInstall"));
    if (busy) throw new Error(t("imageRecognitionIsAlreadyRunningTryAgainShortly"));
    busy = true;
    try {
      await ensureEngine();
      const lines = await callEngine("recognize", { dataUrl }) as OcrLine[];
      return { lines, revision };
    } finally { busy = false; scheduleRelease(); }
  }
  throw new Error(t("unknownOcrOperation"));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== "ocr-offscreen" || sender.id !== chrome.runtime.id || sender.tab) return;
  void handle(request.action, request.dataUrl).then((data) => sendResponse({ ok: true, data }), (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
