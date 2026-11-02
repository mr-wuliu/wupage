import { anySignal } from "../shared/abort";
import { DICTIONARY_LABELS, dictionaryProviderForQuery, isChineseDictionaryQuery, isDictionaryAudioUrl, normalizeDictionaryQuery, type DictionaryEntry, type DictionaryProvider } from "../shared/dictionary";
import type { RuntimeResponse } from "../shared/types";
import { parseYoudaoDictionary } from "../dictionary/parsers";
import { ensureOffscreenDocument } from "./offscreen";

const lookups = new Map<string, Promise<DictionaryEntry>>();
let playback: { id: string; owner: string; controller: AbortController; runtimeStarted: boolean } | undefined;

async function runtimeRequest<T>(message: Record<string, unknown>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage({ target: "dictionary-runtime", ...message }) as Promise<RuntimeResponse | undefined>,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("词典处理超时，请重试。")), 12_000); })
    ]);
    if (!response) throw new Error("词典运行环境未就绪，请重试。");
    if (!response.ok) throw new Error(response.error);
    return response.data as T;
  } finally { clearTimeout(timeout); }
}

async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 429 ? "词典请求过于频繁，请稍后重试。" : `词典服务暂时不可用（${response.status}），请稍后重试或切换词典。`);
  }
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("词典响应过大，请重试。");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("词典返回了空响应。");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("词典响应过大，请重试。");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function checkProvider(provider: unknown): asserts provider is DictionaryProvider {
  if (provider !== "youdao" && provider !== "bing") throw new Error("请选择有道或 Bing 词典。");
}

export function lookupDictionary(provider: DictionaryProvider, input: string): Promise<DictionaryEntry> {
  checkProvider(provider);
  const query = normalizeDictionaryQuery(input);
  if (!query) throw new Error("请选择不超过 100 个字符的单词或短语。");
  provider = dictionaryProviderForQuery(provider, query);
  const key = `${provider}:${query}`;
  const existing = lookups.get(key);
  if (existing) return existing;
  // Only coalesce concurrent requests. Dictionary results are not persisted in the translation cache.
  const task = queryDictionary(provider, query).finally(() => { lookups.delete(key); });
  lookups.set(key, task);
  return task;
}

async function queryDictionary(provider: DictionaryProvider, query: string): Promise<DictionaryEntry> {
  const url = new URL(provider === "youdao" ? "https://dict.youdao.com/jsonapi" : "https://cn.bing.com/dict/search");
  url.searchParams.set("q", query);
  if (provider === "youdao") {
    url.searchParams.set("jsonversion", "2");
    const chinese = isChineseDictionaryQuery(query);
    url.searchParams.set("dicts", JSON.stringify({ count: 3, dicts: [chinese ? ["newhh", "ce", "simple"] : ["ec", "ce", "simple"]] }));
    if (chinese) url.searchParams.set("le", "zh");
  }
  try {
    const response = await fetch(url.href, { signal: AbortSignal.timeout(10_000), credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    const body = new TextDecoder().decode(await readBytes(response, 2_000_000));
    if (provider === "youdao") {
      let data: unknown;
      try { data = JSON.parse(body); } catch { throw new Error("有道词典返回了无法识别的数据，请稍后重试。"); }
      return parseYoudaoDictionary(data, query);
    }
    await ensureOffscreenDocument();
    return await runtimeRequest<DictionaryEntry>({ action: "parse-bing", html: body, query });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error(`${DICTIONARY_LABELS[provider]}查询超时，请重试。`);
    if (error instanceof TypeError) throw new Error(`${DICTIONARY_LABELS[provider]}连接失败，请检查网络或切换词典。`);
    throw error;
  }
}

export async function stopDictionaryAudio(owner: string): Promise<void> {
  const current = playback;
  if (!current || current.owner !== owner) return;
  playback = undefined;
  current.controller.abort();
  if (current.runtimeStarted) await runtimeRequest({ action: "stop", id: current.id }).catch(() => undefined);
}

export async function playDictionaryAudio(provider: DictionaryProvider, url: string, owner: string): Promise<void> {
  checkProvider(provider);
  if (!isDictionaryAudioUrl(provider, url)) throw new Error("词典发音地址无效。");
  const previous = playback;
  const current = { id: crypto.randomUUID(), owner, controller: new AbortController(), runtimeStarted: false };
  playback = current;
  try {
    previous?.controller.abort();
    if (previous?.runtimeStarted) await runtimeRequest({ action: "stop", id: previous.id }).catch(() => undefined);
    if (playback !== current) return;
    const response = await fetch(url, { signal: anySignal([current.controller.signal, AbortSignal.timeout(10_000)]), credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (response.ok && !["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg"].includes(type ?? "")) {
      await response.body?.cancel();
      throw new Error("词典未返回有效发音，请稍后重试。");
    }
    const bytes = await readBytes(response, 2_000_000);
    if (!bytes.length) throw new Error("词典发音为空，请重试。");
    if (playback !== current) return;
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await ensureOffscreenDocument();
    if (playback !== current) return;
    current.runtimeStarted = true;
    await runtimeRequest({ action: "play", id: current.id, dataUrl: `data:${type};base64,${btoa(binary)}` });
  } catch (error) {
    if (playback !== current || current.controller.signal.aborted) return;
    await stopDictionaryAudio(owner);
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("发音加载超时，请重试。");
    if (error instanceof TypeError) throw new Error("发音加载失败，请检查网络后重试。");
    throw error;
  }
}
