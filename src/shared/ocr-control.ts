import { sendRuntimeMessage } from "./messaging";
import { OCR_DESCRIPTION, type OcrStatus } from "./ocr";
import "./ocr-control.css";

const wrench = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 6a5 5 0 0 0-6 6L3 17a2.8 2.8 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z"/></svg>';
const trash = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';

function setupHelp(action: HTMLButtonElement, contents: HTMLElement[]): () => void {
  const help = document.createElement("div"); help.className = "ocr-help";
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.className = "ocr-help-trigger"; trigger.textContent = "?";
  trigger.setAttribute("aria-label", "图片翻译说明与模型状态");
  trigger.setAttribute("aria-describedby", "ocrHelpPanel");
  const panel = document.createElement("div");
  panel.id = "ocrHelpPanel"; panel.className = "ocr-help-panel"; panel.setAttribute("role", "tooltip"); panel.hidden = true;
  panel.append(...contents); help.append(trigger, panel); action.before(help);
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
  return position;
}

export function setupOcrControl(toggle: HTMLButtonElement | HTMLInputElement, onRemoved: () => void): void {
  const button = document.querySelector<HTMLButtonElement>("#ocrModelAction")!;
  const description = document.querySelector<HTMLElement>("#ocrDescription")!;
  const status = document.querySelector<HTMLElement>("#ocrModelStatus")!;
  const progress = document.querySelector<HTMLProgressElement>("#ocrModelProgress")!;
  description.textContent = OCR_DESCRIPTION;
  const positionHelp = setupHelp(button, [description, progress, status]);
  let current: OcrStatus | undefined;
  let acting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  toggle.disabled = true;
  button.disabled = true;
  button.innerHTML = wrench;

  function render(value: OcrStatus): void {
    const wasInstalled = current?.state === "installed";
    current = value;
    const installed = value.state === "installed";
    const installing = value.state === "installing";
    if (wasInstalled && !installed) onRemoved();
    toggle.disabled = !installed;
    if (!installed) {
      if (toggle instanceof HTMLInputElement) toggle.checked = false;
      else toggle.setAttribute("aria-pressed", "false");
    }
    button.disabled = acting || installing;
    button.dataset.state = value.state;
    button.innerHTML = installed ? trash : wrench;
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

  async function refresh(): Promise<void> {
    try {
      const value = await sendRuntimeMessage<OcrStatus>({ type: "GET_OCR_STATUS" });
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
      if (!disposed) timer = setTimeout(() => void refresh(), current?.state === "installing" ? 800 : 2500);
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
      const value = await sendRuntimeMessage<OcrStatus>({ type: removing ? "REMOVE_OCR" : "INSTALL_OCR" });
      if (removing) onRemoved();
      render(value);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      acting = false;
      positionHelp();
      button.disabled = current?.state === "installing";
      timer = setTimeout(() => void refresh(), 800);
    }
  });
  window.addEventListener("pagehide", () => { disposed = true; clearTimeout(timer); }, { once: true });
  void refresh();
}
