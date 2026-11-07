// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../public/manifest.json";
import english from "../public/_locales/en/messages.json";
import chinese from "../public/_locales/zh_CN/messages.json";
import { htmlMessage, localizeDocument, resolveBridgeMessage, t } from "../src/shared/i18n";
import { catalogApi } from "./helpers/browser-i18n";

describe("extension interface language", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps stale labels readable after reload without retrying invalid APIs or reusing different substitutions", () => {
    const getMessage = vi.fn(catalogApi(english).getMessage);
    vi.stubGlobal("chrome", { i18n: { getMessage } });
    expect(t("retryInS", 7)).toBe("Retry in 7 s");
    getMessage.mockImplementation(() => { throw new Error("Extension context invalidated."); });
    expect(t("retryInS", 7)).toBe("Retry in 7 s");
    expect(t("retryInS", 8)).toBe("__MSG_retryInS__");
    expect(t("retryInS", 7)).toBe("Retry in 7 s");
    expect(getMessage).toHaveBeenCalledTimes(2);
  });

  it("does not hide unrelated localization failures", () => {
    vi.stubGlobal("chrome", { i18n: { getMessage: () => { throw new Error("Unexpected locale failure"); } } });
    expect(() => t("retryInS", 7)).toThrow("Unexpected locale failure");
  });

  it("ships the same messages and substitutions for both browser locales", () => {
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english) as (keyof typeof english)[]) {
      const en = english[key], zh = chinese[key];
      expect(en.message.trim(), key).toBeTruthy();
      expect(zh.message.trim(), key).toBeTruthy();
      const placeholders = "placeholders" in en ? en.placeholders : {};
      expect("placeholders" in zh ? zh.placeholders : {}, key).toEqual(placeholders);
      for (const message of [en.message, zh.message]) {
        const tokens = [...new Set(message.match(/\$[A-Z0-9_]+\$/g) ?? [])].sort();
        expect(tokens, key).toEqual(Object.keys(placeholders).map(name => "$" + name.toUpperCase() + "$").sort());
      }
    }
    expect(manifest.default_locale).toBe("en");
    for (const token of [manifest.name, manifest.action.default_title, manifest.description]) {
      expect(english).toHaveProperty(token.slice(6, -2));
    }
  });

  it.each([["en", english], ["zh-CN", chinese]] as const)("localizes all three extension pages in %s", (locale, messages) => {
    vi.stubGlobal("chrome", { i18n: catalogApi(messages) });
    for (const file of ["options.html", "popup.html", "pdf.html"]) {
      const doc = new DOMParser().parseFromString(readFileSync(file, "utf8"), "text/html");
      const controls = [...doc.querySelectorAll("input, select, button, a, [data-wupage-icon]")];
      localizeDocument(doc);
      expect(doc.documentElement.lang).toBe(locale);
      expect(doc.documentElement.outerHTML).not.toContain("__MSG_");
      expect(doc.querySelector("[data-i18n=sourceLanguage]")?.textContent?.trim()).toBe(messages.sourceLanguage.message);
      expect(controls.every(control => doc.contains(control))).toBe(true);
    }
    expect(t("retryInS", 7)).toBe(locale === "en" ? "Retry in 7 s" : "等待 7 秒后重试");
    expect(resolveBridgeMessage("__MSG_ocrHasNotBeenInitialized__")).toBe(messages.ocrHasNotBeenInitialized.message);
    expect(htmlMessage("delete", '<img src="x">')).toContain("&lt;img src=&quot;x&quot;&gt;");
  });

  it("localizes old built-in names without changing user names or translation languages", async () => {
    vi.stubGlobal("chrome", { i18n: catalogApi(english) });
    vi.resetModules();
    const { normalizeSettings } = await import("../src/shared/settings");
    const settings = normalizeSettings({ sourceLang: "ja", targetLang: "fr", providers: [
      { type: "microsoft-web-translate", id: "microsoft-web-translate", label: "Microsoft 翻译" },
      { type: "google-web-translate", id: "google-web-translate", label: "我的翻译服务" }
    ] });
    expect(settings.providers.find(p => p.id === "microsoft-web-translate")?.label).toBe("Microsoft Translator");
    expect(settings.providers.find(p => p.id === "google-web-translate")?.label).toBe("我的翻译服务");
    expect(settings).toMatchObject({ sourceLang: "ja", targetLang: "fr" });
  });

  it("loads a saved interface override and follows the browser again after reset", async () => {
    vi.resetModules();
    const i18n = await import("../src/shared/i18n");
    const { DEFAULT_SETTINGS } = await import("../src/shared/defaults");
    const { SOURCE_LANGUAGES } = await import("../src/shared/languages");
    const key = i18n.INTERFACE_LANGUAGE_KEY;
    let change!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
    const fetchCatalog = vi.fn(async () => new Response(JSON.stringify(english)));
    vi.stubGlobal("fetch", fetchCatalog);
    vi.stubGlobal("chrome", {
      i18n: catalogApi(chinese),
      runtime: { getURL: (path: string) => `chrome-extension://wupage/${path}` },
      storage: {
        local: { get: async () => ({ [key]: "en" }) },
        onChanged: { addListener: (listener: typeof change) => { change = listener; } }
      }
    });
    await i18n.initializeInterfaceLanguage();
    i18n.watchInterfaceLanguage();
    expect(fetchCatalog).toHaveBeenCalledWith("chrome-extension://wupage/_locales/en/messages.json");
    expect(i18n.getInterfaceLanguage()).toBe("en");
    expect(i18n.t("retryInS", 7)).toBe("Retry in 7 s");
    expect(i18n.resolveBridgeMessage("__MSG_ocrHasNotBeenInitialized__")).toBe(english.ocrHasNotBeenInitialized.message);
    expect(SOURCE_LANGUAGES[0].label).toBe("Detect language");
    expect(DEFAULT_SETTINGS.providers[0].label).toBe("Microsoft Translator");
    expect(DEFAULT_SETTINGS.targetLang).toBe("zh-CN");

    change({ [key]: { oldValue: "en", newValue: "browser" } }, "local");
    await i18n.initializeInterfaceLanguage();
    expect(i18n.getInterfaceLanguage()).toBe("browser");
    expect(i18n.t("retryInS", 7)).toBe("等待 7 秒后重试");
    expect(SOURCE_LANGUAGES[0].label).toBe("自动检测");
    expect(fetchCatalog).toHaveBeenCalledOnce();
  });

  it("loads and refreshes the background locale in runtime-only offscreen documents", async () => {
    vi.resetModules();
    vi.stubGlobal("browser", undefined);
    let language = { selected: "browser", locale: "zh-CN" };
    const sendMessage = vi.fn(async () => language);
    const fetchCatalog = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/zh_CN/") ? chinese : english)));
    vi.stubGlobal("fetch", fetchCatalog);
    vi.stubGlobal("chrome", { runtime: {
      getURL: (path: string) => `chrome-extension://wupage/${path}`, sendMessage
    } });
    const i18n = await import("../src/shared/i18n");
    await Promise.all([i18n.initializeInterfaceLanguage(), i18n.initializeInterfaceLanguage()]);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ target: "wupage-interface-language" });
    expect(i18n.t("downloadedDataWasKeptRetryOrImportOffline", "HTTP 503")).toBe("HTTP 503 已保留完成的数据，可重试或离线导入。");
    language = { selected: "en", locale: "en" };
    await i18n.initializeInterfaceLanguage();
    expect(i18n.getInterfaceLanguage()).toBe("en");
    expect(i18n.t("downloadedDataWasKeptRetryOrImportOffline", "HTTP 503")).toBe("HTTP 503 Downloaded data was kept. Retry or import offline.");
    await i18n.initializeInterfaceLanguage();
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
  });

  it("only shares the effective locale with extension runtime documents", async () => {
    vi.resetModules();
    let listener!: (request: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
    vi.stubGlobal("chrome", {
      i18n: catalogApi(chinese),
      runtime: { id: "wupage", onMessage: { addListener: (handler: typeof listener) => { listener = handler; } } },
      storage: { local: { get: async () => ({}) } }
    });
    const i18n = await import("../src/shared/i18n");
    i18n.watchInterfaceLanguage();
    const reply = vi.fn();
    const request = { target: "wupage-interface-language" };
    expect(listener(request, { id: "other" }, reply)).toBeUndefined();
    expect(listener(request, { id: "wupage", tab: { id: 1 } as chrome.tabs.Tab }, reply)).toBeUndefined();
    expect(reply).not.toHaveBeenCalled();
    expect(listener(request, { id: "wupage" }, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ selected: "browser", locale: "zh-CN" }));
  });
});
