// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import { createSettingsBackup, parseSettingsBackup, SETTINGS_BACKUP_MAX_BYTES } from "../src/shared/settings-backup";
import { setupSettingsBackupControls } from "../src/options/settings-backup";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";

let stored: ExtensionSettings;
const imported = vi.fn(), status = vi.fn(), requests = vi.fn();
const query = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let download: Blob | undefined;
const click = vi.fn();
beforeEach(() => {
  document.open(); document.write(readFileSync("options.html", "utf8")); document.close();
  stored = normalizeSettings({ ...structuredClone(DEFAULT_SETTINGS), targetLang: "fr" });
  imported.mockReset(); status.mockReset(); requests.mockReset(); click.mockReset(); download = undefined;
  vi.stubGlobal("chrome", { runtime: { getManifest: () => ({ version: "1.6.1" }), sendMessage: requests } });
  requests.mockImplementation(async (request: RuntimeRequest) => {
    if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(stored) };
    if (request.type === "IMPORT_SETTINGS") {
      stored = parseSettingsBackup(request.backup).settings;
      return { ok: true, data: { settings: structuredClone(stored), imageTranslationDisabled: false } };
    }
    return { ok: true };
  });
  query<HTMLDialogElement>("settingsBackupDialog").showModal = function () { this.open = true; };
  query<HTMLDialogElement>("settingsBackupDialog").close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
  vi.stubGlobal("Blob", NodeBlob);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);
  vi.stubGlobal("URL", Object.assign(class extends URL {}, {
    createObjectURL: vi.fn((blob: Blob) => { download = blob; return "blob:backup"; }), revokeObjectURL: vi.fn()
  }));
  setupSettingsBackupControls({ imported, status });
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.documentElement.replaceChildren();
});
function choose(text: string, size = new TextEncoder().encode(text).length): void {
  const input = query<HTMLInputElement>("settingsBackupFile");
  Object.defineProperty(input, "files", { configurable: true, value: [{ size, text: async () => text }] });
  input.dispatchEvent(new Event("change"));
}
async function previewImport(): Promise<void> {
  choose(JSON.stringify(createSettingsBackup({ ...structuredClone(DEFAULT_SETTINGS), targetLang: "ja" }, "1.6.1")));
  await vi.waitFor(() => expect(query<HTMLDialogElement>("settingsBackupDialog").open).toBe(true));
}

it("exports the latest saved settings only after a visible credential warning and confirmation", async () => {
  // A different settings page saved after this page was opened.
  stored.targetLang = "ja";
  query<HTMLInputElement>("chunkSize").value = "777";
  query<HTMLButtonElement>("exportSettings").click();
  await vi.waitFor(() => expect(query<HTMLDialogElement>("settingsBackupDialog").open).toBe(true));
  expect(query("settingsBackupWarning").textContent).toMatch(/密钥.*未加密/);
  expect(query("settingsBackupWarning").textContent).toContain("未保存");
  expect(document.activeElement).toBe(query("cancelSettingsBackup"));
  expect(download).toBeUndefined();
  query<HTMLButtonElement>("confirmSettingsBackup").click();
  await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
  const result = parseSettingsBackup(await download!.text());
  expect(result.settings).toMatchObject({ targetLang: "ja", chunkSize: DEFAULT_SETTINGS.chunkSize });
  expect(requests.mock.calls.map(([r]) => r.type)).toEqual(["GET_SETTINGS"]);
});
it("cancels exports without a download and allows reopening", async () => {
  const dialog = query<HTMLDialogElement>("settingsBackupDialog");
  // Chromium dispatches close after a rendering opportunity, not inside close().
  dialog.close = function () { this.open = false; };
  query<HTMLButtonElement>("exportSettings").click();
  await vi.waitFor(() => expect(query<HTMLDialogElement>("settingsBackupDialog").open).toBe(true));
  query<HTMLButtonElement>("cancelSettingsBackup").click();
  expect(download).toBeUndefined();
  query<HTMLButtonElement>("exportSettings").click();
  await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(dialog.open).toBe(true));
  dialog.dispatchEvent(new Event("close"));
  query<HTMLButtonElement>("confirmSettingsBackup").click();
  await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
});
it("previews an import without writing, permits cancellation, then accepts the same file", async () => {
  await previewImport();
  expect(query("settingsBackupWarning").textContent).toContain("接收方");
  expect(imported).not.toHaveBeenCalled(); expect(requests).not.toHaveBeenCalled();
  query<HTMLButtonElement>("cancelSettingsBackup").click();
  expect(stored.targetLang).toBe("fr");
  await previewImport();
  query<HTMLButtonElement>("confirmSettingsBackup").click();
  await vi.waitFor(() => expect(imported).toHaveBeenCalledOnce());
  expect(stored.targetLang).toBe("ja");
  expect(status).toHaveBeenLastCalledWith("已导入并保存设置。");
});
it.each(["invalid", "oversized"])("rejects an %s file without modifying settings or opening a confirmation", async kind => {
  const before = structuredClone(stored);
  choose("{}", kind === "oversized" ? SETTINGS_BACKUP_MAX_BYTES + 1 : 2);
  await vi.waitFor(() => expect(status).toHaveBeenCalled());
  expect(requests).not.toHaveBeenCalled(); expect(imported).not.toHaveBeenCalled();
  expect(query<HTMLDialogElement>("settingsBackupDialog").open).toBe(false);
  expect(stored).toEqual(before);
});
it("retains the form and preview on write failure, blocks duplicate submissions, and supports retry", async () => {
  query<HTMLInputElement>("chunkSize").value = "777";
  await previewImport();
  let finish!: (value: unknown) => void;
  requests.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  query<HTMLButtonElement>("confirmSettingsBackup").click();
  query<HTMLButtonElement>("confirmSettingsBackup").click();
  expect(requests).toHaveBeenCalledTimes(1);
  const escape = new Event("cancel", { cancelable: true });
  query("settingsBackupDialog").dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  finish({ ok: false, error: "disk full" });
  await vi.waitFor(() => expect(query("settingsBackupDialogStatus").textContent).toContain("disk full"));
  expect(query<HTMLInputElement>("chunkSize").value).toBe("777");
  expect(imported).not.toHaveBeenCalled();
  expect(query<HTMLDialogElement>("settingsBackupDialog").open).toBe(true);
  query<HTMLButtonElement>("confirmSettingsBackup").click();
  await vi.waitFor(() => expect(imported).toHaveBeenCalledOnce());
});
it("does not show a late export preview after the options page has closed", async () => {
  let finish!: (value: unknown) => void;
  requests.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  query<HTMLButtonElement>("exportSettings").click();
  window.dispatchEvent(new Event("pagehide"));
  finish({ ok: true, data: stored });
  await vi.waitFor(() => expect(query<HTMLButtonElement>("exportSettings").disabled).toBe(false));
  expect(query<HTMLDialogElement>("settingsBackupDialog").open).toBe(false);
});
