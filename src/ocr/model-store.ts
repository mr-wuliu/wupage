import { OCR_CACHE, OCR_MODELS } from "../shared/ocr";

const receiptUrl = "https://wupage.invalid/ocr/receipt";

export async function installedRevision(): Promise<string | undefined> {
  if (!await caches.has(OCR_CACHE)) return undefined;
  const cache = await caches.open(OCR_CACHE);
  const receipt = await cache.match(receiptUrl);
  if (!receipt) return undefined;
  for (const model of OCR_MODELS) {
    const response = await cache.match(model.url);
    if (!response || Number(response.headers.get("content-length")) !== model.bytes) return undefined;
  }
  return receipt.text();
}

export async function downloadModels(onProgress: (bytes: number) => void): Promise<void> {
  await caches.delete(OCR_CACHE);
  const cache = await caches.open(OCR_CACHE);
  let completed = 0;
  try {
    for (const model of OCR_MODELS) {
      const response = await fetch(model.url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`模型下载失败（${response.status}），请重试。`);
      const reader = response.body.getReader();
      const bytes = new Uint8Array(model.bytes);
      let offset = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.length > model.bytes) throw new Error("模型大小校验失败，请重试。");
          bytes.set(value, offset);
          offset += value.length;
          onProgress(completed + offset);
        }
      } finally { await reader.cancel(); }
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (offset !== model.bytes || digest !== model.sha256) throw new Error("模型完整性校验失败，请重试。");
      await cache.put(model.url, new Response(bytes, { headers: { "content-length": String(model.bytes) } }));
      completed += offset;
    }
  } catch (error) {
    await caches.delete(OCR_CACHE);
    throw error;
  }
}

export async function commitModels(): Promise<string> {
  const revision = crypto.randomUUID();
  await (await caches.open(OCR_CACHE)).put(receiptUrl, new Response(revision));
  return revision;
}

export async function readModelBuffers(): Promise<ArrayBuffer[]> {
  const cache = await caches.open(OCR_CACHE);
  return Promise.all(OCR_MODELS.map(async (model) => {
    const response = await cache.match(model.url);
    if (!response) throw new Error("请先点击图片翻译旁的扳手安装 OCR 模型。");
    return response.arrayBuffer();
  }));
}
