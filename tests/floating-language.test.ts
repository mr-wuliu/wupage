// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";

vi.mock("../src/content/runtime", () => ({
  sendRuntimeRequest: vi.fn()
}));

import { initFloatingBall, openDebugPanel } from "../src/content/floating";
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

  it("resizes the debug panel from its bottom-right handle", async () => {
    vi.mocked(sendRuntimeRequest).mockResolvedValue({
      tasks: [],
      activeCount: 0,
      queuedCount: 0
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });

    await openDebugPanel();
    const panel = query<HTMLElement>("#wupage-debug-panel");
    const handle = query<HTMLElement>(".wupage-debug-resize");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 100,
      width: 360,
      height: 300,
      right: 460,
      bottom: 400,
      x: 100,
      y: 100,
      toJSON: () => ({})
    } as DOMRect);

    handle.dispatchEvent(pointerEvent("pointerdown", 460, 400));
    window.dispatchEvent(pointerEvent("pointermove", 560, 500));

    expect(panel.style.width).toBe("460px");
    expect(panel.style.height).toBe("400px");
    window.dispatchEvent(pointerEvent("pointerup", 560, 500));
    query<HTMLButtonElement>("[data-action='close-debug']").click();
  });
});

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function pointerEvent(type: string, clientX: number, clientY: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY }
  });
  return event;
}
