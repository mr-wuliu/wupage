import { t } from "./i18n";
import type { ExtensionSettings } from "./types";
import type { sendRuntimeMessage } from "./messaging";
import { getLocalRoute, type LocalModelStatus } from "../local/models";

export function localProviderNotice(settings: ExtensionSettings): string | undefined {
  if (settings.providers.find((provider) => provider.id === settings.activeProviderId)?.type !== "firefox-local") return undefined;
  return t("downloadOrImportLanguageModelsInSettingsBefore");
}

export function localModelNotice(settings: ExtensionSettings, status: LocalModelStatus): { text: string; state: string } {
  let ids: string[] | undefined;
  if (settings.sourceLang !== "auto") {
    try { ids = getLocalRoute(settings.sourceLang, settings.targetLang).map(model => model.id); }
    catch { return { text: t("localModelsDoNotSupportThisLanguagePair"), state: "missing" }; }
  }
  const models = ids ? ids.map(id => status.models.find(model => model.id === id)) : status.models;
  const downloading = models.find(model => model?.state === "downloading");
  if (downloading) return { text: t("downloadingLanguageModel", Math.min(100, Math.floor(downloading.downloaded / Math.max(1, downloading.total) * 100))), state: "downloading" };
  const error = models.find(model => model?.state === "error");
  if (error) return { text: t("modelDownloadErrorDetail", error.error || t("retryInSettings")), state: "error" };
  if (ids && models.every(model => model?.state === "ready")) return { text: ids.length ? t("languageModelReady") : t("sourceAndTargetLanguagesMatch"), state: "ready" };
  if (!ids) {
    const ready = models.filter(model => model?.state === "ready");
    if (ready.length) return { text: t("installedLanguageModels", ready.length), state: "ready" };
  }
  return { text: t("installTheRequiredLanguageModelsFirst"), state: "missing" };
}

const renders = new WeakMap<HTMLElement, { timer?: ReturnType<typeof setTimeout> }>();

/** Read-only status; model installation remains an explicit action in settings. */
export function renderLocalModelNotice(element: HTMLElement, settings: ExtensionSettings, request: typeof sendRuntimeMessage, manage: () => void, shouldPoll = () => true): void {
  clearTimeout(renders.get(element)?.timer);
  const render: { timer?: ReturnType<typeof setTimeout> } = {};
  renders.set(element, render);
  const local = settings.providers.find(provider => provider.id === settings.activeProviderId)?.type === "firefox-local";
  element.classList.toggle("wupage-local-notice", local);
  if (!local) { delete element.dataset.state; return; }
  const text = document.createElement("span");
  text.textContent = t("checkingLocalLanguageModels");
  const button = document.createElement("button");
  button.type = "button"; button.textContent = t("manageModels");
  button.addEventListener("click", manage);
  element.replaceChildren(text, button);
  const refresh = async () => {
    if (!element.isConnected || renders.get(element) !== render) return;
    try {
      const status = await request<LocalModelStatus>({ type: "GET_LOCAL_MODEL_STATUS" });
      if (!element.isConnected || renders.get(element) !== render) return;
      const notice = localModelNotice(settings, status);
      text.textContent = notice.text; element.dataset.state = notice.state;
      if (status.downloading && shouldPoll()) render.timer = setTimeout(() => void refresh(), 1500);
    } catch {
      if (renders.get(element) === render) { text.textContent = t("checkLanguageModelStatusInSettings"); element.dataset.state = "unknown"; }
    }
  };
  void refresh();
}
