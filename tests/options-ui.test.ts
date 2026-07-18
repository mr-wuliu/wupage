// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { normalizeSettings } from "../src/shared/settings";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse } from "../src/shared/types";

describe("options provider controls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
    document.documentElement?.replaceChildren();
  });

  it("adds, toggles, and deletes a custom Anthropic provider", async () => {
    document.open();
    document.write(readFileSync(resolve(process.cwd(), "options.html"), "utf8"));
    document.close();
    let stored = cloneSettings(DEFAULT_SETTINGS);
    const sendMessage = vi.fn(async (request: RuntimeRequest): Promise<RuntimeResponse> => {
      if (request.type === "GET_SETTINGS") return { ok: true, data: stored };
      if (request.type === "SAVE_SETTINGS") {
        stored = normalizeSettings(request.settings);
        return { ok: true, data: null };
      }
      return { ok: true, data: null };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      }
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
      }
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await import("../src/options/index");
    await vi.waitFor(() => {
      expect(document.querySelector("#providerTriggerLabel")?.textContent)
        .toBe("Google Web Translate");
    });
    expect(query<HTMLSelectElement>("#sourceLang").value).toBe("auto");
    expect(query<HTMLSelectElement>("#sourceLang").selectedOptions[0]?.textContent)
      .toBe("自动检测");
    query<HTMLSelectElement>("#sourceLang").value = "en";
    click("#save");
    await vi.waitFor(() => expect(stored.sourceLang).toBe("en"));

    click("#providerTrigger");
    expect(document.querySelectorAll(".provider-menu-row")).toHaveLength(6);
    expect(document.querySelectorAll(".provider-enable")).toHaveLength(6);
    expect(document.querySelectorAll(".provider-delete")).toHaveLength(0);

    click("#addProvider");
    expect(document.querySelector("#providerDialog")?.hasAttribute("open")).toBe(true);
    const kind = query<HTMLSelectElement>("#customProviderKind");
    kind.value = "llm";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    expect(query<HTMLLabelElement>("#customLlmFormatField").hidden).toBe(false);
    query<HTMLInputElement>("#customProviderName").value = "My Anthropic";
    query<HTMLSelectElement>("#customLlmFormat").value = "anthropic";
    query<HTMLFormElement>("#providerDialogForm").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );

    await vi.waitFor(() => {
      expect(document.querySelector("#providerTriggerLabel")?.textContent).toBe("My Anthropic");
    });
    expect(stored.providers).toHaveLength(7);
    expect(stored.providers.find((provider) => provider.id === stored.activeProviderId)?.type)
      .toBe("anthropic-compatible");

    click("#providerTrigger");
    expect(document.querySelectorAll(".provider-delete")).toHaveLength(1);
    const customId = stored.activeProviderId;
    click(`[data-action="toggle"][data-provider-id="${customId}"]`);
    await vi.waitFor(() => expect(stored.activeProviderId).toBe("google-web-translate"));
    expect(stored.providers.find((provider) => provider.id === customId)?.enabled).toBe(false);

    click(`[data-action="delete"][data-provider-id="${customId}"]`);
    await vi.waitFor(() => {
      expect(stored.providers).toHaveLength(6);
      expect(document.querySelectorAll(".provider-delete")).toHaveLength(0);
    });
  });
});

function click(selector: string): void {
  query<HTMLButtonElement>(selector).click();
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function cloneSettings(value: ExtensionSettings): ExtensionSettings {
  return JSON.parse(JSON.stringify(value)) as ExtensionSettings;
}
