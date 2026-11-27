// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { DoubaoStatus, ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";

vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, OPS: {}, TextLayer: vi.fn(), getDocument: vi.fn() }));

describe("Doubao provider controls", () => {
  let stored: ExtensionSettings;
  let status: DoubaoStatus;
  let sendMessage: ReturnType<typeof vi.fn<(request: RuntimeRequest) => Promise<RuntimeResponse>>>;
  let createTab: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stored = { ...structuredClone(DEFAULT_SETTINGS), activeProviderId: "doubao-web", sourceLang: "en" };
    status = { state: "unknown" };
    sendMessage = vi.fn(async (request: RuntimeRequest): Promise<RuntimeResponse> => {
      if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(stored) };
      if (request.type === "SAVE_SETTINGS") {
        stored = structuredClone(request.settings);
        return { ok: true };
      }
      if (request.type === "GET_DOUBAO_STATUS" || request.type === "CHECK_DOUBAO") return { ok: true, data: status };
      if (request.type === "GET_OCR_STATUS") return { ok: true, data: { state: "installed", total: 100, downloaded: 100 } };
      return { ok: true };
    });
    createTab = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension",
        sendMessage,
        openOptionsPage: vi.fn(),
        getURL: (path: string) => `chrome-extension://test-extension/${path}`
      },
      tabs: { create: createTab, query: vi.fn(async () => [{ id: 1, url: "chrome://extensions/" }]) }
    });
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
    document.documentElement.replaceChildren();
  });

  async function launch(surface: "options" | "popup" | "pdf"): Promise<void> {
    document.open();
    document.write(readFileSync(resolve(process.cwd(), `${surface}.html`), "utf8"));
    document.close();
    if (surface === "options") await import("../src/options/index");
    else if (surface === "popup") await import("../src/popup/index");
    else await import("../src/pdf/index");
    await vi.waitFor(() => expect(query<HTMLSelectElement>("#sourceLang").value).toBe(stored.sourceLang));
    await Promise.resolve();
  }

  it("shows a login flow while saving the ordinary source language selection", async () => {
    await launch("options");
    const source = query<HTMLSelectElement>("#sourceLang");
    expect(source.value).toBe("en");
    expect(source.disabled).toBe(false);
    expect(source.querySelector('option[value="auto"]')?.textContent).toBe("自动检测");
    expect(document.querySelectorAll("#providerForm [data-field]")).toHaveLength(1);
    expect(Array.from(document.querySelectorAll("[data-role='provider-endpoints'] code"), address => address.textContent)).toEqual([
      "https://www.doubao.com/samantha/plugin/stream_article_translate", "https://www.doubao.com/alice/user/launch"
    ]);
    expect(document.querySelector("#providerPerformance .provider-performance")).toBeNull();
    expect(query<HTMLElement>("#providerPerformance").textContent).toContain("1200");
    expect(query<HTMLElement>("#providerUsage").textContent).toContain("豆包（实验性）");
    expect(query<HTMLElement>("#providerForm h3").textContent).toBe("豆包（实验性）");
    expect(createTab).not.toHaveBeenCalled();
    expect(requests("CHECK_DOUBAO")).toHaveLength(0);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(requests("SAVE_SETTINGS")).toHaveLength(1));
    expect(stored.sourceLang).toBe("en");
    expect(stored.providers.find((provider) => provider.id === "doubao-web")).toMatchObject({ performanceMode: "custom", chunkSize: 1200, concurrency: 1 });
    source.value = "ja";
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.sourceLang).toBe("ja"));
    query<HTMLButtonElement>("[data-action='open-doubao']").click();
    expect(createTab).toHaveBeenCalledWith({ url: "https://www.doubao.com/" });
    expect(query<HTMLElement>("[data-role='doubao-status']").textContent).toContain("尚未验证");
    await chooseOptionsProvider("google-web-translate");
    expect(source.value).toBe("ja");
    expect(source.disabled).toBe(false);
    await chooseOptionsProvider("doubao-web");
    source.value = "auto";
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.sourceLang).toBe("auto"));
    expect(source.selectedOptions[0]?.textContent).toBe("自动检测");
  });

  it("merges repeated checks and ignores a completed check after changing services", async () => {
    vi.useFakeTimers();
    let finish!: (response: RuntimeResponse) => void;
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation((request) => request.type === "CHECK_DOUBAO"
      ? new Promise((resolve) => { finish = resolve; }) : original(request));
    await launch("options");
    const check = query<HTMLButtonElement>("[data-action='check-doubao']");
    check.click();
    check.dispatchEvent(new Event("click"));
    query<HTMLButtonElement>("#test").dispatchEvent(new Event("click"));
    expect(requests("CHECK_DOUBAO")).toHaveLength(1);
    expect(check.disabled).toBe(true);
    expect(query<HTMLElement>("[data-role='doubao-status']").textContent).toContain("正在检测");
    await vi.advanceTimersByTimeAsync(1100);
    expect(requests("GET_DOUBAO_STATUS")).toHaveLength(1);
    expect(query<HTMLElement>("[data-role='doubao-status']").textContent).toContain("正在检测");
    await chooseOptionsProvider("google-web-translate");
    finish({ ok: true, data: { state: "ready", checkedAt: Date.now() } satisfies DoubaoStatus });
    await Promise.resolve();
    await Promise.resolve();
    expect(query<HTMLSelectElement>('#providerForm [data-field="serviceMode"]').value).toBe("free");
    expect(query<HTMLElement>("#providerUsage").textContent).toContain("Google Web Translate");
    expect(document.querySelector("[data-role='doubao-status']")).toBeNull();
    expect(query<HTMLButtonElement>("#test").disabled).toBe(false);
    expect(stored.sourceLang).toBe("en");
  });

  it("requests the Doubao site before checking the connection", async () => {
    const grant = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    Object.assign(chrome, { permissions: { request: grant } });
    await launch("options");
    const button = query<HTMLButtonElement>("[data-action='check-doubao']");
    const checkStatus = query<HTMLElement>("[data-role='doubao-status']");

    button.click();
    expect(grant).toHaveBeenCalledWith({ origins: ["https://www.doubao.com:443/*"] });
    await vi.waitFor(() => expect(checkStatus.dataset.state).toBe("permission-required"));
    expect(requests("CHECK_DOUBAO")).toHaveLength(0);

    button.click();
    await vi.waitFor(() => expect(requests("CHECK_DOUBAO")).toHaveLength(1));
  });

  it("does not let an old status read overwrite a successful explicit probe", async () => {
    let finishRead!: (response: RuntimeResponse) => void;
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation((request) => {
      if (request.type === "GET_DOUBAO_STATUS") return new Promise((resolve) => { finishRead = resolve; });
      if (request.type === "CHECK_DOUBAO") return Promise.resolve({ ok: true, data: { state: "ready", checkedAt: 1_700_000_000_000 } satisfies DoubaoStatus });
      return original(request);
    });
    await launch("options");
    query<HTMLButtonElement>("[data-action='check-doubao']").click();
    await vi.waitFor(() => expect(query<HTMLElement>("[data-role='doubao-status']").textContent).toContain("最近一次翻译或检测成功"));
    expect(query<HTMLElement>("[data-role='doubao-status']").textContent).toContain("最近验证");
    finishRead({ ok: true, data: { state: "login-required" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(query<HTMLElement>("[data-role='doubao-status']").dataset.state).toBe("ready");
    expect(requests("TEST_PROVIDER")).toHaveLength(0);
  });

  it("shows the cooldown and enables checking only after it expires", async () => {
    vi.useFakeTimers();
    status = { state: "rate-limited", checkedAt: Date.now(), retryAt: Date.now() + 1500 };
    await launch("options");
    await vi.waitFor(() => expect(query<HTMLElement>("[data-role='doubao-status']").dataset.state).toBe("rate-limited"));
    const check = query<HTMLButtonElement>("[data-action='check-doubao']");
    expect(check.disabled).toBe(true);
    expect(query<HTMLElement>("[data-role='doubao-status']").textContent).toContain("秒后可重试");
    check.click();
    expect(requests("CHECK_DOUBAO")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1510);
    expect(check.disabled).toBe(false);
  });

  it.each(["options", "popup", "pdf"] as const)("keeps Traditional Chinese disabled for Doubao in the %s", async (surface) => {
    stored.targetLang = "zh-TW";
    await launch(surface);
    const target = query<HTMLSelectElement>("#targetLang");
    expect(target.value).toBe("zh-TW");
    expect(target.selectedOptions[0]?.textContent).toBe("繁中");
    expect(target.selectedOptions[0]?.disabled).toBe(true);
    expect(target.title).toContain("豆包暂不支持");
  });

  it.each(["popup", "pdf"] as const)("saves ordinary source language choices across Doubao selections in the %s", async (surface) => {
    stored.targetLang = "pt";
    await launch(surface);
    const source = query<HTMLSelectElement>("#sourceLang");
    const target = query<HTMLSelectElement>("#targetLang");
    const provider = query<HTMLSelectElement>("#provider");
    expect(target.value).toBe("pt");
    expect(target.selectedOptions[0]?.disabled).toBe(true);
    expect(source.value).toBe("en");
    expect(source.disabled).toBe(false);
    expect(source.querySelector('option[value="auto"]')?.textContent).toBe("自动检测");
    source.value = "de";
    source.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.sourceLang).toBe("de"));
    target.value = "ja";
    target.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.targetLang).toBe("ja"));
    expect(stored.sourceLang).toBe("de");
    provider.value = "google-web-translate";
    provider.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.activeProviderId).toBe("google-web-translate"));
    expect(source.disabled).toBe(false);
    expect(source.value).toBe("de");
    expect(stored.sourceLang).toBe("de");
    expect(Array.from(target.options).find((option) => option.value === "pt")?.disabled).toBe(false);
    provider.value = "doubao-web";
    provider.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.activeProviderId).toBe("doubao-web"));
    expect(source.value).toBe("de");
    expect(stored.sourceLang).toBe("de");
    source.value = "auto";
    source.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(stored.sourceLang).toBe("auto"));
    expect(source.selectedOptions[0]?.textContent).toBe("自动检测");
    expect(source.disabled).toBe(false);
    expect(requests("TRANSLATE_BATCH")).toHaveLength(0);
    expect(requests("CHECK_DOUBAO")).toHaveLength(0);
    expect(createTab).not.toHaveBeenCalled();
  });

  it.each(["options", "popup", "pdf"] as const)("keeps the %s usable in Firefox while disabling only Doubao", async (surface) => {
    vi.spyOn(chrome.runtime, "getURL").mockImplementation((path) => `moz-extension://test-extension/${path}`);
    await launch(surface);
    if (surface === "options") {
      expect(query<HTMLButtonElement>("[data-action='select'][data-provider-id='doubao-web']").disabled).toBe(true);
      expect(query<HTMLButtonElement>("[data-action='select'][data-provider-id='google-web-translate']").disabled).toBe(false);
      expect(query<HTMLButtonElement>("[data-action='check-doubao']").disabled).toBe(true);
      expect(query<HTMLElement>("[data-role='doubao-status']").dataset.state).toBe("unsupported-browser");
    } else {
      expect(query<HTMLOptionElement>("#provider option[value='doubao-web']").disabled).toBe(true);
      expect(query<HTMLOptionElement>("#provider option[value='google-web-translate']").disabled).toBe(false);
      expect(query<HTMLButtonElement>('.wupage-provider-choice[data-value="doubao-web"]').disabled).toBe(true);
      expect(query<HTMLButtonElement>('.wupage-provider-choice[data-value="google-web-translate"]').disabled).toBe(false);
      expect(document.body.textContent).toContain("Firefox 尚未支持");
    }
    expect(requests("CHECK_DOUBAO")).toHaveLength(0);
  });

  function requests(type: RuntimeRequest["type"]): RuntimeRequest[] {
    return sendMessage.mock.calls.map(([request]) => request).filter((request) => request.type === type);
  }

  async function chooseOptionsProvider(id: string): Promise<void> {
    query<HTMLButtonElement>(`[data-action='select'][data-provider-id='${id}']`).click();
    await vi.waitFor(() => expect(stored.activeProviderId).toBe(id));
    await vi.waitFor(() => expect(query<HTMLButtonElement>(`[data-action='select'][data-provider-id='${id}']`).getAttribute("aria-selected")).toBe("true"));
  }
});

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
