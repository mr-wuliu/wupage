import type { DoubaoStatus, DoubaoStatusState, DoubaoWebConfig, TranslateBatchRequest, TranslatorProvider, ValidationResult } from "../shared/types";
import { ProviderError } from "../shared/errors";
import { DOUBAO_TARGET_LANGUAGES, isDoubaoBrowserSupported } from "../shared/doubao";
import { DoubaoSseParser, doubaoServiceError } from "./doubao-sse";
import { segmentDoubaoTexts, groupDoubaoSegments, reassembleDoubaoSegments } from "./doubao-segmentation";
import { DOUBAO_LAUNCH_ENDPOINT, DOUBAO_TRANSLATE_ENDPOINT, withDoubaoCompatibility } from "./doubao-compatibility";

const DEVICE_KEY = "wupage.doubao.device";
const TASK_TIMEOUT_MS = 110_000;
const REQUEST_TIMEOUT_MS = 60_000;
const HEADERS_TIMEOUT_MS = 25_000;
const IDLE_TIMEOUT_MS = 20_000;
const MIN_REQUEST_INTERVAL_MS = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_COOLDOWN_MS = 60_000;

interface SessionConfig { deviceId: string; country: string }
interface Initialization {
  controller: AbortController;
  promise: Promise<number>;
  users: number;
}
interface QueueEntry {
  signal: AbortSignal;
  probe: boolean;
  execute: () => Promise<void>;
  reject: (error: unknown) => void;
  onAbort: () => void;
  started: boolean;
}

let session: SessionConfig | undefined;
let initialization: Initialization | undefined;
let devicePromise: Promise<string> | undefined;
let tabId: string | undefined;
let status: DoubaoStatus = { state: "unknown" };
let blockingFailure: ProviderError | undefined;
let failureGeneration = 0;
const taskGenerations = new WeakMap<AbortSignal, number>();
const reportedErrors = new WeakSet<ProviderError>();
let retryAt = 0;
let checkPromise: Promise<DoubaoStatus> | undefined;
let draining = false;
let lastRequestStartedAt: number | undefined;
const queue: QueueEntry[] = [];

class TransientNetworkError extends ProviderError {
  constructor() { super("豆包网络请求失败，请稍后重试。", "network-error"); }
}

function timeoutError(message = "豆包翻译超时，请稍后重试。"): ProviderError {
  return new ProviderError(message, "timeout");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ProviderError("豆包请求已取消。", "cancelled");
  }
  return new TransientNetworkError();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The operation may already have started (for example reader.read()).
    // Observe its rejection even when the caller no longer waits for it.
    void promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", onAbort); resolve(); };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The caller's deadline also owns waits and all later protected-text retries. */
