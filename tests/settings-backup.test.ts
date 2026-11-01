import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import {
  createSettingsBackup,
  mergeStoredKeys,
  parseSettingsBackup,
  providerHasStoredKey,
  SETTINGS_BACKUP_MAX_BYTES,
  settingsBackupFileName,
  SettingsBackupError,
  settingsBackupHasKeys
} from "../src/shared/settings-backup";
import type { ExtensionSettings, ProviderConfig } from "../src/shared/types";
import { supportsServiceMode } from "../src/shared/translation-service";

/** Settings with a stored key in both key shapes: a provider field and a service-mode api block. */
function settingsWithKeys(): ExtensionSettings {
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, activeProviderId: "deepseek", chunkSize: 900 });
  const providers: ProviderConfig[] = settings.providers.map((provider) => {
    if (provider.id === "deepseek") return { ...provider, apiKey: "sk-deepseek-secret" } as ProviderConfig;
    if (provider.id === "microsoft-web-translate") {
      return { ...provider, serviceMode: "api", api: { apiKey: "azure-secret" } } as ProviderConfig;
    }
    return provider;
  });
  return { ...settings, providers };
}

/** Fictional credentials, so a leak assertion can name the exact string that must not appear. */
const CUSTOM_SECRETS = [
  "http-template-secret",
  "sk-llm-key",
  "sk-llm-template-secret",
  "llm-body-secret",
  "deepseek-secret-query"
] as const;

/** An LLM provider that keeps its credential in the editable request template as well. */
function llmProvider(): ProviderConfig {
  return {
    type: "openai-compatible", id: "custom-llm", label: "Custom LLM",
    baseURL: "https://api.example.com/v1", apiKey: "sk-llm-key", model: "gpt-4o-mini",
    systemPrompt: "Translate to {{targetLang}}", ollamaCompatibility: false,
    requestTemplate: {
      enabled: true,
      headers: JSON.stringify({
        "Content-Type": "application/json",
        Authorization: "Bearer {{apiKey}}",
        "x-api-key": "sk-llm-template-secret",
        "x-tenant": "wupage-tenant"
      }, null, 2),
      body: JSON.stringify({
        model: "{{model}}",
        api_key: "llm-body-secret",
        texts: "{{json texts}}"
      }, null, 2)
    }
  };
}

/** An HTTP Template plus that LLM: both keep credentials outside the fixed key fields. */
function settingsWithCustomCredentials(): ExtensionSettings {
  const template: ProviderConfig = {
    type: "http-template", id: "http-template", label: "HTTP Template", enabled: true, method: "POST",
    url: "https://user:pass@api.example.com/translate?api_key=deepseek-secret-query&target={{targetLang}}",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer http-template-secret",
      "x-api-key": "http-template-secret",
      // An invented header name: a fixed list of well-known names would miss this one.
      "x-custom-auth": "http-template-secret",
      "x-tenant": "wupage-tenant"
    },
    bodyTemplate: '{"texts":{{json texts}},"target":"{{targetLang}}"}',
    responsePath: "translations"
  };
  // The built-in HTTP Template shares this id, so it is replaced by normalizeSettings rather
  // than appended, which is the shape the panel actually stores.
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    activeProviderId: "custom-llm",
    providers: [...DEFAULT_SETTINGS.providers, template, llmProvider()]
  });
}

function keyOf(settings: ExtensionSettings, id: string): string | undefined {
  const provider = settings.providers.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`missing provider ${id}`);
  return (provider as unknown as Record<string, unknown>).apiKey as string | undefined;
}

/** The api block only exists on service-mode providers, so narrow before reading it. */
function apiKeyOf(settings: ExtensionSettings, id: string): string | undefined {
  const provider = settings.providers.find((candidate) => candidate.id === id);
  if (!provider || !supportsServiceMode(provider)) return undefined;
  return provider.api?.apiKey;
}

