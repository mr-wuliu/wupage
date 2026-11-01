import { sendRuntimeMessage } from "./messaging";
import { OCR_DESCRIPTION, type OcrStatus } from "./ocr";
import { uiIconMarkup } from "./ui-icons";
import { setHtmlContent } from "./html";

interface OcrControlOptions {
  elements?: { action: HTMLButtonElement; description: HTMLElement; status: HTMLElement; progress: HTMLProgressElement };
  helpId?: string;
  request?: typeof sendRuntimeMessage;
  shouldPoll?: () => boolean;
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
  trigger.setAttribute("aria-label", "图片翻译说明与模型状态");
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
  description.textContent = OCR_DESCRIPTION;
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
    if (wasInstalled && !installed) onRemoved();
    toggle.disabled = !installed || toggle.getAttribute("aria-busy") === "true";
    if (!installed) setImageTranslationToggle(toggle, false);
    button.disabled = acting || installing;
    button.dataset.state = value.state;
    setHtmlContent(button, uiIconMarkup(installed ? "trash" : "wrench"));
    button.title = installed ? "删除 OCR 模型并关闭图片翻译" : installing ? "正在安装 OCR 模型" : "安装 OCR 模型（约 20.5 MB）";
    button.setAttribute("aria-label", button.title);
    progress.hidden = !installing;
    progress.max = value.total;
    progress.value = value.downloaded;
    status.dataset.state = value.state;
    status.textContent = installed ? "OCR 模型已安装 · 可开启图片翻译"
      : installing ? value.downloaded >= value.total ? "下载完成，正在验证模型可用性…" : `正在下载 OCR 模型 · ${Math.floor(value.downloaded / value.total * 100)}%`
      : value.state === "error" ? `安装失败：${value.error ?? "请重试"}。点击扳手重试。`
      : "未安装 OCR 模型 · 点击旁边的扳手安装";
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
      const value = await request<OcrStatus>({ type: "GET_OCR_STATUS" });
      if (!disposed) render(value);
    } catch (error) {
      if (!disposed) {
        status.textContent = `无法读取模型状态：${error instanceof Error ? error.message : String(error)}`;
        button.disabled = false;
        button.title = "重试读取 OCR 模型状态";
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
    acting = true;
    button.disabled = true;
    clearTimeout(timer);
    try {
      const removing = current.state === "installed";
      status.textContent = removing ? "正在删除 OCR 模型…" : "正在开始安装…";
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
