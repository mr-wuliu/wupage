import type { LlmRequestTemplate, ProviderConfig, TranslateBatchRequest } from "./types";

export type LlmTemplateProvider = Extract<ProviderConfig, { systemPrompt: string }>;
export type RequestTemplateContext = Record<string, string | string[]>;
type JsonObject = Record<string, unknown>;

const VARIABLES = new Set([
  "model", "apiKey", "sourceLang", "targetLang", "context", "texts", "systemPrompt", "userPrompt"
]);
const VARIABLE = /\{\{\s*(json\s+)?([a-zA-Z0-9_]+)\s*\}\}/g;
const SAMPLE_CONTEXT: RequestTemplateContext = {
  model: "model", apiKey: "", sourceLang: "en", targetLang: "zh-CN", context: "",
  texts: ["Hello world"], systemPrompt: "Translate", userPrompt: '{"texts":["Hello world"]}'
};

export class RequestTemplateError extends Error {
  constructor(readonly field: "headers" | "body", message: string) {
    super(message);
    this.name = "RequestTemplateError";
  }
}

export function supportsRequestTemplate(provider: ProviderConfig): provider is LlmTemplateProvider {
  return provider.type === "openai-compatible" || provider.type === "anthropic-compatible"
    || provider.type === "deepseek" || provider.type === "zhipu-glm";
}

export function normalizeRequestTemplate(value: unknown): LlmRequestTemplate | undefined {
  if (!isObject(value)) return undefined;
  return {
    enabled: value.enabled === true,
    headers: typeof value.headers === "string" ? value.headers : "{}",
    body: typeof value.body === "string" ? value.body : "{}"
  };
}

export function validateRequestTemplate(template: LlmRequestTemplate | undefined): void {
  if (!template?.enabled) return;
  applyRequestTemplate(template, {}, {}, SAMPLE_CONTEXT);
}

export function requestTemplateContext(
  config: LlmTemplateProvider, request: TranslateBatchRequest, systemPrompt: string
): RequestTemplateContext {
  const input = {
    sourceLang: request.sourceLang ?? "auto", targetLang: request.targetLang,
    context: request.context ?? "", texts: request.texts
  };
  return { ...input, model: config.model, apiKey: config.apiKey, systemPrompt, userPrompt: JSON.stringify(input) };
}

/** Keep the editable defaults and the generated text request in sync. Never embed credentials. */
export function defaultLlmRequestTemplate(config: LlmTemplateProvider): Pick<LlmRequestTemplate, "headers" | "body"> {
  const anthropic = config.type === "anthropic-compatible";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (anthropic) {
    headers["anthropic-version"] = "2023-06-01";
    // The extension calls the API from a browser context; Anthropic rejects such requests with 401 without this opt-in.
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  if (config.apiKey.trim()) {
    if (anthropic) headers["x-api-key"] = "{{apiKey}}";
    else headers.Authorization = "Bearer {{apiKey}}";
  }
  const body: JsonObject = {
    model: "{{model}}",
    ...(anthropic ? { max_tokens: 8192 } : {}),
    // Newer Claude models reject `temperature` with 400, so Anthropic defaults omit it.
    ...(anthropic ? {} : { temperature: 0 }),
    ...(config.type === "deepseek" ? { thinking: { type: "disabled" } } : {}),
    ...(anthropic ? { system: "{{systemPrompt}}" } : {}),
    messages: [
      ...(!anthropic ? [{ role: "system", content: "{{systemPrompt}}" }] : []),
      { role: "user", content: "{{userPrompt}}" }
    ]
  };
  return { headers: JSON.stringify(headers, null, 2), body: JSON.stringify(body, null, 2) };
}

export function defaultLlmRequest(
  config: LlmTemplateProvider, context: RequestTemplateContext
): { headers: Record<string, string>; body: JsonObject } {
  const template = defaultLlmRequestTemplate(config);
  return {
    headers: renderObject(template.headers, context, "headers") as Record<string, string>,
    body: renderObject(template.body, context, "body")
  };
}

/** Parse before substitution so quotes, newlines and input text cannot become JSON syntax. */
function renderObject(template: string, context: RequestTemplateContext, field: "headers" | "body"): JsonObject {
  const label = field === "headers" ? "请求头模板" : "请求体参数模板";
  let parsed: unknown;
  try {
    parsed = JSON.parse(template.trim() || "{}");
  } catch {
    throw new RequestTemplateError(field, `${label}必须是有效的 JSON，请检查引号、逗号和括号。`);
  }
  if (!isObject(parsed)) throw new RequestTemplateError(field, `${label}必须是 JSON 对象。`);

  const render = (value: unknown): unknown => {
    if (typeof value === "string") {
      const tokenValue = (asJson: string | undefined, key: string): string | string[] => {
        if (!VARIABLES.has(key)) throw new RequestTemplateError(field, `${label}包含未知变量：${key}。`);
        const entry = context[key] ?? "";
        return asJson ? JSON.stringify(entry) : entry;
      };
      const exact = /^\{\{\s*(json\s+)?([a-zA-Z0-9_]+)\s*\}\}$/.exec(value);
      if (exact) return tokenValue(exact[1], exact[2]);
      return value.replace(VARIABLE, (_, asJson, key) => {
        const entry = tokenValue(asJson, key);
        return Array.isArray(entry) ? entry.join("\n") : entry;
      });
    }
    if (Array.isArray(value)) return value.map(render);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, render(entry)]));
    return value;
  };
  return render(parsed) as JsonObject;
}

/** Objects merge recursively, arrays/scalars replace, and null removes a member. */
function mergePatch(base: JsonObject, patch: JsonObject): JsonObject {
  const result = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) result.delete(key);
    else {
      const previous = result.get(key);
      result.set(key, isObject(value) ? mergePatch(isObject(previous) ? previous : {}, value) : value);
    }
  }
  return Object.fromEntries(result);
}

export function applyRequestTemplate(
  template: LlmRequestTemplate | undefined,
  defaultHeaders: Record<string, string>,
  defaultBody: JsonObject,
  context: RequestTemplateContext
): { headers: Record<string, string>; body: JsonObject } {
  if (!template?.enabled) return { headers: defaultHeaders, body: defaultBody };
  const headerPatch = renderObject(template.headers, context, "headers");
  const headers = new Headers(defaultHeaders);
  for (const [name, value] of Object.entries(headerPatch)) {
    if (value !== null && typeof value !== "string") {
      throw new RequestTemplateError("headers", "请求头的值必须是字符串或 null。");
    }
    try {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    } catch {
      throw new RequestTemplateError("headers", "请求头名称或内容无效，请检查名称及换行等特殊字符。");
    }
  }
  const body = mergePatch(defaultBody, renderObject(template.body, context, "body"));
  if (body.stream !== undefined && body.stream !== false) {
    throw new RequestTemplateError("body", "当前仅支持非流式响应，请将 stream 设为 false 或用 null 删除该字段。");
  }
  return { headers: Object.fromEntries(headers.entries()), body };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
