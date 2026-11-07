import { t } from "../shared/i18n";
import { getLocalModel, LOCAL_MODEL_CACHE, LOCAL_MODELS, modelBytes, type LocalModelState, type ModelFile } from "./models";

const PART_BYTES = 1024 * 1024;
const LOCK = "wupage.bergamot.model-write";
const fileKey = (file: ModelFile) => `https://wupage.invalid/bergamot/${file.sha256}`;
const partKey = (file: ModelFile, part: number) => `${fileKey(file)}/part/${part}`;

export async function withModelWriteLock<T>(task: () => Promise<T>): Promise<T> {
  return navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => {
    if (!lock) throw new Error(t("anotherWindowIsInstallingImportingOrDeletingA"));
    return task();
  });
}

async function completeFile(cache: Cache, file: ModelFile): Promise<Response | undefined> {
  const response = await cache.match(fileKey(file));
  return response && Number(response.headers.get("content-length")) === file.bytes
    && response.headers.get("x-wupage-sha256") === file.sha256 ? response : undefined;
}

async function readParts(cache: Cache, file: ModelFile, bytes?: Uint8Array): Promise<number> {
  let offset = 0;
  for (let part = 0; offset < file.bytes; part++) {
    const response = await cache.match(partKey(file, part));
    const expected = Math.min(PART_BYTES, file.bytes - offset);
    if (!response || Number(response.headers.get("content-length")) !== expected) break;
    if (bytes) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== expected) break;
      bytes.set(new Uint8Array(buffer), offset);
    }
    offset += expected;
  }
  return offset;
}

export async function localModelStates(): Promise<LocalModelState[]> {
  const cache = await caches.open(LOCAL_MODEL_CACHE);
  return Promise.all(LOCAL_MODELS.map(async (model) => {
    let downloaded = 0;
    let ready = true;
    for (const file of model.files) {
      if (await completeFile(cache, file)) downloaded += file.bytes;
      else { ready = false; downloaded += await readParts(cache, file); }
    }
    return { id: model.id, state: ready ? "ready" : downloaded ? "partial" : "missing", downloaded, total: modelBytes(model) };
  }));
}

export async function verifyModelBytes(file: ModelFile, bytes: ArrayBuffer): Promise<void> {
  if (bytes.byteLength !== file.bytes) throw new Error(t("sizeMismatchForChooseAModelFileFrom", file.name));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== file.sha256) throw new Error(t("integrityCheckFailedForDownloadTheFileAgain", file.name));
}

async function deleteParts(cache: Cache, file: ModelFile): Promise<void> {
  for (let part = 0; part * PART_BYTES < file.bytes; part++) await cache.delete(partKey(file, part));
}

async function storeFile(cache: Cache, file: ModelFile, bytes: ArrayBuffer): Promise<void> {
  await verifyModelBytes(file, bytes);
  await cache.put(fileKey(file), new Response(bytes, { headers: {
    "content-length": String(file.bytes), "x-wupage-sha256": file.sha256
  } }));
  await deleteParts(cache, file);
}

export async function importModelFiles(id: string, files: File[]): Promise<number> {
  return withModelWriteLock(async () => {
    const model = getLocalModel(id);
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    let imported = 0;
    for (const file of files) {
      // CDN filenames may be UUIDs when saved through another browser.
      const expected = model.files.find((entry) => entry.name === file.name)
        ?? model.files.find((entry) => entry.bytes === file.size);
      if (!expected) continue;
      if (file.size !== expected.bytes) throw new Error(t("sizeMismatchForChooseAModelFileFrom", file.name));
      await storeFile(cache, expected, await file.arrayBuffer());
      imported++;
    }
    if (!imported) throw new Error(t("noMatchingModelFilesFoundChooseTheListed"));
    return imported;
  });
}

export async function downloadLocalModel(id: string, signal: AbortSignal, onProgress: (bytes: number) => void): Promise<void> {
  await withModelWriteLock(async () => {
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    let completed = 0;
    for (const file of getLocalModel(id).files) {
      signal.throwIfAborted();
      if (!await completeFile(cache, file)) {
        for (let attempt = 0; ; attempt++) {
          try { await downloadFile(cache, file, signal, (bytes) => onProgress(completed + bytes)); break; }
          catch (error) {
            if (signal.aborted || attempt >= 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
          }
        }
      }
      completed += file.bytes;
      onProgress(completed);
    }
  });
}

async function downloadFile(cache: Cache, file: ModelFile, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  const bytes = new Uint8Array(file.bytes);
  let offset = await readParts(cache, file, bytes);
  let saved = offset;
  progress(offset);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout>;
  const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(abort, 30_000); };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    signal.throwIfAborted();
    if (offset < file.bytes) {
      resetTimeout();
      const response = await fetch(file.url, { credentials: "omit", cache: "no-store", signal: controller.signal,
        headers: offset ? { Range: `bytes=${offset}-` } : {} });
      if (!response.ok || !response.body) throw new Error(t("modelDownloadFailed", response.status));
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
        if (!range || Number(range[1]) !== offset || Number(range[3]) !== file.bytes) throw new Error(t("theServerResponseDoesNotMatchTheRequested"));
      } else { offset = saved = 0; }
      reader = response.body.getReader();
      while (true) {
        resetTimeout();
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        if (offset + value.length > file.bytes) throw new Error(t("modelDownloadSizeMismatch"));
        bytes.set(value, offset);
        offset += value.length;
        progress(offset);
        while (offset - saved >= PART_BYTES || offset === file.bytes && saved < offset) {
          const end = Math.min(saved + PART_BYTES, file.bytes);
          await cache.put(partKey(file, saved / PART_BYTES), new Response(bytes.slice(saved, end), {
            headers: { "content-length": String(end - saved) }
          }));
          saved = end;
        }
      }
    }
    signal.throwIfAborted();
    if (offset !== file.bytes) throw new Error(t("modelDownloadInterruptedDownloadedDataWasKeptFor"));
    try { await storeFile(cache, file, bytes.buffer); }
    catch (error) { await deleteParts(cache, file); throw error; }
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => undefined);
  }
}

export async function removeLocalModel(id: string): Promise<void> {
  await withModelWriteLock(async () => {
    const cache = await caches.open(LOCAL_MODEL_CACHE);
    const model = getLocalModel(id);
    const ready = new Set((await localModelStates()).filter((entry) => entry.state === "ready" && entry.id !== id).map((entry) => entry.id));
    for (const file of model.files) {
      const shared = LOCAL_MODELS.some((other) => ready.has(other.id) && other.files.some((entry) => entry.sha256 === file.sha256));
      if (!shared) await cache.delete(fileKey(file));
      await deleteParts(cache, file);
    }
  });
}

export async function readLocalModel(id: string): Promise<Record<string, ArrayBuffer>> {
  const model = getLocalModel(id);
  const cache = await caches.open(LOCAL_MODEL_CACHE);
  const buffers: Record<string, ArrayBuffer> = {};
  for (const file of model.files) {
    const response = await completeFile(cache, file);
    if (!response) throw new Error(t("downloadOrImportTheModelInSettingsFirst", model.label));
    const buffer = await response.arrayBuffer();
    try { await verifyModelBytes(file, buffer); }
    catch (error) { await cache.delete(fileKey(file)); throw error; }
    buffers[file.role] = buffer;
  }
  return buffers;
}
