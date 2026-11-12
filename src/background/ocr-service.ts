import { t } from "../shared/i18n";
import { sha256 } from "../shared/hash";
import { SETTINGS_KEY } from "../shared/defaults";
import { getSettings } from "../shared/settings";
import { normalizeOcrSettings, ocrSettingsIdentity, validateOcrImage, validateOcrService, type OcrImageInput, type OcrSettings } from "../shared/ocr-service";
import type { OcrLine, OcrRecognition } from "../shared/ocr";
import type { ExtensionSettings } from "../shared/types";
import { installedRevision } from "../ocr/model-store";
import { fetchWithTimeout, httpResponseError, readJsonResponse } from "./provider-transport";
import { anySignal } from "../shared/abort";

const active = new Set<{ identity: string; controller: AbortController }>();
const tests = new Map<string, AbortController>();

export async function ocrRevision(settings: Pick<ExtensionSettings, "ocr">): Promise<string | undefined> {
  const config = normalizeOcrSettings(settings.ocr);
  if (config.mode === "builtin") return installedRevision();
  validateOcrService(config);
  return `http:${await sha256(`ocr-http-v1:${ocrSettingsIdentity(config)}`)}`;
}

export function initOcrService(): void {
  chrome.storage.onChanged?.addListener((changes, area) => {
    const settings = changes[SETTINGS_KEY]?.newValue as ExtensionSettings | undefined;
    if (area !== "local" || !settings) return;
    for (const task of active) {
      if (!settings.imageTranslationEnabled || task.identity !== ocrSettingsIdentity(settings.ocr)) task.controller.abort();
    }
  });
}

export async function recognizeOcrService(config: OcrSettings, image: OcrImageInput, signal?: AbortSignal, track = true): Promise<OcrRecognition> {
  validateOcrService(config);
  validateOcrImage(image);
  const task = { identity: ocrSettingsIdentity(config), controller: new AbortController() };
  if (track) active.add(task);
  try {
    const revision = await ocrRevision({ ocr: config });
    const requestSignal = signal ? anySignal([signal, task.controller.signal]) : task.controller.signal;
    if (track) {
      const latest = await getSettings();
      if (!latest.imageTranslationEnabled || task.identity !== ocrSettingsIdentity(latest.ocr)) throw new Error(t("ocrServiceChanged"));
    }
    requestSignal.throwIfAborted();
    const response = await fetchWithTimeout(config.endpoint, {
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ schemaVersion: 1, model: config.model, image }),
      signal: requestSignal
    }, 90_000);
    if (!response.ok) throw httpResponseError(response, t("ocrServiceHttpError", response.status));
    const payload = await readJsonResponse<unknown>(response, t("customOcrService"));
    return { lines: parseOcrServiceResult(payload, image), revision: revision! };
  } finally { active.delete(task); }
}

export function parseOcrServiceResult(value: unknown, image: Pick<OcrImageInput, "width" | "height">): OcrLine[] {
  const invalid = (): never => { throw new Error(t("ocrServiceInvalidResponse")); };
  if (!value || typeof value !== "object") return invalid();
  const result = value as Record<string, unknown>;
  if (result.schemaVersion !== 1 || result.coordinateSpace !== "pixel" || result.width !== image.width || result.height !== image.height
    || !Array.isArray(result.lines) || result.lines.length > 2000) return invalid();
  let total = 0;
  return result.lines.map((value: unknown): OcrLine => {
    if (!value || typeof value !== "object") return invalid();
    const line = value as Record<string, unknown>;
    if (typeof line.text !== "string" || !line.text.trim() || line.text.length > 4000 || (total += line.text.length) > 100_000
      || line.score !== undefined && (typeof line.score !== "number" || !Number.isFinite(line.score) || line.score < 0 || line.score > 1)
      || !Array.isArray(line.poly) || line.poly.length !== 4) return invalid();
    const poly = line.poly.map((point: unknown): [number, number] => {
      if (!Array.isArray(point) || point.length !== 2 || point.some(v => typeof v !== "number" || !Number.isFinite(v))
        || point[0] < 0 || point[0] > image.width || point[1] < 0 || point[1] > image.height) return invalid();
      return [point[0], point[1]];
    });
    const area = Math.abs(poly.reduce((sum, [x, y], index) => {
      const next = poly[(index + 1) % 4]; return sum + x * next[1] - next[0] * y;
    }, 0)) / 2;
    if (area < 1) return invalid();
    return { text: line.text, poly, ...(line.score !== undefined ? { score: line.score as number } : {}) };
  });
}

export async function testOcrService(id: string, config: OcrSettings, image: OcrImageInput): Promise<OcrRecognition> {
  if (typeof id !== "string" || !/^[\w-]{1,100}$/u.test(id) || tests.has(id) || tests.size >= 2) throw new Error(t("ocrServiceTestBusy"));
  const controller = new AbortController();
  tests.set(id, controller);
  try { return await recognizeOcrService(config, image, controller.signal, false); }
  finally { tests.delete(id); }
}

export function cancelOcrTest(id: string): void { tests.get(id)?.abort(); }
