import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import { createSettingsBackup, parseSettingsBackup, serializeSettingsBackup } from "../src/shared/settings-backup";
import { restoreProviderParameters } from "../src/options/provider-defaults";
import { getProviderUsage } from "../src/shared/provider-usage";

describe("DeepL and Index-Translate settings", () => {
  it.each([false, true])("round-trips both services with includeSecrets=%s", includeSecrets => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.activeProviderId = "deepl";
    Object.assign(settings.providers.find(p => p.type === "deepl")!, { apiKey: "deepl-secret:fx", endpoint: "http://localhost:8088/v2" });
    Object.assign(settings.providers.find(p => p.type === "index-translate")!, { apiKey: "index-secret", baseURL: "http://localhost:8000/v1",
      model: "IndexTeam/Index-Translate-9B", customModels: ["IndexTeam/Index-Translate-9B"], requestTemplate: {
        enabled: true, headers: '{"Authorization":"Bearer {{apiKey}}"}', body: '{"max_tokens":4096}'
      } });
    const backup = createSettingsBackup(settings, "1.10.0", new Date("2026-11-07T00:00:00Z"), { includeKeys: includeSecrets });
    const text = serializeSettingsBackup(backup);
    if (!includeSecrets) expect(text).not.toMatch(/deepl-secret|index-secret/);
    const restored = normalizeSettings(parseSettingsBackup(text).settings);
    expect(restored.activeProviderId).toBe("deepl");
    expect(restored.providers.find(p => p.type === "deepl")).toMatchObject({ endpoint: "http://localhost:8088/v2", apiKey: includeSecrets ? "deepl-secret:fx" : "" });
    expect(restored.providers.find(p => p.type === "index-translate")).toMatchObject({ baseURL: "http://localhost:8000/v1",
      apiKey: includeSecrets ? "index-secret" : "", model: "IndexTeam/Index-Translate-9B", customModels: ["IndexTeam/Index-Translate-9B"],
      requestTemplate: { enabled: true, headers: '{"Authorization":"Bearer {{apiKey}}"}', body: '{"max_tokens":4096}' } });
  });

  it("adds new providers to existing settings without changing the selected service", () => {
    const previous = structuredClone(DEFAULT_SETTINGS);
    previous.providers = previous.providers.filter(p => p.type !== "deepl" && p.type !== "index-translate");
    previous.activeProviderId = "deepseek";
    const normalized = normalizeSettings(previous);
    expect(normalized.activeProviderId).toBe("deepseek");
    expect(normalized.providers.map(p => p.id)).toEqual(expect.arrayContaining(["deepl", "index-translate"]));
  });

  it("restores new service defaults while preserving keys and performance", () => {
    for (const type of ["deepl", "index-translate"] as const) {
      const provider = DEFAULT_SETTINGS.providers.find(p => p.type === type)!;
      if (provider.type !== "deepl" && provider.type !== "index-translate") throw new Error("Missing provider");
      const result = restoreProviderParameters({ ...provider, apiKey: "retain-me", concurrency: 2, performanceMode: "custom" });
      expect(result).toMatchObject({ type, apiKey: "retain-me", concurrency: 2, performanceMode: "custom" });
    }
  });

  it("does not attach official DeepL quotas to a custom host or promise offline Index bridge operation", () => {
    const deepl = DEFAULT_SETTINGS.providers.find(p => p.type === "deepl")!;
    expect(getProviderUsage(deepl)).toMatchObject({ checkedAt: "2026-11-07", request: expect.stringContaining("128 KiB") });
    expect(getProviderUsage({ ...deepl, endpoint: "https://api.deepl.com.example.test" }).sources).toEqual([]);
    const index = DEFAULT_SETTINGS.providers.find(p => p.type === "index-translate")!;
    expect(getProviderUsage(index).note).toContain("并非离线推理");
  });
});
