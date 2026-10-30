// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";

describe("options settings backup", () => {
  let stored: ExtensionSettings;
  let blobs: Blob[];
  let downloads: string[];

  beforeEach(() => {
    vi.resetModules();
    blobs = [];
    downloads = [];
    document.open();
    document.write(readFileSync(resolve(process.cwd(), "options.html"), "utf8"));
    document.close();
    stored = structuredClone(DEFAULT_SETTINGS);
    stored.activeProviderId = "deepseek";
    vi.stubGlobal("chrome", { runtime: {
      sendMessage: async (request: RuntimeRequest): Promise<RuntimeResponse> => {
        if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(stored) };
        if (request.type === "SAVE_SETTINGS") stored = normalizeSettings(request.settings);
        if (request.type === "GET_OCR_STATUS") {
          return { ok: true, data: { state: "installed", downloaded: 100, total: 100 } };
        }
        return { ok: true };
      }
    } });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: (blob: Blob): string => { blobs.push(blob); return "blob:wupage-backup"; }
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: (): void => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement): void {
      downloads.push(this.download);
    });
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    document.documentElement.replaceChildren();
  });

  async function mount(): Promise<void> {
    await import("../src/options/index");
    await vi.waitFor(() => expect(query<HTMLInputElement>("#chunkSize").value).toBe(String(stored.chunkSize)));
  }

  async function chooseFile(text: string): Promise<void> {
    const input = query<HTMLInputElement>("#importSettingsFile");
    const file = new File([text], "wupage-settings.json", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
  }

  function query<T extends Element>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`missing ${selector}`);
    return element;
  }

  it("downloads the stored settings as a backup file", async () => {
    await mount();
    query<HTMLButtonElement>("#exportSettings").click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^wupage-settings-\d{8}-\d{4}\.json$/);
    const file = JSON.parse(await blobs[0]!.text()) as {
      app: string; kind: string; version: number; settings: ExtensionSettings;
    };
    expect(file).toMatchObject({ app: "wupage", kind: "settings", version: 1 });
    expect(file.settings.activeProviderId).toBe("deepseek");
    expect(file.settings.providers).toHaveLength(stored.providers.length);
    expect(query<HTMLElement>("#backupStatus").textContent).toContain("已导出当前设置");
  });

  it("imports a backup over the stored settings and refreshes the form", async () => {
    await mount();
    const incoming = normalizeSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      activeProviderId: "deepseek",
      targetLang: "ja",
      chunkSize: 777,
      cacheEnabled: false
    });
    await chooseFile(JSON.stringify({
      app: "wupage", kind: "settings", version: 1, exportedAt: "2026-02-03T04:05:06.000Z", settings: incoming
    }));
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已导入设置。"));
    expect(stored.targetLang).toBe("ja");
    expect(stored.chunkSize).toBe(777);
    expect(stored.cacheEnabled).toBe(false);
    expect(query<HTMLSelectElement>("#targetLang").value).toBe("ja");
    expect(query<HTMLInputElement>("#chunkSize").value).toBe("777");
    expect(query<HTMLInputElement>("#cacheEnabled").checked).toBe(false);
    expect(query<HTMLElement>("#backupStatus").textContent).toContain("已导入设置");
  });

  it("reports why a file cannot be imported and keeps the stored settings", async () => {
    await mount();
    const before = structuredClone(stored);
    await chooseFile("not json");
    await vi.waitFor(() => expect(query<HTMLElement>("#backupStatus").textContent).toContain("不是有效的 JSON"));
    expect(stored).toEqual(before);

    await chooseFile(JSON.stringify({ hello: "world" }));
    await vi.waitFor(() => expect(query<HTMLElement>("#backupStatus").textContent)
      .toContain("没有可识别的 WuPage 设置"));
    expect(stored).toEqual(before);
    expect(query<HTMLElement>("#status").textContent).toBe("");
  });
});
