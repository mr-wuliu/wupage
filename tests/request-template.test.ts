import { describe, expect, it } from "vitest";
import { applyRequestTemplate, defaultLlmRequest, defaultLlmRequestTemplate, normalizeRequestTemplate, requestTemplateContext, validateRequestTemplate } from "../src/shared/request-template";
import type { LlmRequestTemplate, OpenAICompatibleConfig } from "../src/shared/types";

const config: OpenAICompatibleConfig = {
  type: "openai-compatible", id: "custom", label: "Custom", baseURL: "https://example.com/v1",
  apiKey: "test-key", model: "test-model", systemPrompt: "Translate", ollamaCompatibility: false
};
const context = requestTemplateContext(config, {
  texts: ['A "quote"\nBackslash: \\ and {{targetLang}}', "第二段"], sourceLang: "en", targetLang: "zh-CN", context: "Page context"
}, "Translate to zh-CN");
const defaultHeaders = { Authorization: "Bearer default", "Content-Type": "application/json" };
const defaultBody = { model: "default", temperature: 0, thinking: { type: "disabled", budget: 100 }, messages: [{ role: "user", content: "default" }] };
const template = (body = "{}", headers = "{}"): LlmRequestTemplate => ({ enabled: true, headers, body });

describe("LLM request templates", () => {
  it.each(["openai-compatible", "deepseek", "zhipu-glm", "anthropic-compatible"] as const)(
    "exposes %s defaults using the same template as the runtime request", type => {
      const provider = { ...config, type };
      const defaults = defaultLlmRequestTemplate(provider);
      expect(defaults.headers).not.toContain(config.apiKey);
      expect(defaults.body).not.toContain(config.model);
      expect(JSON.parse(defaults.headers)).toMatchObject(type === "anthropic-compatible"
        ? { "x-api-key": "{{apiKey}}", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }
        : { Authorization: "Bearer {{apiKey}}" });
      const body = JSON.parse(defaults.body);
      expect(body).toMatchObject({ model: "{{model}}" });
      if (type === "anthropic-compatible") expect(body).not.toHaveProperty("temperature");
      else expect(body).toHaveProperty("temperature", 0);
      if (type === "deepseek") expect(body.thinking).toEqual({ type: "disabled" });
      else expect(body).not.toHaveProperty("thinking");
      if (type === "anthropic-compatible") {
        expect(body).toMatchObject({ max_tokens: 8192, system: "{{systemPrompt}}" });
        expect(body.messages).toEqual([{ role: "user", content: "{{userPrompt}}" }]);
      } else {
        expect(body.messages).toEqual([
          { role: "system", content: "{{systemPrompt}}" }, { role: "user", content: "{{userPrompt}}" }
        ]);
      }
      const generated = defaultLlmRequest(provider, context);
      expect(generated.body.model).toBe(config.model);
      expect(generated.body.messages).toEqual(type === "anthropic-compatible"
        ? [{ role: "user", content: context.userPrompt }]
        : [{ role: "system", content: context.systemPrompt }, { role: "user", content: context.userPrompt }]);
      const loaded = applyRequestTemplate({ ...defaults, enabled: true }, generated.headers, generated.body, context);
      expect(loaded.body).toEqual(generated.body);
      expect(new Headers(loaded.headers)).toEqual(new Headers(generated.headers));
    }
  );

  it.each(["openai-compatible", "anthropic-compatible"] as const)("omits unused authentication headers from %s defaults", type => {
    expect(JSON.parse(defaultLlmRequestTemplate({ ...config, type, apiKey: "" }).headers))
      .toEqual(type === "anthropic-compatible" ? {
        "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"
      }
        : { "Content-Type": "application/json" });
  });

  it("leaves legacy and disabled configurations unchanged", () => {
    for (const value of [undefined, { enabled: false, headers: "invalid", body: "invalid" }]) {
      const result = applyRequestTemplate(value, defaultHeaders, defaultBody, context);
      expect(result.headers).toBe(defaultHeaders);
      expect(result.body).toBe(defaultBody);
      expect(() => validateRequestTemplate(value)).not.toThrow();
    }
  });

  it("adds session headers and replaces or removes default headers without case sensitivity", () => {
    const result = applyRequestTemplate(template("{}", JSON.stringify({
      "x-opencode-session": "wupage", authorization: "Token {{apiKey}}", "CONTENT-TYPE": null
    })), defaultHeaders, defaultBody, context);
    const headers = new Headers(result.headers);
    expect(headers.get("x-opencode-session")).toBe("wupage");
    expect(headers.get("authorization")).toBe("Token test-key");
    expect(headers.has("content-type")).toBe(false);
    expect([...headers.keys()]).toHaveLength(2);
    expect(defaultHeaders.Authorization).toBe("Bearer default");
  });

  it("merges nested thinking options, replaces arrays and removes unsupported fields", () => {
    const result = applyRequestTemplate(template(JSON.stringify({
      temperature: null, thinking: { type: "enabled" }, enable_thinking: false,
      messages: [{ role: "user", content: "{{userPrompt}}" }], options: { think: false }, stream: false
    })), defaultHeaders, defaultBody, context);
    expect(result.body).toEqual({
      model: "default", thinking: { type: "enabled", budget: 100 }, enable_thinking: false,
      messages: [{ role: "user", content: context.userPrompt }], options: { think: false }, stream: false
    });
    expect(defaultBody.thinking.type).toBe("disabled");
    expect(defaultBody.temperature).toBe(0);
  });

  it("renders typed arrays and escaped strings without interpreting placeholders from source text", () => {
    const result = applyRequestTemplate(template(JSON.stringify({
      model: "{{model}}", texts: "{{texts}}", encoded: "{{json texts}}",
      system: "{{systemPrompt}}", user: "{{userPrompt}}",
      prompt: "From {{sourceLang}} to {{targetLang}}: {{texts}}\n{{context}}"
    })), {}, {}, context);
    expect(result.body.texts).toEqual(context.texts);
    expect(JSON.parse(result.body.encoded as string)).toEqual(context.texts);
    expect(JSON.parse(result.body.user as string)).toMatchObject({ texts: context.texts });
    expect(result.body.prompt).toBe(`From en to zh-CN: ${(context.texts as string[]).join("\n")}\nPage context`);
    expect(result.body).toMatchObject({ model: "test-model", system: "Translate to zh-CN" });
    expect(JSON.parse(JSON.stringify(result.body))).toEqual(result.body);
  });

  it.each(["", "  ", "{}"])("accepts empty overrides: %j", body => {
    expect(applyRequestTemplate(template(body, body), defaultHeaders, defaultBody, context).body).toEqual(defaultBody);
  });

  it.each([
    ["body", "not json", "有效的 JSON"], ["body", "[]", "JSON 对象"], ["body", "null", "JSON 对象"],
    ["headers", '{"bad":true}', "字符串或 null"], ["headers", '{"bad name":"x"}', "名称或内容无效"],
    ["headers", '{"x-test":"a\\nb"}', "名称或内容无效"], ["headers", '{"x-test":"{{texts}}"}', "字符串或 null"],
    ["body", '{"a":"{{unknown}}"}', "未知变量"], ["body", '{"stream":true}', "非流式"],
    ["body", '{"stream":"false"}', "非流式"]
  ])("rejects invalid %s before any network request: %s", (field, value, message) => {
    expect(() => validateRequestTemplate({ ...template(), [field]: value })).toThrow(message);
  });

  it("safely treats prototype-like JSON keys as data", () => {
    const result = applyRequestTemplate(template('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}'), {}, {}, context);
    expect(Object.getPrototypeOf(result.body)).toBe(Object.prototype);
    expect(Object.hasOwn(result.body, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("normalizes partial saved templates without dropping the provider", () => {
    expect(normalizeRequestTemplate(undefined)).toBeUndefined();
    expect(normalizeRequestTemplate([])).toBeUndefined();
    expect(normalizeRequestTemplate({ enabled: true, headers: 1 })).toEqual(template());
  });
});
