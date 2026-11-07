import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { createProvider } from "../src/background/providers";
import { TranslationResponseError } from "../src/background/translation-response";
import { normalizeSettings } from "../src/shared/settings";
import { isLlmProvider } from "../src/shared/performance";
import { supportsRequestTemplate } from "../src/shared/request-template";

const config = DEFAULT_SETTINGS.providers.find(p => p.type === "index-translate")!;
const request = { texts: ["Hello", "World"], sourceLang: "auto", targetLang: "zh-TW", context: "A greeting" };
const response = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
afterEach(() => vi.unstubAllGlobals());

describe("Index-Translate", () => {
  it("uses the official local bridge without credentials and disables thinking", async () => {
    const fetch = vi.fn().mockResolvedValue(response('["你好","世界"]'));
    vi.stubGlobal("fetch", fetch);
    const usage = vi.fn();
    await expect(createProvider(config).translateBatch(request, undefined, usage)).resolves.toEqual(["你好", "世界"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(init.headers).not.toHaveProperty("Authorization");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "Index-Translate-35B-A3B", stream: false, temperature: 0,
      chat_template_kwargs: { enable_thinking: false } });
    expect(body.messages[0].content).toContain("zh-TW");
    expect(JSON.parse(body.messages[1].content)).toEqual(request);
    expect(usage).toHaveBeenCalledTimes(1);
  });

  it("supports self-hosted model IDs, optional authentication and request overrides", async () => {
    const fetch = vi.fn().mockResolvedValue(response('["你好","世界"]'));
    vi.stubGlobal("fetch", fetch);
    const provider = { ...config, baseURL: "http://localhost:8000/v1/chat/completions", model: "IndexTeam/Index-Translate-9B", apiKey: "test-only",
      requestTemplate: { enabled: true, headers: '{"X-Client":"WuPage"}', body: '{"max_tokens":4096,"chat_template_kwargs":{"custom":true}}' } };
    await createProvider(provider).translateBatch(request);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(provider.baseURL);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-only");
    expect(new Headers(init.headers).get("X-Client")).toBe("WuPage");
    expect(JSON.parse(init.body)).toMatchObject({ model: provider.model, max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false, custom: true } });
  });

  it.each(['<think>private reasoning</think>\n["你好","世界"]', '</think>\n["你好","世界"]',
    'prefilled reasoning</think>\n["你好","世界"]', '```json\n["你好","世界"]\n```'])("accepts the completed translation after model wrappers", async content => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(content)));
      await expect(createProvider(config).translateBatch(request)).resolves.toEqual(["你好", "世界"]);
    }
  );

  it.each(["<think>unfinished reasoning", "<think>reasoning only</think>", '["one"]', "merged plain text", null])(
    "does not display reasoning or misaligned batches", async content => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(content)));
      await expect(createProvider(config).translateBatch(request)).rejects.toBeInstanceOf(TranslationResponseError);
    }
  );

  it("preserves literal thinking tags inside a translated JSON string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response('["<think>标签</think>","世界"]')));
    await expect(createProvider(config).translateBatch(request)).resolves.toEqual(["<think>标签</think>", "世界"]);
  });

  it("normalizes saved settings and retains the LLM recovery and template capabilities", () => {
    const saved = normalizeSettings({ activeProviderId: config.id, providers: [{ ...config, baseURL: "http://localhost:8000/v1",
      model: "my-local-model", customModels: ["my-local-model"], apiKey: "saved-key" }] });
    expect(saved.activeProviderId).toBe(config.id);
    expect(saved.providers.find(p => p.id === config.id)).toMatchObject({ type: "index-translate", model: "my-local-model", apiKey: "saved-key", concurrency: 1 });
    expect(isLlmProvider(config)).toBe(true);
    expect(supportsRequestTemplate(config)).toBe(true);
  });
});
