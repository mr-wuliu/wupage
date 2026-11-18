import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { createSettingsBackup, parseSettingsBackup, serializeSettingsBackup } from "../src/shared/settings-backup";
import { createProvider } from "../src/background/providers";
import { withoutSettingsKeys } from "../src/shared/settings-backup-credentials";
import type { ExtensionSettings } from "../src/shared/types";

afterEach(() => vi.unstubAllGlobals());
const request = { texts: ["Hello"], sourceLang: "en", targetLang: "zh-CN" };

function legacyBackup(settings: ExtensionSettings) {
  const file = createSettingsBackup(settings, "1.6.1", new Date(), { includeKeys: true });
  return { ...file, includesKeys: false, settings: withoutSettingsKeys(file.settings) };
}

it("restores legacy keyless LLM request configuration with the recognized authentication values cleared", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.providers.find(p => p.type === "openai-compatible")!, {
    apiKey: "dedicated-secret", systemPrompt: "Translate with context.", ollamaCompatibility: false,
    requestTemplate: { enabled: true, headers: '{"Authorization":"Bearer header-secret","X-Client":"backup-client"}',
      body: '{"private":{"api_key":"body-secret","purpose":"translation"}}' }
  });
  const file = legacyBackup(settings);
  const restored = parseSettingsBackup(serializeSettingsBackup(file)).settings;
  const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: '["你好"]' } }] }));
  vi.stubGlobal("fetch", fetch);
  await expect(createProvider(restored.providers.find(p => p.type === "openai-compatible")!).translateBatch(request)).resolves.toEqual(["你好"]);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.openai.com/v1/chat/completions");
  expect(new Headers(init.headers).get("Authorization") || null).toBeNull();
  expect(new Headers(init.headers).get("X-Client")).toBe("backup-client");
  const wire = [url, ...[...new Headers(init.headers)].flat(), String(init.body)].join("\n");
  expect(wire).not.toMatch(/dedicated-secret|header-secret|body-secret/);
  expect(wire).toContain("Translate with context.");
  expect(wire).toContain("translation");
});

it.each(["json", "form", "opaque"])("a restored HTTP %s template preserves its working request shape without recognized credentials", async dialect => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const body = { json: '{"api_key":"http-body-secret","q":{{json texts}}}',
    form: "api_key=http-body-secret&q={{texts}}", opaque: "dedicated-secret {{json texts}}" }[dialect]!;
  Object.assign(settings.providers.find(p => p.type === "deepseek")!, { apiKey: "dedicated-secret" });
  settings.providers.push({ type: "http-template", id: "custom-secret", label: "Custom", method: "POST",
    url: "https://example.com/translate?api_key=query-secret&mode=batch", headers: { Authorization: "header-secret", "X-Client": "backup-client" },
    bodyTemplate: body, responsePath: "translations" });
  const file = legacyBackup(settings);
  expect(serializeSettingsBackup(file)).not.toMatch(/query-secret|http-body-secret|header-secret|dedicated-secret/);
  const restored = parseSettingsBackup(serializeSettingsBackup(file)).settings;
  const fetch = vi.fn(async () => Response.json({ translations: ["你好"] })); vi.stubGlobal("fetch", fetch);
  await expect(createProvider(restored.providers.find(p => p.id === "custom-secret")!).translateBatch(request)).resolves.toEqual(["你好"]);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://example.com/translate?api_key=&mode=batch");
  expect(new Headers(init.headers).get("X-Client")).toBe("backup-client");
  expect(String(init.body)).toContain("Hello");
  expect([url, JSON.stringify(init)].join("\n")).not.toMatch(/query-secret|http-body-secret|header-secret|dedicated-secret/);
});

it("requires a new endpoint before a restored custom HTTP service can make requests", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.providers.push({ type: "http-template", id: "custom", label: "Custom", method: "POST",
    url: "https://example.invalid/translate", headers: { "X-Workspace-Access": "fixture-value" },
    bodyTemplate: '{"q":{{json texts}}}', responsePath: "translations" });
  const restored = parseSettingsBackup(serializeSettingsBackup(createSettingsBackup(settings, "1.23.0")));
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(createProvider(restored.settings.providers.find(p => p.id === "custom")!).translateBatch(request)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
