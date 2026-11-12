import { t } from "./i18n";
import { sendRuntimeMessage } from "./messaging";
import type { OcrStatus } from "./ocr";
import { uiIconMarkup } from "./ui-icons";
import { setHtmlContent } from "./html";
import { validateOcrService, type OcrSettings } from "./ocr-service";

interface OcrControlOptions {
  elements?: { action: HTMLButtonElement; description: HTMLElement; status: HTMLElement; progress: HTMLProgressElement };
  helpId?: string;
  request?: typeof sendRuntimeMessage;
  shouldPoll?: () => boolean;
  getConfig?: () => OcrSettings;
  onConfigure?: () => void;
}

export function setImageTranslationToggle(toggle: HTMLButtonElement | HTMLInputElement, enabled: boolean): void {
  if (toggle instanceof HTMLInputElement) toggle.checked = enabled;
  else if (toggle.getAttribute("aria-pressed") !== String(enabled)) toggle.setAttribute("aria-pressed", String(enabled));

  const feature = toggle.closest<HTMLElement>(".image-feature");
  if (!feature?.hasAttribute("data-loading")) return;
  // Commit the saved position while transitions are disabled, then reveal it.
  void feature.offsetWidth;
  feature.removeAttribute("data-loading");
  feature.removeAttribute("aria-busy");
}

