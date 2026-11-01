import { anySignal } from "../shared/abort";
import metadata from "../../public/pdf-fonts/font-metadata.json";

export const PDF_FONT = metadata.font;
export const PDF_FONT_CACHE = "wupage.pdf-export-fonts.v1";
const fontKey = `https://wupage.invalid/pdf-fonts/${PDF_FONT.sha256}`;

export async function verifyPdfFont(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength !== PDF_FONT.bytes) throw new Error("字体包大小不匹配，请重新安装。");
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== PDF_FONT.sha256) throw new Error("字体包完整性校验失败，请重新安装。");
}

export async function readPdfFont(): Promise<Uint8Array | undefined> {
  if (!await caches.has(PDF_FONT_CACHE)) return undefined;
  const cache = await caches.open(PDF_FONT_CACHE);
  const response = await cache.match(fontKey);
  if (!response) return undefined;
  const bytes = new Uint8Array(await response.arrayBuffer());
  try { await verifyPdfFont(bytes); }
  catch { await cache.delete(fontKey); return undefined; }
  return bytes;
}

export async function removePdfFont(): Promise<void> {
  await navigator.locks.request(PDF_FONT_CACHE, () => caches.delete(PDF_FONT_CACHE));
}

export async function installPdfFont(signal: AbortSignal, onProgress: (downloaded: number) => void): Promise<Uint8Array> {
  return navigator.locks.request(PDF_FONT_CACHE, { signal }, async () => {
    signal.throwIfAborted();
    const installed = await readPdfFont();
    if (installed) return installed;
    const response = await fetch(PDF_FONT.source, { credentials: "omit", cache: "no-store",
      signal: anySignal([signal, AbortSignal.timeout(180_000)]) });
    if (!response.ok || !response.body) throw new Error(`字体包下载失败（${response.status}），可重试或直接导出。`);
    const bytes = new Uint8Array(PDF_FONT.bytes);
    const reader = response.body.getReader();
    let downloaded = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (downloaded + value.length > bytes.length) throw new Error("字体包大小不匹配，请重试。");
        bytes.set(value, downloaded);
        downloaded += value.length;
        onProgress(downloaded);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    signal.throwIfAborted();
    if (downloaded !== bytes.length) throw new Error("字体包下载不完整，可重试或直接导出。");
    await verifyPdfFont(bytes);
    signal.throwIfAborted();
    await (await caches.open(PDF_FONT_CACHE)).put(fontKey, new Response(bytes, {
      headers: { "content-length": String(bytes.length), "x-wupage-sha256": PDF_FONT.sha256 }
    }));
    return bytes;
  });
}
