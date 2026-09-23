import { CACHE_PREFIX } from "../shared/defaults";
import { sha256 } from "../shared/hash";
import type { ExtensionSettings, TranslateImageRequest, TranslateImageResponse } from "../shared/types";
import { parseImageRegions } from "./providers";
import { recognizeImage } from "./ocr";
import { installedRevision } from "../ocr/model-store";
import { positionedLines } from "../ocr/regions";
import { translateWithSettings } from "./translation";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const inFlight = new Map<string, Promise<TranslateImageResponse>>();
let active = 0;

export async function translateImageWithSettings(settings: ExtensionSettings, request: TranslateImageRequest): Promise<TranslateImageResponse> {
  if (!settings.imageTranslationEnabled) throw new Error("请先开启图片翻译。");
  const modelRevision = await installedRevision();
  if (!modelRevision) throw new Error("请先点击图片翻译旁的扳手安装 OCR 模型。");
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(request.dataUrl)
    || request.dataUrl.length > MAX_IMAGE_BYTES * 4 / 3 + 100
    || !Number.isInteger(request.width) || !Number.isInteger(request.height)
    || request.width <= 0 || request.height <= 0 || request.width * request.height > 16_000_000) {
    throw new Error("图片格式或尺寸不支持，请使用较小的静态图片。");
  }
  const provider = settings.providers.find((entry) => entry.id === settings.activeProviderId && entry.enabled !== false);
  if (!provider) throw new Error("没有可用的翻译服务。");
  const digest = await sha256(JSON.stringify({ version: 3, modelRevision, provider, target: settings.targetLang, source: settings.sourceLang, ...request }));
  const key = `${CACHE_PREFIX}image.${digest}`;
  if (settings.cacheEnabled) {
    const stored = (await chrome.storage.local.get(key))[key];
    if (stored) {
      try { return { regions: parseImageRegions(JSON.stringify(stored)).map((region) => ({ ...region, sampleColors: true })), targetLang: settings.targetLang, cached: true }; } catch { /* Ignore stale cache. */ }
    }
  }
  const existing = inFlight.get(key);
  if (existing) return existing;
  if (active >= 2) throw new Error("已有两张图片正在翻译，请稍后重试。");
  active += 1;
  const task = (async (): Promise<TranslateImageResponse> => {
    const recognized = await recognizeImage(request.dataUrl);
    const positioned = positionedLines(recognized.lines, request.width, request.height);
    const translated = positioned.length ? await translateWithSettings(settings, {
      texts: positioned.map((region) => region.text), sourceLang: settings.sourceLang, targetLang: settings.targetLang,
      context: "These are labels and text from the same image. Preserve numbers, units and product names. Keep translations concise for the original layout."
    }) : { translations: [], cached: 0 };
    if (recognized.revision !== modelRevision || await installedRevision() !== modelRevision) throw new Error("OCR 模型已删除或更换，请重新安装后重试。");
    const regions = positioned.map((region, index) => ({ ...region, translation: translated.translations[index] }))
      .filter((region) => region.translation.trim() !== region.text.trim());
    if (settings.cacheEnabled) await chrome.storage.local.set({ [key]: { regions } }).catch(() => undefined);
    return { regions, targetLang: settings.targetLang, cached: false };
  })();
  inFlight.set(key, task);
  try { return await task; } finally { active -= 1; inFlight.delete(key); }
}

export async function loadImageData(url: string): Promise<{ dataUrl: string }> {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("无法读取此图片地址。");
  const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`无法读取图片 (${response.status})，请确认图片已加载并且可以访问。`);
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("图片过大，请使用 12 MB 以内的图片。");
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!mime || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) throw new Error("图片格式不支持，或图片地址返回了登录页面。");
  if (!response.body) throw new Error("图片内容为空。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_IMAGE_BYTES) throw new Error("图片过大，请使用 12 MB 以内的图片。");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return { dataUrl: `data:${mime};base64,${btoa(binary)}` };
}
