import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { BUILT_IN_SCHEMES } from "../src/shared/appearance";
import { normalizeSettings } from "../src/shared/settings";
import { createSettingsBackup, parseSettingsBackup, SETTINGS_BACKUP_MAX_BYTES, settingsBackupFilename } from "../src/shared/settings-backup";
import type { ExtensionSettings } from "../src/shared/types";

const now = new Date("2026-11-03T01:02:03.456Z");
function fixture(): ExtensionSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.videoTranslation = { enabled: false, showOriginal: false, fontSize: 26, background: "none", preferredSource: "en", enabledSites: ["youtube.com"] };
  settings.providers.push({ type: "http-template", id: "custom-http", label: "<b>自定义</b>", method: "POST",
    url: "https://user:password@example.com/Api@proxy?signature=short-secret", headers: { "X-Signature2": "opaque-value", "Content-Type": "application/json" },
    bodyTemplate: '{"api_key":"plain-value","q":{{json texts}}}', responsePath: "translations" });
  const deepseek = settings.providers.find(p => p.type === "deepseek")!;
  Object.assign(deepseek, { apiKey: "saved-key", customModels: ["private-model"], requestTemplate: { enabled: true, headers: '{"X-Private":"another-secret"}', body: '{"token":"value"}' } });
  Object.assign(settings.providers[0], { serviceMode: "api", api: { apiKey: "azure-key", endpoint: "https://api.example.com", region: "eastasia", secretAccessKey: "signing-key" } });
  settings.autoTranslation = { enabled: true, nonTargetLanguage: true, presetSites: ["github.com"], customSites: [{ id: "site-1", pattern: "*.example.com/docs/*", enabled: true }] };
  settings.elementExclusions = [{ id: "exclude-1", name: "菜单", pattern: "example.com", selectors: ["nav"], enabled: true }];
  settings.appearance!.customSchemes = [{ ...structuredClone(BUILT_IN_SCHEMES[0]), id: "custom-backup", name: "自定义" }];
  settings.appearance!.lightSchemeId = "custom-backup";
  return normalizeSettings(settings);
}

