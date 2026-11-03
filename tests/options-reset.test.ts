// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";

let stored: ExtensionSettings;
const send = vi.fn();
const query = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const resets = () => send.mock.calls.filter(([request]) => request.type === "RESET_SETTINGS");

beforeEach(async () => {
  vi.resetModules();
  document.open(); document.write(readFileSync("options.html", "utf8")); document.close();
  stored = normalizeSettings({ ...structuredClone(DEFAULT_SETTINGS), targetLang: "ja", activeProviderId: "deepseek" });
  Object.assign(stored.providers.find(p => p.type === "deepseek")!, { apiKey: "saved-private-key" });
  stored.providers.push({ type: "http-template", id: "custom-reset-test", label: "Private service", method: "POST",
    url: "https://example.com/translate", headers: { Authorization: "header-private-key" }, bodyTemplate: "{{texts}}", responsePath: "translations" });
  send.mockReset().mockImplementation(async (request: RuntimeRequest) => {
    if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(stored) };
    if (request.type === "GET_OCR_STATUS") return { ok: true, data: { state: "missing", total: 100, downloaded: 0 } };
    if (request.type === "RESET_SETTINGS") stored = normalizeSettings(structuredClone(DEFAULT_SETTINGS));
    if (request.type === "SAVE_SETTINGS") stored = normalizeSettings(request.settings);
    return { ok: true, data: structuredClone(stored) };
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
  query<HTMLDialogElement>("settingsResetDialog").showModal = function () { this.open = true; };
  query<HTMLDialogElement>("settingsResetDialog").close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
  await import("../src/options/index");
  await vi.waitFor(() => expect(query("providerTriggerLabel").textContent).toBe("DeepSeek"));
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules();
  document.documentElement.removeAttribute("style"); document.documentElement.replaceChildren();
});

it("opens an explicit warning with cancel focused and no writes before confirmation", () => {
  const before = structuredClone(stored);
  query<HTMLInputElement>("chunkSize").value = "777";
  query<HTMLButtonElement>("restore").click();
  expect(query("restore").textContent).toBe("完全重置设置");
  expect(query("restore").classList.contains("danger")).toBe(true);
  expect(query("settingsResetWarning").textContent).toMatch(/所有设置.*全部已保存的密钥.*自定义翻译服务/);
  expect(query("settingsResetCaution").textContent).toContain("无法撤销");
  expect(document.activeElement?.id).toBe("cancelSettingsReset");
  expect(resets()).toHaveLength(0); expect(stored).toEqual(before);
  expect(query<HTMLInputElement>("chunkSize").value).toBe("777");
});

it.each(["button", "escape"])("preserves all stored credentials and unsaved edits when cancelled by %s", method => {
  const before = structuredClone(stored);
  query<HTMLInputElement>("chunkSize").value = "777";
  query<HTMLButtonElement>("restore").click();
  if (method === "button") query<HTMLButtonElement>("cancelSettingsReset").click();
  else {
    const event = new Event("cancel", { cancelable: true });
    query("settingsResetDialog").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    query<HTMLDialogElement>("settingsResetDialog").close(); // Native Escape default action.
  }
  expect(stored).toEqual(before); expect(resets()).toHaveLength(0);
  expect(query<HTMLInputElement>("chunkSize").value).toBe("777");
});

it("requires an open confirmation dialog and blocks duplicate writes or dismissal while committing", async () => {
  query<HTMLButtonElement>("confirmSettingsReset").click();
  expect(resets()).toHaveLength(0);
  query<HTMLButtonElement>("restore").click();
  let finish!: (value: unknown) => void;
  const original = send.getMockImplementation()!;
  send.mockImplementation((request: RuntimeRequest) => request.type === "RESET_SETTINGS"
    ? new Promise(resolve => { finish = resolve; }) : original(request));
  query<HTMLButtonElement>("confirmSettingsReset").click();
  query<HTMLButtonElement>("confirmSettingsReset").click();
  await vi.waitFor(() => expect(resets()).toHaveLength(1));
  const event = new Event("cancel", { cancelable: true }); query("settingsResetDialog").dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(query<HTMLButtonElement>("cancelSettingsReset").disabled).toBe(true);
  expect(stored.providers.find(p => p.type === "deepseek")).toMatchObject({ apiKey: "saved-private-key" });
  stored = normalizeSettings(structuredClone(DEFAULT_SETTINGS));
  finish({ ok: true, data: structuredClone(stored) });
  await vi.waitFor(() => expect(query<HTMLDialogElement>("settingsResetDialog").open).toBe(false));
});

it("replaces form state and its save baseline only after confirmed success", async () => {
  query<HTMLInputElement>("chunkSize").value = "777";
  query<HTMLButtonElement>("restore").click(); query<HTMLButtonElement>("confirmSettingsReset").click();
  await vi.waitFor(() => expect(query("status").textContent).toBe("已完全重置设置。"));
  expect(resets()).toHaveLength(1);
  expect(stored).toEqual(normalizeSettings(structuredClone(DEFAULT_SETTINGS)));
  expect(query<HTMLSelectElement>("targetLang").value).toBe(DEFAULT_SETTINGS.targetLang);
  expect(query<HTMLInputElement>("chunkSize").value).toBe(String(DEFAULT_SETTINGS.chunkSize));
  query<HTMLButtonElement>("save").click();
  await vi.waitFor(() => expect(query("status").textContent).toBe("已保存。"));
  expect(stored.providers.find(p => p.type === "deepseek")).toMatchObject({ apiKey: "" });
  expect(stored.providers.some(p => p.id === "custom-reset-test")).toBe(false);
});

it("retains credentials, form edits and baseline after a failed reset, and supports retry", async () => {
  const before = structuredClone(stored);
  query<HTMLInputElement>("chunkSize").value = "777";
  query<HTMLButtonElement>("restore").click();
  send.mockResolvedValueOnce({ ok: false, error: "storage full" });
  query<HTMLButtonElement>("confirmSettingsReset").click();
  await vi.waitFor(() => expect(query("settingsResetStatus").textContent).toContain("storage full"));
  expect(stored).toEqual(before);
  expect(query<HTMLInputElement>("chunkSize").value).toBe("777");
  expect(query<HTMLDialogElement>("settingsResetDialog").open).toBe(true);
  query<HTMLButtonElement>("cancelSettingsReset").click(); query<HTMLButtonElement>("save").click();
  await vi.waitFor(() => expect(stored.chunkSize).toBe(777));
  expect(stored.providers.find(p => p.type === "deepseek")).toMatchObject({ apiKey: "saved-private-key" });
  query<HTMLButtonElement>("restore").click(); query<HTMLButtonElement>("confirmSettingsReset").click();
  await vi.waitFor(() => expect(query("status").textContent).toBe("已完全重置设置。"));
  expect(stored.providers.find(p => p.type === "deepseek")).toMatchObject({ apiKey: "" });
});

it("waits for an earlier save and its form refresh before committing the confirmed reset", async () => {
  let finishRead!: () => void;
  const original = send.getMockImplementation()!;
  send.mockImplementation((request: RuntimeRequest) => {
    if (request.type === "GET_SETTINGS" && stored.chunkSize === 777) {
      const snapshot = structuredClone(stored);
      return new Promise(resolve => { finishRead = () => resolve({ ok: true, data: snapshot }); });
    }
    return original(request);
  });
  query<HTMLInputElement>("chunkSize").value = "777";
  query<HTMLButtonElement>("save").click();
  await vi.waitFor(() => expect(finishRead).toBeTypeOf("function"));
  query<HTMLButtonElement>("restore").click(); query<HTMLButtonElement>("confirmSettingsReset").click();
  await Promise.resolve(); await Promise.resolve();
  expect(resets()).toHaveLength(0);
  finishRead();
  await vi.waitFor(() => expect(query("status").textContent).toBe("已完全重置设置。"));
  expect(query<HTMLInputElement>("chunkSize").value).toBe(String(DEFAULT_SETTINGS.chunkSize));
  expect(stored.providers.find(p => p.type === "deepseek")).toMatchObject({ apiKey: "" });
});
