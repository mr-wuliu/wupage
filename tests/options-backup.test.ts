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
  let ocrState: "installed" | "missing";
  let saveFailures: number;

  beforeEach(() => {
    ocrState = "installed";
    saveFailures = 0;
    vi.resetModules();
    blobs = [];
    downloads = [];
    document.open();
    document.write(readFileSync(resolve(process.cwd(), "options.html"), "utf8"));
    document.close();
    stored = structuredClone(DEFAULT_SETTINGS);
    stored.activeProviderId = "deepseek";
    // A stored key in both shapes: a provider field and a service-mode api block.
    stored.providers = stored.providers.map((provider) => provider.id === "deepseek"
      ? { ...provider, apiKey: "sk-deepseek-secret" } as typeof provider
      : provider.id === "microsoft-web-translate"
        ? { ...provider, serviceMode: "api" as const, api: { apiKey: "azure-secret" } } as typeof provider
        : provider);
    vi.stubGlobal("chrome", { runtime: {
      sendMessage: async (request: RuntimeRequest): Promise<RuntimeResponse> => {
        if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(stored) };
        if (request.type === "SAVE_SETTINGS") {
          if (saveFailures > 0) {
            saveFailures -= 1;
            return { ok: false, error: "请先点击图片翻译旁的扳手安装 OCR 模型。" };
          }
          stored = normalizeSettings(request.settings);
        }
        if (request.type === "GET_OCR_STATUS") {
          return { ok: true, data: { state: ocrState, downloaded: 100, total: 100 } };
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
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toMatch(/^wupage-settings-\d{8}-\d{4}\.json$/);
    const file = JSON.parse(await blobs[0]!.text()) as {
      app: string; kind: string; version: number; settings: ExtensionSettings;
    };
    expect(file).toMatchObject({ app: "wupage", kind: "settings", version: 1 });
    expect(file.settings.activeProviderId).toBe("deepseek");
    expect(file.settings.providers).toHaveLength(stored.providers.length);
    expect(query<HTMLElement>("#backupStatus").textContent).toContain("已导出当前设置");
  });

  it("leaves every key out of an export unless the user opts in", async () => {
    // The reported risk: exporting used to write the keys into a file and said so only in a hint.
    await mount();
    expect(query<HTMLInputElement>("#backupIncludesKeys").checked).toBe(false);
    query<HTMLButtonElement>("#exportSettings").click();
    await vi.waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobs[0]!.text();
    expect(text).not.toContain("sk-deepseek-secret");
    expect(text).not.toContain("azure-secret");
    const file = JSON.parse(text) as { includesKeys: boolean; settings: ExtensionSettings };
    expect(file.includesKeys).toBe(false);
    // The services themselves must survive the strip, not disappear with their keys.
    expect(file.settings.providers).toHaveLength(stored.providers.length);
    expect(file.settings.activeProviderId).toBe("deepseek");
    expect(query<HTMLElement>("#backupStatus").textContent).toContain("未包含翻译服务密钥");
  });

  it("writes the keys when the user turns the option on", async () => {
    await mount();
    query<HTMLInputElement>("#backupIncludesKeys").checked = true;
    query<HTMLButtonElement>("#exportSettings").click();
    await vi.waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobs[0]!.text();
    expect(text).toContain("sk-deepseek-secret");
    expect(text).toContain("azure-secret");
    expect((JSON.parse(text) as { includesKeys: boolean }).includesKeys).toBe(true);
    expect(query<HTMLElement>("#backupStatus").textContent).toContain("文件包含翻译服务密钥");
  });

  it("keeps the stored keys when importing a file that carries none", async () => {
    // Restoring a key-less backup on the same machine must not blank the keys already stored.
    await mount();
    query<HTMLButtonElement>("#exportSettings").click();
    await vi.waitFor(() => expect(blobs).toHaveLength(1));
    const exported = await blobs[0]!.text();
    await vi.waitFor(() => expect(query<HTMLElement>("#backupStatus").textContent).toContain("已导出当前设置"));

    await chooseFile(exported);
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已导入设置。"));
    const deepseek = stored.providers.find((provider) => provider.id === "deepseek");
    expect((deepseek as unknown as Record<string, unknown>).apiKey).toBe("sk-deepseek-secret");
    const microsoft = stored.providers.find((provider) => provider.id === "microsoft-web-translate");
    expect((microsoft as unknown as Record<string, unknown>).api).toMatchObject({ apiKey: "azure-secret" });
    expect(query<HTMLElement>("#backupStatus").textContent).toContain("本机已保存的密钥保持原样");
  });

  it("replaces the stored keys when importing a file that carries them", async () => {
    await mount();
    const incoming = normalizeSettings({
      ...structuredClone(stored),
      providers: stored.providers.map((provider) => provider.id === "deepseek"
        ? { ...provider, apiKey: "sk-from-file" } as typeof provider : provider)
    });
    await chooseFile(JSON.stringify({
      app: "wupage", kind: "settings", version: 1, includesKeys: true, settings: incoming
    }));
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已导入设置。"));
    const deepseek = stored.providers.find((provider) => provider.id === "deepseek");
    expect((deepseek as unknown as Record<string, unknown>).apiKey).toBe("sk-from-file");
    expect(query<HTMLElement>("#backupStatus").textContent).not.toContain("本机已保存的密钥保持原样");
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

  it("exports the saved settings even after the panel copy drifts to the form draft", async () => {
    await mount();
    // Provider actions and the model dialog replace the panel copy with readSettingsFromForm(),
    // so an unsaved edit would reach the file if the export read that copy.
    query<HTMLInputElement>("#chunkSize").value = "777";
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement): void { this.setAttribute("open", ""); }
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement): void { this.removeAttribute("open"); }
    });
    query<HTMLButtonElement>("[data-action='manage-model']").click();
    expect(query<HTMLDialogElement>("#modelDialog").hasAttribute("open")).toBe(true);
    query<HTMLDialogElement>("#modelDialog").close();
    expect(stored.chunkSize).toBe(1200);

    query<HTMLButtonElement>("#exportSettings").click();
    await vi.waitFor(() => expect(blobs).toHaveLength(1));
    const file = JSON.parse(await blobs[0]!.text()) as { settings: ExtensionSettings };
    expect(file.settings.chunkSize).toBe(1200);
    expect(stored.chunkSize).toBe(1200);
  });

  it("downloads once when the export button is clicked twice", async () => {
    await mount();
    const button = query<HTMLButtonElement>("#exportSettings");
    button.click();
    button.click();
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(downloads).toHaveLength(1);
    expect(blobs).toHaveLength(1);
  });

  it("exports settings another entry point saved after the panel loaded", async () => {
    await mount();
    stored = { ...structuredClone(stored), targetLang: "ja", chunkSize: 3200 };
    query<HTMLInputElement>("#chunkSize").value = "1500";
    query<HTMLButtonElement>("#exportSettings").click();
    await vi.waitFor(() => expect(blobs).toHaveLength(1));
    const file = JSON.parse(await blobs[0]!.text()) as { settings: ExtensionSettings };
    expect(file.settings.targetLang).toBe("ja");
    expect(file.settings.chunkSize).toBe(3200);
  });

  it("restores the rest of a backup when the target has no OCR model", async () => {
    await mount();
    ocrState = "missing";
    const incoming = normalizeSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      activeProviderId: "deepseek",
      targetLang: "ja",
      chunkSize: 777,
      imageTranslationEnabled: true
    });
    await chooseFile(JSON.stringify({ app: "wupage", kind: "settings", version: 1, settings: incoming }));
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已导入设置。"));
    // The toggle cannot survive without the model, but the services and keys must still arrive.
    expect(stored.imageTranslationEnabled).toBe(false);
    expect(stored.targetLang).toBe("ja");
    expect(stored.chunkSize).toBe(777);
    expect(stored.providers).toHaveLength(incoming.providers.length);
    expect(query<HTMLInputElement>("#imageTranslationEnabled").checked).toBe(false);
    expect(query<HTMLElement>("#backupStatus").textContent).toContain("未安装 OCR 模型");
  });

  it("keeps the panel and storage untouched when saving an import fails", async () => {
    await mount();
    const before = structuredClone(stored);
    saveFailures = 1;
    const incoming = normalizeSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      activeProviderId: "deepseek",
      targetLang: "ja",
      chunkSize: 777
    });
    incoming.providers.push({
      type: "openai-compatible", id: "imported-service", label: "Imported", baseURL: "https://example.invalid/v1",
      apiKey: "sk-imported", model: "gpt-4o-mini", systemPrompt: "translate"
    });
    await chooseFile(JSON.stringify({ app: "wupage", kind: "settings", version: 1, settings: incoming }));
    await vi.waitFor(() => expect(query<HTMLElement>("#backupStatus").textContent).toContain("OCR 模型"));
    expect(stored).toEqual(before);
    expect((stored.providers ?? []).some((provider) => provider.id === "imported-service")).toBe(false);

    // The failed import must not leak into the next ordinary save either.
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已保存。"));
    expect(stored.providers.some((provider) => provider.id === "imported-service")).toBe(false);
    expect(stored.targetLang).toBe(before.targetLang);
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