describe("settings backup", () => {
  it("round-trips the current settings through the exported file", () => {
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, activeProviderId: "deepseek", chunkSize: 900 });
    const file = createSettingsBackup(settings, new Date("2026-02-03T04:05:06Z"));
    expect(file).toMatchObject({ app: "wupage", kind: "settings", version: 1 });
    expect(file.exportedAt).toBe("2026-02-03T04:05:06.000Z");
    expect(parseSettingsBackup(JSON.stringify(file)).settings).toEqual(settings);
  });

  it("leaves keys out of an export unless the caller opts in", () => {
    // The reported risk: an exported file used to carry the key with no way to avoid it.
    const settings = settingsWithKeys();
    const file = createSettingsBackup(settings);
    expect(file.includesKeys).toBe(false);
    expect(file.settings).not.toEqual(settings);
    for (const provider of file.settings.providers) {
      expect((provider as unknown as Record<string, unknown>).apiKey ?? "").toBe("");
      if (!supportsServiceMode(provider)) continue;
      expect(provider.api?.apiKey ?? "").toBe("");
      expect(provider.api?.accessKeyId ?? "").toBe("");
      expect(provider.api?.secretAccessKey ?? "").toBe("");
    }
    expect(JSON.stringify(file)).not.toContain("sk-deepseek-secret");
    expect(JSON.stringify(file)).not.toContain("azure-secret");
    expect(settingsBackupHasKeys(file.settings)).toBe(false);
  });

  it("keeps the provider shape when keys are stripped", () => {
    // normalizeSettings drops a provider whose required fields are missing, so a stripped
    // export must still round-trip every provider rather than losing the whole service.
    const settings = settingsWithKeys();
    const restored = parseSettingsBackup(JSON.stringify(createSettingsBackup(settings)));
    expect(restored.settings.providers).toHaveLength(settings.providers.length);
    expect(restored.settings.activeProviderId).toBe("deepseek");
    expect(restored.settings.providers.map((provider) => provider.id))
      .toEqual(settings.providers.map((provider) => provider.id));
  });

  it("writes keys when the export opts in", () => {
    const settings = settingsWithKeys();
    const file = createSettingsBackup(settings, new Date(), { includesKeys: true });
    expect(file.includesKeys).toBe(true);
    expect(file.settings).toEqual(settings);
    expect(JSON.stringify(file)).toContain("sk-deepseek-secret");
    expect(settingsBackupHasKeys(file.settings)).toBe(true);
    // The file records the opt-in, so importing it must not treat the keys as absent.
    expect(parseSettingsBackup(JSON.stringify(file)).includesKeys).toBe(true);
    expect(parseSettingsBackup(JSON.stringify(file)).settings).toEqual(settings);
  });

  it("treats a file without the marker as carrying keys", () => {
    // Files written before this option existed carry real keys and must stay importable.
    const legacy = { app: "wupage", kind: "settings", version: 1, settings: settingsWithKeys() };
    expect(parseSettingsBackup(JSON.stringify(legacy)).includesKeys).toBe(true);
    expect(parseSettingsBackup(JSON.stringify({ targetLang: "ja", chunkSize: 20 })).includesKeys).toBe(true);
  });

  it("keeps the export detached from later edits", () => {
    const settings = normalizeSettings(DEFAULT_SETTINGS);
    const original = settings.chunkSize;
    const file = createSettingsBackup(settings);
    file.settings.chunkSize = original + 100;
    expect(settings.chunkSize).toBe(original);
  });

  it("accepts a bare settings object and normalizes it", () => {
    const { settings: imported } = parseSettingsBackup(JSON.stringify({ targetLang: "ja", chunkSize: 20 }));
    expect(imported.targetLang).toBe("ja");
    expect(imported.chunkSize).toBe(200);
    expect(imported.providers).toHaveLength(DEFAULT_SETTINGS.providers.length);
    expect(imported.providers.some(provider => provider.enabled !== false)).toBe(true);
  });

  it("rejects malformed and foreign files", () => {
    expect(() => parseSettingsBackup("{")).toThrow(SettingsBackupError);
    expect(() => parseSettingsBackup("{}")).toThrow("没有可识别的 WuPage 设置");
    expect(() => parseSettingsBackup("[]")).toThrow("不是设置对象");
    expect(() => parseSettingsBackup(JSON.stringify({ hello: "world" }))).toThrow("没有可识别的 WuPage 设置");
    expect(() => parseSettingsBackup(JSON.stringify({ app: "other", settings: { targetLang: "ja" } })))
      .toThrow("不是 WuPage 的设置备份");
    expect(() => parseSettingsBackup(JSON.stringify({ app: "wupage", version: 2, settings: { targetLang: "ja" } })))
      .toThrow("更新版本");
    expect(() => parseSettingsBackup(JSON.stringify({ app: "wupage", settings: "nope" })))
      .toThrow("没有可识别的设置");
  });

  it("rejects a file that carries another backup kind", () => {
    expect(() => parseSettingsBackup(JSON.stringify({ app: "wupage", kind: "history", settings: { targetLang: "ja" } })))
      .toThrow("这不是设置备份");
  });

  it("rejects a version that is not a number", () => {
    expect(() => parseSettingsBackup(JSON.stringify({ app: "wupage", version: "2", settings: { targetLang: "ja" } })))
      .toThrow("版本无法识别");
  });

  it("rejects a file too large to be settings", () => {
    expect(() => parseSettingsBackup("x".repeat(SETTINGS_BACKUP_MAX_BYTES + 1))).toThrow("文件过大");
  });

  it("names files with a sortable local timestamp", () => {
    expect(settingsBackupFileName(new Date(2026, 1, 3, 4, 5))).toBe("wupage-settings-20260203-0405.json");
  });

  it("keeps this browser's keys when the file carries none", () => {
    // Importing a key-less file must not blank the keys already stored here, or restoring a
    // backup on the same machine would silently break every service.
    const current = settingsWithKeys();
    const incoming = parseSettingsBackup(JSON.stringify(createSettingsBackup(current))).settings;
    expect(settingsBackupHasKeys(incoming)).toBe(false);
    const { settings: merged, restoredKeys } = mergeStoredKeys(incoming, current);
    expect(restoredKeys).toBe(2);
    expect(keyOf(merged, "deepseek")).toBe("sk-deepseek-secret");
    expect(apiKeyOf(merged, "microsoft-web-translate")).toBe("azure-secret");
  });

  it("lets the file win when it carries a key", () => {
    const current = settingsWithKeys();
    const edited = structuredClone(current);
    edited.providers = edited.providers.map((provider) => provider.id === "deepseek"
      ? { ...provider, apiKey: "sk-from-file" } as ProviderConfig : provider);
    const { settings: merged, restoredKeys } = mergeStoredKeys(edited, current);
    expect(keyOf(merged, "deepseek")).toBe("sk-from-file");
    // The untouched Azure key in the same file is not blank, so nothing was restored from here.
    expect(restoredKeys).toBe(0);
  });

  it("restores only the services this browser already knew", () => {
    const current = settingsWithKeys();
    const incoming = parseSettingsBackup(JSON.stringify(createSettingsBackup(current))).settings;
    const added: ProviderConfig = {
      type: "openai-compatible", id: "fresh-service", label: "Fresh", baseURL: "https://example.invalid/v1",
      apiKey: "", model: "gpt-4o-mini", systemPrompt: "translate"
    };
    const { settings: merged, restoredKeys } = mergeStoredKeys(
      { ...incoming, providers: [...incoming.providers, added] }, current
    );
    expect(restoredKeys).toBe(2);
    expect(keyOf(merged, "fresh-service")).toBe("");
  });

  it("reports whether a provider holds a key in either shape", () => {
    const settings = settingsWithKeys();
    const byId = (id: string): ProviderConfig => settings.providers.find((provider) => provider.id === id)!;
    expect(providerHasStoredKey(byId("deepseek"))).toBe(true);
    expect(providerHasStoredKey(byId("microsoft-web-translate"))).toBe(true);
    const bare = normalizeSettings(DEFAULT_SETTINGS);
    expect(bare.providers.some(providerHasStoredKey)).toBe(false);
  });

  it("strips the credentials an HTTP Template keeps outside its key fields", () => {
    // Reported risk: a default export said "without keys" while the custom carriers still held one.
    const settings = settingsWithCustomCredentials();
    const file = createSettingsBackup(settings);
    expect(file.includesKeys).toBe(false);
    const written = JSON.stringify(file);
    for (const secret of CUSTOM_SECRETS) expect(written).not.toContain(secret);
    // The non-credential header must survive, or the export would break the request.
    const template = file.settings.providers.find((provider) => provider.id === "http-template")!;
    expect((template as unknown as { headers: Record<string, string> }).headers["x-tenant"])
      .toBe("wupage-tenant");
    expect(settingsBackupHasKeys(file.settings)).toBe(false);
  });

  it("keeps the credential carriers usable after stripping", () => {
    // The point of blanking instead of deleting: the provider must survive an import.
    const file = createSettingsBackup(settingsWithCustomCredentials());
    const restored = parseSettingsBackup(JSON.stringify(file)).settings;
    const template = restored.providers.find((provider) => provider.id === "http-template");
    expect(template).toBeDefined();
    // A variable-only template is not JSON, so the text the user wrote has to survive verbatim.
    expect((template as unknown as Record<string, unknown>).bodyTemplate)
      .toBe('{"texts":{{json texts}},"target":"{{targetLang}}"}');
    const llm = restored.providers.find((provider) => provider.id === "custom-llm");
    expect(llm).toBeDefined();
    expect(JSON.stringify(llm)).toContain("{{apiKey}}");
  });

  it("keeps the variables a request template renders at runtime", () => {
    const file = createSettingsBackup(settingsWithCustomCredentials());
    const llm = file.settings.providers.find((provider) => provider.id === "custom-llm")!;
    const headers = JSON.parse((llm as unknown as { requestTemplate: { headers: string } }).requestTemplate.headers);
    // The stored key is blank, so the header must still be built from the variable.
    expect(headers.Authorization).toBe("Bearer {{apiKey}}");
    expect(headers["x-api-key"]).toBe("");
    expect(headers["x-tenant"]).toBe("wupage-tenant");
  });

  it("leaves this browser's custom credentials when the file matches its own export", () => {
    // Exporting and re-importing on the same device must not disarm a working service.
    const current = settingsWithCustomCredentials();
    const incoming = parseSettingsBackup(JSON.stringify(createSettingsBackup(current))).settings;
    const { settings: merged, restoredKeys } = mergeStoredKeys(incoming, current);
    const template = merged.providers.find((provider) => provider.id === "http-template")!;
    expect((template as unknown as { headers: Record<string, string> }).headers.Authorization)
      .toBe("Bearer http-template-secret");
    const llm = merged.providers.find((provider) => provider.id === "custom-llm")!;
    expect(JSON.stringify(llm)).toContain("sk-llm-template-secret");
    expect(restoredKeys).toBeGreaterThanOrEqual(2);
  });

  it("does not reuse a stored key once the file moves the provider to another host", () => {
    // Reported risk: a key-less file kept this browser's key while rewriting where it is sent.
    const current = normalizeSettings({
      ...DEFAULT_SETTINGS, activeProviderId: "custom-llm",
      providers: [{ ...llmProvider(), baseURL: "https://host-a.example/v1", apiKey: "sk-stored-key" }]
    });
    const incoming = normalizeSettings({
      ...DEFAULT_SETTINGS, activeProviderId: "custom-llm",
      providers: [{ ...llmProvider(), baseURL: "https://host-b.example/v1", apiKey: "" }]
    });
    const { settings: merged, restoredKeys, skippedKeys } = mergeStoredKeys(incoming, current);
    expect(keyOf(merged, "custom-llm")).toBe("");
    expect(restoredKeys).toBe(0);
    expect(skippedKeys).toBe(1);
  });

  it("still reuses a key when only the URL spelling changed", () => {
    // Trim, trailing slash and host case do not move the credential to another service.
    const current = settingsWithCustomCredentials();
    const incoming = structuredClone(current);
    incoming.providers = incoming.providers.map((provider) => provider.id === "custom-llm"
      ? { ...provider, baseURL: "HTTPS://API.Example.COM/v1/" } as ProviderConfig : provider);
    const { settings: merged, restoredKeys, skippedKeys } = mergeStoredKeys(
      parseSettingsBackup(JSON.stringify(createSettingsBackup(incoming))).settings, current
    );
    expect(keyOf(merged, "custom-llm")).toBe("sk-llm-key");
    expect(restoredKeys).toBeGreaterThanOrEqual(1);
    expect(skippedKeys).toBe(0);
  });

  it("does not reuse a service-mode key after the endpoint is rewritten", () => {
    const current = settingsWithKeys();
    const incoming = structuredClone(parseSettingsBackup(JSON.stringify(createSettingsBackup(current))).settings);
    incoming.providers = incoming.providers.map((provider) => {
      if (provider.id !== "microsoft-web-translate" || !supportsServiceMode(provider)) return provider;
      return { ...provider, api: { ...provider.api, endpoint: "https://collector.example" } } as ProviderConfig;
    });
    const { settings: merged, skippedKeys } = mergeStoredKeys(incoming, current);
    expect(apiKeyOf(merged, "microsoft-web-translate")).toBe("");
    expect(skippedKeys).toBe(1);
  });
});
