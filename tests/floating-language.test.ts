// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";

vi.mock("../src/content/runtime", () => ({
  sendRuntimeRequest: vi.fn()
}));

import { initFloatingBall } from "../src/content/floating";
import { sendRuntimeRequest } from "../src/content/runtime";

describe("floating language controls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(sendRuntimeRequest).mockReset();
    document.documentElement.replaceChildren();
  });

  it("renders and saves the source-to-target language pair", async () => {
    let stored: ExtensionSettings = structuredClone(DEFAULT_SETTINGS);
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type === "GET_SETTINGS") return stored;
      if (request.type === "SAVE_SETTINGS") {
        stored = structuredClone(request.settings);
        return undefined;
      }
      return undefined;
    });
    vi.stubGlobal("chrome", {
      runtime: { id: "test" },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } }
    });

    initFloatingBall();
    const source = query<HTMLSelectElement>("[data-role='source-lang']");
    const target = query<HTMLSelectElement>("[data-role='target-lang']");
    expect(source.options[0]?.textContent).toBe("自动检测");
    expect(target.value).toBe("zh-CN");

    source.value = "en";
    target.value = "ko";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(stored).toMatchObject({ sourceLang: "en", targetLang: "ko" });
    });
  });
});

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
