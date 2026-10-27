import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEY } from "../src/shared/defaults";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

describe("background startup compatibility", () => {
  it.each(["callback-only", "missing-menu", "throwing-menu"])("reads and saves settings with %s context menu APIs", async (mode) => {
    const stored: Record<string, unknown> = {};
    const addListener = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const create = vi.fn();
    const runtime = { onMessage: { addListener }, lastError: undefined as { message: string } | undefined };
    vi.stubGlobal("chrome", {
      runtime,
      storage: { local: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(stored, value); })
      } },
      contextMenus: mode === "missing-menu" ? undefined : {
        update: (_id: string, _properties: unknown, callback?: () => void) => {
          if (mode === "throwing-menu") throw new Error("Menu API unavailable");
          // Chromium before 123 returns undefined and reports errors via callback.
          runtime.lastError = { message: "Menu does not exist" };
          callback?.();
          runtime.lastError = undefined;
        },
        create,
        onClicked: { addListener: vi.fn() }
      }
    });
    await import("../src/background/index");
    expect(addListener).toHaveBeenCalledOnce();
    const receive = addListener.mock.calls[0][0];
    const send = (request: RuntimeRequest): Promise<RuntimeResponse> => new Promise(resolve => {
      expect(receive(request, {}, resolve)).toBe(true);
    });
    const response = await send({ type: "GET_SETTINGS" });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error);
    const settings = response.data as ExtensionSettings;
    expect(settings.providers.length).toBeGreaterThan(0);
    expect(settings.targetLang).toBe("zh-CN");
    const changed = { ...settings, targetLang: "ja", chunkSize: 800 };
    expect((await send({ type: "SAVE_SETTINGS", settings: changed })).ok).toBe(true);
    expect(stored[SETTINGS_KEY]).toMatchObject({ targetLang: "ja", chunkSize: 800 });
    const saved = await send({ type: "GET_SETTINGS" });
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.data).toMatchObject({ targetLang: "ja", chunkSize: 800 });
    if (mode === "callback-only") {
      expect(create).toHaveBeenCalledOnce();
      expect(warning).not.toHaveBeenCalled();
    } else expect(warning).toHaveBeenCalled();
  });
});
