import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { createSettingsBackup, parseSettingsBackup, serializeSettingsBackup } from "../src/shared/settings-backup";
import { createProvider } from "../src/background/providers";

afterEach(() => vi.unstubAllGlobals());
const request = { texts: ["Hello"], sourceLang: "en", targetLang: "zh-CN" };

it("a restored keyless LLM request carries neither a dedicated key nor arbitrary template credentials", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.providers.find(p => p.type === "openai-compatible")!, {
    apiKey: "dedicated-secret", systemPrompt: "prompt-secret", ollamaCompatibility: false,
    requestTemplate: { enabled: true, headers: '{"Unusual-Auth": "header-secret"}', body: '{"private":{"opaque":"body-secret"}}' }
  });
  const file = createSettingsBackup(settings, "1.6.1");
  const restored = parseSettingsBackup(serializeSettingsBackup(file)).settings;
  const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: '["你好"]' } }] }));
  vi.stubGlobal("fetch", fetch);
  await expect(createProvider(restored.providers.find(p => p.type === "openai-compatible")!).translateBatch(request)).resolves.toEqual(["你好"]);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.openai.com/v1/chat/completions");
  expect(new Headers(init.headers).get("Authorization")).toBeNull();
  const wire = [url, ...[...new Headers(init.headers)].flat(), String(init.body)].join("\n");
  expect(wire).not.toMatch(/dedicated-secret|prompt-secret|header-secret|body-secret/);
});

it.each(["json", "form", "opaque"])("a restored HTTP %s template cannot send credentials from its original headers, URL or body", async dialect => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const body = { json: '{"opaque":"http-body-secret","q":{{json texts}}}',
    form: "anything=http-body-secret&q={{texts}}", opaque: "http-body-secret {{json texts}}" }[dialect]!;
  settings.providers.push({ type: "http-template", id: "custom-secret", label: "Custom", method: "POST",
    url: "https://user:url-password@example.com/token-in-path?anything=query-secret", headers: { "Unknown-Header": "short" },
    bodyTemplate: body, responsePath: "translations" });
  const file = createSettingsBackup(settings, "1.6.1");
  expect(serializeSettingsBackup(file)).not.toMatch(/url-password|token-in-path|query-secret|http-body-secret|Unknown-Header/);
  const restored = parseSettingsBackup(serializeSettingsBackup(file)).settings;
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(createProvider(restored.providers.find(p => p.id === "custom-secret")!).translateBatch(request)).rejects.toThrow("URL is required");
  expect(fetch).not.toHaveBeenCalled();
});
