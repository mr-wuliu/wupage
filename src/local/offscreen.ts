import { initializeInterfaceLanguage, t } from "../shared/i18n";
import { LocalTranslationEngine } from "./engine";
import { downloadLocalModel, localModelStates, removeLocalModel } from "./model-store";
import { getLocalModel, getLocalRoute, type LocalModelStatus } from "./models";
import type { TranslateBatchRequest } from "../shared/types";
import { withInferenceLifetime } from "../shared/inference-lifetime";

const engine = new LocalTranslationEngine();
let download: { id: string; controller: AbortController; downloaded: number; settled: Promise<void> } | undefined;
let lastError: { id: string; message: string } | undefined;
let translating = 0;
let queue = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

async function status(): Promise<LocalModelStatus> {
  const models = await localModelStates();
  for (const model of models) {
    if (download?.id === model.id) Object.assign(model, { state: "downloading", downloaded: download.downloaded });
    else if (lastError?.id === model.id && model.state !== "ready") Object.assign(model, { state: "error", error: lastError.message });
  }
  return { models, downloading: download?.id };
}

async function handle(action: string, data?: unknown): Promise<unknown> {
  if (action === "status") return status();
  if (action === "install") {
    const model = getLocalModel(String(data));
    if (download) throw new Error(t("aModelIsDownloadingPauseItBeforeSwitching"));
    const controller = new AbortController();
    const job = { id: model.id, controller, downloaded: 0, settled: Promise.resolve() };
    download = job;
    lastError = undefined;
    job.settled = withInferenceLifetime(() => downloadLocalModel(model.id, controller.signal, (bytes) => { job.downloaded = bytes; }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) lastError = { id: model.id, message: t("downloadedDataWasKeptRetryOrImportOffline", error instanceof Error ? error.message : String(error)) };
      }).finally(() => { if (download === job) download = undefined; });
    return status();
  }
  if (action === "cancel") {
    const job = download;
    job?.controller.abort();
    await job?.settled;
    return status();
  }
  if (action === "remove") {
    if (download || translating) throw new Error(t("pauseTheDownloadAndWaitForTranslationTo"));
    getLocalModel(String(data));
    engine.release();
    await removeLocalModel(String(data));
    lastError = undefined;
    return status();
  }
  if (action === "translate") {
    const request = data as TranslateBatchRequest;
    const route = getLocalRoute(request.sourceLang ?? "auto", request.targetLang);
    if (!route.length) return request.texts;
    const states = await localModelStates();
    const missing = route.filter((model) => !states.some((entry) => entry.id === model.id && entry.state === "ready"));
    if (missing.length) throw new Error(t("downloadOrImportTheModelInSettingsIt", missing.map((model) => model.label).join("、")));
    translating++;
    clearTimeout(idleTimer);
    const task = queue.then(() => engine.translate(route, request.texts));
    queue = task.then(() => undefined, () => undefined);
    try { return await task; }
    finally {
      translating--;
      if (!translating) idleTimer = setTimeout(() => engine.release(), 60_000);
    }
  }
  throw new Error(t("unknownLocalModelOperation"));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== "bergamot-offscreen" || sender.id !== chrome.runtime.id || sender.tab) return;
  void initializeInterfaceLanguage().then(() => handle(request.action, request.data)).then(
    (data) => sendResponse({ ok: true, data }),
    (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
  return true;
});