describe("settings backup format", () => {
  it("round-trips every supported setting and arbitrary credential carrier without modifying its source", () => {
    const settings = fixture(), before = structuredClone(settings);
    const backup = createSettingsBackup(settings, "1.6.1", now, { includeKeys: true });
    const restored = parseSettingsBackup(JSON.stringify(backup));
    expect(restored).toMatchObject({ kind: "wupage-settings-backup", version: 2, includesKeys: true, extensionVersion: "1.6.1", createdAt: now.toISOString() });
    expect(restored.settings).toEqual(settings);
    expect(settings).toEqual(before);
    expect(JSON.stringify(restored)).toContain("short-secret");
    expect(JSON.stringify(restored)).toContain("opaque-value");
    expect(JSON.stringify(restored)).toContain("plain-value");
    expect(settingsBackupFilename(backup)).toBe("wupage-settings-2026-11-03T01-02-03-456Z.json");
  });

  it("exports only configuration even if storage contains unrelated or obsolete properties", () => {
    const stored = Object.assign(fixture(), { cachedTexts: ["private-page-text"], loginCookie: "cookie-value" });
    Object.assign(stored.providers[0], { sessionCookie: "runtime-cookie" });
    const text = JSON.stringify(createSettingsBackup(stored, "1.6.1", now));
    expect(text).not.toMatch(/private-page-text|cookie-value|runtime-cookie/);
  });

  it("accepts a UTF-8 BOM and fills optional settings from defaults", () => {
    const backup = createSettingsBackup(fixture(), "1.6.1", now);
    delete backup.settings.appearance;
    expect(parseSettingsBackup("\uFEFF" + JSON.stringify(backup)).settings.appearance).toEqual(normalizeSettings({}).appearance);
  });

  it.each([
    ["truncated JSON", (b: any) => JSON.stringify(b).slice(0, -10)],
    ["raw settings", (b: any) => JSON.stringify(b.settings)],
    ["wrong kind", (b: any) => JSON.stringify({ ...b, kind: "another-extension" })],
    ["future version", (b: any) => JSON.stringify({ ...b, version: 3 })],
    ["missing key policy", (b: any) => { delete b.includesKeys; return JSON.stringify(b); }],
    ["invalid key policy", (b: any) => { b.includesKeys = "false"; return JSON.stringify(b); }],
    ["invalid date", (b: any) => JSON.stringify({ ...b, createdAt: "unknown" })],
    ["missing core setting", (b: any) => { delete b.settings.targetLang; return JSON.stringify(b); }],
    ["wrong nested type", (b: any) => { b.settings.providers[0].api.apiKey = {}; return JSON.stringify(b); }],
    ["unknown provider", (b: any) => { b.settings.providers[0].type = "unknown"; return JSON.stringify(b); }],
    ["duplicate provider ID", (b: any) => { b.settings.providers.push(b.settings.providers[0]); return JSON.stringify(b); }],
    ["retyped built-in", (b: any) => { b.settings.providers[0].type = "firefox-local"; return JSON.stringify(b); }],
    ["missing active provider", (b: any) => { b.settings.activeProviderId = "missing"; return JSON.stringify(b); }],
    ["disabled active provider", (b: any) => { b.settings.providers[0].enabled = false; return JSON.stringify(b); }],
    ["unknown setting", (b: any) => { b.settings.futureFeature = true; return JSON.stringify(b); }],
    ["invalid header", (b: any) => { b.settings.providers.at(-1).headers.Authorization = 42; return JSON.stringify(b); }],
    ["invalid shortcut", (b: any) => { b.settings.shortcuts["toggle-page-translation"] = "invalid"; return JSON.stringify(b); }],
    ["invalid site rule", (b: any) => { b.settings.autoTranslation.customSites[0].pattern = "https://"; return JSON.stringify(b); }],
    ["invalid number", (b: any) => { b.settings.concurrency = 100; return JSON.stringify(b); }],
    ["polluting key", (b: any) => JSON.stringify(b).replace('"settings":{', '"settings":{"__proto__":{"polluted":true},')],
    ["deep tree", (b: any) => JSON.stringify({ ...b, nested: Array.from({ length: 30 }).reduce(value => ({ child: value }), {}) })]
  ])("rejects %s without echoing credential values", (_name, change) => {
    const text = change(createSettingsBackup(fixture(), "1.6.1", now));
    expect(() => parseSettingsBackup(text)).toThrow();
    try { parseSettingsBackup(text); } catch (error) { expect(String(error)).not.toMatch(/saved-key|azure-key|short-secret/); }
    expect(({} as any).polluted).toBeUndefined();
  });

  it("bounds UTF-8 bytes as well as character count", () => {
    expect(() => parseSettingsBackup(" ".repeat(SETTINGS_BACKUP_MAX_BYTES + 1))).toThrow("5 MiB");
    const text = JSON.stringify({ note: "汉".repeat(SETTINGS_BACKUP_MAX_BYTES / 2) });
    expect(text.length).toBeLessThan(SETTINGS_BACKUP_MAX_BYTES);
    expect(() => parseSettingsBackup(text)).toThrow("5 MiB");
  });

  it("omits all credentials by default while keeping preferences and service identities", () => {
    const settings = fixture(), before = structuredClone(settings);
    const backup = createSettingsBackup(settings, "1.6.1", now);
    expect(backup.includesKeys).toBe(false);
    const text = JSON.stringify(backup);
    for (const secret of ["saved-key", "azure-key", "signing-key", "password", "short-secret", "opaque-value", "plain-value", "another-secret", "eastasia"]) {
      expect(text).not.toContain(secret);
    }
    expect(settings).toEqual(before);
    const restored = parseSettingsBackup(text).settings;
    expect(restored.providers.map(p => [p.id, p.label, "model" in p ? p.model : ""]))
      .toEqual(settings.providers.map(p => [p.id, p.label, "model" in p ? p.model : ""]));
    for (const key of ["appearance", "autoTranslation", "shortcuts", "localShortcuts", "videoTranslation", "elementExclusions"] as const) {
      expect(restored[key]).toEqual(settings[key]);
    }
    expect(restored.providers.find(p => p.type === "deepseek")).toMatchObject({ apiKey: "", baseURL: "https://api.deepseek.com" });
  });

  it.each([
    ['{"api_key":"<secret>","q":{{json texts}}}'],
    ['q={{texts}}&unusual-credential=<secret>'],
    ['<request><custom><secret></custom>{{texts}}</request>'],
    ['not even valid JSON <secret> {{json texts}}']
  ])("removes an entire custom HTTP template regardless of its dialect: %s", template => {
    const settings = fixture();
    const http = settings.providers.find(p => p.id === "custom-http")!;
    Object.assign(http, { headers: { "X-Signature2": "short", "Completely-Unknown": "0123456789abcdef", "secret-name": "a" },
      url: "https://secret-host.example/path/secret-path?unknown=secret-query#secret-fragment", bodyTemplate: template.replace("<secret>", "template-credential") });
    const backup = createSettingsBackup(settings, "1.6.1", now);
    const text = JSON.stringify(backup);
    expect(text).not.toMatch(/secret-name|0123456789abcdef|secret-host|secret-path|secret-query|secret-fragment|template-credential/);
    expect(backup.settings.providers.find(p => p.id === "custom-http"))
      .toMatchObject({ headers: {}, url: "", bodyTemplate: "" });
    expect(() => parseSettingsBackup(text)).not.toThrow();
  });

  it("removes custom base URLs, service endpoints, prompts, and even disabled request templates", () => {
    const settings = fixture();
    const llm = settings.providers.find(p => p.type === "deepseek")!;
    Object.assign(llm, { baseURL: "https://key-user:key-pass@example.com/api/key-in-path", systemPrompt: "custom-key-in-prompt",
      requestTemplate: { enabled: false, headers: '{"X": "short-key"}', body: '{"opaque":"body-key"}' } });
    const file = createSettingsBackup(settings, "1.6.1", now);
    expect(JSON.stringify(file)).not.toMatch(/key-user|key-pass|key-in-path|key-in-prompt|short-key|body-key|api.example.com/);
    expect(file.settings.providers.find(p => p.type === "deepseek"))
      .toMatchObject({ baseURL: "", apiKey: "", systemPrompt: "", requestTemplate: { enabled: false, headers: "{}", body: "{}" } });
  });

  it("rejects keyless metadata that conceals credentials instead of trusting the flag", () => {
    const file = createSettingsBackup(fixture(), "1.6.1", now, { includeKeys: true });
    file.includesKeys = false;
    expect(() => parseSettingsBackup(JSON.stringify(file))).toThrow("settings.credentials");
  });

  it("accepts legacy full backups as containing credentials regardless of extra metadata", () => {
    const full = createSettingsBackup(fixture(), "1.6.1", now, { includeKeys: true });
    const { includesKeys: _ignored, ...legacy } = full;
    const parsed = parseSettingsBackup(JSON.stringify({ ...legacy, version: 1, includesKeys: false }));
    expect(parsed.includesKeys).toBe(true);
    expect(parsed.settings).toEqual(full.settings);
  });
});
