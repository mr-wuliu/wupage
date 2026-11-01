// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";

describe("options provider model and test state", () => {
  let stored: ExtensionSettings;
  let testService: Mock<(providerId?: string) => Promise<RuntimeResponse>>;

  beforeEach(() => {
    vi.resetModules();
    document.open();
    document.write(readFileSync(resolve(process.cwd(), "options.html"), "utf8"));
    document.close();
    stored = structuredClone(DEFAULT_SETTINGS);
    stored.activeProviderId = "deepseek";
    testService = vi.fn(async () => ({ ok: true, data: { translation: "你好" } }));
    vi.stubGlobal("chrome", { runtime: {
      sendMessage: async (request: RuntimeRequest): Promise<RuntimeResponse> => {
        if (request.type === "GET_SETTINGS") return { ok: true, data: structuredClone(stored) };
        if (request.type === "SAVE_SETTINGS") stored = normalizeSettings(request.settings);
        if (request.type === "TEST_PROVIDER") return testService(request.providerId);
        if (request.type === "GET_OCR_STATUS") {
          return { ok: true, data: { state: "installed", downloaded: 100, total: 100 } };
        }
        return { ok: true };
      }
    } });
  });

  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    vi.unstubAllGlobals();
    document.documentElement.replaceChildren();
  });

  async function mount(): Promise<void> {
    await import("../src/options/index");
    await vi.waitFor(() => expect(query<HTMLElement>("#providerForm").dataset.providerId).toBe(stored.activeProviderId));
  }

  async function selectProvider(id: string): Promise<void> {
    query<HTMLButtonElement>("#providerTrigger").click();
    query<HTMLButtonElement>(`[data-action='select'][data-provider-id='${id}']`).click();
    await vi.waitFor(() => expect(query<HTMLElement>("#providerForm").dataset.providerId).toBe(id));
  }

  it("edits and saves a disabled service while retaining the enabled translation service", async () => {
    stored.providers.find(entry => entry.id === "zhipu-glm")!.enabled = false;
    await mount();
    expect(query<HTMLButtonElement>("[data-action='select'][data-provider-id='zhipu-glm']").disabled).toBe(false);
    await selectProvider("zhipu-glm");
    expect(stored.activeProviderId).toBe("deepseek");
    expect(query<HTMLElement>("#disabledProviderHint").hidden).toBe(false);
    query<HTMLInputElement>("[data-field='apiKey']").value = "disabled-draft-key";
    query<HTMLSelectElement>("[data-field='model']").value = "glm-4.7-flash";
    query<HTMLButtonElement>("#providerAdvancedTab").click();
    query<HTMLInputElement>("[data-field='requestTemplateEnabled']").click();
    query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']").value = '{"enable_thinking":false}';
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已保存。"));
    expect(query<HTMLElement>("#providerForm").dataset.providerId).toBe("zhipu-glm");
    expect(stored.activeProviderId).toBe("deepseek");
    expect(stored.providers.find(entry => entry.id === "zhipu-glm")).toMatchObject({ enabled: false,
      apiKey: "disabled-draft-key", model: "glm-4.7-flash", requestTemplate: { enabled: true, body: '{"enable_thinking":false}' } });
    expect(stored.providers.find(entry => entry.id === "deepseek")).toMatchObject({ apiKey: "", model: "deepseek-flash" });
    await selectProvider("deepseek"); await selectProvider("zhipu-glm");
    expect(query<HTMLInputElement>("[data-field='apiKey']").value).toBe("disabled-draft-key");
    expect(query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']").value).toBe('{"enable_thinking":false}');
  });

  it("keeps a service open when disabling it and tests its draft without enabling it", async () => {
    await mount();
    query<HTMLButtonElement>("#providerTrigger").click();
    query<HTMLButtonElement>("[data-action='toggle'][data-provider-id='deepseek']").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#disabledProviderHint").hidden).toBe(false));
    expect(query<HTMLElement>("#providerForm").dataset.providerId).toBe("deepseek");
    expect(stored.activeProviderId).toBe("microsoft-web-translate");
    expect(query<HTMLButtonElement>("[data-action='select'][data-provider-id='deepseek']").getAttribute("aria-selected")).toBe("true");
    query<HTMLInputElement>("[data-field='apiKey']").value = "test-before-enabling";
    query<HTMLButtonElement>("#test").click();
    await vi.waitFor(() => expect(testService).toHaveBeenCalledWith("deepseek"));
    await vi.waitFor(() => expect(query<HTMLElement>("[data-role='provider-test-status']").textContent).toBe("测试通过：你好"));
    expect(stored.providers.find(entry => entry.id === "deepseek")).toMatchObject({ enabled: false, apiKey: "test-before-enabling" });
    expect(stored.activeProviderId).toBe("microsoft-web-translate");
  });

  it("shows provider defaults without saving them as overrides and loads an editable copy", async () => {
    Object.assign(stored.providers.find(entry => entry.id === "deepseek")!, { apiKey: "saved-test-secret" });
    await mount();
    query<HTMLButtonElement>("#providerAdvancedTab").click();
    const headers = query<HTMLTextAreaElement>("[data-field='requestHeadersTemplate']");
    const body = query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']");
    expect(JSON.parse(headers.value)).toEqual({ "Content-Type": "application/json", Authorization: "Bearer {{apiKey}}" });
    expect(headers.value).not.toContain("saved-test-secret");
    expect(JSON.parse(body.value)).toMatchObject({ model: "{{model}}", thinking: { type: "disabled" }, temperature: 0 });
    expect(query<HTMLFieldSetElement>("#requestTemplateFields").disabled).toBe(true);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已保存。"));
    expect(stored.providers.find(entry => entry.id === "deepseek")).toMatchObject({ requestTemplate: undefined });
    query<HTMLButtonElement>("[data-action='load-default-request-template']").click();
    expect(query<HTMLFieldSetElement>("#requestTemplateFields").disabled).toBe(false);
    expect(query<HTMLInputElement>("[data-field='requestTemplateEnabled']").checked).toBe(true);
    const editableBody = query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']");
    editableBody.value = editableBody.value.replace('"disabled"', '"enabled"');
    const loadedBody = editableBody.value;
    const loadedHeaders = query<HTMLTextAreaElement>("[data-field='requestHeadersTemplate']").value;
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.providers.find(entry => entry.id === "deepseek")).toMatchObject({ requestTemplate: {
      enabled: true, headers: loadedHeaders, body: loadedBody
    } }));
    await selectProvider("openai-compatible");
    expect(JSON.parse(query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']").value)).not.toHaveProperty("thinking");
    await selectProvider("deepseek");
    expect(JSON.parse(query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']").value).thinking.type).toBe("enabled");
  });

  it("updates default authentication placeholders with the draft key without overwriting custom headers", async () => {
    await mount();
    const key = query<HTMLInputElement>("[data-field='apiKey']");
    const headers = query<HTMLTextAreaElement>("[data-field='requestHeadersTemplate']");
    expect(JSON.parse(headers.value)).not.toHaveProperty("Authorization");
    key.value = "draft-secret"; key.dispatchEvent(new Event("input", { bubbles: true }));
    expect(JSON.parse(headers.value).Authorization).toBe("Bearer {{apiKey}}");
    expect(headers.value).not.toContain("draft-secret");
    headers.value = '{"x-custom":"saved"}';
    key.value = ""; key.dispatchEvent(new Event("input", { bubbles: true }));
    expect(headers.value).toBe('{"x-custom":"saved"}');
  });

  it("keeps form drafts when changing tabs and supports arrow-key navigation", async () => {
    await mount();
    const key = query<HTMLInputElement>("[data-field='apiKey']");
    key.value = "draft-key";
    const general = query<HTMLButtonElement>("#providerGeneralTab");
    general.focus();
    general.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(query("#providerAdvancedTab"));
    expect(query<HTMLElement>("#providerGeneralPanel").hidden).toBe(true);
    expect(query<HTMLElement>("#providerAdvancedPanel").hidden).toBe(false);
    query<HTMLInputElement>("[data-field='requestTemplateEnabled']").click();
    const body = query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']");
    body.value = '{"enable_thinking":false}';
    query<HTMLButtonElement>("#providerGeneralTab").click();
    expect(query<HTMLInputElement>("[data-field='apiKey']")).toBe(key);
    expect(key.value).toBe("draft-key");
    query<HTMLButtonElement>("#providerAdvancedTab").click();
    expect(query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']")).toBe(body);
    expect(body.value).toBe('{"enable_thinking":false}');
  });

  it("saves per-service templates, tests them from the advanced tab, and retains disabled drafts", async () => {
    await mount();
    query<HTMLButtonElement>("#providerAdvancedTab").click();
    query<HTMLInputElement>("[data-field='requestTemplateEnabled']").click();
    query<HTMLTextAreaElement>("[data-field='requestHeadersTemplate']").value = '{"x-opencode-session":"wupage"}';
    query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']").value = '{"thinking":{"type":"enabled"}}';
    query<HTMLButtonElement>("[data-action='test-provider']").click();
    await vi.waitFor(() => expect(testService).toHaveBeenCalledWith("deepseek"));
    await vi.waitFor(() => expect(query<HTMLElement>("[data-role='provider-test-status']").textContent).toBe("测试通过：你好"));
    expect(query<HTMLElement>("[data-role='provider-test-status']").closest("[role='tabpanel']")).toBeNull();
    expect(stored.providers.find(entry => entry.id === "deepseek")).toMatchObject({ requestTemplate: {
      enabled: true, headers: '{"x-opencode-session":"wupage"}', body: '{"thinking":{"type":"enabled"}}'
    } });
    await selectProvider("zhipu-glm");
    expect(JSON.parse(query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']").value)).toMatchObject({ model: "{{model}}", temperature: 0 });
    await selectProvider("deepseek");
    expect(query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']").value).toContain('"enabled"');
    query<HTMLInputElement>("[data-field='requestTemplateEnabled']").click();
    expect(query<HTMLFieldSetElement>("#requestTemplateFields").disabled).toBe(true);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.providers.find(entry => entry.id === "deepseek")).toMatchObject({ requestTemplate: { enabled: false } }));
    await selectProvider("zhipu-glm"); await selectProvider("deepseek");
    expect(query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']").value).toContain('"enabled"');
  });

  it("reveals and focuses invalid templates and prevents saving or testing", async () => {
    await mount();
    query<HTMLButtonElement>("#providerAdvancedTab").click();
    query<HTMLInputElement>("[data-field='requestTemplateEnabled']").click();
    const body = query<HTMLTextAreaElement>("[data-field='requestBodyTemplate']");
    body.value = '{"stream":true}';
    query<HTMLButtonElement>("#providerGeneralTab").click();
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query<HTMLElement>("[data-role='request-template-status']").textContent).toContain("非流式"));
    expect(document.activeElement).toBe(body);
    expect(query<HTMLElement>("#providerAdvancedPanel").hidden).toBe(false);
    expect(body.getAttribute("aria-invalid")).toBe("true");
    expect(stored.providers.find(entry => entry.id === "deepseek")).not.toHaveProperty("requestTemplate");
    query<HTMLButtonElement>("[data-action='test-provider']").click();
    await flush();
    expect(testService).not.toHaveBeenCalled();
    body.value = '{"enable_thinking":false}'; body.dispatchEvent(new Event("input", { bubbles: true }));
    expect(query<HTMLElement>("[data-role='request-template-status']").hidden).toBe(true);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.providers.find(entry => entry.id === "deepseek")).toMatchObject({ requestTemplate: { enabled: true } }));
    query<HTMLButtonElement>("[data-action='reset-request-template']").click();
    expect(query<HTMLInputElement>("[data-field='requestTemplateEnabled']").checked).toBe(false);
    expect(JSON.parse(body.value)).toMatchObject({ thinking: { type: "disabled" }, model: "{{model}}" });
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.providers.find(entry => entry.id === "deepseek")).toMatchObject({ requestTemplate: undefined }));
  });

  it("places existing HTTP headers and body in the advanced tab and preserves their legacy syntax", async () => {
    stored.activeProviderId = "http-template";
    await mount();
    expect(query("[data-field='headers']").closest("#providerAdvancedPanel")).not.toBeNull();
    expect(query<HTMLTextAreaElement>("[data-field='bodyTemplate']").value).toContain("{{json texts}}");
    expect(document.querySelector("[data-field='requestTemplateEnabled']")).toBeNull();
    query<HTMLButtonElement>("#providerAdvancedTab").click();
    query<HTMLTextAreaElement>("[data-field='headers']").value = '{"x-session":"http"}';
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.providers.find(entry => entry.id === "http-template")).toMatchObject({ headers: { "x-session": "http" } }));
  });

  it("reveals the default language checkbox with the master switch and preserves an unchecked choice", async () => {
    await mount();
    const enabled = query<HTMLInputElement>("#autoTranslateEnabled");
    const foreign = query<HTMLInputElement>("#autoTranslateNonTarget");
    const option = query<HTMLElement>("#autoTranslateNonTargetOption");
    const siteInput = query<HTMLInputElement>(".auto-site-pattern");
    expect(option.hidden).toBe(true);
    expect(foreign.disabled).toBe(true);
    enabled.click();
    expect(option.hidden).toBe(false);
    expect(foreign.type).toBe("checkbox");
    expect(foreign.disabled).toBe(false);
    expect(foreign.checked).toBe(true);
    foreign.click();
    enabled.click();
    expect(option.hidden).toBe(true);
    expect(foreign.disabled).toBe(true);
    enabled.click();
    expect(foreign.checked).toBe(false);
    expect(query<HTMLInputElement>(".auto-site-pattern")).toBe(siteInput);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.autoTranslation).toMatchObject({ enabled: true, nonTargetLanguage: false }));
    expect(option.hidden).toBe(false);
    expect(foreign.checked).toBe(false);
  });

  it.each([false, true])("preserves the saved site-only choice when automatic translation is enabled: %s", async enabled => {
    stored.autoTranslation = { enabled, nonTargetLanguage: false, presetSites: ["github.com"], customSites: [] };
    await mount();
    expect(query<HTMLElement>("#autoTranslateNonTargetOption").hidden).toBe(!enabled);
    if (!enabled) query<HTMLInputElement>("#autoTranslateEnabled").click();
    expect(query<HTMLElement>("#autoTranslateNonTargetOption").hidden).toBe(false);
    expect(query<HTMLInputElement>("#autoTranslateNonTarget").checked).toBe(false);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.autoTranslation).toMatchObject({ enabled: true, nonTargetLanguage: false, presetSites: ["github.com"] }));
  });

  it("saves preset, custom-site and language rules with the current provider settings", async () => {
    await mount();
    query<HTMLInputElement>("#autoTranslateEnabled").checked = true;
    query<HTMLInputElement>("#autoTranslateNonTarget").checked = true;
    query<HTMLInputElement>("#autoTranslateSites input[data-preset='github.com']").checked = true;
    query<HTMLButtonElement>("#addAutoTranslateSite").click();
    query<HTMLInputElement>(".auto-site-row:nth-last-child(2) .auto-site-pattern").value = "Example.COM/docs/*";
    expect(document.querySelectorAll(".auto-site-row")).toHaveLength(7);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已保存。"));
    expect(stored.autoTranslation).toMatchObject({ enabled: true, nonTargetLanguage: true,
      presetSites: ["github.com"], customSites: [{ pattern: "example.com/docs/*", enabled: true }] });
    query<HTMLInputElement>(".auto-site-row:nth-last-child(2) .auto-site-enabled").click();
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.autoTranslation?.customSites[0].enabled).toBe(false));
    await selectProvider("zhipu-glm");
    expect(query<HTMLInputElement>("#autoTranslateEnabled").checked).toBe(true);
    query<HTMLButtonElement>(".auto-site-row:nth-last-child(2) button").click();
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.autoTranslation?.customSites).toHaveLength(0));
    query<HTMLButtonElement>(".auto-site-row[data-site-id='preset-github.com'] button").click();
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.autoTranslation?.removedPresetSites).toContain("github.com"));
    expect(document.querySelector(".auto-site-row[data-site-id='preset-github.com']")).toBeNull();
    expect(stored.autoTranslation?.presetSites).toEqual([]);
  });

  it("edits preset sites inline and keeps the original preset removed after saving", async () => {
    await mount();
    query<HTMLInputElement>(".auto-site-row[data-site-id='preset-github.com'] .auto-site-pattern").value = "docs.example.com/*";
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.autoTranslation?.customSites).toEqual([
      { id: "preset-github.com", pattern: "docs.example.com/*", enabled: false }
    ]));
    expect(stored.autoTranslation?.removedPresetSites).toEqual(["github.com"]);
    expect(document.querySelectorAll(".auto-site-row")).toHaveLength(6);
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已保存。"));
    expect(document.querySelector("input[data-preset='github.com']")).toBeNull();
  });

  it("keeps invalid or duplicate draft rows editable instead of saving incomplete rules", async () => {
    await mount();
    query<HTMLButtonElement>("#addAutoTranslateSite").click();
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#autoTranslateSiteStatus").textContent).toContain("第 7 行"));
    const input = query<HTMLInputElement>(".auto-site-row:nth-last-child(2) .auto-site-pattern");
    expect(document.activeElement).toBe(input);
    input.value = "GITHUB.COM";
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#autoTranslateSiteStatus").textContent).toContain("已经存在"));
    expect(stored.autoTranslation?.customSites).toEqual([]);
    input.value = "example.com/docs/*";
    query<HTMLButtonElement>("#save").click();
    await vi.waitFor(() => expect(stored.autoTranslation?.customSites[0].pattern).toBe("example.com/docs/*"));
  });

  it.each(["tencent-transmart", "yandex-web-translate", "volcengine-web-translate", "mymemory"])(
    "configures the preloaded %s service without a model or key", async id => {
      stored.activeProviderId = id;
      await mount();
      expect(document.querySelector("#providerForm [data-field='apiKey']")).toBeNull();
      expect(document.querySelector("#providerModel")).toBeNull();
      expect(document.querySelector("#translationFreeHint")).toBeNull();
      expect(document.querySelector("#providerTriggerIcon svg")).not.toBeNull();
      if (id === "mymemory") expect(query<HTMLElement>("#providerForm").textContent).toContain("5,000");
      query<HTMLButtonElement>("#save").click();
      await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已保存。"));
      expect(stored.activeProviderId).toBe(id);
      expect(stored.providers.find(entry => entry.id === id)).toMatchObject({ type: id, enabled: true });
    }
  );

  it.each(["microsoft-web-translate", "google-web-translate", "tencent-transmart", "yandex-web-translate", "volcengine-web-translate", "mymemory"])(
    "switches %s between free and API without losing credentials or refreshing the form", async id => {
      stored.activeProviderId = id;
      await mount();
      const mode = query<HTMLSelectElement>("[data-field='serviceMode']");
      const label = query<HTMLInputElement>("[data-field='label']");
      expect(mode.value).toBe("free");
      expect(query<HTMLElement>("#translationApiFields").hidden).toBe(true);
      mode.value = "api"; mode.dispatchEvent(new Event("change", { bubbles: true }));
      expect(query<HTMLElement>("#translationApiFields").hidden).toBe(false);
      const key = query<HTMLInputElement>(id === "volcengine-web-translate" ? "[data-api-field='secretAccessKey']" : "[data-api-field='apiKey']");
      key.value = "example-user-key";
      mode.value = "free"; mode.dispatchEvent(new Event("change", { bubbles: true }));
      expect(query<HTMLElement>("#translationApiFields").hidden).toBe(true);
      expect(query<HTMLInputElement>("[data-field='label']")).toBe(label);
      mode.value = "api"; mode.dispatchEvent(new Event("change", { bubbles: true }));
      expect(key.value).toBe("example-user-key");
      query<HTMLButtonElement>("#save").click();
      await vi.waitFor(() => expect(stored.providers.find(entry => entry.id === id)).toMatchObject({ serviceMode: "api", api: {
        [id === "volcengine-web-translate" ? "secretAccessKey" : "apiKey"]: "example-user-key"
      } }));
      await selectProvider("deepseek");
      await selectProvider(id);
      expect(query<HTMLSelectElement>("[data-field='serviceMode']").value).toBe("api");
      query<HTMLSelectElement>("[data-field='serviceMode']").value = "free";
      query<HTMLButtonElement>("#save").click();
      await vi.waitFor(() => expect(stored.providers.find(entry => entry.id === id)).toMatchObject({ serviceMode: "free", api: {
        [id === "volcengine-web-translate" ? "secretAccessKey" : "apiKey"]: "example-user-key"
      } }));
    }
  );

  it("refreshes usage by service mode and scheduling inputs without replacing credential fields", async () => {
    stored.activeProviderId = "microsoft-web-translate";
    await mount();
    const label = query<HTMLInputElement>("[data-field='label']");
    const usage = query<HTMLElement>("#providerUsage");
    expect(usage.textContent).toContain("匿名");
    expect(usage.textContent).not.toContain("每月 200 万字符");
    const mode = query<HTMLSelectElement>("[data-field='serviceMode']");
    mode.value = "api"; mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect(usage.textContent).toContain("每月 200 万字符");
    expect(usage.querySelector("a[href*='translator/service-limits']")).not.toBeNull();
    const official = usage.querySelector("dl");
    query<HTMLInputElement>("#concurrency").value = "2";
    query<HTMLInputElement>("#concurrency").dispatchEvent(new Event("input", { bubbles: true }));
    expect(usage.querySelector("[data-role='provider-scheduling']")?.textContent).toContain("调度并发 2");
    expect(usage.querySelector("dl")).toBe(official);
    expect(query<HTMLInputElement>("[data-field='label']")).toBe(label);
    mode.value = "free"; mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect(usage.textContent).not.toContain("每月 200 万字符");
  });

  it("updates model-specific usage and removes official claims when the API address becomes custom", async () => {
    await mount();
    const model = query<HTMLSelectElement>("#providerModel");
    model.value = "deepseek-v4-pro"; model.dispatchEvent(new Event("change", { bubbles: true }));
    expect(query<HTMLElement>("#providerUsage").textContent).toContain("每账号 500 并发");
    const endpoint = query<HTMLInputElement>("[data-field='baseURL']");
    endpoint.value = "https://example.com/v1"; endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    expect(query<HTMLElement>("#providerUsage").textContent).not.toContain("每账号 500 并发");
    expect(query<HTMLElement>("#providerUsage").querySelectorAll("a")).toHaveLength(0);
  });

  it.each(["deepseek", "zhipu-glm", "openai-compatible", "anthropic-compatible"])(
    "preserves a previously configured %s model when selecting another model", async id => {
      stored.activeProviderId = id;
      if (id === "anthropic-compatible") stored.providers.push({
        type: "anthropic-compatible", id, label: "Custom Anthropic", model: "legacy-custom-model",
        baseURL: "https://example.com/v1", apiKey: "", systemPrompt: "Translate"
      });
      const provider = stored.providers.find(entry => entry.id === id)!;
      Object.assign(provider, { model: "legacy-custom-model", apiKey: "saved-test-key", baseURL: "https://example.com/v1" });
      if (id === "anthropic-compatible") provider.customModels = ["another-model"];
      await mount();
      const model = query<HTMLSelectElement>("#providerModel");
      const alternate = Array.from(model.options).find(option => option.value !== "legacy-custom-model")!.value;
      model.value = alternate;
      query<HTMLButtonElement>("#save").click();
      await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("已保存。"));
      expect(Array.from(query<HTMLSelectElement>("#providerModel").options, option => option.value))
        .toContain("legacy-custom-model");
      expect(stored.providers.find(entry => entry.id === id)).toMatchObject({
        model: alternate, apiKey: "saved-test-key", baseURL: "https://example.com/v1",
        customModels: expect.arrayContaining(["legacy-custom-model"])
      });
      query<HTMLSelectElement>("#providerModel").value = "legacy-custom-model";
      query<HTMLButtonElement>("#save").click();
      await vi.waitFor(() => expect(stored.providers.find(entry => entry.id === id))
        .toMatchObject({ model: "legacy-custom-model" }));
    }
  );

  it.each([true, false])("ignores a late test result after switching services (success: %s)", async success => {
    const pending = deferred<RuntimeResponse>();
    testService.mockReturnValueOnce(pending.promise);
    await mount();
    query<HTMLButtonElement>("#test").click();
    await vi.waitFor(() => expect(testService).toHaveBeenCalledWith("deepseek"));
    await selectProvider("zhipu-glm");
    const message = query<HTMLElement>("#status").textContent;
    pending.resolve(testResult(success, "旧服务结果"));
    await flush();
    expect(query<HTMLElement>("[data-role='provider-test-status']").hidden).toBe(true);
    expect(query<HTMLElement>("#status").textContent).toBe(message);
  });

  it("does not restore an old result after switching away and back to the same service", async () => {
    const pending = deferred<RuntimeResponse>();
    testService.mockReturnValueOnce(pending.promise);
    await mount();
    query<HTMLButtonElement>("#test").click();
    await vi.waitFor(() => expect(testService).toHaveBeenCalledTimes(1));
    await selectProvider("zhipu-glm");
    await selectProvider("deepseek");
    pending.resolve(testResult(true, "离开前的结果"));
    await flush();
    expect(query<HTMLElement>("[data-role='provider-test-status']").hidden).toBe(true);
    expect(query<HTMLElement>("#status").textContent).toBe("已切换当前服务。");
  });

  it.each([true, false])("keeps the latest test result when an earlier request finishes (success: %s)", async success => {
    const pending = deferred<RuntimeResponse>();
    testService.mockReturnValueOnce(pending.promise);
    await mount();
    query<HTMLButtonElement>("#test").click();
    await vi.waitFor(() => expect(testService).toHaveBeenCalledTimes(1));
    query<HTMLButtonElement>("#test").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("测试通过：你好"));
    pending.resolve(testResult(success, "较早的结果"));
    await flush();
    expect(query<HTMLElement>("[data-role='provider-test-status']").textContent).toBe("测试通过：你好");
    expect(query<HTMLElement>("#status").textContent).toBe("测试通过：你好");
  });

  it.each([
    ["model", "deepseek-v4-pro", "change"],
    ["apiKey", "updated-test-key", "input"],
    ["baseURL", "https://updated.example/v1", "input"]
  ])("clears test feedback when %s changes and allows testing the updated configuration", async (field, value, event) => {
    const pending = deferred<RuntimeResponse>();
    testService.mockReturnValueOnce(pending.promise);
    await mount();
    query<HTMLButtonElement>("#test").click();
    await vi.waitFor(() => expect(testService).toHaveBeenCalledTimes(1));
    const control = query<HTMLInputElement | HTMLSelectElement>(`[data-field='${field}']`);
    control.value = value;
    control.dispatchEvent(new Event(event, { bubbles: true }));
    expect(query<HTMLElement>("[data-role='provider-test-status']").hidden).toBe(true);
    expect(query<HTMLElement>("#status").textContent).toBe("");
    pending.resolve(testResult(true, "旧模型的结果"));
    await flush();
    expect(query<HTMLElement>("[data-role='provider-test-status']").hidden).toBe(true);
    query<HTMLButtonElement>("#test").click();
    await vi.waitFor(() => expect(query<HTMLElement>("#status").textContent).toBe("测试通过：你好"));
    expect(stored.providers.find(entry => entry.id === "deepseek")).toMatchObject({ [field]: value });
  });
});

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function testResult(success: boolean, message: string): RuntimeResponse {
  return success ? { ok: true, data: { translation: message } } : { ok: false, error: message };
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}
