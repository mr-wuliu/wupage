import { t } from "../shared/i18n";
import { sendRuntimeMessage } from "../shared/messaging";
import { setupOcrControl } from "../shared/ocr-control";
import { normalizeOcrSettings, validateOcrService, type OcrSettings } from "../shared/ocr-service";
import type { OcrRecognition } from "../shared/ocr";

export function setupOcrSettings(toggle: HTMLInputElement, onRemoved: () => void, initial?: OcrSettings,
  reveal?: (element: HTMLElement) => void): {
  render: (value?: OcrSettings) => void;
  read: () => OcrSettings;
} {
  const query = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const root = query<HTMLElement>("ocrServiceSettings");
  const mode = query<HTMLSelectElement>("ocrBackend");
  const fields = query<HTMLElement>("ocrServiceFields");
  const endpoint = query<HTMLInputElement>("ocrServiceEndpoint");
  const model = query<HTMLInputElement>("ocrServiceModel");
  const key = query<HTMLInputElement>("ocrServiceKey");
  const revision = query<HTMLInputElement>("ocrServiceRevision");
  const test = query<HTMLButtonElement>("testOcrService");
  const cancel = query<HTMLButtonElement>("cancelOcrTest");
  const status = query<HTMLElement>("ocrServiceTestStatus");
  const preview = query<HTMLCanvasElement>("ocrServicePreview");
  const text = query<HTMLElement>("ocrServiceTestText");
  const initialConfig = normalizeOcrSettings(initial);
  mode.value = initialConfig.mode; endpoint.value = initialConfig.endpoint; model.value = initialConfig.model;
  key.value = initialConfig.apiKey; revision.value = initialConfig.modelRevision;
  fields.hidden = initialConfig.mode !== "http";
  let active: string | undefined;
  let rendered: string | undefined;
  const read = (): OcrSettings => normalizeOcrSettings({ mode: mode.value, endpoint: endpoint.value,
    model: model.value, apiKey: key.value, modelRevision: revision.value });
  const control = setupOcrControl(toggle, onRemoved, { getConfig: read,
    onConfigure: () => { reveal?.(root); root.scrollIntoView?.({ block: "center" }); endpoint.focus(); } });
  function stop(): void {
    const requestId = active;
    active = undefined;
    test.disabled = false; cancel.hidden = true;
    if (requestId) void sendRuntimeMessage({ type: "CANCEL_OCR_TEST", requestId }).catch(() => {});
  }
  function update(): void {
    fields.hidden = mode.value !== "http";
    void control.refresh();
  }
  function invalidate(): void {
    stop(); status.textContent = ""; preview.hidden = true; text.hidden = true; update();
  }
  root.addEventListener("input", invalidate);
  root.addEventListener("change", invalidate);
  cancel.addEventListener("click", () => { stop(); status.textContent = t("ocrServiceTestCanceled"); });
  window.addEventListener("pagehide", stop, { once: true });
  test.addEventListener("click", () => { void run(); });
  async function run(): Promise<void> {
    stop(); text.hidden = true; preview.hidden = true;
    const requestId = crypto.randomUUID();
    active = requestId;
    test.disabled = true; cancel.hidden = false;
    try {
      const config = read(); validateOcrService(config);
      const context = preview.getContext("2d");
      if (!context) throw new Error(t("ocrServicePreviewUnavailable"));
      context.fillStyle = "#ffffff"; context.fillRect(0, 0, 640, 160);
      context.font = "48px sans-serif"; context.fillStyle = "#111111";
      context.fillText("Hello OCR 123", 32, 100);
      const image = { dataUrl: preview.toDataURL("image/png"), width: 640, height: 160 };
      preview.hidden = false;
      status.textContent = t("ocrServiceTesting");
      const result = await sendRuntimeMessage<OcrRecognition>({ type: "TEST_OCR_SERVICE", requestId, config, image });
      if (active !== requestId) return;
      context.strokeStyle = "#116466"; context.lineWidth = 2;
      for (const line of result.lines) {
        context.beginPath(); line.poly.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
        context.closePath(); context.stroke();
      }
      text.textContent = result.lines.map(line => line.text).join("\n"); text.hidden = !result.lines.length;
      status.textContent = result.lines.length ? t("ocrServiceTestPassed", result.lines.length) : t("ocrServiceTestEmpty");
    } catch (error) {
      if (active === requestId) status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (active === requestId) { active = undefined; test.disabled = false; cancel.hidden = true; }
    }
  }
  return { read() {
    const config = read();
    if (config.mode === "http") {
      try { validateOcrService(config); }
      catch (error) {
        reveal?.(root); root.scrollIntoView?.({ block: "center" }); endpoint.focus();
        throw error;
      }
    }
    return config;
  }, render(value) {
    const config = normalizeOcrSettings(value);
    const identity = JSON.stringify(config);
    if (rendered === identity && JSON.stringify(read()) === identity) return;
    rendered = identity;
    mode.value = config.mode; endpoint.value = config.endpoint; model.value = config.model;
    key.value = config.apiKey; revision.value = config.modelRevision;
    invalidate();
  } };
}
