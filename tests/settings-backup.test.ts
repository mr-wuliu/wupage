import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { BUILT_IN_SCHEMES } from "../src/shared/appearance";
import { normalizeSettings } from "../src/shared/settings";
import { createSettingsBackup, parseSettingsBackup, serializeSettingsBackup, SETTINGS_BACKUP_MAX_BYTES, settingsBackupFilename } from "../src/shared/settings-backup";
import type { ExtensionSettings } from "../src/shared/types";
import { stringify as stringifyToml } from "smol-toml";

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
    const restored = parseSettingsBackup(serializeSettingsBackup(backup));
    expect(restored).toMatchObject({ kind: "wupage-settings-backup", version: 1, includesKeys: true, extensionVersion: "1.6.1", createdAt: now.toISOString() });
    expect(restored.settings).toEqual(settings);
    expect(settings).toEqual(before);
    expect(serializeSettingsBackup(restored)).toContain("short-secret");
    expect(serializeSettingsBackup(restored)).toContain("opaque-value");
    expect(serializeSettingsBackup(restored)).toContain("plain-value");
    expect(settingsBackupFilename(backup)).toBe("wupage-settings-2026-11-03T01-02-03-456Z.toml");
  });

  it("exports only configuration even if storage contains unrelated or obsolete properties", () => {
    const stored = Object.assign(fixture(), { cachedTexts: ["private-page-text"], loginCookie: "cookie-value" });
    Object.assign(stored.providers[0], { sessionCookie: "runtime-cookie" });
    const text = serializeSettingsBackup(createSettingsBackup(stored, "1.6.1", now));
    expect(text).not.toMatch(/private-page-text|cookie-value|runtime-cookie/);
  });

  it("accepts a UTF-8 BOM and fills optional settings from defaults", () => {
    const backup = createSettingsBackup(fixture(), "1.6.1", now);
    delete backup.settings.appearance;
    expect(parseSettingsBackup("\uFEFF" + serializeSettingsBackup(backup)).settings.appearance).toEqual(normalizeSettings({}).appearance);
  });

  it.each([
    ["unclosed TOML string", (b: any) => serializeSettingsBackup(b) + '\nbroken = "saved-key'],
    ["raw settings", (b: any) => stringifyToml(b.settings)],
    ["wrong kind", (b: any) => serializeSettingsBackup({ ...b, kind: "another-extension" })],
    ["future version", (b: any) => serializeSettingsBackup({ ...b, version: 2 })],
    ["missing key policy", (b: any) => { delete b.includesKeys; return serializeSettingsBackup(b); }],
    ["invalid key policy", (b: any) => { b.includesKeys = "false"; return serializeSettingsBackup(b); }],
    ["invalid date", (b: any) => serializeSettingsBackup({ ...b, createdAt: "unknown" })],
    ["missing core setting", (b: any) => { delete b.settings.targetLang; return serializeSettingsBackup(b); }],
    ["wrong nested type", (b: any) => { b.settings.providers[0].api.apiKey = {}; return serializeSettingsBackup(b); }],
    ["unknown provider", (b: any) => { b.settings.providers[0].type = "unknown"; return serializeSettingsBackup(b); }],
    ["duplicate provider ID", (b: any) => { b.settings.providers.push(b.settings.providers[0]); return serializeSettingsBackup(b); }],
    ["retyped built-in", (b: any) => { b.settings.providers[0].type = "firefox-local"; return serializeSettingsBackup(b); }],
    ["missing active provider", (b: any) => { b.settings.activeProviderId = "missing"; return serializeSettingsBackup(b); }],
    ["disabled active provider", (b: any) => { b.settings.providers[0].enabled = false; return serializeSettingsBackup(b); }],
    ["unknown setting", (b: any) => { b.settings.futureFeature = true; return serializeSettingsBackup(b); }],
    ["invalid header", (b: any) => { b.settings.providers.at(-1).headers.Authorization = 42; return serializeSettingsBackup(b); }],
    ["invalid shortcut", (b: any) => { b.settings.shortcuts["toggle-page-translation"] = "invalid"; return serializeSettingsBackup(b); }],
    ["invalid site rule", (b: any) => { b.settings.autoTranslation.customSites[0].pattern = "https://"; return serializeSettingsBackup(b); }],
    ["invalid number", (b: any) => { b.settings.concurrency = 100; return serializeSettingsBackup(b); }],
    ["polluting key", (b: any) => '__proto__.polluted = true\n' + serializeSettingsBackup(b)],
    ["duplicate TOML key", (b: any) => 'kind = "duplicate"\n' + serializeSettingsBackup(b)],
    ["invalid numeric value", (b: any) => serializeSettingsBackup(b).replace('concurrency = 3', 'concurrency = nan')],
    ["deep tree", (b: any) => serializeSettingsBackup({ ...b, nested: Array.from({ length: 30 }).reduce(value => ({ child: value }), {}) })]
  ])("rejects %s without echoing credential values", (_name, change) => {
    const text = change(createSettingsBackup(fixture(), "1.6.1", now));
    expect(() => parseSettingsBackup(text)).toThrow();
    try { parseSettingsBackup(text); } catch (error) { expect(String(error)).not.toMatch(/saved-key|azure-key|short-secret/); }
    expect(({} as any).polluted).toBeUndefined();
  });

  it("bounds UTF-8 bytes as well as character count", () => {
    expect(() => parseSettingsBackup(" ".repeat(SETTINGS_BACKUP_MAX_BYTES + 1))).toThrow("5 MiB");
    const text = stringifyToml({ note: "汉".repeat(SETTINGS_BACKUP_MAX_BYTES / 2) });
    expect(text.length).toBeLessThan(SETTINGS_BACKUP_MAX_BYTES);
    expect(() => parseSettingsBackup(text)).toThrow("5 MiB");
  });

  it("omits credentials by default while retaining all other configuration", () => {
    const settings = fixture(), before = structuredClone(settings);
    const backup = createSettingsBackup(settings, "1.6.1", now);
    expect(backup.includesKeys).toBe(false);
    const text = serializeSettingsBackup(backup);
    for (const secret of ["saved-key", "azure-key", "signing-key", "password", "short-secret", "opaque-value", "plain-value"]) {
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
    expect(restored.providers[0]).toMatchObject({ serviceMode: "api", api: { endpoint: "https://api.example.com", region: "eastasia", apiKey: "", secretAccessKey: "" } });
    expect(restored.providers.find(p => p.id === "custom-http")).toMatchObject({
      url: "https://user:@example.com/Api@proxy?signature=", headers: { "X-Signature2": "", "Content-Type": "application/json" },
      bodyTemplate: '{"api_key":"","q":{{json texts}}}', responsePath: "translations" });
    expect(restored.providers.find(p => p.type === "deepseek")).toMatchObject({ requestTemplate: {
      enabled: true, headers: '{"X-Private":"another-secret"}', body: '{"token":""}' } });
  });

  it.each([
    ['{"api_key":"<secret>","q":{{json texts}}}', '{"api_key":"","q":{{json texts}}}'],
    ['q={{texts}}&api_key=<secret>', 'q={{texts}}&api_key='],
    ['<request><api_key><secret></api_key>{{texts}}</request>', '<request><api_key></api_key>{{texts}}</request>'],
    ['opaque text saved-key {{json texts}}', 'opaque text  {{json texts}}']
  ])("removes credential values while preserving the HTTP template dialect: %s", (template, expected) => {
    const settings = fixture();
    const http = settings.providers.find(p => p.id === "custom-http")!;
    Object.assign(http, { headers: { "X-Signature2": "short", "X-Client": "public-client", "Content-Type": "text/plain" },
      url: "https://service.example/path/v2?mode=translate#endpoint", bodyTemplate: template.replace("<secret>", "template-credential") });
    const backup = createSettingsBackup(settings, "1.6.1", now);
    const text = serializeSettingsBackup(backup);
    expect(text).not.toMatch(/template-credential|saved-key/);
    expect(backup.settings.providers.find(p => p.id === "custom-http"))
      .toMatchObject({ headers: { "X-Signature2": "", "X-Client": "public-client", "Content-Type": "text/plain" },
        url: "https://service.example/path/v2?mode=translate#endpoint", bodyTemplate: expected });
    expect(() => parseSettingsBackup(text)).not.toThrow();
  });

  it("retains custom addresses, prompts, disabled templates and key references", () => {
    const settings = fixture();
    const llm = settings.providers.find(p => p.type === "deepseek")!;
    Object.assign(llm, { baseURL: "https://key-user:key-pass:more@example.com/api/private-path", systemPrompt: "Translate carefully with context. saved-key",
      requestTemplate: { enabled: false, headers: '{"Authorization":"Bearer {{apiKey}}", "X-Client":"custom"}', body: '{"context":"{{context}}"}' } });
    const file = createSettingsBackup(settings, "1.6.1", now);
    expect(serializeSettingsBackup(file)).not.toMatch(/key-pass|saved-key/);
    expect(file.settings.providers.find(p => p.type === "deepseek"))
      .toMatchObject({ baseURL: "https://key-user:@example.com/api/private-path", apiKey: "", systemPrompt: "Translate carefully with context. ",
        requestTemplate: { enabled: false, headers: '{"Authorization":"Bearer {{apiKey}}", "X-Client":"custom"}', body: '{"context":"{{context}}"}' } });
    expect(parseSettingsBackup(serializeSettingsBackup(file)).settings).toEqual(file.settings);
  });

  it("rejects keyless metadata that conceals credentials instead of trusting the flag", () => {
    const file = createSettingsBackup(fixture(), "1.6.1", now, { includeKeys: true });
    file.includesKeys = false;
    expect(() => parseSettingsBackup(serializeSettingsBackup(file))).toThrow("settings.credentials");
  });

  it("round-trips all configuration unchanged when no credentials are configured", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.providers.find(p => p.type === "deepseek")!, {
      baseURL: "https://proxy.example/CaseSensitive/v1?mode=batch", systemPrompt: "自定义提示词\n{{targetLang}}",
      requestTemplate: { enabled: true, headers: '{"Authorization":"Bearer {{apiKey}}","X-Client":"custom-client"}',
        body: '{"model":"{{model}}","q":{{json texts}},"context":"{{context}}"}' } });
    Object.assign(settings.providers[0], { serviceMode: "api", api: { endpoint: "https://api.example/Translate", region: "eastasia", folderId: "public-folder", model: "custom-model" } });
    settings.providers.push({ type: "http-template", id: "public-template", label: "配置", method: "POST", url: "https://api.example/Translate?mode=batch#config",
      headers: { "Content-Type": "application/json", "X-Client": "custom-client" }, bodyTemplate: '{"text":{{json texts}},"option":true}', responsePath: "data.translations" });
    const normalized = normalizeSettings(settings);
    const backup = createSettingsBackup(normalized, "1.6.1", now);
    expect(backup.settings).toEqual(normalized);
    expect(parseSettingsBackup(serializeSettingsBackup(backup)).settings).toEqual(normalized);
  });

  it.each(["Authorization", "Proxy-Authorization", "X-Api-Key", "Ocp-Apim-Subscription-Key", "X-Goog-Api-Key", "X-Signature2"])("keeps the %s header name and non-authentication headers while clearing its secret value", name => {
    const settings = fixture();
    Object.assign(settings.providers.find(p => p.id === "custom-http")!, { headers: { [name]: "private-header", "X-Client": "client", "Content-Type": "application/json" } });
    const file = createSettingsBackup(settings, "1.6.1", now);
    expect(file.settings.providers.find(p => p.id === "custom-http")).toMatchObject({ headers: { [name]: "", "X-Client": "client", "Content-Type": "application/json" } });
    expect(parseSettingsBackup(serializeSettingsBackup(file)).settings).toEqual(file.settings);
  });

  it("preserves URL spelling and encoded key references while clearing encoded credential values", () => {
    const settings = fixture();
    Object.assign(settings.providers.find(p => p.id === "custom-http")!, {
      url: "https://API.example/Keep%2fCase?%61pi_key=encoded%2Bsecret&token=%7B%7BapiKey%7D%7D&mode=fast#config" });
    const backup = createSettingsBackup(settings, "1.6.1", now);
    expect(backup.settings.providers.find(p => p.id === "custom-http")).toMatchObject({
      url: "https://API.example/Keep%2fCase?%61pi_key=&token=%7B%7BapiKey%7D%7D&mode=fast#config" });
    expect(parseSettingsBackup(serializeSettingsBackup(backup)).settings).toEqual(backup.settings);
  });

  it("does not corrupt ordinary text when a configured key is only one character", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.providers.find(p => p.type === "deepseek")!, { apiKey: "a", systemPrompt: "Translate a paragraph with a model.",
      requestTemplate: { enabled: true, headers: '{"X-Client":"a-client"}', body: '{"api_key":"a","q":{{json texts}}}' } });
    expect(createSettingsBackup(settings, "1.6.1", now).settings.providers.find(p => p.type === "deepseek"))
      .toMatchObject({ apiKey: "", systemPrompt: "Translate a paragraph with a model.",
        requestTemplate: { enabled: true, headers: '{"X-Client":"a-client"}', body: '{"api_key":"","q":{{json texts}}}' } });
  });

  it("removes escaped copies of configured credentials without corrupting JSON template syntax", () => {
    const settings = structuredClone(DEFAULT_SETTINGS), secret = 'private"key\\secret';
    Object.assign(settings.providers.find(p => p.type === "deepseek")!, { apiKey: secret,
      requestTemplate: { enabled: true, headers: JSON.stringify({ "X-Custom": secret, "X-Client": "custom" }),
        body: '{"opaque":' + JSON.stringify(secret) + ',"q":{{json texts}}}' } });
    const file = createSettingsBackup(settings, "1.6.1", now);
    expect(file.settings.providers.find(p => p.type === "deepseek"))
      .toMatchObject({ requestTemplate: { enabled: true, headers: '{"X-Custom":"","X-Client":"custom"}', body: '{"opaque":"","q":{{json texts}}}' } });
    expect(parseSettingsBackup(serializeSettingsBackup(file)).settings).toEqual(file.settings);
  });

  it("clears credentials inside nested URL strings without consuming JSON structure or template references", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.providers.find(p => p.type === "deepseek")!, {
      requestTemplate: { enabled: true, headers: '{}',
        body: '{"url":"https://user:private-password@example.com?api_key=private-key&mode=batch","token":"{{ apiKey }}","q":{{json texts}}}' } });
    const file = createSettingsBackup(settings, "1.6.1", now);
    expect(file.settings.providers.find(p => p.type === "deepseek")).toMatchObject({ requestTemplate: {
      enabled: true, headers: '{}', body: '{"url":"https://user:@example.com?api_key=&mode=batch","token":"{{ apiKey }}","q":{{json texts}}}' } });
    expect(parseSettingsBackup(serializeSettingsBackup(file)).settings).toEqual(file.settings);
  });

  it.each([null, 0, 5, 1000])("round-trips the PDF page radius %s without losing the unlimited value", radius => {
    const settings = fixture(); settings.pdfTranslationPageRadius = radius;
    const text = serializeSettingsBackup(createSettingsBackup(settings, "1.6.1", now));
    expect(text).toContain(`pdfTranslationPageRadius = ${radius === null ? '"all"' : radius}`);
    expect(parseSettingsBackup(text).settings.pdfTranslationPageRadius).toBe(radius);
  });

  it("exports tables and multiline strings that remain editable with comments", () => {
    const settings = fixture();
    const prompt = '\n中文、引号 """、单引号 \'\'\' 和路径 C:\\Users\\test\r\n{{targetLang}}\n字面量 \\n 和末尾反斜杠\\\n';
    const llm = settings.providers.find(p => p.type === "deepseek")!;
    Object.assign(llm, { systemPrompt: prompt, requestTemplate: { enabled: true,
      headers: '{\n  "X-Private": "\\\"quoted\\\""\n}', body: '{\n  "context": "{{context}}"\n}' } });
    const backup = createSettingsBackup(settings, "1.6.1", now, { includeKeys: true });
    const text = serializeSettingsBackup(backup);
    expect(text).toContain("[[settings.providers]]");
    expect(text).toContain('systemPrompt = """\n');
    expect(text).toContain('[settings.shortcuts]');
    const restored = parseSettingsBackup('# 手工添加的注释\n' + text.replace('targetLang = "zh-CN"', 'targetLang = "ja" # 目标语言'));
    expect(restored.settings.targetLang).toBe("ja");
    expect(restored.settings.providers.find(p => p.type === "deepseek")).toMatchObject({ systemPrompt: prompt });
    expect(restored.settings.providers).toEqual(backup.settings.providers);
  });

  it("accepts only TOML, without autodetecting a different backup format", () => {
    expect(() => parseSettingsBackup('{"kind":"wupage-settings-backup","version":1}')).toThrow("TOML");
  });
});
