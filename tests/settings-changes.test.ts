import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { mergeSettingsChanges } from "../src/shared/settings-changes";
import { normalizeVideoTranslation } from "../src/shared/video";

describe("settings changes from different pages", () => {
  it("keeps external toggles and credentials while applying edited fields", () => {
    const previous = structuredClone(DEFAULT_SETTINGS);
    const draft = structuredClone(previous);
    draft.cacheEnabled = false;
    draft.providers.find(provider => provider.id === "deepseek")!.label = "Edited label";
    const latest = structuredClone(previous);
    latest.videoTranslation = normalizeVideoTranslation({ enabled: false });
    const provider = latest.providers.find(provider => provider.type === "deepseek")!;
    if (provider.type === "deepseek") provider.apiKey = "new-key";

    const merged = mergeSettingsChanges(latest, draft, previous);
    expect(merged).toMatchObject({ cacheEnabled: false, videoTranslation: { enabled: false } });
    expect(merged.providers.find(provider => provider.id === "deepseek"))
      .toMatchObject({ label: "Edited label", apiKey: "new-key" });
    expect(previous.cacheEnabled).toBe(true);
    expect(latest.cacheEnabled).toBe(true);
  });

  it("merges independent edits within the same nested setting", () => {
    const previous = structuredClone(DEFAULT_SETTINGS);
    previous.videoTranslation = normalizeVideoTranslation(undefined);
    const draft = structuredClone(previous);
    draft.videoTranslation!.showOriginal = false;
    const latest = structuredClone(previous);
    latest.videoTranslation!.fontSize = 26;
    expect(mergeSettingsChanges(latest, draft, previous).videoTranslation)
      .toMatchObject({ fontSize: 26, showOriginal: false });
  });

  it("preserves provider additions and deletions made by either page", () => {
    const previous = structuredClone(DEFAULT_SETTINGS);
    const provider = { ...previous.providers[0], id: "custom-old" };
    previous.providers.push(provider);
    const draft = structuredClone(previous);
    draft.providers = draft.providers.filter(entry => entry.id !== provider.id);
    const latest = structuredClone(previous);
    latest.providers.push({ ...provider, id: "custom-new" });
    expect(mergeSettingsChanges(latest, draft, previous).providers.map(entry => entry.id))
      .toContain("custom-new");
    expect(mergeSettingsChanges(latest, draft, previous).providers.map(entry => entry.id))
      .not.toContain("custom-old");
    // A stale edit must not recreate a provider already deleted by another page.
    latest.providers.find(entry => entry.id === provider.id)!.label = "Stale edit";
    expect(mergeSettingsChanges(draft, latest, previous).providers.map(entry => entry.id))
      .not.toContain("custom-old");
  });

  it("honors explicit field removal and uses the submitted value for conflicting edits", () => {
    const previous = structuredClone(DEFAULT_SETTINGS);
    previous.videoTranslation = normalizeVideoTranslation(undefined);
    const draft = { ...structuredClone(previous), targetLang: "ja" };
    delete draft.videoTranslation;
    const latest = { ...structuredClone(previous), targetLang: "fr" };
    const merged = mergeSettingsChanges(latest, draft, previous);
    expect(merged.targetLang).toBe("ja");
    expect(merged).not.toHaveProperty("videoTranslation");
  });
});
