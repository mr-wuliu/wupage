import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import { createSettingsBackup } from "../src/shared/settings-backup";
import { getSettings, saveSettings } from "../src/shared/settings";
import { importSettingsBackup } from "../src/background/settings-backup";

const installed = vi.hoisted(() => vi.fn());
vi.mock("../src/ocr/model-store", () => ({ installedRevision: installed }));
let storage: Record<string, unknown>;
const set = vi.fn(async (update: Record<string, unknown>) => { Object.assign(storage, structuredClone(update)); });
beforeEach(() => {
  storage = { [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS), translationCache: "keep-cache", statistics: "keep-statistics" };
  installed.mockResolvedValue("installed");
  set.mockClear();
  vi.stubGlobal("chrome", { storage: { local: { get: async (key: string) => ({ [key]: structuredClone(storage[key]) }), set } } });
});
afterEach(() => vi.unstubAllGlobals());
function backup(imageTranslationEnabled = false): string {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.targetLang = "ja";
  settings.imageTranslationEnabled = imageTranslationEnabled;
  return JSON.stringify(createSettingsBackup(settings, "1.6.1"));
}

it("fully replaces settings without reusing local credentials or deleting other stores", async () => {
  const local = await getSettings();
  Object.assign(local.providers.find(p => p.type === "deepseek")!, { apiKey: "local-secret", baseURL: "https://old.example/v1" });
  await saveSettings(local);
  set.mockClear();
  const result = await importSettingsBackup(backup());
  expect(result.settings.targetLang).toBe("ja");
  expect(result.settings.providers.find(p => p.type === "deepseek")).toMatchObject({ apiKey: "" });
  expect(storage.translationCache).toBe("keep-cache");
  expect(storage.statistics).toBe("keep-statistics");
  expect(set).toHaveBeenCalledTimes(1);
  expect(Object.keys(set.mock.calls[0][0])).toEqual([SETTINGS_KEY]);
});
it("keeps image translation off when the destination has no OCR model", async () => {
  installed.mockResolvedValue(undefined);
  const result = await importSettingsBackup(backup(true));
  expect(result).toMatchObject({ imageTranslationDisabled: true, settings: { targetLang: "ja", imageTranslationEnabled: false } });
});
it("preserves the image toggle when models exist and never checks unused models", async () => {
  expect((await importSettingsBackup(backup(true))).settings.imageTranslationEnabled).toBe(true);
  installed.mockClear();
  await importSettingsBackup(backup());
  expect(installed).not.toHaveBeenCalled();
});
it.each(["storage", "model", "file"])("leaves all prior settings intact after a %s failure and permits retry", async failure => {
  const before = structuredClone(storage);
  if (failure === "storage") set.mockRejectedValueOnce(new Error("disk full"));
  if (failure === "model") installed.mockRejectedValueOnce(new Error("cache unavailable"));
  await expect(importSettingsBackup(failure === "file" ? "{}" : backup(true))).rejects.toThrow();
  expect(storage).toEqual(before);
  expect((await importSettingsBackup(backup())).settings.targetLang).toBe("ja");
});
it("serializes replacement with pending ordinary settings writes", async () => {
  let release!: () => void;
  const previous = saveSettings(async latest => {
    await new Promise<void>(resolve => { release = resolve; });
    return { ...latest, targetLang: "fr" };
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const restore = importSettingsBackup(backup());
  release();
  await Promise.all([previous, restore]);
  expect((await getSettings()).targetLang).toBe("ja");
});