function setupHelp(action: HTMLButtonElement, contents: HTMLElement[], helpId: string): { position: () => void; hide: () => void } {
  const help = document.createElement("div"); help.className = "ocr-help";
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.className = "ocr-help-trigger"; setHtmlContent(trigger, uiIconMarkup("question-mark"));
  trigger.setAttribute("aria-label", t("imageTranslationHelpAndModelStatus"));
  trigger.setAttribute("aria-describedby", helpId);
  const panel = document.createElement("div");
  panel.id = helpId; panel.className = "ocr-help-panel"; panel.setAttribute("role", "tooltip"); panel.hidden = true;
  panel.append(...contents); help.append(trigger, panel);
  const slot = action.closest(".image-feature-row")?.querySelector(".ocr-help-slot");
  if (slot) slot.append(help);
  else action.before(help);
  const position = () => {
    if (panel.hidden) return;
    const anchor = trigger.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 12))}px`;
    const top = anchor.bottom + 8 + bounds.height <= window.innerHeight - 12
      ? anchor.bottom + 8 : anchor.top - bounds.height - 8;
    panel.style.top = `${Math.max(12, top)}px`;
  };
  const show = () => { panel.hidden = false; position(); };
  const hide = () => {
    if (!help.matches(":hover") && !help.contains(document.activeElement)) panel.hidden = true;
  };
  help.addEventListener("mouseenter", show);
  help.addEventListener("mouseleave", hide);
  help.addEventListener("focusin", show);
  help.addEventListener("focusout", () => queueMicrotask(hide));
  trigger.addEventListener("click", show);
  help.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { panel.hidden = true; trigger.blur(); event.stopPropagation(); }
  });
  return { position, hide: () => { panel.hidden = true; } };
}

export function setupOcrControl(toggle: HTMLButtonElement | HTMLInputElement, onRemoved: () => void, options: OcrControlOptions = {}): { refresh: () => Promise<void>; pause: () => void; dispose: () => void } {
  const button = options.elements?.action ?? document.querySelector<HTMLButtonElement>("#ocrModelAction")!;
  const description = options.elements?.description ?? document.querySelector<HTMLElement>("#ocrDescription")!;
  const status = options.elements?.status ?? document.querySelector<HTMLElement>("#ocrModelStatus")!;
  const progress = options.elements?.progress ?? document.querySelector<HTMLProgressElement>("#ocrModelProgress")!;
  const request = options.request ?? sendRuntimeMessage;
  description.textContent = t("imageTranslationRequiresAnAdditionalDownloadOfAbout");
  const help = setupHelp(button, [description, progress, status], options.helpId ?? "ocrHelpPanel");
  const positionHelp = help.position;
  let current: OcrStatus | undefined;
  let acting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let refreshing: Promise<void> | undefined;
  toggle.disabled = true;
  button.disabled = true;
  setHtmlContent(button, uiIconMarkup("wrench"));

  function render(value: OcrStatus): void {
    const wasInstalled = current?.state === "installed";
    current = value;
    const installed = value.state === "installed";
    const installing = value.state === "installing";
    const remote = value.backend === "http";
    description.textContent = remote ? t("ocrServicePrivacy") : t("imageTranslationRequiresAnAdditionalDownloadOfAbout");
    if (wasInstalled && !installed) onRemoved();
    toggle.disabled = !installed || toggle.getAttribute("aria-busy") === "true";
    if (!installed) setImageTranslationToggle(toggle, false);
    button.disabled = acting || installing;
    button.dataset.state = value.state;
    setHtmlContent(button, uiIconMarkup(installed && !remote ? "trash" : "wrench"));
    button.title = remote ? t("configureOcrService") : installed ? t("removeOcrModelsAndDisableImageTranslation") : installing ? t("installingOcrModels") : t("installOcrModelsAbout205Mb");
    button.setAttribute("aria-label", button.title);
    progress.hidden = !installing;
    progress.max = value.total;
    progress.value = value.downloaded;
    status.dataset.state = value.state;
    status.textContent = remote ? installed ? t("ocrServiceConfigured") : value.error ?? t("ocrServiceInvalidConfig")
      : installed ? t("ocrModelsInstalledImageTranslationAvailable")
      : installing ? value.downloaded >= value.total ? t("downloadCompleteCheckingModels") : t("downloadingOcrModels", Math.floor(value.downloaded / value.total * 100))
      : value.state === "error" ? t("installationFailedClickTheWrenchToRetry", value.error ?? t("modelRetry"))
      : t("ocrModelsNotInstalledClickTheWrenchTo");
    positionHelp();
  }

  function scheduleRefresh(delay: number): void {
    clearTimeout(timer);
    if (!disposed && options.shouldPoll?.() !== false) timer = setTimeout(() => void refresh(), delay);
  }

  function refresh(): Promise<void> {
    clearTimeout(timer);
    if (disposed || acting || options.shouldPoll?.() === false) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = readStatus().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  async function readStatus(): Promise<void> {
    try {
      const config = options.getConfig?.();
      let value: OcrStatus;
      if (config?.mode === "http") {
        try { validateOcrService(config); value = { backend: "http", state: "installed", total: 0, downloaded: 0 }; }
        catch (error) { value = { backend: "http", state: "error", total: 0, downloaded: 0, error: error instanceof Error ? error.message : String(error) }; }
      } else value = await request<OcrStatus>({ type: "GET_OCR_STATUS", ...(config ? { builtin: true } : {}) });
      // The draft may have switched backends while a local status was loading.
      if (config && JSON.stringify(config) !== JSON.stringify(options.getConfig?.())) return readStatus();
      if (!disposed) render(value);
    } catch (error) {
      if (!disposed) {
        status.textContent = t("couldNotReadModelStatus", error instanceof Error ? error.message : String(error));
        button.disabled = false;
        button.title = t("retryOcrModelStatusCheck");
        button.setAttribute("aria-label", button.title);
        positionHelp();
      }
    } finally {
      scheduleRefresh(current?.state === "installing" ? 800 : 2500);
    }
  }

  button.addEventListener("click", async () => {
    if (acting) return;
    if (!current) { clearTimeout(timer); await refresh(); return; }
    if (current.backend === "http") {
      if (options.onConfigure) options.onConfigure();
      else await request({ type: "OPEN_OPTIONS_PAGE" });
      return;
    }
    acting = true;
    button.disabled = true;
    clearTimeout(timer);
    try {
      const removing = current.state === "installed";
      status.textContent = removing ? t("removingOcrModels") : t("startingInstallation");
      const value = await request<OcrStatus>({ type: removing ? "REMOVE_OCR" : "INSTALL_OCR" });
      if (removing) onRemoved();
      render(value);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      acting = false;
      positionHelp();
      button.disabled = current?.state === "installing";
      scheduleRefresh(800);
    }
  });
  function pause(): void { clearTimeout(timer); help.hide(); }
  function dispose(): void { disposed = true; pause(); window.removeEventListener("pagehide", dispose); }
  window.addEventListener("pagehide", dispose, { once: true });
  void refresh();
  return { refresh, pause, dispose };
}