export async function withDoubaoDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  // Capture before the shared provider/global queues. A failed generation must
  // never be revived by a later, successful user-initiated translation.
  taskGenerations.set(controller.signal, parent ? taskGeneration(parent) : failureGeneration);
  const onAbort = () => controller.abort(parent && abortReason(parent));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError("豆包任务超过 110 秒，请重试未完成的内容。")), TASK_TIMEOUT_MS);
  try {
    throwIfAborted(controller.signal);
    return await abortable(Promise.resolve().then(() => {
      throwIfAborted(controller.signal);
      return operation(controller.signal);
    }), controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}

const ERROR_STATES = new Set<DoubaoStatusState>([
  "login-required", "rate-limited", "service-rejected", "permission-required",
  "network-error", "timeout", "protocol-changed", "incomplete", "unsupported-browser", "unsupported-language"
]);

function updateErrorStatus(error: ProviderError, checking = false): void {
  // One failed request can reject several callers. Their late catches must not
  // replace a newer successful connection result with the same old failure.
  if (reportedErrors.has(error) && !(checking && status.state === "checking")) return;
  reportedErrors.add(error);
  status = {
    state: ERROR_STATES.has(error.errorCode as DoubaoStatusState) ? error.errorCode as DoubaoStatusState : "network-error",
    message: error.message,
    checkedAt: Date.now(),
    ...(retryAt > Date.now() ? { retryAt } : {})
  };
}

function taskGeneration(signal: AbortSignal): number {
  const existing = taskGenerations.get(signal);
  if (existing !== undefined) return existing;
  taskGenerations.set(signal, failureGeneration);
  return failureGeneration;
}

function assertAllowed(probe: boolean, signal: AbortSignal): void {
  if (retryAt > Date.now()) {
    const error = new ProviderError("豆包请求受限，请等待后重试翻译或重新检测。", "rate-limited", retryAt - Date.now());
    reportedErrors.add(error);
    throw error;
  }
  // Reject work that was already waiting when the service failed. A NEW
  // top-level task can prepare a fresh session and try normally; opening the
  // settings page is not a prerequisite for recovery.
  if (!probe && blockingFailure && taskGeneration(signal) < failureGeneration) {
    const error = new ProviderError(blockingFailure.message, blockingFailure.errorCode,
      blockingFailure.errorCode === "rate-limited" ? Math.max(0, retryAt - Date.now()) : undefined);
    reportedErrors.add(error);
    throw error;
  }
}

function recordRequestFailure(error: ProviderError): void {
  if (reportedErrors.has(error)) return;
  if (error.errorCode === "login-required" || error.errorCode === "service-rejected" || error.errorCode === "rate-limited") {
    blockingFailure = error;
    failureGeneration++;
    if (error.errorCode !== "rate-limited") session = undefined;
    if (error.errorCode === "rate-limited") {
      retryAt = Date.now() + Math.max(DEFAULT_COOLDOWN_MS, error.retryAfterMs ?? 0);
    }
    // Do not retain ordinary work for an automatic replay after login/cooldown.
    for (const entry of [...queue]) {
      if (entry.probe && error.errorCode !== "rate-limited") continue;
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.reject(error);
    }
  }
  updateErrorStatus(error);
}

function enqueue<T>(probe: boolean, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  throwIfAborted(signal);
  assertAllowed(probe, signal);
  return new Promise<T>((resolve, reject) => {
    const entry: QueueEntry = {
      signal, probe, reject, started: false,
      execute: async () => { resolve(await operation()); },
      onAbort: () => {
        if (entry.started) return;
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
        signal.removeEventListener("abort", entry.onAbort);
        reject(abortReason(signal));
      }
    };
    signal.addEventListener("abort", entry.onAbort, { once: true });
    queue.push(entry);
    void drain();
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const entry = queue.shift()!;
      entry.started = true;
      try {
        throwIfAborted(entry.signal);
        assertAllowed(entry.probe, entry.signal);
        await entry.execute();
      } catch (error) {
        entry.reject(error);
      } finally {
        entry.signal.removeEventListener("abort", entry.onAbort);
      }
    }
  } finally {
    draining = false;
  }
}

async function deviceId(): Promise<string> {
  if (!devicePromise) {
    devicePromise = (async () => {
      try {
        const stored = (await chrome.storage.local.get(DEVICE_KEY))[DEVICE_KEY];
        if (typeof stored === "string" && /^\d{18}$/.test(stored)) return stored;
        const random = crypto.getRandomValues(new Uint32Array(2));
        const value = [random[0], random[1]].map((part) => String(100_000_000 + part % 900_000_000)).join("");
        await chrome.storage.local.set({ [DEVICE_KEY]: value });
        return value;
      } catch {
        devicePromise = undefined;
        throw new ProviderError("无法保存豆包设备配置，请检查扩展存储权限。", "permission-required");
      }
    })();
  }
  return devicePromise;
}

async function queryParameters(): Promise<URLSearchParams> {
  const localDeviceId = await deviceId();
  tabId ??= crypto.randomUUID();
  return new URLSearchParams({
    language: "zh",
    browser_language: typeof navigator !== "undefined" ? navigator.language : "zh-CN",
    device_platform: "web",
    aid: "586864",
    real_aid: "586864",
    pkg_type: "release_version",
    device_id: session?.deviceId ?? "0",
    tea_uuid: localDeviceId,
    web_id: localDeviceId,
    is_new_user: "0",
    region: session?.country ?? "",
    sys_region: session?.country ?? "",
    "use-olympus-account": "1",
    samantha_web: "1",
    version: "1.38.0",
    pc_version: "1.38.0",
    version_code: "20800",
    web_tab_id: tabId
  });
}

function retryAfter(response: Response): number {
  const value = response.headers.get("Retry-After");
  if (!value) return DEFAULT_COOLDOWN_MS;
  const numeric = Number(value);
  const ms = Number.isFinite(numeric) && numeric >= 0 ? numeric * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 && ms <= Number.MAX_SAFE_INTEGER - Date.now()
    ? Math.max(DEFAULT_COOLDOWN_MS, ms)
    : DEFAULT_COOLDOWN_MS;
}

function httpError(response: Response): ProviderError {
  if (response.status === 401) return new ProviderError("请先在同一浏览器登录豆包，再重试翻译或重新检测。", "login-required");
  if (response.status === 429) return new ProviderError("豆包请求受限，请等待后重试翻译或重新检测。", "rate-limited", retryAfter(response));
  if (response.status >= 500) return new TransientNetworkError();
  if (response.status === 408) return timeoutError();
  return new ProviderError(`豆包拒绝了请求（HTTP ${response.status}），请到豆包网页检查后重试翻译或重新检测。`, "service-rejected");
}

async function consumeBody(
  response: Response,
  controller: AbortController,
  onText: (text: string) => boolean | void
): Promise<void> {
  if (!response.body) throw new ProviderError("豆包返回了空响应。", "protocol-changed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    for (;;) {
      const idle = setTimeout(() => controller.abort(timeoutError("豆包响应中断，请稍后重试。")), IDLE_TIMEOUT_MS);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await abortable(reader.read(), controller.signal);
      } finally {
        clearTimeout(idle);
      }
      if (chunk.done) {
        onText(decoder.decode());
        return;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ProviderError("豆包响应过大，已停止读取。", "protocol-changed");
      if (onText(decoder.decode(chunk.value, { stream: true }))) return;
    }
  } catch (error) {
    if (error instanceof TypeError && /encoded data|encoding/i.test(error.message)) {
      throw new ProviderError("豆包响应编码无效。", "protocol-changed");
    }
    throw error;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readJson(response: Response, controller: AbortController): Promise<Record<string, unknown>> {
  let text = "";
  await consumeBody(response, controller, (chunk) => { text += chunk; });
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ProviderError("豆包返回了无法识别的响应，请到官网检查后重新检测。", "protocol-changed");
  }
}

async function physicalRequest<T>(
  endpoint: string,
  body: unknown,
  probe: boolean,
  signal: AbortSignal,
  consume: (response: Response, controller: AbortController) => Promise<T>
): Promise<T> {
  return enqueue(probe, signal, async () => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const total = setTimeout(() => controller.abort(timeoutError()), REQUEST_TIMEOUT_MS);
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await withDoubaoCompatibility(endpoint, async () => {
        const parameters = await abortable(queryParameters(), controller.signal);
        await delay(lastRequestStartedAt === undefined ? 0 : lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS - Date.now(), controller.signal);
        throwIfAborted(controller.signal);
        assertAllowed(probe, signal);
        lastRequestStartedAt = Date.now();
        headersTimer = setTimeout(() => controller.abort(timeoutError("豆包未及时响应，请稍后重试。")), HEADERS_TIMEOUT_MS);
        const response = await abortable(fetch(`${endpoint}?${parameters}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: endpoint === DOUBAO_TRANSLATE_ENDPOINT ? "text/event-stream" : "application/json",
            ...(endpoint === DOUBAO_LAUNCH_ENDPOINT ? { "Agw-Js-Conv": "str" } : {})
          },
          credentials: "include",
          redirect: "error",
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal
        }), controller.signal);
        clearTimeout(headersTimer);
        if (response.redirected || (response.url && new URL(response.url).origin + new URL(response.url).pathname !== endpoint)) {
          throw new ProviderError("豆包请求被重定向，已停止发送登录态请求。", "service-rejected");
        }
        if (!response.ok) throw httpError(response);
        return await consume(response, controller);
      }, controller.signal);
    } catch (error) {
      const normalized = asProviderError(controller.signal.aborted ? abortReason(controller.signal) : error);
      recordRequestFailure(normalized);
      throw normalized;
    } finally {
      clearTimeout(total);
      clearTimeout(headersTimer);
      signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  });
}

async function ensureSession(signal: AbortSignal, probe: boolean): Promise<number> {
  if (session) return 0;
  // The previous last waiter may have aborted before the shared Promise's
  // finally handler ran. A fresh request must not join that doomed operation.
  if (initialization?.controller.signal.aborted) initialization = undefined;
  if (!initialization) {
    const entry: Initialization = { controller: new AbortController(), users: 0, promise: Promise.resolve(0) };
    initialization = entry;
    entry.promise = withDoubaoDeadline(async (initSignal) => {
      let retries = 0;
      let payload: Record<string, unknown>;
      try {
        payload = await physicalRequest(DOUBAO_LAUNCH_ENDPOINT, undefined, probe, initSignal, readJson);
      } catch (error) {
        if (!(error instanceof TransientNetworkError) || initSignal.aborted) throw error;
        retries = 1;
        await delay(MIN_REQUEST_INTERVAL_MS, initSignal);
        payload = await physicalRequest(DOUBAO_LAUNCH_ENDPOINT, undefined, probe, initSignal, readJson);
      }
      throwIfAborted(initSignal);
      if (payload.code !== 0) throw doubaoServiceError(payload.code);
      const data = payload.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new ProviderError("豆包初始化响应无效。", "protocol-changed");
      }
      const { config, country } = data as Record<string, unknown>;
      const details = config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : {};
      const serverDeviceId = typeof details.web_id === "string" || typeof details.web_id === "number" ? String(details.web_id) : "";
      if (details.ttwid && !serverDeviceId) throw new ProviderError("豆包初始化缺少设备信息。", "protocol-changed");
      session = { deviceId: details.ttwid ? serverDeviceId : "0", country: typeof country === "string" ? country : "" };
      return retries;
    }, entry.controller.signal).catch((error) => {
      const normalized = asProviderError(error);
      recordRequestFailure(normalized);
      throw normalized;
    }).finally(() => {
      if (initialization === entry) initialization = undefined;
    });
    void entry.promise.catch(() => undefined);
  }
  const entry = initialization;
  entry.users++;
  try {
    return await abortable(entry.promise, signal);
  } finally {
    entry.users--;
    if (!entry.users && initialization === entry) {
      entry.controller.abort(signal.aborted ? abortReason(signal) : new DOMException("Aborted", "AbortError"));
    }
  }
}

async function article(
  sources: string[],
  target: string,
  signal: AbortSignal,
  probe: boolean
): Promise<Array<string | undefined>> {
  return physicalRequest(DOUBAO_TRANSLATE_ENDPOINT, {
    // The article protocol detects the source language itself and accepts only
    // the target. Do not require a separate local detection before this call.
    raw_text: sources, target_lang: target, translate_service: "1"
  }, probe, signal, async (response, controller) => {
    if (!/^text\/event-stream\b/i.test(response.headers.get("Content-Type") ?? "")) {
      const payload = await readJson(response, controller);
      if (payload.code !== undefined && payload.code !== 0) throw doubaoServiceError(payload.code);
      throw new ProviderError("豆包文章接口未返回翻译流。", "protocol-changed");
    }
    const parser = new DoubaoSseParser(sources, target);
    await consumeBody(response, controller, (chunk) => {
      parser.push(chunk);
      return parser.done;
    });
    const translations = parser.finish();
    if (translations.every((value) => value !== undefined)) {
      throwIfAborted(controller.signal);
      // Commit health while still owning the physical queue slot. A later
      // response must win over an earlier caller's Promise continuation.
      retryAt = 0;
      status = { state: "ready", checkedAt: Date.now(), message: "可以翻译" };
    }
    return translations;
  });
}

async function translateTexts(request: TranslateBatchRequest, signal: AbortSignal, probe: boolean): Promise<string[]> {
  throwIfAborted(signal);
  taskGeneration(signal);
  if (!request.texts.length) return [];
  if (!isDoubaoBrowserSupported()) {
    throw new ProviderError("豆包（实验性）目前仅支持 Chromium 浏览器，Firefox 尚未支持。", "unsupported-browser");
  }
  const target = Object.prototype.hasOwnProperty.call(DOUBAO_TARGET_LANGUAGES, request.targetLang)
    ? DOUBAO_TARGET_LANGUAGES[request.targetLang] : undefined;
  if (!target) throw new ProviderError("豆包暂不支持所选目标语言，请选择列表中的语言。", "unsupported-language");
  assertAllowed(probe, signal);
  const segments = segmentDoubaoTexts(request.texts);
  const groups = groupDoubaoSegments(segments);
  if (!groups.length) return reassembleDoubaoSegments(request.texts.length, segments, new Map());
  const initializationRetries = await ensureSession(signal, probe);
  const translated = new Map<number, string>();
  let additionalAttempts = 1 - initializationRetries;
  for (const group of groups) {
    let missing = group;
    for (;;) {
      throwIfAborted(signal);
      let values: Array<string | undefined>;
      try {
        values = await article(missing.map((index) => segments[index].text), target, signal, probe);
      } catch (error) {
        if (!(error instanceof TransientNetworkError) || additionalAttempts === 0 || signal.aborted) throw error;
        additionalAttempts--;
        await delay(MIN_REQUEST_INTERVAL_MS, signal);
        continue;
      }
      for (let index = 0; index < missing.length; index++) {
        const value = values[index];
        if (value !== undefined) translated.set(missing[index], value);
      }
      missing = missing.filter((index) => !translated.has(index));
      if (!missing.length) break;
      if (additionalAttempts === 0) throw new ProviderError("豆包返回的段落不完整，请重试未完成内容。", "incomplete");
      additionalAttempts--;
    }
  }
  throwIfAborted(signal);
  return reassembleDoubaoSegments(request.texts.length, segments, translated);
}

export class DoubaoProvider implements TranslatorProvider {
  constructor(private readonly config: DoubaoWebConfig) {}
  get id(): string { return this.config.id; }
  get label(): string { return this.config.label; }
  validateConfig(): ValidationResult {
    return isDoubaoBrowserSupported()
      ? { ok: true }
      : { ok: false, message: "豆包（实验性）目前仅支持 Chromium 浏览器，Firefox 尚未支持。" };
  }
  async translateBatch(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
    try {
      const result = signal ? await translateTexts(request, signal, false)
        : await withDoubaoDeadline((deadline) => translateTexts(request, deadline, false));
      return result;
    } catch (error) {
      const normalized = asProviderError(error);
      updateErrorStatus(normalized);
      throw normalized;
    }
  }
}

export function getDoubaoStatus(): DoubaoStatus {
  if (!isDoubaoBrowserSupported()) {
    return { state: "unsupported-browser", message: "豆包（实验性）目前仅支持 Chromium 浏览器，Firefox 尚未支持。" };
  }
  return { ...status };
}

/** Optional diagnostic; normal new translation tasks can also refresh a failed session. */
export function checkDoubao(): Promise<DoubaoStatus> {
  if (checkPromise) return checkPromise;
  status = { state: "checking", message: "正在检测豆包翻译…" };
  checkPromise = withDoubaoDeadline(async (signal) => {
    const result = await translateTexts({ texts: ["Hello world"], targetLang: "zh-CN", sourceLang: "en" }, signal, true);
    if (result.length !== 1 || !result[0]?.trim()) throw new ProviderError("豆包检测未返回有效译文。", "incomplete");
    return getDoubaoStatus();
  }).catch((error) => {
    const normalized = asProviderError(error);
    updateErrorStatus(normalized, true);
    return getDoubaoStatus();
  }).finally(() => { checkPromise = undefined; });
  return checkPromise;
}
