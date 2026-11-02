// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupInputTranslationControls } from "../src/options/input-translation";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { DEFAULT_INPUT_PROMPT } from "../src/shared/input-translation";
import type { ExtensionSettings, ProviderConfig } from "../src/shared/types";

let root: HTMLElement;
const query = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
const llm = (id: string, apiKey = "test-key") => ({ type: "openai-compatible", id, label: `LLM ${id}`, enabled: true,
  ollamaCompatibility: false, baseURL: "https://llm.test/v1", apiKey, model: "m", systemPrompt: "p" }) as ProviderConfig;
const settingsWith = (providers: ProviderConfig[], extra: Partial<ExtensionSettings> = {}): ExtensionSettings =>
  ({ ...structuredClone(DEFAULT_SETTINGS), providers: [DEFAULT_SETTINGS.providers[0], ...providers], ...extra });

beforeEach(() => {
  const html = new DOMParser().parseFromString(readFileSync(resolve(process.cwd(), "options.html"), "utf8"), "text/html");
  document.body.replaceChildren(html.querySelector("#inputTranslationSettings")!);
  root = document.querySelector("#inputTranslationSettings")!; root.hidden = false;
});
afterEach(() => { document.body.replaceChildren(); });

describe("input translation settings panel", () => {
  it("lists only LLM services, marks incomplete ones and names the service that will be used", () => {
    const controls = setupInputTranslationControls(root);
    controls.render(settingsWith([llm("a", ""), llm("b")]));
    const options = [...query<HTMLSelectElement>("#inputTranslationProvider").options].map(option => [option.value, option.textContent]);
    expect(options).toEqual([["", "自动选择"], ["a", "LLM a（未配置）"], ["b", "LLM b"]]);
    expect(query("#inputTranslationProviderStatus").textContent).toContain("LLM b");
    expect(query<HTMLTextAreaElement>("#inputTranslationPrompt").value).toBe(DEFAULT_INPUT_PROMPT);
  });
  it("tells the user to configure an LLM when none is usable", () => {
    const controls = setupInputTranslationControls(root);
    controls.render(settingsWith([]));
    expect(query("#inputTranslationProviderStatus").textContent).toContain("需要大模型服务");
  });
  it("reads the toggle, chosen service and custom prompt, and restores the default prompt", () => {
    const controls = setupInputTranslationControls(root);
    controls.render(settingsWith([llm("a"), llm("b")], { inputTranslation: { enabled: true, providerId: "b", prompt: "Custom" } }));
    expect(query<HTMLSelectElement>("#inputTranslationProvider").value).toBe("b");
    expect(controls.read()).toEqual({ enabled: true, providerId: "b", prompt: "Custom" });
    query<HTMLButtonElement>("#resetInputTranslationPrompt").click();
    query<HTMLInputElement>("#inputTranslationEnabled").click();
    expect(query<HTMLFieldSetElement>("#inputTranslationFields").disabled).toBe(true);
    expect(controls.read()).toEqual({ enabled: false, providerId: "b", prompt: DEFAULT_INPUT_PROMPT });
  });
  it("keeps a saved service that is no longer listed so it is not silently replaced", () => {
    const controls = setupInputTranslationControls(root);
    controls.render(settingsWith([llm("a")], { inputTranslation: { enabled: true, providerId: "gone", prompt: "p" } }));
    expect(query<HTMLSelectElement>("#inputTranslationProvider").value).toBe("gone");
    expect(query("#inputTranslationProviderStatus").textContent).toContain("LLM a");
    expect(controls.read().providerId).toBe("gone");
  });
});
