import { t, htmlMessage } from "../shared/i18n";
import { sendRuntimeMessage } from "../shared/messaging";
import { importModelFiles } from "./model-store";
import { getLocalModel, getLocalRoute, LOCAL_MODELS, modelBytes, normalizeLocalLanguage, type LocalModelStatus } from "./models";
import "./control.css";

const size = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export function setupLocalModelControl(container: HTMLElement, source: string, target: string): () => void {
  let route = t("autoDetectionUsesTheBrowserSLocalLanguage");
  let selectedId = LOCAL_MODELS.find((model) => model.to === normalizeLocalLanguage(target))?.id ?? "en-zh-Hans";
  try {
    if (source !== "auto") {
      const models = getLocalRoute(source, target);
      route = models.length ? t("requiredForThisDirection", models.map((model) => model.label).join(" + "), models.length > 1 ? t("translationGoesThroughEnglishAndRequiresBothModels") : "") : t("sourceAndTargetLanguagesMatchNoTranslationNeeded");
      selectedId = models[0]?.id ?? selectedId;
    }
  } catch (error) { route = error instanceof Error ? error.message : String(error); }
  container.innerHTML = `
    <section class="local-model-control" aria-label="${htmlMessage("firefoxLocalModels")}">
      <p class="local-resource-notice"></p>
      <p class="local-route"></p>
      <label>${htmlMessage("languageModel")} <select data-local="model"></select></label>
      <progress data-local="progress" value="0" max="1" hidden aria-label="${htmlMessage("modelDownloadProgress")}"></progress>
      <p data-local="status" role="status" aria-live="polite">${htmlMessage("checkingLocalModels")}</p>
      <div class="local-model-actions">
        <button type="button" data-local="download" disabled>${htmlMessage("downloadModel")}</button>
        <button type="button" data-local="cancel" hidden>${htmlMessage("pauseDownload")}</button>
        <button type="button" data-local="import">${htmlMessage("importOffline")}</button>
        <button type="button" data-local="remove" disabled>${htmlMessage("deleteModel")}</button>
      </div>
      <input type="file" data-local="files" multiple accept=".bin,.spm" hidden />
      <details><summary>${htmlMessage("offlineInstallationAndInterruptedDownloads")}</summary>
        <p>${htmlMessage("failedDownloadsRetryAutomaticallyCompletedFilesAndEach")}</p>
        <p>${htmlMessage("youCanDownloadAllFilesBelowOnAnother")}</p>
        <ul data-local="links"></ul>
      </details>
      <p class="local-model-note">${htmlMessage("experimentalSupportForEnglishSimplifiedChineseJapaneseGerman")}</p>
    </section>`;
  const query = <T extends HTMLElement>(key: string) => container.querySelector<T>(`[data-local='${key}']`)!;
  container.querySelector<HTMLElement>(".local-resource-notice")!.textContent = t("localTranslationRequiresASeparateModelDownloadFor");
  container.querySelector<HTMLElement>(".local-route")!.textContent = route;
  const select = query<HTMLSelectElement>("model");
  const progress = query<HTMLProgressElement>("progress");
  const status = query<HTMLParagraphElement>("status");
  const download = query<HTMLButtonElement>("download");
  const cancel = query<HTMLButtonElement>("cancel");
  const remove = query<HTMLButtonElement>("remove");
  const importButton = query<HTMLButtonElement>("import");
  const input = query<HTMLInputElement>("files");
  let current: LocalModelStatus | undefined;
  let busy = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notice = "";
  select.replaceChildren(...LOCAL_MODELS.map((model) => new Option(`${model.label} · ${size(modelBytes(model))}`, model.id)));
  select.value = selectedId;

  function render(): void {
    if (disposed) return;
    const model = getLocalModel(select.value);
    const state = current?.models.find((entry) => entry.id === model.id);
    const downloading = current?.downloading === model.id;
    const labels = { ready: t("modelReady"), partial: t("resumable"), missing: t("notInstalled"), downloading: t("downloading"), error: t("downloadIncomplete") };
    for (const option of select.options) {
      const entry = getLocalModel(option.value);
      const value = current?.models.find((item) => item.id === option.value);
      option.textContent = `${entry.label} · ${size(modelBytes(entry))}${value ? ` · ${labels[value.state]}` : ""}`;
    }
    progress.hidden = !state || state.state === "ready" || state.downloaded === 0;
    progress.max = state?.total ?? 1;
    progress.value = state?.downloaded ?? 0;
    status.textContent = notice || (state?.state === "ready" ? t("modelReadyForOfflineTranslation") : state?.error
      ?? (state ? `${downloading ? t("modelDownloading") : state.downloaded ? t("retained") : t("pendingDownload")}：${size(state.downloaded)} / ${size(state.total)}。${downloading ? t("downloadsContinueAfterYouCloseSettings") : t("modelsAreDownloadedOnlyWhenYouChooseDownload")}` : t("checkingLocalModels")));
    download.disabled = busy || !state || !!current?.downloading || state.state === "ready";
    download.textContent = state?.state === "ready" ? t("modelInstalled") : state?.downloaded ? t("resumeDownload") : t("downloadModelWithSize", size(modelBytes(model)));
    cancel.hidden = !downloading;
    cancel.disabled = busy;
    remove.disabled = busy || !state?.downloaded || !!current?.downloading;
    importButton.disabled = busy || !!current?.downloading;
    const links = query<HTMLUListElement>("links");
    links.replaceChildren(...model.files.map((file) => {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = file.url; link.textContent = `${file.name}（${size(file.bytes)}）`;
      link.target = "_blank"; link.rel = "noopener noreferrer"; link.download = file.name;
      li.append(link); return li;
    }));
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    clearTimeout(timer);
    try { current = await sendRuntimeMessage<LocalModelStatus>({ type: "GET_LOCAL_MODEL_STATUS" }); render(); }
    catch (error) { if (!disposed) status.textContent = error instanceof Error ? error.message : String(error); }
    if (!disposed) timer = setTimeout(() => void refresh(), current?.downloading ? 1000 : 5000);
  }

  async function act(task: () => Promise<unknown>): Promise<void> {
    busy = true; notice = ""; render();
    try { await task(); }
    catch (error) { notice = error instanceof Error ? error.message : String(error); }
    finally { busy = false; await refresh(); }
  }

  download.addEventListener("click", () => void act(() => sendRuntimeMessage({ type: "INSTALL_LOCAL_MODEL", modelId: select.value })));
  cancel.addEventListener("click", () => void act(() => sendRuntimeMessage({ type: "CANCEL_LOCAL_MODEL_DOWNLOAD" })));
  remove.addEventListener("click", () => void act(() => sendRuntimeMessage({ type: "REMOVE_LOCAL_MODEL", modelId: select.value })));
  importButton.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    const id = select.value;
    input.value = "";
    if (!files.length) return;
    void act(async () => {
      const imported = await importModelFiles(id, files);
      notice = t("verifiedAndImportedFilesOfflineTranslationIsAvailable", imported);
    });
  });
  select.addEventListener("change", () => { notice = ""; render(); });
  const dispose = () => { disposed = true; clearTimeout(timer); window.removeEventListener("pagehide", dispose); };
  window.addEventListener("pagehide", dispose);
  void refresh();
  return dispose;
}
